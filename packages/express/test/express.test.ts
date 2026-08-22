import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { RECEIPT_HEADER, verifyReceipt } from "@octroi/core";
import type { OctroiEvent } from "@octroi/core";
import {
  createMockFacilitator,
  encodePaymentHeader,
  mockPayment,
  type MockFacilitator,
} from "@octroi/core/testing";
import { octroi, type OctroiExpressOptions } from "../src/index.js";

interface Harness {
  url: string;
  events: OctroiEvent[];
  facilitator: MockFacilitator;
  gate: ReturnType<typeof octroi>["gate"];
  flush(): Promise<void>;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    const closing = new Promise<void>((resolve) => server!.close(() => resolve()));
    // undici keeps connections alive, and `close` waits on idle sockets.
    server.closeAllConnections();
    await closing;
  }
  server = undefined;
});

async function harness(
  options: Partial<OctroiExpressOptions> = {},
  mount: (app: express.Express, middleware: ReturnType<typeof octroi>) => void = (
    app,
    middleware,
  ) => {
    app.use("/v1/report", middleware);
    app.get("/v1/report", (_req, res) => {
      res.json({ report: "paid content" });
    });
  },
): Promise<Harness> {
  const events: OctroiEvent[] = [];
  const facilitator = createMockFacilitator({ networks: ["base-sepolia"] });

  const middleware = octroi({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: "0xmerchant",
    facilitator,
    onEvent: (event) => void events.push(event),
    ...options,
  });

  const app = express();
  mount(app, middleware);

  server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    events,
    facilitator,
    gate: middleware.gate,
    flush: () => middleware.gate.flushEvents(),
  };
}

const paidHeaders = (payment = mockPayment()) => ({ "x-payment": encodePaymentHeader(payment) });

describe("unpaid requests", () => {
  it("answers 402 with the challenge body and does not run the handler", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/v1/report`);
    await h.flush();

    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await response.json()) as { accepts: unknown[]; errorDetail: { code: string } };
    expect(body.accepts).toHaveLength(1);
    expect(body.errorDetail.code).toBe("payment_required");
    expect(h.events.map((e) => e.type)).toEqual(["challenge.issued"]);
  });

  it("advertises an absolute resource URL built from the request", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/v1/report?deep=1`);
    const body = (await response.json()) as { accepts: Array<{ resource: string }> };

    // x402 validates `resource` as a URL, so this must survive round-tripping.
    expect(() => new URL(body.accepts[0]!.resource)).not.toThrow();
    expect(body.accepts[0]?.resource).toBe(`${h.url}/v1/report?deep=1`);
  });
});

describe("paid requests", () => {
  it("serves the handler, attaches the receipt, and reports the outcome", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: "paid content" });

    const receiptId = response.headers.get(RECEIPT_HEADER);
    expect(receiptId).toMatch(/^oct_rcpt_/);

    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.served"]);
    const served = h.events[1];
    expect(served?.data).toMatchObject({ receipt_id: receiptId, status: 200 });
    expect(served?.data["latency_ms"]).toBeTypeOf("number");
  });

  it("issues a receipt that verifies under the gate's key", async () => {
    const h = await harness();
    await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();

    const receipt = h.events.find((e) => e.type === "toll.settled")?.data["receipt"];
    await expect(
      verifyReceipt(receipt as Parameters<typeof verifyReceipt>[0], await h.gate.publicKey()),
    ).resolves.toBe(true);
  });

  it("labels events with the mount path, never the query string", async () => {
    const h = await harness();
    await fetch(`${h.url}/v1/report?deep=1`, { headers: paidHeaders() });
    await h.flush();
    expect(h.events.every((e) => e.route === "/v1/report")).toBe(true);
  });

  it("passes the raw express request to a dynamic price resolver", async () => {
    const h = await harness({
      price: (req) => {
        const raw = req.raw as express.Request;
        return raw.query["deep"] === "1" ? "$0.02" : "$0.004";
      },
    });

    const response = await fetch(`${h.url}/v1/report?deep=1`);
    const body = (await response.json()) as { accepts: Array<{ maxAmountRequired: string }> };
    expect(body.accepts[0]?.maxAmountRequired).toBe("20000");
  });
});

