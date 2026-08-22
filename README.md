# Octroi

Toll gates for HTTP routes: return a 402, verify the payment, serve the 200.
Works with no Octroi account; the cloud is additive (`specs/sdk.md` §1).

## Status

Build order is `specs/sdk.md` §12.

| Step | Package | State |
| --- | --- | --- |
| 1 | `packages/core` — challenge, verify pipeline, events, receipts, nonce cache | **done** |
| 2 | `packages/coinbase` + Base Sepolia e2e ← first demo | **done**, live run pending credentials |
| 3 | `packages/express` + `packages/gate` (`doctor`) + examples | **done** |
| 4 | `packages/ingest` + `services/ingest` + dashboard v1 | **done** |
| 5 | `packages/hono`, `packages/python` (core + FastAPI) | **done** |
| 6 | `payai` adapter (Solana), multi-network challenges | ⚠️ Solana adapter pending; multi-network EVM done |

**Sweep (post-step-5):** all 15 client-parseable EVM networks with verified
asset facts, settleability-gated with a `doctor` /supported check · §9 rate
limits + denylist (TS + Py) · `octroi-ingest` Python cloud client ·
FastAPI + Workers examples · Dockerfile + self-served `/docs/errors`.

The reference `x402-fetch` client pays a Octroi gate end to end in CI, with no
funds and no network (`packages/coinbase/test/client-walk.test.ts`). The live
Base Sepolia run is written and wired to a nightly workflow; it needs a
faucet-funded wallet to have ever run for real.

```bash
npx @octroi/gate doctor --pay-to 0xYourAddress --network base-sepolia
```

## Layout

```
packages/core/      protocol logic, framework-agnostic   (MIT)
packages/coinbase/  CDP facilitator adapter, Base        (MIT)
packages/express/   Express middleware                   (MIT)
packages/gate/      umbrella install + `doctor` CLI      (MIT)
packages/hono/      Hono middleware, edge-ready           (MIT)
packages/python/    Python core + FastAPI adapter        (MIT)
packages/ingest-py/ Python cloud event client            (BSL)
packages/ingest/    cloud event client + signed config   (BSL)
services/ingest/    cloud ingest API + dashboard v1      (BSL)
examples/           Express + Base, in 20 lines
golden/             cross-language byte fixtures (§11)
specs/sdk.md        the build contract
```

Licensing follows §2: everything a merchant needs is MIT, and no MIT package
depends on the BSL ones — `@octroi/express` loads `@octroi/ingest` lazily as
an optional peer, so a standalone install has no BSL code in its tree.

## Develop

```bash
pnpm install
pnpm -r test
pnpm -r build
```

Node 20+ (WebCrypto Ed25519). Start with `packages/core/README.md`, then
`packages/core/PROTOCOL.md` for the wire format.

Python:

```bash
cd packages/python
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

The Python port reproduces the TypeScript wire format byte for byte — the
fixtures in `golden/` are the contract, and both suites are held to them in CI.

## Licensing

Octroi is **open core**.

- **The SDK is MIT — free forever, no account required.** Everything a merchant
  needs to gate a route, return a 402, verify payment, and issue receipts:
  `@octroi/core`, `@octroi/express`, `@octroi/hono`, `@octroi/coinbase`,
  `@octroi/gate`, and the Python `octroi` package.
- **The cloud pieces are BUSL-1.1 (source-available).** `@octroi/ingest`,
  `octroi-ingest` (Python), and `services/ingest`. You can read them, and run
  them to send or ingest **your own** telemetry (including self-hosting). You
  may not offer them, or a derivative, as a hosted or managed service to third
  parties. Each converts to MIT on its Change Date (2030-08-12).

| Package | License |
| --- | --- |
| `@octroi/core`, `/express`, `/hono`, `/coinbase`, `/gate` | MIT |
| `octroi` (Python) | MIT |
| `@octroi/ingest`, `octroi-ingest`, `services/ingest` | BUSL-1.1 |

The MIT SDK never depends on the BSL packages — a standalone install pulls no
BSL code. See each package's `LICENSE`, and `LICENSE` at the root for the MIT
text. Octroi's own hosted cloud is a separate, commercial product built on
these foundations.
