# Tollway

Toll gates for HTTP routes: return a 402, verify the payment, serve the 200.
Works with no Tollway account; the cloud is additive (`specs/sdk.md` §1).

## Status

Build order is `specs/sdk.md` §12.

| Step | Package | State |
| --- | --- | --- |
| 1 | `packages/core` — challenge, verify pipeline, events, receipts, nonce cache | **done** |
| 2 | `packages/coinbase` + Base Sepolia e2e ← first demo | **done**, live run pending credentials |
| 3 | `express` adapter + examples + `doctor` | next |
| 4 | `ingest` client + cloud ingest + dashboard v1 | |
| 5 | `hono`, then Python core + FastAPI | |
| 6 | `payai` adapter (Solana), multi-network challenges | |

The reference `x402-fetch` client pays a Tollway gate end to end in CI, with no
funds and no network (`packages/coinbase/test/client-walk.test.ts`). The live
Base Sepolia run is written and wired to a nightly workflow; it needs a
faucet-funded wallet to have ever run for real.

## Layout

```
packages/core/      protocol logic, framework-agnostic   (MIT)
packages/coinbase/  CDP facilitator adapter, Base        (MIT)
golden/             cross-language byte fixtures (§11)
specs/sdk.md        the build contract
```

## Develop

```bash
pnpm install
pnpm -r test
pnpm -r build
```

Node 20+ (WebCrypto Ed25519). Start with `packages/core/README.md`, then
`packages/core/PROTOCOL.md` for the wire format.
