import { describe, expect, it } from "vitest";
import { PaymentRequirementsSchema, SettleResponseSchema, VerifyResponseSchema } from "x402/types";
import { createGate, silentLogger } from "@tollway/core";
import { encodePaymentHeader } from "@tollway/core/testing";
import type { ChallengeRequest, PaymentPayload, VerifyContext } from "@tollway/core";
import { coinbaseFacilitator } from "../src/index.js";
import { NETWORKS } from "../src/networks.js";
import { exchange, failingFetch, hangingFetch, replayFetch } from "./replay.js";

const requirements: ChallengeRequest = {
  route: "/v1/report",
  resource: "https://api.example.com/v1/report",
  description: "Access to /v1/report",
  mimeType: "application/json",
  network: "base-sepolia",
  asset: "usdc",
  amount: 4_000n,
  payTo: `0x${"1".repeat(40)}`,
  nonce: "nonce-1",
  expiresAt: 1_765_432_220,
  maxTimeoutSeconds: 120,
};

const payment: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: `0x${"ab".repeat(65)}`,
    authorization: {
      from: "0x9f4c8a3b2d1e0f5a6b7c8d9e0f1a2b3c4d5e6f70",
      to: `0x${"1".repeat(40)}`,
      value: "4000",
      validAfter: "0",
      validBefore: "1765432220",
      nonce: `0x${"cd".repeat(32)}`,
    },
  },
};

function context(adapter = coinbaseFacilitator()): VerifyContext {
  return {
    scheme: adapter.buildChallenge(requirements),
    requirements,
    route: requirements.route,
    now: 1_765_432_100_000,
    signal: new AbortController().signal,
    logger: silentLogger,
  };
}

describe("fixtures", () => {
  // If these drift from the reference schemas the fixtures are lying, and
  // every test below is worthless.
  it("a recorded fixture is exempt — reality outranks the schema", () => {
    // The live facilitator sends `invalidReason: "unexpected_error"`, which is
    // not in the enum. If we forced recorded fixtures to validate, we would be
    // asserting that the real world is wrong.
    const recorded = exchange("verify.garbagePayload");
    expect(() => VerifyResponseSchema.parse(recorded.response.body)).toThrow();
  });

  it("verify fixtures match the reference VerifyResponse schema", () => {
    for (const name of [
      "verify.ok",
      "verify.badSignature",
      "verify.expired",
      "verify.insufficientFunds",
      "verify.wrongNetwork",
      "verify.underpaid",
      "verify.facilitatorFault",
    ]) {
      expect(() => VerifyResponseSchema.parse(exchange(name).response.body), name).not.toThrow();
    }
  });

  it("settle fixtures match the reference SettleResponse schema", () => {
    for (const name of ["settle.ok", "settle.duplicate", "settle.fault"]) {
      expect(() => SettleResponseSchema.parse(exchange(name).response.body), name).not.toThrow();
    }
  });
});

