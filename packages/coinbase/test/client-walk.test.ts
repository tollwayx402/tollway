/**
 * The interop test: the **official** x402 client walks 402 → pay → 200 against
 * a real HTTP server running our gate and our adapter's challenges.
 *
 * No funds and no network are required. The client signs an EIP-3009
 * authorization with a throwaway local key — signing is free — and the
 * facilitator is replayed from fixtures. What this proves is the part we
 * cannot prove alone: that an agent using the reference library can actually
 * parse our challenge, produce a payment for it, and be served.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePaymentHeader, createGate, RECEIPT_HEADER, verifyReceipt } from "@tollway/core";
import type { Gate } from "@tollway/core";
import { coinbaseFacilitator } from "../src/index.js";
import { routedFetch } from "./replay.js";
import { agentFetch, capturePaymentHeader } from "../dev/agent.js";

// Throwaway key. Never funded, never used for anything real — the client only
// needs it to produce a signature.
const AGENT_KEY = `0x${"7".repeat(64)}` as const;

let server: Server;
let baseUrl: string;
let gate: Gate;
let facilitatorCalls: () => number;
let lastReceiptId: string | null = null;

beforeAll(async () => {
  // Answers per path rather than from a queue: this server may be paid
  // several times across the tests below.
  const replay = routedFetch({ verify: "verify.ok", settle: "settle.ok" });
  facilitatorCalls = () => replay.calls.length;

  gate = createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: `0x${"1".repeat(40)}`,
    facilitator: coinbaseFacilitator({ fetchImpl: replay.fetch }),
  });

  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const result = await gate.handle({
        method: req.method ?? "GET",
        route: url.pathname,
        url: url.toString(),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });

      if (result.type !== "pass") {
        res.writeHead(result.status, result.headers);
        res.end(JSON.stringify(result.body));
        return;
      }

      lastReceiptId = result.receiptId;
      res.writeHead(200, { ...result.headers, "content-type": "application/json" });
      res.end(JSON.stringify({ report: "the paid content" }));
      result.report({ status: 200 });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("reference client interop", () => {
  it("an unpaid request gets a 402 the reference client can act on", async () => {
    const response = await fetch(`${baseUrl}/v1/report`);
    expect(response.status).toBe(402);

    const body = (await response.json()) as { accepts: unknown[]; error?: string };
    expect(body.accepts).toHaveLength(1);
    // Nothing here should make the client's zod parse throw.
    expect(body.error).toBeUndefined();
  });

  it("the client pays and is served, and our receipt is on the response", async () => {
    const response = await agentFetch(AGENT_KEY).fetch(`${baseUrl}/v1/report`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: "the paid content" });

    const receiptId = response.headers.get(RECEIPT_HEADER);
    expect(receiptId).toMatch(/^twy_rcpt_/);
    expect(receiptId).toBe(lastReceiptId);

    // One verify and one settle for the one payment.
    expect(facilitatorCalls()).toBe(2);
  });

  it("the payment the client produced is one our core can decode", async () => {
    // Rebuild what the client sent, and check our own decoder against it —
    // the header format is the client's, not ours.
    const challenge = await (await fetch(`${baseUrl}/v1/report`)).json();
    const captured = await capturePaymentHeader(AGENT_KEY, `${baseUrl}/v1/report`, challenge);
    const decoded = decodePaymentHeader(captured);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("base-sepolia");
    // The authorization is signed over the domain our adapter advertised.
    const authorization = decoded.payload["authorization"] as Record<string, string>;
    expect(authorization["to"]).toBe(challenge.accepts[0].payTo);
    expect(authorization["value"]).toBe("4000");
    expect(decoded.payload["signature"]).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("issues a receipt that verifies under the gate's own key", async () => {
    const replay = routedFetch({ verify: "verify.ok", settle: "settle.ok" });
    const standalone = createGate({
      price: "$0.004",
      asset: "usdc",
      network: "base-sepolia",
      payTo: `0x${"1".repeat(40)}`,
      facilitator: coinbaseFacilitator({ fetchImpl: replay.fetch }),
      resourceBase: "https://api.example.com",
    });

    const challenge = await (await fetch(`${baseUrl}/v1/report`)).json();
    const captured = await capturePaymentHeader(AGENT_KEY, `${baseUrl}/v1/report`, challenge);

    const result = await standalone.handle({
      method: "GET",
      route: "/v1/report",
      headers: { "x-payment": captured },
    });

    expect(result.type).toBe("pass");
    if (result.type !== "pass" || !result.receipt) throw new Error("no receipt");
    await expect(verifyReceipt(result.receipt, await standalone.publicKey())).resolves.toBe(true);
    // The payer on a receipt is whoever the *facilitator* says paid, which
    // here is the fixture's payer. Binding payer to the signing account is a
    // live-run assertion — see scripts/e2e-testnet.ts.
    expect(result.receipt.payer).toBe("0x9f4c8a3b2d1e0f5a6b7c8d9e0f1a2b3c4d5e6f70");
    expect(agentFetch(AGENT_KEY).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
