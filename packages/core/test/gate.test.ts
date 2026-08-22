import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryNonceStore,
  RECEIPT_HEADER,
  createGate,
  readErrorDetail,
  verifyReceipt,
} from "../src/index.js";
import type {
  ChallengeBody,
  ErrorBody,
  GateOptions,
  GateRequest,
  OctroiEvent,
} from "../src/index.js";
import {
  counterIds,
  createMockFacilitator,
  encodePaymentHeader,
  fixedClock,
  mockPayment,
  type MockFacilitator,
} from "../src/testing.js";

const NOW = 1_765_432_100_000;

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    method: "GET",
    route: "/v1/report",
    url: "https://api.example.com/v1/report",
    headers: {},
    ...overrides,
  };
}

function paid(payload = mockPayment()): GateRequest {
  return request({ headers: { "X-PAYMENT": encodePaymentHeader(payload) } });
}

let facilitator: MockFacilitator;
let events: OctroiEvent[];

function gate(overrides: Partial<GateOptions> = {}) {
  const ids = counterIds();
  return createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: "0xmerchant",
    facilitator,
    onEvent: (e) => void events.push(e),
    clock: () => NOW,
    newNonce: () => "nonce-1",
    newId: (prefix) => ids(prefix),
    ...overrides,
  });
}

beforeEach(() => {
  facilitator = createMockFacilitator({ networks: ["base-sepolia", "base"] });
  events = [];
});

describe("challenge", () => {
  it("answers an unpaid request with a 402 and the advertised schemes", async () => {
    const g = gate();
    const result = await g.handle(request());
    await g.flushEvents();

    expect(result.type).toBe("challenge");
    if (result.type === "pass") throw new Error("unreachable");
    expect(result.status).toBe(402);
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");

    const body = result.body as ChallengeBody;
    expect(body.x402Version).toBe(1);
    // `error` is an optional closed enum in x402, and a first contact is not
    // one of its reasons — so it is omitted rather than filled with our code.
    expect(body.error).toBeUndefined();
    // The §10 envelope rides alongside, never instead of, the spec fields.
    expect(body.errorDetail).toEqual({
      code: "payment_required",
      message: "This route costs 0.004000 USDC.",
      doc: "https://octroi.ai/docs/errors#payment_required",
    });
    expect(readErrorDetail(body)?.code).toBe("payment_required");
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "4000",
      payTo: "0xmerchant",
      resource: "https://api.example.com/v1/report",
      maxTimeoutSeconds: 120,
    });
  });

  it("advertises every configured network in order", async () => {
    const g = gate({ network: ["base", "base-sepolia"] });
    const result = await g.handle(request());
    if (result.type === "pass") throw new Error("unreachable");
    const body = result.body as ChallengeBody;
    expect(body.accepts.map((a) => a.network)).toEqual(["base", "base-sepolia"]);
  });

  it("sets the challenge expiry from the injected clock", async () => {
    const g = gate({ expirySeconds: 300 });
    await g.handle(request());
    const built = facilitator.challenges[0];
    expect(built?.expiresAt).toBe(Math.floor(NOW / 1_000) + 300);
    expect(built?.nonce).toBe("nonce-1");
  });

  it("emits challenge.issued with price, asset, networks and nonce", async () => {
    const g = gate();
    await g.handle(request());
    await g.flushEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      v: 1,
      type: "challenge.issued",
      ts: NOW,
      route: "/v1/report",
      merchant: null,
      data: {
        price: "4000",
        asset: "usdc",
        networks: ["base-sepolia"],
        nonce: "nonce-1",
      },
    });
  });

  it("prices per request when price is a function", async () => {
    const g = gate({ price: (req) => (req.route === "/v1/deep" ? "$0.02" : "$0.004") });
    const result = await g.handle(request({ route: "/v1/deep" }));
    if (result.type === "pass") throw new Error("unreachable");
    expect((result.body as ChallengeBody).accepts[0]?.maxAmountRequired).toBe("20000");
  });

  it("returns 500 without serving when a dynamic price throws", async () => {
    const g = gate({
      price: () => {
        throw new Error("pricing service down");
      },
    });
    const result = await g.handle(request());
    await g.flushEvents();

    if (result.type === "pass") throw new Error("unreachable");
    expect(result.status).toBe(500);
    expect((result.body as ErrorBody).error.code).toBe("invalid_config");
    expect(events.map((e) => e.type)).toEqual(["gate.error"]);
  });
});

