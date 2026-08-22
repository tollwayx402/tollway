/**
 * The whole loop, for real: an Express route behind a gate → the ingest client
 * → this service → the dashboard's numbers.
 *
 * Every layer is the real implementation; only the facilitator is a mock,
 * because settling on-chain is not what this test is about.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { octroi } from "@octroi/express";
import { createIngestClient } from "@octroi/ingest";
import type { OctroiEvent } from "@octroi/core";
import { createMockFacilitator, encodePaymentHeader, mockPayment } from "@octroi/core/testing";
import { createServer, type MerchantAccount } from "../src/server.js";
import { EventStore } from "../src/store.js";

let dir: string;
let cloud: Server;
let merchantApp: Server;
let cloudUrl: string;
let merchantUrl: string;
let ingest: ReturnType<typeof createIngestClient>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "octroi-roundtrip-"));

  const keys = new Map<string, MerchantAccount>([["sk_test", { merchant: "acct_9d2" }]]);
  const app = createServer({ store: new EventStore(dir), keys });
  cloud = await new Promise<Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;

  ingest = createIngestClient({
    apiKey: "sk_test",
    url: cloudUrl,
    // Flush on demand so the test never sleeps.
    flushIntervalMs: 60_000,
    maxBatchSize: 1_000,
  });

  const merchant = express();
  merchant.use(
    "/v1/report",
    octroi({
      price: "$0.004",
      network: "base-sepolia",
      payTo: "0xmerchant",
      facilitator: createMockFacilitator({ networks: ["base-sepolia"] }),
      merchant: "acct_9d2",
      sinks: [ingest.sink],
    }),
  );
  merchant.get("/v1/report", (req, res) => {
    if (req.query["boom"] === "1") {
      res.status(500).json({ error: "upstream exploded" });
      return;
    }
    res.json({ report: "paid content" });
  });

  merchantApp = await new Promise<Server>((resolve) => {
    const created = merchant.listen(0, "127.0.0.1", () => resolve(created));
  });
  merchantUrl = `http://127.0.0.1:${(merchantApp.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await ingest.close();
  for (const server of [cloud, merchantApp]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

const dashboard = async () =>
  (await fetch(`${cloudUrl}/v1/dashboard`, { headers: { authorization: "Bearer sk_test" } })).json();

describe("gate → ingest client → cloud → dashboard", () => {
  it("a paid request shows up as revenue", async () => {
    const response = await fetch(`${merchantUrl}/v1/report`, {
      headers: { "x-payment": encodePaymentHeader(mockPayment()) },
    });
    expect(response.status).toBe(200);

    await ingest.flush();
    const d = await dashboard();

    expect(d.rejects.settled).toBe(1);
    expect(d.revenueByRouteDay).toHaveLength(1);
    expect(d.revenueByRouteDay[0]).toMatchObject({ route: "/v1/report", revenue: "4000", tolls: 1 });
    expect(d.receipts[0]).toMatchObject({ route: "/v1/report", amount: "4000", merchant: "acct_9d2" });
    expect(d.tollsByPayer[0]).toMatchObject({ payer: "0xpayer-1", tolls: 1 });
  });

  it("a paid request that then 500s becomes a refund candidate (§8)", async () => {
    const response = await fetch(`${merchantUrl}/v1/report?boom=1`, {
      headers: { "x-payment": encodePaymentHeader(mockPayment()) },
    });
    expect(response.status).toBe(500);

    await ingest.flush();
    const d = await dashboard();

    expect(d.refundCandidates).toHaveLength(1);
    expect(d.refundCandidates[0]).toMatchObject({ status: 500, amount: "4000", refunded: false });

    // And it can be marked refunded from the dashboard's own endpoint.
    const marked = await fetch(`${cloudUrl}/v1/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk_test" },
      body: JSON.stringify({ receipt_id: d.refundCandidates[0].receipt_id }),
    });
    expect(marked.status).toBe(201);
    expect((await dashboard()).refundCandidates[0].refunded).toBe(true);
  });

  it("an unpaid request produces a challenge but no revenue", async () => {
    await fetch(`${merchantUrl}/v1/report`);
    await ingest.flush();

    const d = await dashboard();
    expect(d.events).toBe(1);
    expect(d.rejects.settled).toBe(0);
    expect(d.revenueByRouteDay).toHaveLength(0);
  });

  it("a replayed payment is one sale and one reject, not two sales", async () => {
    const header = encodePaymentHeader(mockPayment());
    await fetch(`${merchantUrl}/v1/report`, { headers: { "x-payment": header } });
    await fetch(`${merchantUrl}/v1/report`, { headers: { "x-payment": header } });

    await ingest.flush();
    const d = await dashboard();

    expect(d.rejects).toMatchObject({ settled: 1, rejected: 1, rate: 0.5 });
    expect(d.rejects.byCode).toEqual({ replay: 1 });
    expect(d.revenueByRouteDay[0].revenue).toBe("4000");
  });

  it("a resent batch does not double the revenue", async () => {
    await fetch(`${merchantUrl}/v1/report`, {
      headers: { "x-payment": encodePaymentHeader(mockPayment()) },
    });
    await ingest.flush();

    const before = await dashboard();
    expect(before.rejects.settled).toBe(1);

    // The at-least-once path: after an ambiguous failure the client resends the
    // batch with the *same* event ids. Idempotency by id is what stops a
    // network hiccup from inventing revenue.
    const logged = readFileSync(join(dir, "acct_9d2.events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as OctroiEvent);
    expect(logged.length).toBeGreaterThan(0);

    const resent = createIngestClient({ apiKey: "sk_test", url: cloudUrl, flushIntervalMs: 60_000 });
    for (const event of logged) resent.sink(event);
    await resent.flush();
    await resent.close();

    const after = await dashboard();
    expect(after.rejects.settled).toBe(1);
    expect(after.revenueByRouteDay[0].revenue).toBe("4000");
  });
});
