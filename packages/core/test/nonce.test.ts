import { describe, expect, it } from "vitest";
import { MemoryNonceStore } from "../src/index.js";

describe("MemoryNonceStore", () => {
  it("consumes a key exactly once", () => {
    const store = new MemoryNonceStore();
    expect(store.consume("pay:a", 60_000)).toBe(true);
    expect(store.consume("pay:a", 60_000)).toBe(false);
    expect(store.has("pay:a")).toBe(true);
    expect(store.has("pay:b")).toBe(false);
  });

  it("forgets keys once their TTL elapses", () => {
    let now = 1_000;
    const store = new MemoryNonceStore({ clock: () => now });
    expect(store.consume("pay:a", 5_000)).toBe(true);

    now = 5_999;
    expect(store.has("pay:a")).toBe(true);

    now = 6_000;
    expect(store.has("pay:a")).toBe(false);
    expect(store.consume("pay:a", 5_000)).toBe(true);
  });

  it("evicts the least recently used key at capacity", () => {
    const store = new MemoryNonceStore({ maxEntries: 3 });
    store.consume("a", 60_000);
    store.consume("b", 60_000);
    store.consume("c", 60_000);
    // Touch "a" so "b" becomes the eviction candidate.
    expect(store.has("a")).toBe(true);

    store.consume("d", 60_000);
    expect(store.size).toBe(3);
    expect(store.has("b")).toBe(false);
    expect(store.has("a")).toBe(true);
    expect(store.has("c")).toBe(true);
    expect(store.has("d")).toBe(true);
  });

  it("reclaims expired entries before evicting live ones", () => {
    let now = 0;
    const store = new MemoryNonceStore({ maxEntries: 2, clock: () => now });
    store.consume("short", 1_000);
    now = 500;
    store.consume("long", 60_000);

    now = 2_000; // "short" is expired but still resident
    expect(store.consume("fresh", 60_000)).toBe(true);
    expect(store.has("long")).toBe(true);
    expect(store.has("fresh")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new MemoryNonceStore({ maxEntries: 0 })).toThrow(RangeError);
  });
});