describe("settlement", () => {
  it("verifies, mints a signed receipt and passes the request through", async () => {
    const g = gate();
    const result = await g.handle(paid());
    await g.flushEvents();

    expect(result.type).toBe("pass");
    if (result.type !== "pass") throw new Error("unreachable");
    expect(result.receipt).toMatchObject({
      v: 1,
      route: "/v1/report",
      amount: "4000",
      asset: "usdc",
      network: "base-sepolia",
      payer: "0xpayer-1",
      tx_ref: "0xtx-1",
      ts: Math.floor(NOW / 1_000),
      merchant: null,
    });
    expect(result.receipt?.id).toMatch(/^oct_rcpt_/);
    expect(result.headers[RECEIPT_HEADER]).toBe(result.receipt?.id);
    await expect(verifyReceipt(result.receipt!, await g.publicKey())).resolves.toBe(true);

    expect(events.map((e) => e.type)).toEqual(["toll.settled"]);
    expect(events[0]?.data).toEqual({ receipt: result.receipt });
  });

  it("carries the merchant id into receipts and events in cloud mode", async () => {
    const g = gate({ merchant: "acct_9d2" });
    const result = await g.handle(paid());
    await g.flushEvents();
    if (result.type !== "pass") throw new Error("unreachable");
    expect(result.receipt?.merchant).toBe("acct_9d2");
    expect(events[0]?.merchant).toBe("acct_9d2");
  });

  it("hands the facilitator the requirements it built the challenge from", async () => {
    const g = gate();
    await g.handle(paid());
    const call = facilitator.calls[0];
    expect(call?.ctx.requirements).toMatchObject({
      amount: 4_000n,
      payTo: "0xmerchant",
      network: "base-sepolia",
      route: "/v1/report",
    });
    expect(call?.ctx.scheme.maxAmountRequired).toBe("4000");
    expect(call?.ctx.signal.aborted).toBe(false);
  });

  it("re-binds the requirements nonce to the one the payer echoed", async () => {
    const g = gate();
    await g.handle(paid(mockPayment({ payload: { nonce: "nonce-from-challenge" } })));
    expect(facilitator.calls[0]?.ctx.requirements.nonce).toBe("nonce-from-challenge");
  });

  it("accepts an overpayment", async () => {
    const g = gate();
    const result = await g.handle(paid(mockPayment({ amount: "9000" })));
    if (result.type !== "pass") throw new Error("unreachable");
    expect(result.receipt?.amount).toBe("9000");
  });

  it("reports served and failed outcomes after the handler runs", async () => {
    const g = gate();
    const ok = await g.handle(paid());
    if (ok.type !== "pass") throw new Error("unreachable");
    ok.report({ status: 200, latencyMs: 42 });

    const broken = await g.handle(paid(mockPayment({ txRef: "0xtx-2" })));
    if (broken.type !== "pass") throw new Error("unreachable");
    broken.report({ status: 500, latencyMs: 7 });
    await g.flushEvents();

    expect(events.map((e) => e.type)).toEqual([
      "toll.settled",
      "request.served",
      "toll.settled",
      "request.failed",
    ]);
    expect(events[1]?.data).toEqual({
      receipt_id: ok.receiptId,
      latency_ms: 42,
      status: 200,
    });
    expect(events[3]?.data).toEqual({
      receipt_id: broken.receiptId,
      status: 500,
      latency_ms: 7,
    });
  });

  it("reports at most once per request", async () => {
    const g = gate();
    const result = await g.handle(paid());
    if (result.type !== "pass") throw new Error("unreachable");
    result.report({ status: 200 });
    result.report({ status: 500 });
    await g.flushEvents();
    expect(events.filter((e) => e.type.startsWith("request.")).map((e) => e.type)).toEqual([
      "request.served",
    ]);
  });
});

