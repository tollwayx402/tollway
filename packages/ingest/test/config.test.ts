/**
 * Remote config is the one place a remote party can change what a merchant
 * charges, so these tests are mostly about what must be *refused*.
 */
import { describe, expect, it, vi } from "vitest";
import { createEphemeralSigner, signDocument, type Signer } from "@octroi/core";
import { createRemoteConfigClient, validateSignedConfig } from "../src/index.js";
import type { SignedConfig } from "../src/index.js";

const NOW = 1_765_432_100_000;

async function signedConfig(
  signer: Signer,
  overrides: Partial<Omit<SignedConfig, "sig">> = {},
): Promise<SignedConfig> {
  const body = {
    v: 1 as const,
    merchant: "acct_9d2",
    issued_at: Math.floor(NOW / 1_000),
    routes: { "/v1/report": { price: "$0.02" } },
    ...overrides,
  };
  return signDocument(body, signer);
}

function respondWith(config: unknown, init: ResponseInit = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(config), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"v1"', ...(init.headers ?? {}) },
      ...init,
    })) as unknown as typeof fetch;
}

describe("verification", () => {
  it("applies a correctly signed, fresh config", async () => {
    const signer = await createEphemeralSigner();
    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl: respondWith(await signedConfig(signer)),
      clock: () => NOW,
    });

    expect(await client.refresh()).toBe(true);
    expect(client.lookup("/v1/report")).toEqual({ price: "$0.02" });
  });

  it("refuses a config signed by the wrong key", async () => {
    const real = await createEphemeralSigner();
    const attacker = await createEphemeralSigner();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await real.publicKey(),
      fetchImpl: respondWith(await signedConfig(attacker)),
      clock: () => NOW,
      logger,
    });

    expect(await client.refresh()).toBe(false);
    expect(client.current()).toBeUndefined();
    expect(client.lookup("/v1/report")).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing unverified remote config"),
      expect.objectContaining({ reason: expect.stringContaining("signature did not verify") }),
    );
  });

  it("refuses a config whose prices were edited after signing", async () => {
    const signer = await createEphemeralSigner();
    const tampered = await signedConfig(signer);
    tampered.routes["/v1/report"] = { price: "$0.000001" };

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl: respondWith(tampered),
      clock: () => NOW,
    });

    expect(await client.refresh()).toBe(false);
    expect(client.lookup("/v1/report")).toBeUndefined();
  });

  it("refuses a stale config — a replayed price cut must expire", async () => {
    const signer = await createEphemeralSigner();
    const old = await signedConfig(signer, {
      issued_at: Math.floor(NOW / 1_000) - 3_600,
      routes: { "/v1/report": { price: "$0.0001" } },
    });

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl: respondWith(old),
      clock: () => NOW,
      maxAgeMs: 15 * 60 * 1_000,
    });

    expect(await client.refresh()).toBe(false);
    expect(client.lookup("/v1/report")).toBeUndefined();
  });

  it("refuses a config dated far in the future", async () => {
    const signer = await createEphemeralSigner();
    const future = await signedConfig(signer, { issued_at: Math.floor(NOW / 1_000) + 86_400 });
    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl: respondWith(future),
      clock: () => NOW,
    });
    expect(await client.refresh()).toBe(false);
  });

  it("keeps the last good config when a later fetch fails to verify", async () => {
    const signer = await createEphemeralSigner();
    const attacker = await createEphemeralSigner();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      const body = call === 1 ? await signedConfig(signer) : await signedConfig(attacker, {
        routes: { "/v1/report": { price: "$0.000001" } },
      });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl,
      clock: () => NOW,
    });

    await client.refresh();
    expect(client.lookup("/v1/report")).toEqual({ price: "$0.02" });

    await client.refresh();
    // The good config stands; an unverifiable response cannot revoke it.
    expect(client.lookup("/v1/report")).toEqual({ price: "$0.02" });
  });

  it("requires a 32-byte key and rejects nonsense", async () => {
    expect(() =>
      createRemoteConfigClient({ apiKey: "k", publicKey: "abcd" }),
    ).toThrow(/32-byte Ed25519 key/);
    expect(() =>
      createRemoteConfigClient({ apiKey: "k", publicKey: "not-hex-at-all!!" }),
    ).toThrow(/valid hex/);
  });

  it("rejects a config for a different merchant when one is expected", async () => {
    const signer = await createEphemeralSigner();
    const other = await signedConfig(signer, { merchant: "acct_someone_else" });
    const reason = await validateSignedConfig(other, await signer.publicKey(), {
      now: NOW,
      maxAgeMs: 900_000,
      merchant: "acct_9d2",
    });
    expect(reason).toMatch(/config is for merchant acct_someone_else/);
  });
});

describe("polling", () => {
  it("keeps the current config on a network error", async () => {
    const signer = await createEphemeralSigner();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify(await signedConfig(signer)), { status: 200 });
      throw new TypeError("ENOTFOUND ingest.octroi.ai");
    }) as unknown as typeof fetch;

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl,
      clock: () => NOW,
    });

    await client.refresh();
    await expect(client.refresh()).resolves.toBe(false);
    expect(client.lookup("/v1/report")).toEqual({ price: "$0.02" });
  });

  it("sends the ETag it was given and treats 304 as no change", async () => {
    const signer = await createEphemeralSigner();
    const seen: Array<string | undefined> = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      call += 1;
      seen.push((init?.headers as Record<string, string>)["if-none-match"]);
      if (call === 1) {
        return new Response(JSON.stringify(await signedConfig(signer)), {
          status: 200,
          headers: { etag: '"abc"' },
        });
      }
      return new Response("", { status: 304 });
    }) as unknown as typeof fetch;

    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl,
      clock: () => NOW,
    });

    await client.refresh();
    await expect(client.refresh()).resolves.toBe(false);
    expect(seen).toEqual([undefined, '"abc"']);
  });

  it("reports no change when the same config is served twice", async () => {
    const signer = await createEphemeralSigner();
    const config = await signedConfig(signer);
    const onUpdate = vi.fn();
    const client = createRemoteConfigClient({
      apiKey: "k",
      publicKey: await signer.publicKey(),
      fetchImpl: respondWith(config),
      clock: () => NOW,
      onUpdate,
    });

    expect(await client.refresh()).toBe(true);
    expect(await client.refresh()).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
