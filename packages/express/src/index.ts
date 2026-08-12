/**
 * `@tollway/express` — Express binding for the protocol core.
 *
 * The whole adapter contract is three things (see core's README): map the
 * request onto `GateRequest`, render a halt, and report the outcome once the
 * handler has produced a status.
 */
import { createGate, type Gate, type GateOptions, type GateRequest } from "@tollway/core";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface TollwayExpressOptions extends Omit<GateOptions, "route"> {
  /** Route label for events and receipts. Defaults to the mount path. */
  route?: string | ((req: Request) => string);
  /**
   * Cloud API key (§3.1). Reserved: inert until `@tollway/ingest` ships in
   * step 4. Passing it today logs a warning rather than silently pretending
   * events are reaching the cloud.
   */
  apiKey?: string;
}

export interface TollwayMiddleware extends RequestHandler {
  /** The underlying gate, for event sinks, `publicKey()`, or `doctor`. */
  gate: Gate;
}

/** Status reported when a client hangs up before the response completed. */
const CLIENT_CLOSED = 499;

export function tollway(options: TollwayExpressOptions): TollwayMiddleware {
  const { route, apiKey, ...gateOptions } = options;
  const gate = createGate(gateOptions);

  if (apiKey !== undefined) {
    (gateOptions.logger ?? console).warn?.(
      "tollway: `apiKey` is not wired up yet — events stay local until @tollway/ingest ships (spec §12.4)",
    );
  }

  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      let result;
      try {
        result = await gate.handle(toGateRequest(req, route));
      } catch (error) {
        // Only merchant misconfiguration reaches here; payment failures come
        // back as halts. Hand it to the app's error middleware rather than
        // inventing a response shape.
        next(error);
        return;
      }

      if (result.type !== "pass") {
        res.status(result.status).set(result.headers).json(result.body);
        return;
      }

      res.set(result.headers);

      // `finish` means the response was fully written; `close` without it means
      // the client left. They paid and got nothing, so that is a refund
      // candidate, not a served request.
      let reported = false;
      const report = (outcome: { status: number; error?: unknown }) => {
        if (reported) return;
        reported = true;
        result.report(outcome);
      };
      res.once("finish", () => report({ status: res.statusCode }));
      res.once("close", () => {
        if (res.writableFinished) return;
        report({
          status: res.statusCode || CLIENT_CLOSED,
          error: "client closed the connection before the response completed",
        });
      });

      next();
    })();
  };

  return Object.assign(handler, { gate });
}

function toGateRequest(req: Request, route: TollwayExpressOptions["route"]): GateRequest {
  const gateRequest: GateRequest = {
    method: req.method,
    route: resolveRoute(req, route),
    path: req.path,
    headers: req.headers,
    raw: req,
  };
  const url = absoluteUrl(req);
  if (url !== undefined) gateRequest.url = url;
  if (req.ip !== undefined) gateRequest.ip = req.ip;
  return gateRequest;
}

/**
 * The x402 `resource`. Query string included: it is part of what identifies
 * the resource, and dynamic pricing keys off it.
 *
 * `req.protocol` and `req.ip` honour `app.set("trust proxy", …)`. Behind a
 * proxy without that setting, this yields `http://` for an HTTPS request — set
 * `trust proxy`, or pin `resourceBase` on the gate.
 */
function absoluteUrl(req: Request): string | undefined {
  const host = req.get("host");
  if (host === undefined || host === "") return undefined;
  return `${req.protocol}://${host}${req.originalUrl}`;
}

/** Stable label for events and receipts — the path, never the query. */
function resolveRoute(req: Request, override: TollwayExpressOptions["route"]): string {
  if (typeof override === "function") return override(req);
  if (override !== undefined) return override;

  const mounted = req.baseUrl ?? "";
  const routePath = (req.route as { path?: string } | undefined)?.path ?? "";
  const combined = `${mounted}${routePath === "/" ? "" : routePath}`;
  return combined || req.path || "/";
}
