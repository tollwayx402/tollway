import { describe, expect, it } from "vitest";
import { TollwayConfigError, formatAtomic, parsePrice, resolvePrice } from "../src/index.js";
import type { GateRequest } from "../src/index.js";

const usdc = { asset: "usdc" as const };

const req: GateRequest = { method: "GET", route: "/v1/report", headers: {} };

describe("parsePrice", () => {
  it("parses USD strings into atomic units", () => {
    expect(parsePrice("$0.004", usdc)).toBe(4_000n);
    expect(parsePrice("$1", usdc)).toBe(1_000_000n);
    expect(parsePrice("1.5", usdc)).toBe(1_500_000n);
    expect(parsePrice("$0.000001", usdc)).toBe(1n);
    expect(parsePrice("$1,250.50", usdc)).toBe(1_250_500_000n);
    expect(parsePrice("  $0.02  ", usdc)).toBe(20_000n);
  });

  it("passes bigints through as atomic units", () => {
    expect(parsePrice(4_000n, usdc)).toBe(4_000n);
  });

  it("does not accumulate float error", () => {
    // 0.1 + 0.2 territory: the string path never touches a float.
    expect(parsePrice("$0.07", usdc)).toBe(70_000n);
    expect(parsePrice("$29.97", usdc)).toBe(29_970_000n);
  });

  it("rejects more precision than the asset carries", () => {
    expect(() => parsePrice("$0.0000004", usdc)).toThrow(TollwayConfigError);
    expect(() => parsePrice("$0.0000004", usdc)).toThrow(/7 decimal places but usdc carries 6/);
  });

  it("rejects unparseable and non-positive prices", () => {
    expect(() => parsePrice("free", usdc)).toThrow(TollwayConfigError);
    expect(() => parsePrice("0.004 USDC", usdc)).toThrow(TollwayConfigError);
    expect(() => parsePrice("-$1", usdc)).toThrow(TollwayConfigError);
    expect(() => parsePrice("$0", usdc)).toThrow(/greater than zero/);
    expect(() => parsePrice(0n, usdc)).toThrow(/greater than zero/);
    expect(() => parsePrice(-5n, usdc)).toThrow(/greater than zero/);
  });

  it("requires decimals for unknown assets", () => {
    expect(() => parsePrice("$1", { asset: "wrappedwidget" })).toThrow(/unknown asset/);
    expect(parsePrice("$1", { asset: "wrappedwidget", decimals: 18 })).toBe(10n ** 18n);
  });
});

describe("resolvePrice", () => {
  it("resolves sync and async price functions", async () => {
    await expect(resolvePrice(() => "$0.02", req, usdc)).resolves.toBe(20_000n);
    await expect(resolvePrice(async () => 7_000n, req, usdc)).resolves.toBe(7_000n);
  });

  it("hands the request to the resolver", async () => {
    const dynamic = (r: GateRequest) => (r.route === "/v1/deep" ? "$0.02" : "$0.004");
    await expect(resolvePrice(dynamic, { ...req, route: "/v1/deep" }, usdc)).resolves.toBe(20_000n);
    await expect(resolvePrice(dynamic, req, usdc)).resolves.toBe(4_000n);
  });
});

describe("formatAtomic", () => {
  it("renders atomic units back to decimals", () => {
    expect(formatAtomic(4_000n, 6)).toBe("0.004000");
    expect(formatAtomic(1_000_000n, 6)).toBe("1.000000");
    expect(formatAtomic(1n, 6)).toBe("0.000001");
    expect(formatAtomic(42n, 0)).toBe("42");
  });
});
