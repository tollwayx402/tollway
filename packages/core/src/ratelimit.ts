/**
 * §9 spam & abuse: per-IP and per-payer rate limits, token bucket, auto-429.
 *
 * Config-flag simple by design — ML/behavioral filtering is explicitly out of
 * scope for v1; the events exist to build it later. The store is pluggable the
 * same way the nonce store is, so multi-instance deployments can share
 * buckets, and the default is an LRU-capped in-memory map with the same
 * per-process caveat.
 */

export interface RateLimitStore {
  /**
   * Take one token from `key`'s bucket. Returns true when a token was
   * available. `ratePerMinute` and `burst` describe the bucket so a shared
   * store needs no per-key configuration.
   */
  take(key: string, ratePerMinute: number, burst: number): boolean | Promise<boolean>;
}

export interface RateLimitOptions {
  /**
   * Max 402 challenges per minute per client IP. Undefined disables the
   * check — and it is also inert for requests whose adapter supplies no
   * trustworthy IP, because limiting on a spoofable key only punishes the
   * innocent.
   */
  challengesPerMinutePerIp?: number;
  /** Max verification attempts per minute per payer address. */
  attemptsPerMinutePerPayer?: number;
  /** Bucket capacity. Defaults to the per-minute rate (1× burst). */
  burst?: number;
  store?: RateLimitStore;
}

export interface MemoryRateLimitStoreOptions {
  /** Hard cap on tracked keys; least recently used are evicted. */
  maxEntries?: number;
  clock?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Classic token bucket over an LRU map. Eviction forgets a bucket, which
 * refills it — an attacker cycling millions of IPs gets fresh buckets anyway,
 * so the cap costs nothing they could not already have, while bounding memory.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxEntries: number;
  readonly #clock: () => number;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#clock = options.clock ?? (() => Date.now());
    if (this.#maxEntries < 1) throw new RangeError("maxEntries must be at least 1");
  }

  take(key: string, ratePerMinute: number, burst: number): boolean {
    const now = this.#clock();
    const existing = this.#buckets.get(key);

    let bucket: Bucket;
    if (existing === undefined) {
      bucket = { tokens: burst, updatedAt: now };
    } else {
      this.#buckets.delete(key); // re-insert for LRU order
      const refill = ((now - existing.updatedAt) / 60_000) * ratePerMinute;
      bucket = { tokens: Math.min(burst, existing.tokens + refill), updatedAt: now };
    }

    while (this.#buckets.size >= this.#maxEntries) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done) break;
      this.#buckets.delete(oldest.value);
    }

    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return true;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** Payer addresses to refuse (§9: "optional denylist of payer addresses"). */
export type Denylist = readonly string[] | (() => readonly string[]);

export function isDenied(denylist: Denylist | undefined, payer: string | undefined): boolean {
  if (denylist === undefined || payer === undefined) return false;
  const entries = typeof denylist === "function" ? denylist() : denylist;
  const needle = payer.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === needle);
}

/**
 * Best-effort payer extraction from an undecoded payment payload, for shedding
 * denied or over-limit payers BEFORE spending a facilitator call. The facilitator's
 * verified `payer` is still checked afterwards — this is an optimization, not
 * the enforcement point.
 */
export function payerHint(payload: Record<string, unknown>): string | undefined {
  const direct = payload["payer"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const authorization = payload["authorization"];
  if (typeof authorization === "object" && authorization !== null) {
    const from = (authorization as Record<string, unknown>)["from"];
    if (typeof from === "string" && from.length > 0) return from;
  }
  return undefined;
}
