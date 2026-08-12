/**
 * Interop against the reference implementation (`x402@1.2.0`).
 *
 * The party parsing our 402 is the agent's client library, so "it passes our
 * tests" proves nothing about whether an agent can actually pay us. These tests
 * validate our bodies with the reference project's own zod schemas.
 *
 * Two bugs were found this way and are pinned below: `error` is a closed enum
 * rather than free text, and `resource` must be an absolute URL.
 */
import { describe, expect, it } from "vitest";
import { PaymentRequirementsSchema, x402ResponseSchema } from "x402/types";
import { X402_ERROR_REASONS, createGate } from "../src/index.js";
import type { ChallengeBody, GateOptions, GateRequest } from "../src/index.js";
import { createMockFacilitator, encodePaymentHeader, mockPayment } from "../src/testing.js";

const PAY_TO = `0x${"1".repeat(40)}`;
const ASSET = `0x${"2".repeat(40)}`;

function gate(overrides: Partial<GateOptions> = {}) {
  return createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: PAY_TO,
    facilitator: createMockFacilitator({ networks: ["base-sepolia"], assetAddress: ASSET }),
    ...overrides,
  });
}

const REQUEST: GateRequest = {
  method: "GET",
  route: "/v1/report",
  url: "https://api.example.com/v1/report",
  headers: {},
};

async function bodyOf(req: GateRequest, options: Partial<GateOptions> = {}) {
  const result = await gate(options).handle(req);
  if (result.type === "pass") throw new Error("expected a halt");
  return { result, body: result.body as ChallengeBody };
}

describe("x402 interop", () => {
  it("every advertised scheme validates as PaymentRequirements", async () => {
    const { body } = await bodyOf(REQUEST);
    for (const scheme of body.accepts) {
      expect(() => PaymentRequirementsSchema.parse(scheme)).not.toThrow();
    }
  });

  it("the whole 402 body validates as an x402Response", async () => {
    const { body } = await bodyOf(REQUEST);
    expect(() => x402ResponseSchema.parse(body)).not.toThrow();
  });

  it("rejection bodies validate too, with a mapped enum reason", async () => {
    const cases: Array<[GateRequest, string]> = [
      [{ ...REQUEST, headers: { "x-payment": "not-base64!" } }, "invalid_payment"],
      [
        {
          ...REQUEST,
          headers: { "x-payment": encodePaymentHeader(mockPayment({ network: "solana" })) },
        },
        "invalid_network",
      ],
      [
        {
          ...REQUEST,
          headers: { "x-payment": encodePaymentHeader(mockPayment({ amount: "1" })) },
        },
        "invalid_payment",
      ],
    ];

    for (const [req, expectedReason] of cases) {
      const { body } = await bodyOf(req);
      expect(() => x402ResponseSchema.parse(body)).not.toThrow();
      expect(body.error).toBe(expectedReason);
      // Our precise code survives in the envelope alongside the coarse enum.
      expect(body.errorDetail.code).toBeTruthy();
    }
  });

  it("replay maps onto the reason the spec already has for it", async () => {
    const g = gate();
    const payment = mockPayment();
    const header = encodePaymentHeader(payment);
    await g.handle({ ...REQUEST, headers: { "x-payment": header } });
    const replayed = await g.handle({ ...REQUEST, headers: { "x-payment": header } });
    if (replayed.type === "pass") throw new Error("replay accepted");

    const body = replayed.body as ChallengeBody;
    expect(body.error).toBe("duplicate_settlement");
    expect(body.errorDetail.code).toBe("replay");
    expect(() => x402ResponseSchema.parse(body)).not.toThrow();
  });

  it("every mapped reason is a value the reference schema accepts", () => {
    // Guards against inventing a plausible-looking reason that is not in the
    // enum — the exact mistake this file exists to catch.
    for (const reason of Object.values(X402_ERROR_REASONS)) {
      expect(() =>
        x402ResponseSchema.parse({ x402Version: 1, accepts: [], error: reason }),
      ).not.toThrow();
    }
  });

  it("refuses to emit a challenge with a non-absolute resource", async () => {
    // x402 validates `resource` as a URL. A bare path used to sail through here
    // and fail inside the agent's client, where we would never see it.
    const { result } = await bodyOf({ ...REQUEST, url: undefined });
    expect(result.status).toBe(500);
    expect(result.code).toBe("invalid_resource");
  });

  it("absolutizes a path against resourceBase", async () => {
    const { body } = await bodyOf(
      { ...REQUEST, url: undefined },
      { resourceBase: "https://api.example.com" },
    );
    expect(body.accepts[0]?.resource).toBe("https://api.example.com/v1/report");
    expect(() => PaymentRequirementsSchema.parse(body.accepts[0])).not.toThrow();
  });

  it("only advertises networks the reference client recognises", async () => {
    // `network` is a closed enum client-side; a custom id makes the whole
    // scheme unparseable for the agent, not just unknown.
    const { body } = await bodyOf(REQUEST);
    for (const scheme of body.accepts) {
      expect(() => PaymentRequirementsSchema.parse(scheme)).not.toThrow();
    }
    const custom = await bodyOf(REQUEST, {
      network: "my-l2",
      facilitator: createMockFacilitator({ networks: ["my-l2"], assetAddress: ASSET }),
    });
    expect(() => PaymentRequirementsSchema.parse(custom.body.accepts[0])).toThrow();
  });
});
