import { describe, expect, it } from "vitest";
import { resolvePrice, type GateRequest } from "@octroi/core";
import { remoteMode, remotePrice } from "../src/index.js";
import type { RemoteConfigClient, RemoteRouteConfig } from "../src/index.js";

function stubConfig(routes: Record<string, RemoteRouteConfig>): RemoteConfigClient {
  return {
    start() {},
    stop() {},
    refresh: async () => false,
    current: () => undefined,
    lookup: (route) => routes[route],
  };
}

const req: GateRequest = { method: "GET", route: "/v1/report", headers: {} };
const usdc = { asset: "usdc" as const };

describe("remotePrice", () => {
  it("prefers a verified dashboard price", async () => {
    const price = remotePrice({
      config: stubConfig({ "/v1/report": { price: "$0.02" } }),
      local: "$0.004",
    });
    await expect(resolvePrice(price, req, usdc)).resolves.toBe(20_000n);
  });

  it("falls back to the local price when the cloud says nothing", async () => {
    const price = remotePrice({ config: stubConfig({}), local: "$0.004" });
    await expect(resolvePrice(price, req, usdc)).resolves.toBe(4_000n);
  });

  it("lets local win outright under configSource: local (§3.1)", async () => {
    const price = remotePrice({
      config: stubConfig({ "/v1/report": { price: "$0.02" } }),
      local: "$0.004",
      configSource: "local",
    });
    await expect(resolvePrice(price, req, usdc)).resolves.toBe(4_000n);
  });

  it("supports an async local resolver", async () => {
    const price = remotePrice({
      config: stubConfig({}),
      local: async () => "$0.05",
    });
    await expect(resolvePrice(price, req, usdc)).resolves.toBe(50_000n);
  });

  it("never leaves a route unpriced — the cloud cannot make anything free", async () => {
    // A route with no local price is a config error at boot; a route whose
    // cloud config is missing simply keeps charging the local price.
    const price = remotePrice({ config: stubConfig({ "/other": { price: "$1" } }), local: "$0.004" });
    await expect(resolvePrice(price, req, usdc)).resolves.toBe(4_000n);
  });
});

describe("remoteMode", () => {
  it("takes the dashboard mode, or the local one", () => {
    const config = stubConfig({ "/v1/report": { mode: "fail_open" } });
    expect(remoteMode({ config, local: "fail_closed", route: "/v1/report" })).toBe("fail_open");
    expect(remoteMode({ config, local: "fail_closed", route: "/other" })).toBe("fail_closed");
    expect(
      remoteMode({ config, local: "fail_closed", route: "/v1/report", configSource: "local" }),
    ).toBe("fail_closed");
  });
});
