import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEphemeralSigner,
  signDocument,
  publicKeyHex,
  type Receipt,
  type Signer,
  type TollwayEvent,
} from "@tollway/core";
import { validateSignedConfig } from "@tollway/ingest";
import { createServer, type MerchantAccount } from "../src/server.js";
import { EventStore } from "../src/store.js";

const NOW = 1_765_432_100_000;
let dir: string;
let server: Server;
let url: string;
let store: EventStore;
let receiptSigner: Signer;

const KEYS = new Map<string, MerchantAccount>();

async function receipt(overrides: Partial<Receipt> = {}): Promise<Receipt> {
  const body = {
    id: overrides.id ?? "twy_rcpt_0001",
    v: 1 as const,
    route: overrides.route ?? "/v1/report",
    amount: overrides.amount ?? "4000",
    asset: "usdc",
    network: "base",
    payer: overrides.payer ?? "0xpayer1",
    tx_ref: "0xtx1",
    ts: overrides.ts ?? Math.floor(NOW / 1_000),
    merchant: "acct_9d2",
  };
  return signDocument(body, receiptSigner);
}

function event(id: string, type: TollwayEvent["type"], data: Record<string, unknown> = {}): TollwayEvent {
  return { id, v: 1, type, ts: NOW, route: "/v1/report", merchant: "acct_9d2", data };
}

async function post(path: string, body: unknown, key = "key-a", headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
}

const get = (path: string, key = "key-a") =>
  fetch(`${url}${path}`, { headers: { authorization: `Bearer ${key}` } });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tollway-ingest-"));
  store = new EventStore(dir);
  receiptSigner = await createEphemeralSigner();

  KEYS.clear();
  KEYS.set("key-a", {
    merchant: "acct_9d2",
    receiptPublicKey: await publicKeyHex(receiptSigner),
    routes: { "/v1/report": { price: "$0.02", mode: "fail_closed" } },
  });
  KEYS.set("key-b", { merchant: "acct_other" });

  const app = createServer({
    store,
    keys: KEYS,
    configSigner: await createEphemeralSigner(),
    clock: () => NOW,
  });
  server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("refuses every endpoint without a valid key", async () => {
    for (const path of ["/v1/events", "/v1/refunds"]) {
      expect((await post(path, {}, "nope")).status).toBe(401);
    }
    for (const path of ["/v1/receipts/x", "/v1/config", "/v1/dashboard"]) {
      expect((await get(path, "nope")).status).toBe(401);
    }
  });

  it("gives the same answer for a missing and a wrong key", async () => {
    const missing = await fetch(`${url}/v1/dashboard`);
    const wrong = await get("/v1/dashboard", "definitely-not-a-key");
    expect(missing.status).toBe(wrong.status);
    expect(await missing.json()).toEqual(await wrong.json());
  });
});

