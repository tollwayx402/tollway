import { describe, expect, it } from "vitest";
import { formatConformance, runFacilitatorConformance } from "@octroi/core";
import { coinbaseFacilitator } from "../src/index.js";
import { measureClockSkew } from "../src/skew.js";
import { routedFetch } from "./replay.js";

describe("facilitator contract suite (§11)", () => {
  it("the coinbase adapter passes every check", async () => {
    const adapter = coinbaseFacilitator({
      fetchImpl: routedFetch({ verify: "verify.badSignature", settle: "settle.ok" }).fetch,
      networks: ["base-sepolia"],
    });

    const checks = await runFacilitatorConformance(adapter, { network: "base-sepolia" });
    const failed = checks.filter((check) => !check.ok);
    expect(failed, `\n${formatConformance(checks)}`).toEqual([]);
    // The valid-payment check needs a real signed authorization; the testnet
    // run supplies one.
    expect(checks.some((check) => check.skipped)).toBe(true);
  });
});

describe("clock skew", () => {
  function dateFetch(date: string): typeof fetch {
    return (async () =>
      new Response("{}", { status: 200, headers: { date } })) as unknown as typeof fetch;
  }

  it("reports an aligned clock as ok", async () => {
    const skew = await measureClockSkew({
      fetchImpl: dateFetch(new Date(1_765_432_100_000).toUTCString()),
      now: () => 1_765_432_100_000,
    });
    expect(skew.severity).toBe("ok");
    expect(Math.abs(skew.skewMs)).toBeLessThan(1_000);
  });

  it("flags a fast local clock, with the right direction of advice", async () => {
    const skew = await measureClockSkew({
      fetchImpl: dateFetch(new Date(1_765_432_100_000).toUTCString()),
      now: () => 1_765_432_160_000, // a minute ahead
    });
    expect(skew.severity).toBe("critical");
    expect(skew.skewMs).toBeGreaterThan(0);
    expect(skew.advice).toMatch(/ahead of the facilitator/);
  });

  it("flags a slow local clock", async () => {
    const skew = await measureClockSkew({
      fetchImpl: dateFetch(new Date(1_765_432_100_000).toUTCString()),
      now: () => 1_765_432_040_000,
    });
    expect(skew.severity).toBe("critical");
    expect(skew.skewMs).toBeLessThan(0);
    expect(skew.advice).toMatch(/behind the facilitator/);
  });

  it("treats a missing or unparseable Date header as unreachable", async () => {
    const noDate = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(measureClockSkew({ fetchImpl: noDate })).rejects.toThrow(/no Date header/);
    await expect(measureClockSkew({ fetchImpl: dateFetch("not-a-date") })).rejects.toThrow(
      /unparseable Date header/,
    );
  });
});
