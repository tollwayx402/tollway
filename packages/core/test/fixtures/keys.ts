/**
 * A throwaway Ed25519 key, committed on purpose: the §11 golden files need a
 * fixed signing key so that TS and Python produce byte-identical receipts.
 *
 * NOT A SECRET. Never use this key to sign anything real.
 */
export const FIXED_SIGNING_JWK: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  d: "ZKNe5-iXTmtZuK2pSDpvJzoGfu56DfyBi0kd8_mhDuk",
  x: "0uWeBzd1niqoYVfUexW-vzHi4EUOV8VjxynhWmd0L34",
};

/** Raw public key of {@link FIXED_SIGNING_JWK}, hex. */
export const FIXED_PUBLIC_KEY_HEX =
  "d2e59e0737759e2aa86157d47b15bebf31e2e0450e57c563c729e15a67742f7e";