describe("buildChallenge", () => {
  it("advertises the real USDC address and EIP-712 domain per network", () => {
    const adapter = coinbaseFacilitator();

    const sepolia = adapter.buildChallenge(requirements);
    expect(sepolia.asset).toBe(NETWORKS["base-sepolia"]?.assets["usdc"]?.address);
    expect(sepolia.extra).toEqual({ name: "USDC", version: "2" });

    const mainnet = adapter.buildChallenge({ ...requirements, network: "base" });
    expect(mainnet.asset).toBe(NETWORKS["base"]?.assets["usdc"]?.address);
    // Mainnet USDC signs under "USD Coin"; testnet under "USDC". Getting this
    // wrong produces signatures that fail with no useful error.
    expect(mainnet.extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("produces a scheme the reference client can parse", () => {
    const scheme = coinbaseFacilitator().buildChallenge(requirements);
    expect(() => PaymentRequirementsSchema.parse(scheme)).not.toThrow();
  });

  it("refuses networks and assets it has no facts for", () => {
    const adapter = coinbaseFacilitator();
    expect(() => adapter.buildChallenge({ ...requirements, network: "solana" })).toThrow(
      /does not support network "solana"/,
    );
    expect(() => adapter.buildChallenge({ ...requirements, asset: "doge" })).toThrow(
      /no address for asset "doge"/,
    );
  });
});

describe("verify", () => {
  it("verifies then settles, and reports the settlement transaction", async () => {
    const replay = replayFetch(["verify.ok", "settle.ok"]);
    const adapter = coinbaseFacilitator({ fetchImpl: replay.fetch });
    const result = await adapter.verify(payment, context(adapter));

    expect(result).toMatchObject({
      ok: true,
      txRef: "0x5a3f8c1e9b2d7a4f6c0e8b1d3a5f7c9e2b4d6a8f0c2e4b6d8a0f2c4e6b8d0a2f",
      payer: "0x9f4c8a3b2d1e0f5a6b7c8d9e0f1a2b3c4d5e6f70",
      settledAmount: 4_000n,
    });

    expect(replay.calls.map((c) => c.url)).toEqual([
      "https://x402.org/facilitator/verify",
      "https://x402.org/facilitator/settle",
    ]);
    // The wire body is the reference contract, not our own shape.
    expect(replay.calls[0]?.body).toMatchObject({
      x402Version: 1,
      paymentPayload: payment,
    });
    expect(() =>
      PaymentRequirementsSchema.parse(replay.calls[0]?.body.paymentRequirements),
    ).not.toThrow();
  });

  it("does not settle when verification fails", async () => {
    const replay = replayFetch(["verify.badSignature"]);
    const adapter = coinbaseFacilitator({ fetchImpl: replay.fetch });
    const result = await adapter.verify(payment, context(adapter));

    expect(result).toMatchObject({ ok: false, code: "invalid_payment" });
    expect(replay.calls).toHaveLength(1);
  });

  it("handles the real facilitator's out-of-enum crash response", async () => {
    // Recorded live: HTTP 500, isValid:false, invalidReason "unexpected_error"
    // — a string x402@1.2.0's enum does not contain. It must be a rejection,
    // not an outage: the payload that provoked it is attacker-controlled.
    const adapter = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.garbagePayload"]).fetch,
    });
    const result = await adapter.verify(payment, context(adapter));
    expect(result).toMatchObject({ ok: false, code: "invalid_payment" });
    if (!result.ok) expect(result.message).toMatch(/unexpected_error/);
  });

  it("maps facilitator reasons onto Tollway reject codes", async () => {
    const cases: Array<[string, string]> = [
      ["verify.expired", "expired"],
      ["verify.insufficientFunds", "invalid_payment"],
      ["verify.wrongNetwork", "wrong_network"],
      ["verify.underpaid", "wrong_amount"],
    ];

    for (const [fixture, expected] of cases) {
      const adapter = coinbaseFacilitator({ fetchImpl: replayFetch([fixture]).fetch });
      const result = await adapter.verify(payment, context(adapter));
      expect(result.ok, fixture).toBe(false);
      if (!result.ok) expect(result.code, fixture).toBe(expected);
    }
  });

  it("reports a duplicate settlement as a replay", async () => {
    const adapter = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.ok", "settle.duplicate"]).fetch,
    });
    const result = await adapter.verify(payment, context(adapter));
    expect(result).toMatchObject({ ok: false, code: "replay" });
  });

  it("skips settlement when the merchant opted out", async () => {
    const replay = replayFetch(["verify.ok"]);
    const adapter = coinbaseFacilitator({ fetchImpl: replay.fetch, settle: false });
    const result = await adapter.verify(payment, context(adapter));

    expect(result.ok).toBe(true);
    expect(replay.calls).toHaveLength(1);
    if (result.ok) expect(result.txRef).toBe("unsettled:base-sepolia");
  });

  it("sends auth headers to the right endpoint", async () => {
    const replay = replayFetch(["verify.ok", "settle.ok"]);
    const adapter = coinbaseFacilitator({
      fetchImpl: replay.fetch,
      url: "https://api.cdp.coinbase.com/platform/v2/x402",
      createAuthHeaders: () => ({
        verify: { authorization: "Bearer verify-jwt" },
        settle: { authorization: "Bearer settle-jwt" },
      }),
    });
    await adapter.verify(payment, context(adapter));

    expect(replay.calls[0]?.headers["authorization"]).toBe("Bearer verify-jwt");
    expect(replay.calls[1]?.headers["authorization"]).toBe("Bearer settle-jwt");
  });
});

