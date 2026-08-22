import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { RECEIPT_HEADER, verifyReceipt, type OctroiEvent } from "@octroi/core";
import { createMockFacilitator, encodePaymentHeader, mockPayment } from "@octroi/core/testing";
import { octroi, type OctroiHonoOptions } from "../src/index.js";

function harness(
  options: Partial<OctroiHonoOptions> = {},
  mount: (app: Hono, middleware: ReturnType<typeof octroi>) => void = (app, middleware) => {
    app.use("/v1/report", middleware);
    app.get("/v1/report", (c) => c.json({ report: "paid content" }));
  },
) {
  const events: OctroiEvent[] = [];
  const middleware = octroi({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: "0xmerchant",
    facilitator: createMockFacilitator({ networks: ["base-sepolia"] }),
    onEvent: (event) => void events.push(event),
    ...options,
  });

  const app = new Hono();
  mount(app, middleware);

  return {
    app,
    events,
    gate: middleware.gate,
    flush: () => middleware.gate.flushEvents(),
    // Hono's own test client: a real fetch through the real router.
    request: (path: string, init?: RequestInit) =>
      app.request(`http://api.example.com${path}`, init),
  };
}

const paid = (payment = mockPayment()) => ({
  headers: { "x-payment": encodePaymentHeader(payment) },
});

describe("unpaid requests", () => {
  it("answers 402 with the challenge and never runs the handler", async () => {
    const h = harness();
    const response = await h.request("/v1/report");
    await h.flush();

    expect(response.status).toBe(402);
    const body = (await response.json()) as { accepts: unknown[]; errorDetail: { code: string } };
    expect(body.accepts).toHaveLength(1);
    expect(body.errorDetail.code).toBe("payment_required");
    expect(h.events.map((e) => e.type)).toEqual(["challenge.issued"]);
  });

  it("gets an absolute resource without any resourceBase configuration", async () => {
    // Hono hands us a full URL, so unlike Express there is no Host-header
    // reconstruction and nothing to misconfigure behind a proxy.
    const h = harness();
    const body = (await (await h.request("/v1/report?deep=1")).json()) as {
      accepts: Array<{ resource: string }>;
    };
    expect(body.accepts[0]?.resource).toBe("http://api.example.com/v1/report?deep=1");
  });
});

describe("paid requests", () => {
  it("serves the handler, attaches the receipt, reports served", async () => {
    const h = harness();
    const response = await h.request("/v1/report", paid());
    await h.flush();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: "paid content" });

    const receiptId = response.headers.get(RECEIPT_HEADER);
    expect(receiptId).toMatch(/^oct_rcpt_/);

    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.served"]);
    expect(h.events[1]?.data).toMatchObject({ receipt_id: receiptId, status: 200 });
  });

  it("issues a receipt that verifies under the gate's key", async () => {
    const h = harness();
    await h.request("/v1/report", paid());
    await h.flush();

    const receipt = h.events.find((e) => e.type === "toll.settled")?.data["receipt"];
    await expect(
      verifyReceipt(receipt as Parameters<typeof verifyReceipt>[0], await h.gate.publicKey()),
    ).resolves.toBe(true);
  });

  it("labels events with the matched pattern, not the expanded path", async () => {
    const h = harness({}, (app, middleware) => {
      app.get("/v1/:kind/report", middleware, (c) => c.json({ ok: true }));
    });

    await h.request("/v1/deep/report", paid());
    await h.flush();
    expect(h.events[0]?.route).toBe("/v1/:kind/report");
  });

  it("passes the Hono context to a dynamic price resolver", async () => {
    const h = harness({
      price: (req) => {
        const c = req.raw as { req: { query: (k: string) => string | undefined } };
        return c.req.query("deep") === "1" ? "$0.02" : "$0.004";
      },
    });

    const body = (await (await h.request("/v1/report?deep=1")).json()) as {
      accepts: Array<{ maxAmountRequired: string }>;
    };
    expect(body.accepts[0]?.maxAmountRequired).toBe("20000");
  });
});

describe("outcome reporting", () => {
  it("reports a 500 from the handler as a refund candidate", async () => {
    const h = harness({}, (app, middleware) => {
      app.use("/v1/report", middleware);
      app.get("/v1/report", (c) => c.json({ error: "upstream" }, 500));
    });

    const response = await h.request("/v1/report", paid());
    await h.flush();

    expect(response.status).toBe(500);
    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.failed"]);
    expect(h.events[1]?.data["receipt_id"]).toMatch(/^oct_rcpt_/);
  });

  it("reports a thrown handler as failed and still lets Hono render the error", async () => {
    const h = harness({}, (app, middleware) => {
      app.use("/v1/report", middleware);
      app.get("/v1/report", () => {
        throw new Error("upstream exploded");
      });
    });

    const response = await h.request("/v1/report", paid());
    await h.flush();

    expect(response.status).toBe(500);
    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.failed"]);
  });

  it("reports exactly once", async () => {
    const h = harness();
    await h.request("/v1/report", paid());
    await h.flush();
    expect(h.events.filter((e) => e.type.startsWith("request."))).toHaveLength(1);
  });
});

describe("rejections and outages", () => {
  it("returns the machine-readable rejection body", async () => {
    const h = harness();
    const response = await h.request("/v1/report", { headers: { "x-payment": "not-base64!" } });
    await h.flush();

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; errorDetail: { code: string } };
    expect(body.error).toBe("invalid_payment");
    expect(h.events.map((e) => e.type)).toEqual(["toll.rejected"]);
  });

  it("refuses a replayed payment", async () => {
    const h = harness();
    const payment = mockPayment();
    expect((await h.request("/v1/report", paid(payment))).status).toBe(200);

    const replay = await h.request("/v1/report", paid(payment));
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { error: string }).error).toBe("duplicate_settlement");
  });

  it("fails closed with 503 and Retry-After when the facilitator is down", async () => {
    const h = harness({
      facilitator: createMockFacilitator({ networks: ["base-sepolia"], unreachable: true }),
    });
    const response = await h.request("/v1/report", paid());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("serves without a receipt under fail_open", async () => {
    const h = harness({
      mode: "fail_open",
      facilitator: createMockFacilitator({ networks: ["base-sepolia"], unreachable: true }),
    });
    const response = await h.request("/v1/report", paid());
    await h.flush();

    expect(response.status).toBe(200);
    expect(response.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(h.events.map((e) => e.type)).toEqual(["gate.error", "request.served"]);
  });
});
