import { canonicalBytes, canonicalJson } from "./canonical.js";
import { fromBase64, getCrypto, sha256Hex, toBase64Url, toHex } from "./bytes.js";
import type { Asset, Network } from "./types.js";

const ED25519 = { name: "Ed25519" } as const;

/** §6 — the receipt body, before signing. Field names are the wire contract. */
export interface UnsignedReceipt {
  id: string;
  v: 1;
  route: string;
  /** Atomic units, decimal string. */
  amount: string;
  asset: Asset;
  network: Network;
  payer: string;
  tx_ref: string;
  /** Unix seconds. */
  ts: number;
  /** Account id in cloud mode, null standalone. */
  merchant: string | null;
}

export interface Receipt extends UnsignedReceipt {
  /** Ed25519 signature over the canonical JSON of the unsigned receipt, base64url. */
  sig: string;
}

export interface Signer {
  /** Stable identifier for the signing key — logged, never part of the receipt. */
  readonly keyId: string;
  readonly algorithm: "ed25519";
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** Raw 32-byte public key, for out-of-band verification. */
  publicKey(): Promise<Uint8Array>;
}

/**
 * Standalone mode (§6): an ephemeral key generated at boot. Receipts are
 * verifiable inside the merchant's own system for the life of the process; the
 * cloud signer makes them portable.
 */
export async function createEphemeralSigner(): Promise<Signer> {
  const subtle = getCrypto().subtle;
  const pair = (await subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  return signerFromKeys(pair.privateKey, pair.publicKey);
}

/** Load a persistent signing key from a JWK (`{kty:"OKP",crv:"Ed25519",d,x}`). */
export async function createSignerFromJwk(jwk: JsonWebKey): Promise<Signer> {
  const subtle = getCrypto().subtle;
  const privateKey = await subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ext: true };
  const publicKey = await subtle.importKey("jwk", publicJwk, ED25519, true, ["verify"]);
  return signerFromKeys(privateKey, publicKey);
}

async function signerFromKeys(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Signer> {
  const subtle = getCrypto().subtle;
  const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));
  const keyId = (await sha256Hex(raw)).slice(0, 16);
  return {
    keyId,
    algorithm: "ed25519",
    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const signature = await subtle.sign(ED25519, privateKey, bytes as BufferSource);
      return new Uint8Array(signature);
    },
    async publicKey(): Promise<Uint8Array> {
      return raw.slice();
    },
  };
}

/**
 * There is exactly one signing rule in Tollway: Ed25519 over the canonical
 * JSON of the document minus its `sig` field, encoded base64url. Receipts use
 * it; so does signed remote config. Anything else that needs a signature
 * should use these rather than inventing a second construction.
 */
export type SignedDocument = { sig: string };

/** Bytes a signature covers: canonical JSON of the document minus `sig`. */
export function documentSigningBytes(document: object): Uint8Array {
  const { sig: _sig, ...unsigned } = document as SignedDocument;
  return canonicalBytes(unsigned);
}

export function documentSigningPayload(document: object): string {
  const { sig: _sig, ...unsigned } = document as SignedDocument;
  return canonicalJson(unsigned);
}

export async function signDocument<T extends object>(
  document: T,
  signer: Signer,
): Promise<T & SignedDocument> {
  const signature = await signer.sign(documentSigningBytes(document));
  return { ...document, sig: toBase64Url(signature) };
}

/** Verify a signed document against a raw 32-byte Ed25519 public key. */
export async function verifyDocument(
  document: SignedDocument,
  publicKey: Uint8Array | CryptoKey,
): Promise<boolean> {
  const subtle = getCrypto().subtle;
  let key: CryptoKey;
  try {
    key =
      publicKey instanceof Uint8Array
        ? await subtle.importKey("raw", publicKey as BufferSource, ED25519, false, ["verify"])
        : publicKey;
  } catch {
    return false;
  }
  try {
    return await subtle.verify(
      ED25519,
      key,
      fromBase64(document.sig) as BufferSource,
      documentSigningBytes(document) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** @deprecated Use {@link documentSigningBytes}. Kept for the receipt vocabulary. */
export const receiptSigningBytes = documentSigningBytes;
/** @deprecated Use {@link documentSigningPayload}. */
export const receiptSigningPayload = documentSigningPayload;

export async function signReceipt(receipt: UnsignedReceipt, signer: Signer): Promise<Receipt> {
  return signDocument(receipt, signer);
}

/** Verify a receipt against a raw 32-byte Ed25519 public key. */
export async function verifyReceipt(
  receipt: Receipt,
  publicKey: Uint8Array | CryptoKey,
): Promise<boolean> {
  return verifyDocument(receipt, publicKey);
}

/** Export a public key for the merchant to pin. */
export async function publicKeyHex(signer: Signer): Promise<string> {
  return toHex(await signer.publicKey());
}
