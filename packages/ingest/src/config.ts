/**
 * Signed remote config (§3.1, §8 `GET /v1/config`).
 *
 * This is the most security-sensitive thing in the SDK: it lets a remote party
 * change what a merchant charges. Three rules follow, and none of them are
 * optional:
 *
 * 1. **The verification key is pinned by the merchant**, never learned from the
 *    response. A key fetched from the server it authenticates is not a key.
 * 2. **Unverified config is never applied.** A bad signature is a no-op plus a
 *    loud log — the previous good config (or local config) stays in force.
 * 3. **Stale config is rejected.** Without a freshness bound, anyone who can
 *    replay an old signed response can revert a price rise indefinitely.
 */
import { canonicalJson, verifyDocument, type Logger } from "@octroi/core";
import type { Mode, Price } from "@octroi/core";

export const DEFAULT_CONFIG_URL = "https://ingest.octroi.ai";

/** Per-route overrides the dashboard can push. */
export interface RemoteRouteConfig {
  price?: Price;
  mode?: Mode;
}

/** The signed document. `sig` covers the canonical JSON of everything else. */
export interface SignedConfig {
  v: 1;
  merchant: string;
  /** Unix seconds. Bounds replay of an old, still-valid signature. */
  issued_at: number;
  routes: Record<string, RemoteRouteConfig>;
  sig: string;
}

export interface RemoteConfigOptions {
  apiKey: string;
  /**
   * Ed25519 public key of the merchant's Octroi account, hex or raw bytes.
   * **Pinned by the merchant.** Required — there is no unverified mode.
   */
  publicKey: string | Uint8Array;
  url?: string;
  /** §3.1: changes apply within 60s. */
  pollIntervalMs?: number;
  /** Reject configs older than this. Default 15 minutes. */
  maxAgeMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  clock?: () => number;
  /** Called after each successful, verified update. */
  onUpdate?: (config: SignedConfig) => void;
}

export interface RemoteConfigClient {
  start(): void;
  stop(): void;
  /** Fetch once, verify, and apply. Returns true when the config changed. */
  refresh(): Promise<boolean>;
  /** The current verified config, or undefined if none has ever verified. */
  current(): SignedConfig | undefined;
  /** Overrides for a route, or undefined when the cloud has nothing to say. */
  lookup(route: string): RemoteRouteConfig | undefined;
}

export function createRemoteConfigClient(options: RemoteConfigOptions): RemoteConfigClient {
  const url = (options.url ?? DEFAULT_CONFIG_URL).replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60 * 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? (() => Date.now());
  const log = options.logger;
  const publicKey =
    typeof options.publicKey === "string" ? hexToBytes(options.publicKey) : options.publicKey;

  if (publicKey.length !== 32) {
    throw new Error(
      `@octroi/ingest: publicKey must be a 32-byte Ed25519 key, got ${publicKey.length} bytes`,
    );
  }

  let current: SignedConfig | undefined;
  let etag: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<boolean> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
    if (etag !== undefined) headers["if-none-match"] = etag;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${url}/v1/config`, { headers, signal: controller.signal });
    } catch (error) {
      log?.warn("octroi: could not fetch remote config, keeping the current one", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(abortTimer);
    }

    if (response.status === 304) return false;
    if (!response.ok) {
      log?.warn("octroi: remote config responded with an error, keeping the current one", {
        status: response.status,
      });
      return false;
    }

    let payload: SignedConfig;
    try {
      payload = (await response.json()) as SignedConfig;
    } catch {
      log?.error("octroi: remote config was not valid JSON — ignoring");
      return false;
    }

    const problem = await validate(payload, publicKey, {
      now: clock(),
      maxAgeMs,
    });
    if (problem !== undefined) {
      // Refusing is the whole point: an attacker who can answer this request
      // must not be able to change what the merchant charges.
      log?.error("octroi: refusing unverified remote config", { reason: problem });
      return false;
    }

    const changed = current === undefined || canonicalJson(current) !== canonicalJson(payload);
    current = payload;
    etag = response.headers.get("etag") ?? undefined;
    if (changed) options.onUpdate?.(payload);
    return changed;
  }

  return {
    start(): void {
      if (timer !== undefined) return;
      void refresh();
      timer = setInterval(() => void refresh(), pollIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    refresh,
    current: () => current,
    lookup: (route) => current?.routes[route],
  };
}

/** Returns a reason string when the config must be refused, undefined when good. */
export async function validate(
  payload: SignedConfig,
  publicKey: Uint8Array,
  opts: { now: number; maxAgeMs: number; merchant?: string },
): Promise<string | undefined> {
  if (payload === null || typeof payload !== "object") return "not an object";
  if (payload.v !== 1) return `unsupported config version ${String(payload.v)}`;
  if (typeof payload.sig !== "string" || payload.sig.length === 0) return "missing signature";
  if (typeof payload.merchant !== "string") return "missing merchant";
  if (typeof payload.routes !== "object" || payload.routes === null) return "missing routes";
  if (typeof payload.issued_at !== "number" || !Number.isFinite(payload.issued_at)) {
    return "missing issued_at";
  }
  if (opts.merchant !== undefined && payload.merchant !== opts.merchant) {
    return `config is for merchant ${payload.merchant}, expected ${opts.merchant}`;
  }

  const ageMs = opts.now - payload.issued_at * 1_000;
  if (ageMs > opts.maxAgeMs) {
    return `config is ${Math.round(ageMs / 1_000)}s old, older than the ${Math.round(
      opts.maxAgeMs / 1_000,
    )}s bound — possible replay of a superseded config`;
  }
  // A little tolerance for clock skew, but not unlimited: a far-future
  // issued_at would otherwise pin a config forever.
  if (ageMs < -opts.maxAgeMs) return "config is dated in the future";

  // The signature covers the canonical JSON of everything but `sig` — the same
  // construction receipts use, so there is one signing rule in the system.
  const verified = await verifyDocument(payload, publicKey);
  return verified ? undefined : "signature did not verify against the pinned key";
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("@octroi/ingest: publicKey must be valid hex");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
