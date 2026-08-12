/**
 * Replay protection store (§4.5).
 *
 * The default is an in-memory LRU, which is correct for a single instance.
 * Multi-instance deployments pass a shared implementation (Redis) — the
 * interface is deliberately two methods so that a Redis version is a
 * `EXISTS` and a `SET NX PX`.
 */
export interface NonceStore {
  /** Has this key already been consumed? */
  has(key: string): boolean | Promise<boolean>;
  /**
   * Consume the key. MUST be atomic: returns true only for the caller that
   * consumed it first, false if it was already present.
   */
  consume(key: string, ttlMs: number): boolean | Promise<boolean>;
}

export interface MemoryNonceStoreOptions {
  /** Hard cap on retained keys; oldest are evicted first. Default 10_000. */
  maxEntries?: number;
  /** Injected clock, unix milliseconds. */
  clock?: () => number;
}

/**
 * In-memory LRU with per-entry TTL. `Map` preserves insertion order, so the
 * first key is always the least recently used once we re-insert on touch.
 */
export class MemoryNonceStore implements NonceStore {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #clock: () => number;

  constructor(options: MemoryNonceStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#clock = options.clock ?? (() => Date.now());
    if (this.#maxEntries < 1) throw new RangeError("maxEntries must be at least 1");
  }

  has(key: string): boolean {
    const expiresAt = this.#entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return false;
    }
    // Touch: keep live keys away from the eviction end.
    this.#entries.delete(key);
    this.#entries.set(key, expiresAt);
    return true;
  }

  consume(key: string, ttlMs: number): boolean {
    if (this.has(key)) return false;
    if (this.#entries.size >= this.#maxEntries) {
      // Only pay for the sweep under pressure; steady state is O(1) per call.
      this.#sweep();
      while (this.#entries.size >= this.#maxEntries) {
        const oldest = this.#entries.keys().next();
        if (oldest.done) break;
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, this.#clock() + ttlMs);
    return true;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Drop every expired entry. Insertion order is not expiry order once TTLs vary. */
  #sweep(): void {
    const now = this.#clock();
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(key);
    }
  }
}