describe("outages are not rejections", () => {
  // A payer must never be told their payment is bad because our facilitator
  // is down — that decision belongs to the merchant's fail_open/fail_closed.
  it("treats a non-JSON gateway page as unreachable", async () => {
    const adapter = coinbaseFacilitator({ fetchImpl: replayFetch(["gateway.502"]).fetch });
    await expect(adapter.verify(payment, context(adapter))).rejects.toThrow(
      /non-JSON body \(status 502\)/,
    );
  });

  it("treats a JSON body with no verdict as unreachable", async () => {
    const adapter = coinbaseFacilitator({ fetchImpl: replayFetch(["gateway.rateLimited"]).fetch });
    await expect(adapter.verify(payment, context(adapter))).rejects.toThrow(
      /unrecognised body \(status 429\)/,
    );
  });

  it("treats a transport failure as unreachable", async () => {
    const adapter = coinbaseFacilitator({ fetchImpl: failingFetch() });
    await expect(adapter.verify(payment, context(adapter))).rejects.toThrow(/ENOTFOUND/);
  });

  it("treats a settle-stage relayer/broadcast failure as unreachable, not invalid_payment", async () => {
    // Observed live: a verified payment failed at on-chain broadcast because
    // the facilitator relayer had a stale nonce. That is the facilitator's
    // infrastructure, not a bad payment — reporting invalid_payment to the
    // payer would be a lie. It must escalate so the merchant's mode decides.
    const adapter = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.ok", "settle.relayerNonce"]).fetch,
    });
    await expect(adapter.verify(payment, context(adapter))).rejects.toThrow(/nonce too low/);
  });

  it("still reports a duplicate settlement as a payment-level replay, not a fault", async () => {
    const adapter = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.ok", "settle.duplicate"]).fetch,
    });
    const result = await adapter.verify(payment, context(adapter));
    expect(result).toMatchObject({ ok: false, code: "replay" });
  });

  it("treats settle-stage faults as unreachable — money may have moved", async () => {
    const settleFault = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.ok", "settle.fault"]).fetch,
    });
    await expect(settleFault.verify(payment, context(settleFault))).rejects.toThrow(
      /unexpected_settle_error/,
    );
  });

  it("a verify-stage 'unexpected error' is a REJECTION, or fail_open is a bypass", async () => {
    // The payload is attacker-controlled input. If a payload that crashes the
    // facilitator's verify counted as an outage, any merchant running
    // fail_open would serve it for free. A verdict-shaped response is a
    // verdict, whatever the reason string says.
    const verifyFault = coinbaseFacilitator({
      fetchImpl: replayFetch(["verify.facilitatorFault"]).fetch,
    });
    const result = await verifyFault.verify(payment, context(verifyFault));
    expect(result).toMatchObject({ ok: false, code: "invalid_payment" });
  });

  it("fail_open cannot be bought with a crafted payload", async () => {
    // The full exploit path, end to end: a fail_open gate must still 402 a
    // payload that provokes unexpected_verify_error, because the facilitator
    // did answer — only a genuine outage may open the gate.
    const gate = createGate({
      price: "$0.004",
      asset: "usdc",
      network: "base-sepolia",
      payTo: `0x${"1".repeat(40)}`,
      mode: "fail_open",
      resourceBase: "https://api.example.com",
      facilitator: coinbaseFacilitator({
        fetchImpl: replayFetch(["verify.facilitatorFault"]).fetch,
      }),
    });

    const result = await gate.handle({
      method: "GET",
      route: "/v1/report",
      headers: { "x-payment": encodePaymentHeader(payment) },
    });

    expect(result.type).toBe("reject");
    if (result.type === "pass") throw new Error("fail_open served a crafted payload for free");
    expect(result.status).toBe(402);
  });

  it("times out rather than hanging the request", async () => {
    const adapter = coinbaseFacilitator({ fetchImpl: hangingFetch(), timeoutMs: 20 });
    await expect(adapter.verify(payment, context(adapter))).rejects.toThrow(/call failed/);
  });

  it("gives up immediately when the gate's signal is already aborted", async () => {
    const adapter = coinbaseFacilitator({ fetchImpl: hangingFetch() });
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.verify(payment, { ...context(adapter), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
