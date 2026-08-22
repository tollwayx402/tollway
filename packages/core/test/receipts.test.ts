import { describe, expect, it } from "vitest";
import {
  createEphemeralSigner,
  createSignerFromJwk,
  publicKeyHex,
  receiptSigningPayload,
  signReceipt,
  verifyReceipt,
} from "../src/index.js";
import type { UnsignedReceipt } from "../src/index.js";
import { FIXED_SIGNING_JWK } from "./fixtures/keys.js";

const unsigned: UnsignedReceipt = {
  id: "oct_rcpt_8f3a2c",
  v: 1,
  route: "/v1/report",
  amount: "4000",
  asset: "usdc",
  network: "base",
  payer: "0xabc",
  tx_ref: "0xdef",
  ts: 1_765_432_100,
  merchant: null,
};

describe("receipts", () => {
  it("signs and verifies a round trip", async () => {
    const signer = await createEphemeralSigner();
    const receipt = await signReceipt(unsigned, signer);

    expect(receipt).toMatchObject(unsigned);
    expect(receipt.sig).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(verifyReceipt(receipt, await signer.publicKey())).resolves.toBe(true);
  });

  it("signs over canonical JSON, so field order does not matter", async () => {
    const signer = await createEphemeralSigner();
    const a = await signReceipt(unsigned, signer);
    const reordered = Object.fromEntries(
      Object.entries(unsigned).reverse(),
    ) as unknown as UnsignedReceipt;
    const b = await signReceipt(reordered, signer);
    expect(b.sig).toBe(a.sig);
  });

  it("excludes sig from what it covers", () => {
    expect(receiptSigningPayload(unsigned)).toBe(
      receiptSigningPayload({ ...unsigned, sig: "tampered" }),
    );
    expect(receiptSigningPayload(unsigned)).not.toContain('"sig"');
  });

  it("fails verification when any field is altered", async () => {
    const signer = await createEphemeralSigner();
    const receipt = await signReceipt(unsigned, signer);
    const publicKey = await signer.publicKey();

    await expect(verifyReceipt({ ...receipt, amount: "1" }, publicKey)).resolves.toBe(false);
    await expect(verifyReceipt({ ...receipt, route: "/v1/other" }, publicKey)).resolves.toBe(false);
    await expect(verifyReceipt({ ...receipt, payer: "0xbad" }, publicKey)).resolves.toBe(false);
    await expect(verifyReceipt({ ...receipt, sig: "AAAA" }, publicKey)).resolves.toBe(false);
  });

  it("fails verification under a different key", async () => {
    const mine = await createEphemeralSigner();
    const theirs = await createEphemeralSigner();
    const receipt = await signReceipt(unsigned, mine);
    await expect(verifyReceipt(receipt, await theirs.publicKey())).resolves.toBe(false);
  });

  it("is deterministic for a fixed key (Ed25519), which the golden files rely on", async () => {
    const signer = await createSignerFromJwk(FIXED_SIGNING_JWK);
    const a = await signReceipt(unsigned, signer);
    const b = await signReceipt(unsigned, signer);
    expect(a.sig).toBe(b.sig);
    expect(await publicKeyHex(signer)).toHaveLength(64);
    await expect(verifyReceipt(a, await signer.publicKey())).resolves.toBe(true);
  });

  it("gives each ephemeral gate its own key", async () => {
    const a = await createEphemeralSigner();
    const b = await createEphemeralSigner();
    expect(a.keyId).not.toBe(b.keyId);
  });
});