describe("rejections", () => {
  async function rejectionOf(req: GateRequest, options: Partial<GateOptions> = {}) {
    const g = gate(options);
    const result = await g.handle(req);
    await g.flushEvents();
    if (result.type === "pass") throw new Error("expected a rejection");
    return { result, body: result.body as ChallengeBody };
  }

  it("rejects a malformed payment header", async () => {
    const { result, body } = await rejectionOf(request({ headers: { "x-payment": "not-base64!" } }));
    expect(result.status).toBe(402);
    expect(result.code).toBe("invalid_payment");
    expect(body.error).toBe("invalid_payment");
    expect(body.errorDetail.doc).toBe("https://octroi.ai/docs/errors#invalid_payment");
    // Re-advertised so the agent can retry immediately.
    expect(body.accepts).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["toll.rejected"]);
  });

  it("rejects a payment on an unconfigured network", async () => {
    const { result } = await rejectionOf(paid(mockPayment({ network: "solana" })));
    expect(result.code).toBe("wrong_network");
    expect(facilitator.calls).toHaveLength(0);
  });

  it("rejects an underpayment", async () => {
    const { result } = await rejectionOf(paid(mockPayment({ amount: "3999" })));
    expect(result.code).toBe("wrong_amount");
    expect(events[0]?.data).toMatchObject({ code: "wrong_amount" });
  });

  it("rejects a payload whose authorization has already lapsed", async () => {
    const expired = mockPayment({
      payload: { authorization: { validBefore: String(Math.floor(NOW / 1_000) - 1) } },
    });
    const { result } = await rejectionOf(paid(expired));
    expect(result.code).toBe("expired");
    expect(facilitator.calls).toHaveLength(0);
  });

  it("passes facilitator rejection codes straight through", async () => {
    facilitator = createMockFacilitator({
      networks: ["base-sepolia"],
      verify: () => ({ ok: false, code: "invalid_payment", message: "bad signature" }),
    });
    const { result, body } = await rejectionOf(paid());
    expect(result.code).toBe("invalid_payment");
    expect(body.errorDetail.message).toBe("bad signature");
    expect(events[0]?.data).toMatchObject({ code: "invalid_payment", facilitator: "mock" });
  });

  it("does not count a re-challenge as a new challenge.issued", async () => {
    await rejectionOf(paid(mockPayment({ amount: "1" })));
    expect(events.map((e) => e.type)).toEqual(["toll.rejected"]);
  });
});

describe("replay protection", () => {
  it("rejects the same payment payload twice", async () => {
    const g = gate();
    const payment = mockPayment();

    const first = await g.handle(paid(payment));
    expect(first.type).toBe("pass");

    const second = await g.handle(paid(payment));
    await g.flushEvents();
    if (second.type === "pass") throw new Error("replay was accepted");
    expect(second.code).toBe("replay");
    expect(second.status).toBe(402);
    expect(events.map((e) => e.type)).toEqual(["toll.settled", "toll.rejected"]);
    // The facilitator is not called a second time.
    expect(facilitator.calls).toHaveLength(1);
  });

  it("rejects a re-wrapped payload that settles the same transaction", async () => {
    const g = gate();
    await g.handle(paid(mockPayment({ payload: { pad: "a" } })));
    const second = await g.handle(paid(mockPayment({ payload: { pad: "b" } })));
    if (second.type === "pass") throw new Error("tx replay was accepted");
    expect(second.code).toBe("replay");
    expect(facilitator.calls).toHaveLength(2);
  });

  it("keeps a failed payment retriable", async () => {
    let attempt = 0;
    facilitator = createMockFacilitator({
      networks: ["base-sepolia"],
      verify: () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, code: "invalid_payment" }
          : { ok: true, txRef: "0xtx-1", payer: "0xpayer-1", settledAmount: "4000" };
      },
    });
    const g = gate();
    const payment = mockPayment();

    const first = await g.handle(paid(payment));
    expect(first.type).toBe("reject");
    const second = await g.handle(paid(payment));
    expect(second.type).toBe("pass");
  });

  it("distinguishes payloads that differ only in key order", async () => {
    const g = gate();
    await g.handle(paid(mockPayment({ payload: { a: 1, b: 2 } })));
    const reordered = mockPayment({ txRef: "0xtx-9", payload: { b: 2, a: 1 } });
    const second = await g.handle(paid(reordered));
    // Same canonical payload shape but a different txRef: not a replay of the
    // payload, and the tx key is fresh too.
    expect(second.type).toBe("pass");
  });
});

