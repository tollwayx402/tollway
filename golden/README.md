# Golden files

Byte-level cross-language fixtures (sdk spec §11): the same inputs must produce
byte-identical challenges, receipts and events in TypeScript and Python.

| File | Contents |
| --- | --- |
| `challenge.json` | canonical JSON of the 402 body for an unpaid request |
| `receipt.json` | canonical JSON of the signed receipt for the fixed payment |
| `events.json` | canonical JSON of one full challenge → settle → serve stream |

These are **canonical** JSON (sorted keys, no whitespace), not pretty-printed —
the point is the bytes. Each file has a trailing newline that comparisons strip.

## The fixed inputs

Defined in `packages/core/test/fixtures/golden-case.ts`, and reproduced by the
Python port:

- clock: `1765432100000` ms, frozen
- nonce: `9f86d081884c7d659a2feaa0c55ad015`
- ids: `oct_rcpt_000001`, `oct_evt_000001…`
- signing key: the throwaway Ed25519 JWK in
  `packages/core/test/fixtures/keys.ts` — **not a secret, never sign anything
  real with it**
- facilitator: the `golden` mock — scheme `exact`, asset address
  `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, echoes `{nonce, expiresAt}` in
  `extra`, and settles exactly what the payload claims
- route `/v1/report` at `$0.004` usdc on base, `payTo`
  `0xmerchant000000000000000000000000000000ff`, merchant `acct_9d2`
- payment: `txRef 0xdeadbeef`, payer
  `0xabc0000000000000000000000000000000000001`, amount `4000`
- served with `status: 200`, `latencyMs: 37`

Ed25519 is deterministic, so a fixed key gives a fixed signature — that is what
makes `receipt.json` comparable across languages at all.

## Changing them

A diff here is a protocol change. Regenerate only when you mean it:

```bash
cd packages/core && UPDATE_GOLDEN=1 pnpm test
```

Then review the diff as a wire-format change, and re-run the Python suite.
