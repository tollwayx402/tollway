import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { getDefaultAsset, getNetworkId } from "x402/shared";
import { PaymentRequirementsSchema } from "x402/types";
import type { ChallengeRequest } from "@tollway/core";
import { coinbaseFacilitator } from "../src/index.js";
import { DEFAULT_NETWORKS, KNOWN_NETWORKS, NETWORKS, networkForCaip2 } from "../src/networks.js";
import { fetchSupportedNetworks } from "../src/supported.js";

function requirementFor(network: string): ChallengeRequest {
  return {
    route: "/v1/report",
    resource: "https://api.example.com/v1/report",
    description: "Access to /v1/report",
    mimeType: "application/json",
    network,
    asset: "usdc",
    amount: 4_000n,
    payTo: `0x${"1".repeat(40)}`,
    nonce: "nonce-1",
    expiresAt: 1_765_432_220,
    maxTimeoutSeconds: 120,
  };
}

describe("the network table", () => {
  it("agrees with the reference package on every network — address, domain, chain id", () => {
    // The table was extracted from x402@1.2.0; this keeps it pinned there. A
    // failure here means either a typo crept in or the reference moved.
    for (const network of KNOWN_NETWORKS) {
      const reference = getDefaultAsset(network as Parameters<typeof getDefaultAsset>[0]) as {
        address: string;
        decimals: number;
        eip712: { name: string; version: string };
      };
      const ours = NETWORKS[network]!.assets["usdc"]!;
      expect(ours.address, network).toBe(reference.address);
      expect(ours.decimals, network).toBe(reference.decimals);
      expect(ours.eip712, network).toEqual(reference.eip712);
      expect(NETWORKS[network]!.chainId, network).toBe(
        getNetworkId(network as Parameters<typeof getNetworkId>[0]),
      );
    }
  });

  it("covers every EVM network the reference client can parse", () => {
    for (const network of KNOWN_NETWORKS) {
      const scheme = coinbaseFacilitator({ networks: [network] }).buildChallenge(
        requirementFor(network),
      );
      expect(() => PaymentRequirementsSchema.parse(scheme), network).not.toThrow();
    }
    expect(KNOWN_NETWORKS.length).toBe(15);
  });

  it("defaults to Base only — parseable is not the same as settleable", () => {
    // Advertising a network the facilitator will not settle fails the payer
    // after they signed. Breadth is opt-in; the default is what settles today.
    const adapter = coinbaseFacilitator();
    expect(adapter.networks).toEqual(["base", "base-sepolia"]);
    expect(DEFAULT_NETWORKS.length).toBeLessThan(KNOWN_NETWORKS.length);
  });

  it("maps CAIP-2 ids back to network names", () => {
    expect(networkForCaip2("eip155:84532")).toBe("base-sepolia");
    expect(networkForCaip2("eip155:137")).toBe("polygon");
    expect(networkForCaip2("eip155:999999")).toBeUndefined();
    expect(networkForCaip2("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBeUndefined();
  });
});

describe("multi-network challenges", () => {
  it("advertises several networks in configured order, all client-parseable", async () => {
    const { createGate } = await import("@tollway/core");
    const gate = createGate({
      price: "$0.004",
      asset: "usdc",
      network: ["base", "polygon", "avalanche"],
      payTo: `0x${"1".repeat(40)}`,
      facilitator: coinbaseFacilitator({ networks: ["base", "polygon", "avalanche"] }),
      resourceBase: "https://api.example.com",
    });

    const result = await gate.handle({ method: "GET", route: "/v1/report", headers: {} });
    if (result.type !== "challenge") throw new Error(`expected challenge, got ${result.type}`);
    const body = result.body as { accepts: Array<{ network: string; asset: string }> };

    expect(body.accepts.map((a) => a.network)).toEqual(["base", "polygon", "avalanche"]);
    for (const scheme of body.accepts) {
      expect(() => PaymentRequirementsSchema.parse(scheme)).not.toThrow();
    }
    // Each network advertises its own asset address, not Base's.
    expect(body.accepts[1]?.asset).toBe(NETWORKS["polygon"]!.assets["usdc"]!.address);
  });
});

describe("fetchSupportedNetworks", () => {
  const respond = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("normalizes the measured x402.org shape — v1 names and v2 CAIP-2 ids", async () => {
    // This fixture is the live /supported body from 2026-08-12, abridged.
    const supported = await fetchSupportedNetworks({
      url: "https://x402.org/facilitator",
      fetchImpl: respond({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          { x402Version: 2, scheme: "upto", network: "eip155:84532" },
          { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
          { x402Version: 2, scheme: "exact", network: "stellar:testnet" },
          { x402Version: 1, scheme: "exact", network: "base-sepolia" },
          { x402Version: 1, scheme: "exact", network: "solana-devnet" },
        ],
      }),
    });

    // v1 plain names count even outside our EVM table — "solana-devnet" is a
    // real network name a payai-configured gate could legitimately advertise.
    expect([...supported.networks].sort()).toEqual(["base-sepolia", "solana-devnet"]);
    expect(supported.unrecognized).toContain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(supported.unrecognized).toContain("stellar:testnet");
    expect(supported.kinds).toHaveLength(6);
  });

  it("treats an unreachable or malformed endpoint as an outage, not an empty set", async () => {
    // An empty set would read as "facilitator settles nothing" and fail every
    // network check with a wrong message.
    await expect(
      fetchSupportedNetworks({
        url: "https://x.test",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/unrecognised body/);

    await expect(
      fetchSupportedNetworks({
        url: "https://x.test",
        fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/answered 503/);
  });
});