describe("facilitator outages", () => {
  beforeEach(() => {
    facilitator = createMockFacilitator({ networks: ["base-sepolia"], unreachable: true });
  });

  it("fails closed with a 503 by default", async () => {
    const g = gate();
    const result = await g.handle(paid());
    await g.flushEvents();

    if (result.type === "pass") throw new Error("fail_closed served the request");
    expect(result.status).toBe(503);
    expect(result.code).toBe("facilitator_unreachable");
    expect(result.headers["retry-after"]).toBe("5");
    expect(events.map((e) => e.type)).toEqual(["gate.error"]);
    expect(events[0]?.data).toMatchObject({
      code: "facilitator_unreachable",
      facilitator: "mock",
      mode: "fail_closed",
    });
  });

  it("serves without a receipt when the merchant opted into fail_open", async () => {
    const g = gate({ mode: "fail_open" });
    const result = await g.handle(paid());
    if (result.type !== "pass") throw new Error("fail_open rejected the request");
    expect(result.receipt).toBeNull();
    expect(result.headers[RECEIPT_HEADER]).toBeUndefined();

    result.report({ status: 200, latencyMs: 3 });
    await g.flushEvents();
    expect(events.map((e) => e.type)).toEqual(["gate.error", "request.served"]);
    expect(events[0]?.data).toMatchObject({ mode: "fail_open" });
    expect(events[1]?.data).toMatchObject({ receipt_id: null });
  });

  it("treats a slow facilitator as unreachable", async () => {
    facilitator = createMockFacilitator({ networks: ["base-sepolia"], latencyMs: 50 });
    const g = gate({ verifyTimeoutMs: 5, clock: () => NOW });
    const result = await g.handle(paid());
    await g.flushEvents();

    if (result.type === "pass") throw new Error("timeout served the request");
    expect(result.status).toBe(503);
    expect(events[0]?.data).toMatchObject({ code: "facilitator_unreachable" });
    expect(facilitator.calls[0]?.ctx.signal.aborted).toBe(true);
  });
});

describe("configuration", () => {
  it("rejects a mistyped static price at construction", () => {
    expect(() => gate({ price: "4 dollars" })).toThrow(/could not parse price/);
  });

  it("requires a settlement address", () => {
    expect(() => gate({ payTo: "  " })).toThrow(/payTo/);
  });

  it("requires a facilitator that covers every configured network", () => {
    expect(() => gate({ network: ["base-sepolia", "solana"] })).toThrow(
      /no configured facilitator supports network "solana"/,
    );
  });

  it("rejects an unknown facilitator id", () => {
    expect(() => gate({ facilitator: "coinbase" })).toThrow(/unknown facilitator "coinbase"/);
  });

  it("refuses to forget a payment before its challenge window closes", () => {
    // Otherwise a payload replayed after LRU/TTL eviction but before expiry
    // would sail through.
    expect(() => gate({ expirySeconds: 120, replayTtlMs: 119_000 })).toThrow(
      /replayTtlMs \(119000\) must be at least the challenge window/,
    );
    expect(() => gate({ expirySeconds: 120, replayTtlMs: 120_000 })).not.toThrow();
    // The defaults satisfy the relationship exactly at the boundary: a 900s
    // window is the longest the default 15m TTL covers.
    expect(() => gate()).not.toThrow();
    expect(() => gate({ expirySeconds: 900 })).not.toThrow();
    expect(() => gate({ expirySeconds: 901 })).toThrow(/at least the challenge window/);
  });

  it("honours the relationship at runtime, not just at boot", async () => {
    let now = NOW;
    const g = gate({
      expirySeconds: 60,
      replayTtlMs: 60_000,
      clock: () => now,
      nonceStore: new MemoryNonceStore({ clock: () => now }),
    });
    const payment = mockPayment();

    expect((await g.handle(paid(payment))).type).toBe("pass");

    // One second before the challenge would have expired: still remembered.
    now = NOW + 59_000;
    const replayed = await g.handle(paid(payment));
    if (replayed.type === "pass") throw new Error("replay was accepted inside the window");
    expect(replayed.code).toBe("replay");
  });

  it("routes each network to the adapter that supports it", async () => {
    const base = createMockFacilitator({ id: "coinbase-ish", networks: ["base"] });
    const solana = createMockFacilitator({ id: "payai-ish", networks: ["solana"] });
    const g = gate({ network: ["base", "solana"], facilitator: [base, solana] });

    const result = await g.handle(paid(mockPayment({ network: "solana" })));
    expect(result.type).toBe("pass");
    expect(solana.calls).toHaveLength(1);
    expect(base.calls).toHaveLength(0);
  });
});
