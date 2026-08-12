/**
 * Fixture replay: a `fetch` that answers from `fixtures/exchanges.json`
 * instead of the network.
 *
 * CI must never depend on a live facilitator or a faucet. Flaky testnet builds
 * teach a team to ignore red, which costs more than the coverage is worth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/exchanges.json"), "utf8"),
) as Record<string, Exchange | unknown>;

export interface Exchange {
  path: "verify" | "settle";
  response: {
    status: number;
    body?: unknown;
    rawBody?: string;
    contentType?: string;
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    x402Version: number;
    paymentPayload: unknown;
    paymentRequirements: unknown;
  };
}

export function exchange(name: string): Exchange {
  const found = FIXTURES[name];
  if (found === undefined || typeof found !== "object") {
    throw new Error(`no fixture named "${name}"`);
  }
  return found as Exchange;
}

export interface ReplayFetch {
  fetch: typeof fetch;
  /** Every call the adapter made, in order. */
  calls: RecordedCall[];
}

/**
 * Replays the named exchanges in order, one per matching path. Extra calls
 * throw, so a test that silently starts making more requests fails loudly.
 */
export function replayFetch(names: string[]): ReplayFetch {
  const queue = names.map(exchange);
  const calls: RecordedCall[] = [];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected extra facilitator call to ${url}`);
    }
    if (!url.endsWith(`/${next.path}`)) {
      throw new Error(`expected a call to /${next.path}, got ${url}`);
    }

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as RecordedCall["body"],
    });

    if (init?.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }

    const { status, body, rawBody, contentType } = next.response;
    return new Response(rawBody ?? JSON.stringify(body ?? null), {
      status,
      headers: { "content-type": contentType ?? "application/json" },
    });
  }) as typeof fetch;

  return { fetch: impl, calls };
}

/**
 * A fetch that never answers — for timeout and outage paths. Mirrors real
 * `fetch` by rejecting immediately on an already-aborted signal rather than
 * waiting for an abort event that will never fire.
 */
export function routedFetch(routes: { verify: string; settle: string }): ReplayFetch {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.endsWith("/settle") ? "settle" : "verify";
    const fixture = exchange(routes[path]);

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as RecordedCall["body"],
    });

    const { status, body, rawBody, contentType } = fixture.response;
    return new Response(rawBody ?? JSON.stringify(body ?? null), {
      status,
      headers: { "content-type": contentType ?? "application/json" },
    });
  }) as typeof fetch;

  return { fetch: impl, calls };
}

export function hangingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    if (init?.signal?.aborted) throw abortError();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()));
    });
  }) as typeof fetch;
}

/** A fetch that fails the way a DNS or TLS failure does. */
export function failingFetch(message = "getaddrinfo ENOTFOUND x402.org"): typeof fetch {
  return (async () => {
    throw new TypeError(message);
  }) as typeof fetch;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}
