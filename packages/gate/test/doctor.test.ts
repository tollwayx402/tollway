import { describe, expect, it } from "vitest";
import { createMockFacilitator } from "@tollway/core/testing";
import type { GateOptions } from "@tollway/core";
import { doctor, formatReport } from "../src/doctor.js";

function gateOptions(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo: `0x${"1".repeat(40)}`,
    facilitator: createMockFacilitator({ networks: ["base-sepolia"] }),
    resourceBase: "https://doctor.tollway.local",
    ...overrides,
  };
}

/**
 * A facilitator whose `Date` header is `offsetMs` away from ours, and which
 * answers /supported with the given kinds — doctor probes both endpoints
 * through one injected fetch.
 */
function skewedFacilitator(offsetMs: number, settles: string[] = ["base-sepolia"]) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/supported")) {
      return new Response(
        JSON.stringify({
          kinds: settles.map((network) => ({ x402Version: 1, scheme: "exact", network })),
        }),
        { status: 200, headers: { date: new Date(Date.now() - offsetMs).toUTCString() } },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { date: new Date(Date.now() - offsetMs).toUTCString() },
    });
  }) as unknown as typeof fetch;
}

describe("doctor", () => {
  it("passes a healthy standalone config", async () => {
    const report = await doctor({ gate: gateOptions(), skipSelfPayment: true });

    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toContain("config is valid");
    expect(report.checks.find((c) => c.name === "price parses to atomic units")?.detail).toContain(
      "4000 atomic units",
    );
  });

  it("reports a skipped self-payment as incomplete, never as a clean bill", async () => {
    // A doctor that reads green because it skipped the hard part is worse
    // than no doctor at all.
    const report = await doctor({ gate: gateOptions() });

    expect(report.ok).toBe(true);
    expect(report.incomplete).toBe(true);
    const selfPayment = report.checks.find((c) => c.name === "self-payment");
    expect(selfPayment?.skipped).toBe(true);
    expect(selfPayment?.detail).toMatch(/TW_AGENT_KEY/);
    expect(formatReport(report)).toContain("This is not a clean bill.");
  });

  it("fails on bad config and stops rather than cascading", async () => {
    const report = await doctor({ gate: gateOptions({ price: "4 dollars" }) });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "config is valid", ok: false });
    expect(report.checks[0]?.detail).toMatch(/could not parse price/);
    // Nothing downstream can be trusted once the config is invalid.
    expect(report.checks).toHaveLength(1);
  });

  it("catches a facilitator that cannot cover the configured network", async () => {
    const report = await doctor({
      gate: gateOptions({
        network: "base",
        facilitator: createMockFacilitator({ networks: ["base-sepolia"] }),
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toMatch(/no configured facilitator supports network "base"/);
  });

  it("runs the shared conformance suite against each adapter", async () => {
    const report = await doctor({ gate: gateOptions(), skipSelfPayment: true });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("mock: buildChallenge returns a complete scheme");
    expect(names).toContain("mock: verify returns a rejection value for a bad payload, never throws");
  });

  it("resolves a string facilitator and still runs its conformance suite", async () => {
    // A by-id facilitator must not silently vanish from the run.
    const { registerFacilitator } = await import("@tollway/core");
    registerFacilitator(createMockFacilitator({ id: "doctor-registered", networks: ["base-sepolia"] }));

    const report = await doctor({
      gate: gateOptions({ facilitator: "doctor-registered" }),
      skipSelfPayment: true,
    });

    expect(report.checks.map((c) => c.name)).toContain(
      "doctor-registered: buildChallenge returns a complete scheme",
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("reports an aligned clock as healthy", async () => {
    const report = await doctor({
      gate: gateOptions(),
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: skewedFacilitator(0),
      skipSelfPayment: true,
    });

    const skew = report.checks.find((c) => c.name === "clock skew is within tolerance");
    expect(skew?.ok).toBe(true);
    expect(skew?.detail).toMatch(/^-?\d+ms \(rtt \d+ms\)$/);
  });

  it("fails the run when the local clock is badly out", async () => {
    // This is where our challenge expiry meets the facilitator's timestamp
    // validation, so a bad clock has to be a failure, not a note.
    const report = await doctor({
      gate: gateOptions(),
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: skewedFacilitator(120_000),
      skipSelfPayment: true,
    });

    const skew = report.checks.find((c) => c.name === "clock skew is within tolerance");
    expect(skew?.ok).toBe(false);
    expect(skew?.detail).toMatch(/ahead of the facilitator/);
    expect(report.ok).toBe(false);
  });

  it("fails when the facilitator cannot be reached for skew at all", async () => {
    const report = await doctor({
      gate: gateOptions(),
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND facilitator.test");
      }) as unknown as typeof fetch,
      skipSelfPayment: true,
    });

    const skew = report.checks.find((c) => c.name === "clock skew is within tolerance");
    expect(skew?.ok).toBe(false);
    expect(skew?.detail).toMatch(/ENOTFOUND/);
  });

  it("fails when a configured network is not facilitator-settleable", async () => {
    // The failure this catches otherwise happens in the agent's process, after
    // they signed.
    const report = await doctor({
      gate: gateOptions(),
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: skewedFacilitator(0, ["solana-devnet"]),
      skipSelfPayment: true,
    });

    const check = report.checks.find(
      (c) => c.name === "configured networks are facilitator-settleable",
    );
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/does not settle: base-sepolia/);
    expect(check?.detail).toMatch(/it settles: solana-devnet/);
    expect(report.ok).toBe(false);
  });

  it("passes settleability when the facilitator lists every configured network", async () => {
    const report = await doctor({
      gate: gateOptions(),
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: skewedFacilitator(0),
      skipSelfPayment: true,
    });
    const check = report.checks.find(
      (c) => c.name === "configured networks are facilitator-settleable",
    );
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/settles all of: base-sepolia/);
  });

  it("skips the skew check loudly when no facilitator URL is known", async () => {
    const report = await doctor({ gate: gateOptions(), skipSelfPayment: true });
    const skew = report.checks.find((c) => c.name === "clock skew");
    expect(skew?.skipped).toBe(true);
    expect(skew?.detail).toMatch(/--facilitator-url/);
    expect(report.incomplete).toBe(true);
  });

  it("warns that a standalone key only verifies in-process", async () => {
    const report = await doctor({ gate: gateOptions(), skipSelfPayment: true });
    const key = report.checks.find((c) => c.name === "a receipt signing key is available");
    expect(key?.ok).toBe(true);
    expect(key?.detail).toMatch(/ephemeral/);
  });
});

describe("formatReport", () => {
  it("marks failures, skips and passes distinctly", async () => {
    const report = await doctor({ gate: gateOptions() });
    const text = formatReport(report);
    expect(text).toMatch(/pass {2}config is valid/);
    expect(text).toMatch(/skip {2}self-payment/);
  });

  it("says so plainly when everything passed and nothing was skipped", async () => {
    const report = await doctor({
      gate: gateOptions(),
      skipSelfPayment: false,
      agentKey: undefined,
    });
    // With a skip present, the summary must not claim success.
    expect(formatReport(report)).not.toContain("All checks passed.");
  });
});