describe("POST /v1/events", () => {
  it("accepts a batch and is idempotent by event id (§8)", async () => {
    const batch = { events: [event("e1", "toll.settled", { receipt: await receipt() })] };

    const first = await post("/v1/events", batch);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: 1, duplicates: 0 });

    // The client's at-least-once retry resends; revenue must not double.
    const second = await post("/v1/events", batch);
    expect(await second.json()).toMatchObject({ accepted: 0, duplicates: 1 });

    const dash = await (await get("/v1/dashboard")).json();
    expect(dash.rejects.settled).toBe(1);
    expect(dash.revenueByRouteDay[0].revenue).toBe("4000");
  });

  it("accepts gzip", async () => {
    const body = gzipSync(
      Buffer.from(JSON.stringify({ events: [event("e1", "toll.settled", { receipt: await receipt() })] })),
    );
    const response = await post("/v1/events", body, "key-a", {
      "content-encoding": "gzip",
      "content-type": "application/json",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: 1 });
  });

  it("refuses a gzip bomb rather than decompressing it", async () => {
    // ~10 KB compressed, 10 MB inflated. The limit is enforced during
    // inflation, so this is cut off rather than buffered and then measured.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0));
    const response = await post("/v1/events", bomb, "key-a", { "content-encoding": "gzip" });
    expect(response.status).toBe(413);
  });

  it("stamps the authenticated merchant, ignoring the body's claim", async () => {
    // Otherwise anyone with a key could write into another account's stream.
    await post("/v1/events", {
      events: [{ ...event("e1", "toll.settled", { receipt: await receipt() }), merchant: "acct_other" }],
    });

    expect((await (await get("/v1/dashboard", "key-a")).json()).events).toBe(1);
    expect((await (await get("/v1/dashboard", "key-b")).json()).events).toBe(0);
  });

  it("drops malformed entries but keeps the rest of the batch", async () => {
    const response = await post("/v1/events", {
      events: [event("e1", "toll.rejected", { code: "replay" }), { nope: true }, null],
    });
    expect(await response.json()).toMatchObject({ accepted: 1, rejected: 2 });
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("/v1/events", "not json at all");
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/receipts/:id", () => {
  it("returns the receipt and verifies its signature (§8)", async () => {
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });

    const response = await get(`/v1/receipts/${signed.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.receipt).toEqual(signed);
    expect(body.verified).toBe(true);
  });

  it("reports a tampered receipt as unverified rather than trusting storage", async () => {
    const signed = await receipt();
    await post("/v1/events", {
      events: [event("e1", "toll.settled", { receipt: { ...signed, amount: "999999" } })],
    });

    const body = await (await get(`/v1/receipts/${signed.id}`)).json();
    expect(body.receipt.amount).toBe("999999");
    expect(body.verified).toBe(false);
  });

  it("does not leak another merchant's receipt", async () => {
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });
    expect((await get(`/v1/receipts/${signed.id}`, "key-b")).status).toBe(404);
  });

  it("says so when no key is registered, instead of implying verification", async () => {
    KEYS.set("key-a", { merchant: "acct_9d2" });
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });

    const body = await (await get(`/v1/receipts/${signed.id}`)).json();
    expect(body.verified).toBeNull();
    expect(body.note).toMatch(/no receipt public key registered/);
  });
});

describe("GET /v1/config", () => {
  it("serves a config the SDK's verifier accepts", async () => {
    const signer = await createEphemeralSigner();
    const app = createServer({ store, keys: KEYS, configSigner: signer, clock: () => NOW });
    const local = await new Promise<Server>((resolve) => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
    const localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;

    try {
      const response = await fetch(`${localUrl}/v1/config`, {
        headers: { authorization: "Bearer key-a" },
      });
      const config = await response.json();

      // The SDK's own validator is the judge — not a bespoke assertion here.
      const problem = await validateSignedConfig(config, await signer.publicKey(), {
        now: NOW,
        maxAgeMs: 900_000,
        merchant: "acct_9d2",
      });
      expect(problem).toBeUndefined();
      expect(config.routes["/v1/report"]).toEqual({ price: "$0.02", mode: "fail_closed" });
    } finally {
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("honours If-None-Match with 304 even as the clock moves (§8: ETag / 60s poll)", async () => {
    // The clock must ADVANCE between polls: with a per-second issued_at the
    // signature changes every request and 304 never fires — the bug a frozen
    // clock hid. issued_at is bucketed, so polls inside a bucket match.
    // Aligned to a bucket start, so the two 60s polls below are unambiguously
    // inside one bucket and the +10min poll is unambiguously outside it.
    let now = Math.floor(NOW / 300_000) * 300_000;
    const app = createServer({
      store,
      keys: KEYS,
      configSigner: await createEphemeralSigner(),
      clock: () => now,
    });
    const local = await new Promise<Server>((resolve) => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
    const localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    const poll = (etag?: string) =>
      fetch(`${localUrl}/v1/config`, {
        headers: { authorization: "Bearer key-a", ...(etag ? { "if-none-match": etag } : {}) },
      });

    try {
      const first = await poll();
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      // Two §8-style 60s polls later, same bucket: 304.
      now += 60_000;
      expect((await poll(etag!)).status).toBe(304);
      now += 60_000;
      expect((await poll(etag!)).status).toBe(304);

      // Past the bucket boundary the document legitimately changes.
      now += 10 * 60_000;
      const later = await poll(etag!);
      expect(later.status).toBe(200);
      expect(later.headers.get("etag")).not.toBe(etag);
    } finally {
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("serves each merchant only their own routes", async () => {
    const body = await (await get("/v1/config", "key-b")).json();
    expect(body.merchant).toBe("acct_other");
    expect(body.routes).toEqual({});
  });
});

describe("POST /v1/refunds", () => {
  it("marks a receipt refunded without moving money (v1)", async () => {
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });

    const response = await post("/v1/refunds", { receipt_id: signed.id, reason: "handler 500" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ receipt_id: signed.id, executed: false });

    const dash = await (await get("/v1/dashboard")).json();
    expect(dash.revenueByRouteDay[0].refunded).toBe("4000");
  });

  it("refuses an unknown receipt and a double refund", async () => {
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });

    expect((await post("/v1/refunds", { receipt_id: "twy_rcpt_nope" })).status).toBe(404);
    expect((await post("/v1/refunds", { receipt_id: signed.id })).status).toBe(201);
    expect((await post("/v1/refunds", { receipt_id: signed.id })).status).toBe(409);
  });

  it("cannot refund another merchant's receipt", async () => {
    const signed = await receipt();
    await post("/v1/events", { events: [event("e1", "toll.settled", { receipt: signed })] });
    expect((await post("/v1/refunds", { receipt_id: signed.id }, "key-b")).status).toBe(404);
  });
});

describe("dashboard projections (§8)", () => {
  it("derives revenue, rejects, payers and refund candidates from the stream alone", async () => {
    const paid = await receipt({ id: "twy_rcpt_a", amount: "4000", payer: "0xpayer1" });
    const failed = await receipt({ id: "twy_rcpt_b", amount: "20000", payer: "0xpayer2" });

    await post("/v1/events", {
      events: [
        event("e1", "challenge.issued", { price: "4000" }),
        event("e2", "toll.settled", { receipt: paid }),
        event("e3", "request.served", { receipt_id: paid.id, status: 200 }),
        event("e4", "toll.settled", { receipt: failed }),
        event("e5", "request.failed", { receipt_id: failed.id, status: 500 }),
        event("e6", "toll.rejected", { code: "replay" }),
        event("e7", "toll.rejected", { code: "expired" }),
      ],
    });

    const d = await (await get("/v1/dashboard")).json();

    expect(d.revenueByRouteDay[0]).toMatchObject({ route: "/v1/report", revenue: "24000", tolls: 2 });
    expect(d.tollsByPayer).toEqual([
      { payer: "0xpayer2", tolls: 1, amount: "20000" },
      { payer: "0xpayer1", tolls: 1, amount: "4000" },
    ]);
    // Reject rate is over verification attempts, not challenges (PROTOCOL.md §8).
    expect(d.rejects).toMatchObject({ settled: 2, rejected: 2, rate: 0.5 });
    expect(d.rejects.byCode).toEqual({ replay: 1, expired: 1 });

    // Refund candidates are request.failed *after* toll.settled — and only those.
    expect(d.refundCandidates).toHaveLength(1);
    expect(d.refundCandidates[0]).toMatchObject({
      receipt_id: failed.id,
      amount: "20000",
      status: 500,
      refunded: false,
    });
  });

  it("rebuilds identical projections from the log after a restart", async () => {
    const signed = await receipt();
    await post("/v1/events", {
      events: [
        event("e1", "toll.settled", { receipt: signed }),
        event("e2", "request.failed", { receipt_id: signed.id, status: 503 }),
        event("e3", "toll.rejected", { code: "wrong_amount" }),
      ],
    });
    await post("/v1/refunds", { receipt_id: signed.id });

    const before = await (await get("/v1/dashboard")).json();
    // §1.5: the dashboard is a pure function of the event stream, so a cold
    // process must fold its way back to exactly the same numbers.
    const rebuilt = new EventStore(dir).projections("acct_9d2");

    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(before);
  });
});

describe("the page itself", () => {
  it("serves the dashboard without an API key, but no data with it", async () => {
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toContain("Tollway");
    // The page is a shell; every number arrives through the authenticated API.
    expect(html).not.toContain("acct_9d2");
  });
});
