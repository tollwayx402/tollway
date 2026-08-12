/**
 * The §11 cross-language golden case.
 *
 * Every input is fixed — clock, nonce, ids, signing key, facilitator — so the
 * output is a pure function of the protocol logic. `tollway` (Python) must
 * reproduce these bytes exactly; see golden/README.md.
 */
import { createGate, createSignerFromJwk, canonicalJson } from "../../src/index.js";
import { createMockFacilitator, encodePaymentHeader, mockPayment } from "../../src/testing.js";
import type { GateRequest } from "../../src/index.js";
import { FIXED_SIGNING_JWK } from "./keys.js";

export const GOLDEN_CLOCK_MS = 1_765_432_100_000;
export const GOLDEN_NONCE = "9f86d081884c7d659a2feaa0c55ad015";

const REQUEST: GateRequest = {
  method: "GET",
  route: "/v1/report",
  url: "https://api.example.com/v1/report",
  headers: {},
};

const PAYMENT = mockPayment({
  network: "base",
  txRef: "0xdeadbeef",
  payer: "0xabc0000000000000000000000000000000000001",
  amount: "4000",
});

function goldenGate() {
  let receiptCount = 0;
  let eventCount = 0;
  return createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base",
    payTo: "0xmerchant000000000000000000000000000000ff",
    facilitator: createMockFacilitator({
      id: "golden",
      networks: ["base"],
      assetAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    }),
    merchant: "acct_9d2",
    description: "Access to /v1/report",
    mimeType: "application/json",
    clock: () => GOLDEN_CLOCK_MS,
    newNonce: () => GOLDEN_NONCE,
    newId: (prefix) =>
      prefix === "rcpt"
        ? `twy_rcpt_${(++receiptCount).toString().padStart(6, "0")}`
        : `twy_evt_${(++eventCount).toString().padStart(6, "0")}`,
    signer: createSignerFromJwk(FIXED_SIGNING_JWK),
  });
}

/** Canonical JSON of the 402 body for an unpaid request. */
export async function goldenChallenge(): Promise<string> {
  const gate = goldenGate();
  const result = await gate.handle(REQUEST);
  if (result.type !== "challenge") throw new Error(`expected a challenge, got ${result.type}`);
  return canonicalJson(result.body);
}

/** Canonical JSON of the signed receipt for the fixed payment. */
export async function goldenReceipt(): Promise<string> {
  const gate = goldenGate();
  const result = await gate.handle({
    ...REQUEST,
    headers: { "x-payment": encodePaymentHeader(PAYMENT) },
  });
  if (result.type !== "pass") throw new Error(`expected a pass, got ${result.type}`);
  return canonicalJson(result.receipt);
}

/** Canonical JSON of the event stream for one full challenge → settle → serve cycle. */
export async function goldenEvents(): Promise<string> {
  const gate = goldenGate();
  const events: unknown[] = [];
  gate.events.addSink((event) => void events.push(event));

  await gate.handle(REQUEST);
  const paid = await gate.handle({
    ...REQUEST,
    headers: { "x-payment": encodePaymentHeader(PAYMENT) },
  });
  if (paid.type !== "pass") throw new Error(`expected a pass, got ${paid.type}`);
  paid.report({ status: 200, latencyMs: 37 });
  await gate.flushEvents();

  return canonicalJson(events);
}
