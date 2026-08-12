/**
 * The cloud ingest API (§8).
 *
 *   POST /v1/events        batch ingest, API-key auth, idempotent by event id
 *   GET  /v1/receipts/:id  receipt lookup + verification
 *   GET  /v1/config        signed route config, ETag / 60s poll
 *   POST /v1/refunds       mark a receipt refunded (execution manual in v1)
 *
 * Plus the dashboard: `GET /` and `GET /v1/dashboard`.
 */
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { signDocument, verifyDocument, type Signer, type TollwayEvent } from "@tollway/core";
import { EventStore, type RefundRecord } from "./store.js";
import { dashboardHtml } from "./dashboard.js";

export interface MerchantAccount {
  merchant: string;
  /** Ed25519 public key (hex) that this merchant's receipts are signed with. */
  receiptPublicKey?: string;
  /** Route config the dashboard serves back to the SDK. */
  routes?: Record<string, { price?: string; mode?: "fail_closed" | "fail_open" }>;
}

export interface ServerOptions {
  store: EventStore;
  /** API key → account. Keys are secrets; only their hash should ever be logged. */
  keys: Map<string, MerchantAccount>;
  /** Signs `GET /v1/config`. The SDK verifies against a pinned public key. */
  configSigner?: Signer;
  /** Max decompressed body. Guards against a gzip bomb. Default 8 MiB. */
  maxBodyBytes?: number;
  clock?: () => number;
}

interface AuthedRequest extends Request {
  account?: MerchantAccount;
}

export function createServer(options: ServerOptions): Express {
  const app = express();
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const clock = options.clock ?? (() => Date.now());
  app.disable("x-powered-by");

  const authenticate = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const account = options.keys.get(token);
    if (account === undefined) {
      // Deliberately identical for "no key" and "wrong key": a distinct message
      // would confirm which keys exist.
      res.status(401).json(errorBody("unauthorized", "A valid API key is required."));
      return;
    }
    req.account = account;
    next();
  };

  // --- POST /v1/events -----------------------------------------------------

  app.post(
    "/v1/events",
    authenticate,
    // body-parser inflates `content-encoding: gzip` itself, enforcing `limit`
    // *during* decompression. That streaming check is the gzip-bomb guard: a
    // few KB of zeros that would expand to gigabytes is cut off mid-inflate and
    // answered 413, rather than being buffered first and measured after.
    express.raw({ type: () => true, limit: maxBodyBytes, inflate: true }),
    (req: AuthedRequest, res: Response) => {
      const account = req.account!;
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let events: unknown;
      try {
        events = (JSON.parse(body.toString("utf8")) as { events?: unknown }).events;
      } catch {
        res.status(400).json(errorBody("invalid_body", "Body was not valid JSON."));
        return;
      }

      if (!Array.isArray(events)) {
        res.status(400).json(errorBody("invalid_body", "`events` must be an array."));
        return;
      }

      const valid = events.filter(isEvent);
      const result = options.store.append(account.merchant, valid);

      res.status(202).json({
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: events.length - valid.length,
      });
    },
  );

  // --- GET /v1/receipts/:id ------------------------------------------------

  app.get("/v1/receipts/:id", authenticate, (req: AuthedRequest, res: Response) => {
    void (async () => {
      const account = req.account!;
      // Express types a param as possibly repeated; a receipt id is a single
      // opaque string, so anything else is simply not found.
      const id = req.params["id"];
      const receipt = typeof id === "string" ? options.store.receipt(account.merchant, id) : undefined;
      if (receipt === undefined) {
        res.status(404).json(errorBody("not_found", "No such receipt."));
        return;
      }

      // §8 says "lookup + verification", so verify rather than just echoing:
      // a stored receipt whose signature no longer checks out is the single
      // most important thing this endpoint can tell a merchant.
      let verified: boolean | null = null;
      if (account.receiptPublicKey !== undefined) {
        verified = await verifyDocument(receipt, hexToBytes(account.receiptPublicKey));
      }

      res.json({
        receipt,
        verified,
        ...(verified === null
          ? { note: "no receipt public key registered for this account — signature not checked" }
          : {}),
      });
    })();
  });

  // --- GET /v1/config ------------------------------------------------------

  app.get("/v1/config", authenticate, (req: AuthedRequest, res: Response) => {
    void (async () => {
      const account = req.account!;
      if (options.configSigner === undefined) {
        res.status(503).json(errorBody("config_unavailable", "This deployment has no config signer."));
        return;
      }

      // `issued_at` is bucketed to 5 minutes, NOT the current second. With a
      // per-second timestamp the signature — and therefore the ETag — would
      // change on every request, making If-None-Match dead weight and every
      // §8 poll a full 200. Within a bucket the document is byte-stable, so
      // 304s actually happen; 5 minutes stays well inside the client's
      // 15-minute freshness bound, so replay protection is unaffected.
      const ISSUED_AT_BUCKET_S = 300;
      const config = await signDocument(
        {
          v: 1 as const,
          merchant: account.merchant,
          issued_at: Math.floor(clock() / 1_000 / ISSUED_AT_BUCKET_S) * ISSUED_AT_BUCKET_S,
          routes: account.routes ?? {},
        },
        options.configSigner,
      );

      // Ed25519 is deterministic, so for identical content the sig doubles as
      // the ETag.
      const etag = `"${config.sig.slice(0, 27)}"`;
      res.setHeader("etag", etag);
      res.setHeader("cache-control", "no-cache");
      if (req.get("if-none-match") === etag) {
        res.status(304).end();
        return;
      }
      res.json(config);
    })();
  });

  // --- POST /v1/refunds ----------------------------------------------------

  app.post("/v1/refunds", authenticate, express.json({ limit: "64kb" }), (req: AuthedRequest, res) => {
    const account = req.account!;
    const receiptId = (req.body as { receipt_id?: unknown }).receipt_id;
    const reason = (req.body as { reason?: unknown }).reason;

    if (typeof receiptId !== "string") {
      res.status(400).json(errorBody("invalid_body", "`receipt_id` is required."));
      return;
    }

    const record: RefundRecord = {
      receipt_id: receiptId,
      merchant: account.merchant,
      reason: typeof reason === "string" ? reason.slice(0, 500) : "",
      ts: clock(),
    };
    const result = options.store.refund(record);
    if (!result.ok) {
      res.status(result.reason === "unknown receipt" ? 404 : 409).json(
        errorBody(result.reason === "unknown receipt" ? "not_found" : "already_refunded", result.reason!),
      );
      return;
    }

    // v1 marks; it does not move money (§8).
    res.status(201).json({ ...record, executed: false });
  });

  // --- dashboard -----------------------------------------------------------

  app.get("/v1/dashboard", authenticate, (req: AuthedRequest, res: Response) => {
    res.json(options.store.projections(req.account!.merchant));
  });

  app.get("/", (_req, res) => {
    res.type("html").send(dashboardHtml());
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "No such endpoint."));
  });

  return app;
}

/** Same error envelope the SDK uses (§10). */
function errorBody(code: string, message: string) {
  return { error: { code, message, doc: `https://tollway.sh/docs/errors#${code}` } };
}

function isEvent(value: unknown): value is TollwayEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event["id"] === "string" &&
    typeof event["type"] === "string" &&
    typeof event["ts"] === "number" &&
    typeof event["route"] === "string" &&
    typeof event["data"] === "object"
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
