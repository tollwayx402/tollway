import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRateLimitStore, createGate, payerHint } from "../src/index.js";
import type { GateHalt, GateOptions, GateRequest, GateResult, TollwayEvent } from "../src/index.js";
import {
  counterIds,
  createMockFacilitator,
  encodePaymentHeader,
  mockPayment,
} from "../src/testing.js";

const NOW = 1_765_432_100_000;

function asHalt(result: GateResult): GateHalt {
  if (result.type === "pass") throw new Error("expected a halt, got a pass");
  return result;
}

let now: number;
let events: TollwayEvent[];

function gate(overrides: Partial<GateOptions> = {}) {
  const ids = counterIds();
  return createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: "0xmerchant",
    facilitator: createMockFacilitator({ networks: ["base-sepolia"] }),
    onEvent: (e) => void events.push(e),
    clock: () => now,
    newId: (prefix) => ids(prefix),
    rateLimit: {
      challengesPerMinutePerIp: 3,
      attemptsPerMinutePerPayer: 3,
      store: new MemoryRateLimitStore({ clock: () => now }),
    },
    ...overrides,
  });
}

function unpaid(ip?: string): GateRequest {
  return {
    method: "GET",
    route: "/v1/report",
    url: "https://api.example.com/v1/report",
    headers: {},
    ...(ip === undefined ? {} : { ip }),
  };
}

function paid(payer = "0xpayer-1", ip = "203.0.113.7"): GateRequest {
  return {
    ...unpaid(ip),
    headers: { "x-payment": encodePaymentHeader(mockPayment({ payer })) },
  };
}

beforeEach(() => {
  now = NOW;
  events = [];
});

describe("MemoryRateLimitStore", () => {
  it("allows burst, then refuses, then refills over time", () => {
    let t = 0;
    const store = new MemoryRateLimitStore({ clock: () => t });

    expect(store.take("k", 60, 2)).toBe(true);
    expect(store.take("k", 60, 2)).toBe(true);
    expect(store.take("k", 60, 2)).toBe(false);

    t += 1_000; // one second at 60/min = one token
    expect(store.take("k", 60, 2)).toBe(true);
    expect(store.take("k", 60, 2)).toBe(false);
  });

  it("caps refill at burst", () => {
    let t = 0;
    const store = new MemoryRateLimitStore({ clock: () => t });
    store.take("k", 60, 2);
    t += 3_600_000; // an hour later: still only `burst` tokens
    expect(store.take("k", 60, 2)).toBe(true);
    expect(store.take("k", 60, 2)).toBe(true);
    expect(store.take("k", 60, 2)).toBe(false);
  });

  it("evicts least recently used keys at the cap", () => {
    const store = new MemoryRateLimitStore({ maxEntries: 2, clock: () => 0 });
    store.take("a", 60, 1);
    store.take("b", 60, 1);
    store.take("c", 60, 1); // evicts "a"
    expect(store.size).toBe(2);
    // "a" comes back with a fresh bucket — eviction can only ever be generous.
    expect(store.take("a", 60, 1)).toBe(true);
  });
});

describe("per-IP challenge limits (§9)", () => {
  it("answers 429 above the threshold and recovers as the bucket refills", async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) {
      expect(asHalt(await g.handle(unpaid("203.0.113.7"))).status).toBe(402);
    }

    const limited = await g.handle(unpaid("203.0.113.7"));
    expect(limited.type).toBe("reject");
    if (limited.type === "pass") throw new Error("unreachable");
    expect(limited.status).toBe(429);
    expect(limited.code).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBe("60");

    now += 20_000; // 3/min → one token per 20s
    expect(asHalt(await g.handle(unpaid("203.0.113.7"))).status).toBe(402);
  });

  it("limits per IP, not globally", async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await g.handle(unpaid("203.0.113.7"));
    expect(asHalt(await g.handle(unpaid("203.0.113.7"))).status).toBe(429);
    // A different client is unaffected.
    expect(asHalt(await g.handle(unpaid("198.51.100.9"))).status).toBe(402);
  });

  it("is inert without a client IP — a spoofable key punishes the innocent", async () => {
    const g = gate();
    for (let i = 0; i < 10; i++) {
      expect(asHalt(await g.handle(unpaid())).status).toBe(402);
    }
  });

  it("emits no event for a 429 — shedding load must not rebuild the flood", async () => {
    const g = gate();
    for (let i = 0; i < 5; i++) await g.handle(unpaid("203.0.113.7"));
    await g.flushEvents();
    expect(events.filter((e) => e.type === "challenge.issued")).toHaveLength(3);
    expect(events).toHaveLength(3);
  });

  it("is off entirely when not configured", async () => {
    const g = gate({ rateLimit: undefined });
    for (let i = 0; i < 10; i++) {
      expect(asHalt(await g.handle(unpaid("203.0.113.7"))).status).toBe(402);
    }
  });
});

