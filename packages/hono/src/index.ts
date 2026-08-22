/**
 * `@octroi/hono` — Hono binding for the protocol core.
 *
 * Edge-first: no `node:` imports anywhere in this package or in
 * `@octroi/core`, so the same build runs on Cloudflare Workers, Deno, Bun and
 * Node. A test enforces that (see `test/portability.test.ts`) — it is easy to
 * break by accident and impossible to notice until a deploy fails.
 *
 * Hono's middleware shape is a better fit for the gate than Express's: `next()`
 * returns once the handler is done, so the outcome is reported at a plain
 * `await` rather than through response events.
 */
import { createGate, type EventSink, type Gate, type GateOptions, type GateRequest } from "@octroi/core";
import type { Context, MiddlewareHandler } from "hono";

export interface OctroiHonoOptions extends Omit<GateOptions, "route"> {
  /** Route label for events and receipts. Defaults to Hono's matched pattern. */
  route?: string | ((c: Context) => string);
  /**
   * Cloud API key (§3.1). `@octroi/ingest` is an optional peer, loaded
   * lazily — it is BSL and this package is MIT, so it is never a hard
   * dependency. Not installed means events stay local, loudly.
   */
  apiKey?: string;
  ingestUrl?: string;
}

export interface OctroiMiddleware {
  (c: Context, next: () => Promise<void>): Promise<Response | void>;
  /** The underlying gate, for event sinks, `publicKey()`, or `doctor`. */
  gate: Gate;
}

export function octroi(options: OctroiHonoOptions): OctroiMiddleware {
  const { route, apiKey, ingestUrl, ...gateOptions } = options;
  const gate = createGate(gateOptions);

  if (apiKey !== undefined) {
    attachCloudSink(gate, apiKey, ingestUrl, gateOptions.logger);
  }

  const handler: MiddlewareHandler = async (c, next) => {
    const result = await gate.handle(toGateRequest(c, route));

    if (result.type !== "pass") {
      return c.json(result.body, result.status as 402, result.headers);
    }

    for (const [name, value] of Object.entries(result.headers)) c.header(name, value);

    try {
      await next();
    } catch (error) {
      // The handler threw after the payer was charged: a refund candidate,
      // and still an error for Hono's own error handling to render.
      result.report({ status: 500, error });
      throw error;
    }

    result.report({ status: c.res.status });
    return undefined;
  };

  return Object.assign(handler, { gate }) as OctroiMiddleware;
}

function toGateRequest(c: Context, route: OctroiHonoOptions["route"]): GateRequest {
  const url = c.req.url;
  return {
    method: c.req.method,
    route: resolveRoute(c, route),
    // Hono always has a full URL, so `resource` is absolute without any
    // `resourceBase` configuration — unlike Express, where it is rebuilt from
    // the Host header.
    url,
    path: safePath(url),
    // A `Headers` object; core reads it through its `get` method.
    headers: c.req.raw.headers,
    raw: c,
  };
}

/** Stable label for events and receipts: the matched pattern, not the query. */
function resolveRoute(c: Context, override: OctroiHonoOptions["route"]): string {
  if (typeof override === "function") return override(c);
  if (override !== undefined) return override;
  // `routePath` is the registered pattern ("/v1/:kind"), so one label per
  // route rather than one per parameter value.
  return c.req.routePath || safePath(c.req.url) || "/";
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

/** See the Express adapter: buffer synchronously, replay once the client loads. */
function attachCloudSink(
  gate: Gate,
  apiKey: string,
  url: string | undefined,
  logger: OctroiHonoOptions["logger"],
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
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      pending.length = 0;
      live = () => {};
    }
  })();
}
