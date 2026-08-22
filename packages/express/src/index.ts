/**
 * `@octroi/express` — Express binding for the protocol core.
 *
 * The whole adapter contract is three things (see core's README): map the
 * request onto `GateRequest`, render a halt, and report the outcome once the
 * handler has produced a status.
 */
import { createGate, type EventSink, type Gate, type GateOptions, type GateRequest } from "@octroi/core";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface OctroiExpressOptions extends Omit<GateOptions, "route"> {
  /** Route label for events and receipts. Defaults to the mount path. */
  route?: string | ((req: Request) => string);
  /**
   * Cloud API key (§3.1). When set, events are also sent to Octroi Cloud.
   *
   * `@octroi/ingest` is an **optional peer dependency**, loaded lazily: it is
   * BSL, this package is MIT, and §1.1 promises the SDK works with no cloud —
   * so a hard dependency would drag BSL code into every standalone install.
   * If it is not installed, this logs an error and stays local rather than
   * pretending events are being delivered.
   */
  apiKey?: string;
  /** Cloud ingest base URL. Defaults to the client's own default. */
  ingestUrl?: string;
}

export interface OctroiMiddleware extends RequestHandler {
  /** The underlying gate, for event sinks, `publicKey()`, or `doctor`. */
  gate: Gate;
}

/** Status reported when a client hangs up before the response completed. */
const CLIENT_CLOSED = 499;

export function octroi(options: OctroiExpressOptions): OctroiMiddleware {
  const { route, apiKey, ingestUrl, ...gateOptions } = options;
  const gate = createGate(gateOptions);

  if (apiKey !== undefined) {
    attachCloudSink(gate, apiKey, ingestUrl, gateOptions.logger);
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

/**
 * Attach the cloud sink without ever blocking construction.
 *
 * The import is async but `octroi()` is not, so a buffering sink goes on the
 * bus **synchronously** and replays into the real client once it loads. Without
 * that, every event emitted during startup — exactly when a misconfiguration
 * shows up — would be lost to the cloud.
 */
function attachCloudSink(
  gate: Gate,
  apiKey: string,
  url: string | undefined,
  logger: OctroiExpressOptions["logger"],
): void {
  const pending: Parameters<EventSink>[0][] = [];
  let live: EventSink | undefined;

  gate.events.addSink((event) => {
    if (live === undefined) pending.push(event);
    else return live(event);
  });

  void (async () => {
    try {
      const { createIngestClient } = await import("@octroi/ingest");
      const client = createIngestClient({
        apiKey,
        ...(url === undefined ? {} : { url }),
        ...(logger === undefined ? {} : { logger }),
      });
      live = client.sink;
      for (const event of pending.splice(0)) client.sink(event);
    } catch (error) {
      (logger ?? console).error?.(
        "octroi: `apiKey` was set but @octroi/ingest could not be loaded — events stay local. " +
          `Install it to enable cloud events. (${error instanceof Error ? error.message : String(error)})`,
      );
      // Drop the backlog rather than growing it forever on a machine that will
      // never have the package.
      pending.length = 0;
      live = () => {};
    }
  })();
}

function toGateRequest(req: Request, route: OctroiExpressOptions["route"]): GateRequest {
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
function resolveRoute(req: Request, override: OctroiExpressOptions["route"]): string {
  if (typeof override === "function") return override(req);
  if (override !== undefined) return override;

  const mounted = req.baseUrl ?? "";
  const routePath = (req.route as { path?: string } | undefined)?.path ?? "";
  const combined = `${mounted}${routePath === "/" ? "" : routePath}`;
  return combined || req.path || "/";
}