describe("per-payer attempt limits (§9)", () => {
  it("limits verification attempts per payer address", async () => {
    const g = gate();
    // Distinct payloads so replay protection is not what stops them.
    for (let i = 0; i < 3; i++) {
      const result = await g.handle({
        ...unpaid("203.0.113.7"),
        headers: {
          "x-payment": encodePaymentHeader(mockPayment({ payer: "0xflood", txRef: `0xtx-${i}` })),
        },
      });
      expect(result.type).toBe("pass");
    }

    const limited = await g.handle({
      ...unpaid("203.0.113.7"),
      headers: {
        "x-payment": encodePaymentHeader(mockPayment({ payer: "0xflood", txRef: "0xtx-9" })),
      },
    });
    if (limited.type === "pass") throw new Error("over-limit payer was served");
    expect(limited.status).toBe(429);
  });

  it("does not throttle other payers", async () => {
    const g = gate();
    for (let i = 0; i < 4; i++) {
      await g.handle({
        ...unpaid(),
        headers: {
          "x-payment": encodePaymentHeader(mockPayment({ payer: "0xflood", txRef: `0xtx-${i}` })),
        },
      });
    }
    // Distinct txRef: the flood loop above already burned 0xtx-1 in the
    // replay store, which would reject this for the right-but-wrong reason.
    const other = await g.handle({
      ...unpaid(),
      headers: {
        "x-payment": encodePaymentHeader(mockPayment({ payer: "0xcalm", txRef: "0xtx-calm" })),
      },
    });
    expect(other.type).toBe("pass");
  });
});

describe("denylist (§9)", () => {
  it("refuses a denylisted payer with 403 before the facilitator is called", async () => {
    const facilitator = createMockFacilitator({ networks: ["base-sepolia"] });
    const g = gate({ facilitator, denylist: ["0xBADD"] });

    const result = await g.handle(paid("0xbadd"));
    await g.flushEvents();

    if (result.type === "pass") throw new Error("denied payer was served");
    expect(result.status).toBe(403);
    expect(result.code).toBe("payer_denied");
    // The whole point of the pre-check: no facilitator spend for known abuse.
    expect(facilitator.calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["toll.rejected"]);
    expect(events[0]?.data).toMatchObject({ code: "payer_denied", payer: "0xbadd" });
  });

  it("catches a payer the payload lied about, from the verified result", async () => {
    // The payload hint says one payer; the facilitator verifies another. The
    // authoritative check must win.
    const facilitator = createMockFacilitator({
      networks: ["base-sepolia"],
      verify: () => ({ ok: true, txRef: "0xtx-1", payer: "0xbadd", settledAmount: "4000" }),
    });
    const g = gate({ facilitator, denylist: ["0xbadd"] });

    const result = await g.handle(paid("0xlooks-fine"));
    if (result.type === "pass") throw new Error("denied payer was served");
    expect(result.status).toBe(403);
  });

  it("supports a live denylist function", async () => {
    const denied: string[] = [];
    const g = gate({ denylist: () => denied });

    expect((await g.handle(paid("0xsoon"))).type).toBe("pass");
    denied.push("0xsoon");
    const second = await g.handle({
      ...unpaid(),
      headers: {
        "x-payment": encodePaymentHeader(mockPayment({ payer: "0xsoon", txRef: "0xtx-2" })),
      },
    });
    expect(second.type).toBe("reject");
  });
});

describe("payerHint", () => {
  it("reads the mock shape and the exact-scheme shape", () => {
    expect(payerHint({ payer: "0xabc" })).toBe("0xabc");
    expect(payerHint({ authorization: { from: "0xdef" } })).toBe("0xdef");
    expect(payerHint({ nothing: true })).toBeUndefined();
  });
});

describe("configuration", () => {
  it("rejects nonsensical rates at construction", () => {
    expect(() => gate({ rateLimit: { challengesPerMinutePerIp: 0 } })).toThrow(/positive number/);
    expect(() => gate({ rateLimit: { attemptsPerMinutePerPayer: -5 } })).toThrow(/positive number/);
  });
});