describe("outcome reporting", () => {
  it("reports a handler error as request.failed — a refund candidate", async () => {
    const h = await harness({}, (app, middleware) => {
      app.use("/v1/report", middleware);
      app.get("/v1/report", () => {
        throw new Error("upstream exploded");
      });
    });

    const response = await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();

    expect(response.status).toBe(500);
    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.failed"]);
    expect(h.events[1]?.data).toMatchObject({ status: 500 });
    expect(h.events[1]?.data["receipt_id"]).toMatch(/^oct_rcpt_/);
  });

  it("reports exactly once per request", async () => {
    const h = await harness();
    await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();
    expect(h.events.filter((e) => e.type.startsWith("request."))).toHaveLength(1);
  });

  it("reports a client that hangs up as failed, not served", async () => {
    // They paid and received nothing: that is a refund candidate.
    const h = await harness({}, (app, middleware) => {
      app.use("/v1/slow", middleware);
      app.get("/v1/slow", (_req, res) => {
        setTimeout(() => res.json({ ok: true }), 300);
      });
    });

    const controller = new AbortController();
    const pending = fetch(`${h.url}/v1/slow`, {
      headers: paidHeaders(),
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.flush();

    expect(h.events.map((e) => e.type)).toEqual(["toll.settled", "request.failed"]);
  });
});

describe("rejections and outages", () => {
  it("returns the machine-readable rejection body", async () => {
    const h = await harness();
    const response = await fetch(`${h.url}/v1/report`, {
      headers: { "x-payment": "not-base64!" },
    });
    await h.flush();

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; errorDetail: { code: string } };
    expect(body.error).toBe("invalid_payment");
    expect(body.errorDetail.code).toBe("invalid_payment");
    expect(h.events.map((e) => e.type)).toEqual(["toll.rejected"]);
  });

  it("fails closed with 503 when the facilitator is down", async () => {
    const h = await harness({
      facilitator: createMockFacilitator({ networks: ["base-sepolia"], unreachable: true }),
    });
    const response = await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("serves without a receipt under fail_open", async () => {
    const h = await harness({
      mode: "fail_open",
      facilitator: createMockFacilitator({ networks: ["base-sepolia"], unreachable: true }),
    });
    const response = await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();

    expect(response.status).toBe(200);
    expect(response.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(h.events.map((e) => e.type)).toEqual(["gate.error", "request.served"]);
  });

  it("hands merchant misconfiguration to the app's error middleware", async () => {
    const h = await harness(
      {
        price: () => {
          throw new Error("pricing service down");
        },
      },
      (app, middleware) => {
        app.use("/v1/report", middleware);
        app.get("/v1/report", (_req, res) => res.json({ never: true }));
        app.use(((error: Error, _req, res, _next) => {
          res.status(500).json({ handled: error.message });
        }) as express.ErrorRequestHandler);
      },
    );

    // A price that throws is caught by the gate itself and rendered as a
    // 500 halt, so the app's error middleware is not involved.
    const response = await fetch(`${h.url}/v1/report`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_config");
  });
});

describe("mounting", () => {
  it("works as per-route middleware with the router's path as the label", async () => {
    const h = await harness({}, (app, middleware) => {
      app.get("/v1/:kind/report", middleware, (_req, res) => {
        res.json({ ok: true });
      });
    });

    await fetch(`${h.url}/v1/deep/report`, { headers: paidHeaders() });
    await h.flush();
    // The pattern, not the expansion: one label per route, not per parameter.
    expect(h.events[0]?.route).toBe("/v1/:kind/report");
  });

  it("accepts an explicit route label", async () => {
    const h = await harness({ route: "reports.v1" });
    await fetch(`${h.url}/v1/report`, { headers: paidHeaders() });
    await h.flush();
    expect(h.events[0]?.route).toBe("reports.v1");
  });
});
