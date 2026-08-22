# Octroi SDK specification
**specs/sdk.md · v0.1 · August 2026**

The build contract for `@octroi/gate` (TypeScript) and `octroi` (Python). One protocol core, thin adapters. Everything here is buildable without the cloud; the cloud lights up when an API key is present.

---

## 1. Design principles

1. **Standalone first.** The SDK fully functions with no Octroi account: gate routes, return 402 challenges, verify payments via any facilitator, serve the 200. The cloud is additive, never required.
2. **One core, thin adapters.** Protocol logic (challenge construction, payment verification, receipt emission) lives in a framework-agnostic core. Express/Hono/FastAPI adapters are under 150 lines each. Facilitators are pluggable behind one interface.
3. **Fail open or fail closed is the merchant's choice, explicit, never silent.** If a facilitator is unreachable, default is `fail_closed` (reject with 503). Merchants may opt into `fail_open` (serve without payment) per route.
4. **Zero custody.** The SDK never holds keys or funds. Verification is delegated to facilitators; settlement addresses belong to the merchant.
5. **Events are facts.** Every meaningful moment emits an immutable event. Local sink by default (log/callback); cloud sink when configured. The dashboard is a pure function of the event stream.

## 2. Package layout

```
octroi/
  packages/
    core/          # TS: protocol logic, no framework deps   (MIT)
    express/       # TS adapter                              (MIT)
    hono/          # TS adapter                              (MIT)
    python/        # Python: core + FastAPI adapter          (MIT)
    ingest/        # cloud event client, TS + Py             (BSL)
  specs/
  examples/
```

npm: `@octroi/core`, `@octroi/express`, `@octroi/hono`, `@octroi/ingest`
PyPI: `octroi` (extras: `octroi[fastapi]`)

## 3. Merchant-facing API

### 3.1 TypeScript (Express shown; Hono identical shape)

```ts
import { octroi } from "@octroi/express";

app.use("/v1/report", octroi({
  price: "$0.004",                 // string USD, bigint atomic units, or (req) => Price
  asset: "usdc",
  network: "base",                 // "base" | "solana" | [ordered fallback list]
  payTo: process.env.OCT_ADDRESS,   // settlement address (required standalone)
  facilitator: "coinbase",         // "coinbase" | "payai" | custom adapter instance
  apiKey: process.env.OCT_KEY,      // optional: enables cloud events + remote config
  mode: "fail_closed",             // "fail_closed" | "fail_open"
  onEvent: (e) => log.info(e),     // optional local sink, always called
}));
```

Dynamic pricing: `price: (req) => req.query.deep ? "$0.02" : "$0.004"`.
Per-route config overrides app-level defaults. With `apiKey` set and remote config enabled, dashboard price changes apply within 60s via signed config polling; local config is the fallback and always wins on conflict if `configSource: "local"`.

### 3.2 Python (FastAPI)

```py
from octroi.fastapi import Octroi

tw = Octroi(api_key=os.environ.get("OCT_KEY"), network="base",
             pay_to=os.environ["OCT_ADDRESS"], facilitator="coinbase")

@app.get("/v1/report", dependencies=[tw.gate(price="$0.004", asset="usdc")])
async def report(): ...
```

Same semantics, idiomatic surface. `tw.gate()` returns a FastAPI dependency.

## 4. Protocol flow (core)

1. Request arrives without valid payment → core builds a **402 challenge**: price, asset, network(s), payTo, nonce, expiry (default 120s), and accepted facilitator schemes, encoded per current x402 spec revision (pin the spec version in `core/PROTOCOL.md`; treat spec drift as a versioned adapter concern).
2. Agent retries with payment payload header → core routes to the configured **facilitator adapter** for verification/settlement.
3. On success → core emits `toll.settled`, attaches a **receipt** to the response header `x-octroi-receipt`, and passes the request through.
4. On failure → 402 again with a machine-readable error body (`invalid_payment`, `expired`, `wrong_amount`, `wrong_network`, `replay`).
5. Replay protection: nonce cache (in-memory LRU default; pluggable Redis store interface for multi-instance deployments).

## 5. Facilitator adapter interface

```ts
interface FacilitatorAdapter {
  readonly id: string;                       // "coinbase" | "payai" | ...
  readonly networks: Network[];
  buildChallenge(req: ChallengeRequest): ChallengeScheme;
  verify(payload: PaymentPayload, ctx: VerifyContext): Promise<VerifyResult>;
  // VerifyResult: { ok: true, txRef, settledAmount, payer } | { ok: false, code }
}
```

Ship `coinbase` (Base) and `payai` (Solana) at spec level; build coinbase first. Multi-network config tries networks in order and advertises all in the challenge. A custom adapter can be passed directly, keeping Octroi facilitator-neutral by construction.

## 6. Receipts

Receipt = signed statement that a specific request was paid.

```json
{
  "id": "oct_rcpt_8f3a2c...",
  "v": 1,
  "route": "/v1/report",
  "amount": "4000",
  "asset": "usdc",
  "network": "base",
  "payer": "0xabc...",
  "tx_ref": "0xdef...",
  "ts": 1765432100,
  "merchant": "acct_9d2 | null (standalone)",
  "sig": "ed25519 signature over canonical JSON"
}
```

Standalone mode signs with an ephemeral local key (verifiable within the merchant's own system). Cloud mode signs with the merchant's Octroi account key, making receipts portable/third-party verifiable. Receipt ID always returned in `x-octroi-receipt`; full object available via `onEvent` and, in cloud mode, the receipts API.

## 7. Event schema

All events: `{ id, v: 1, type, ts, route, merchant?, data }`. Types:

- `challenge.issued` — 402 sent (data: price, asset, networks, nonce)
- `toll.settled` — payment verified (data: receipt)
- `toll.rejected` — verification failed (data: code)
- `request.served` — 200 after settlement (data: receipt_id, latency_ms, status)
- `request.failed` — upstream handler errored after payment (data: receipt_id, status) → refund candidate
- `gate.error` — facilitator unreachable etc. (data: mode applied)

Delivery: `onEvent` callback always fires synchronously-safe (never blocks the request path; internal queue). With `apiKey`, the BSL ingest client batches events to `ingest.octroi.ai` (HTTPS, gzip, at-least-once, 5s flush or 100 events, disk-less retry buffer capped at 10k events, drop-oldest with `gate.error` emitted on overflow).

## 8. Cloud ingest API (dashboard contract)

- `POST /v1/events` — batch ingest, API-key auth, idempotent by event id.
- `GET /v1/receipts/:id` — receipt lookup + verification.
- `GET /v1/config` — signed route config (prices, modes) for remote pricing; ETag/60s poll.
- `POST /v1/refunds` — mark receipt refunded (execution manual in v1; automation later).

Dashboard v1 reads: revenue by route/day, tolls by payer, reject rates, refund candidates (`request.failed` after `toll.settled`). All derivable from §7 — no other coupling.

## 9. Spam & abuse (v1 scope)

In-SDK, config-flag simple: per-IP and per-payer challenge rate limits (token bucket), auto-429 above threshold; optional denylist of payer addresses pulled from cloud config. ML/behavioral filtering is explicitly out of scope for v1 — the events exist to build it later.

## 10. Errors, observability, DX

- Structured logger injection (`logger` option), silent by default.
- Every 4xx/5xx body: `{ error: { code, message, doc: "https://octroi.ai/docs/errors#<code>" } }`.
- `npx @octroi/gate doctor` — checks config, facilitator reachability, clock skew, and fires a testnet self-payment end-to-end.
- Examples repo: Express + Base in 20 lines; FastAPI + Base; Hono on Cloudflare Workers.

## 11. Testing bar

- Core: unit tests for challenge build, verify dispatch, nonce replay, price parsing (string/bigint/function), event emission ordering.
- Adapters: contract-test suite every FacilitatorAdapter must pass (mock + testnet).
- E2E: dockerized example server + scripted agent paying on Base Sepolia in CI.
- Cross-language: golden-file tests — same inputs produce byte-identical challenges and receipts in TS and Py.

## 12. Build order

1. `core` (TS): challenge, verify pipeline, events, receipts, nonce cache.
2. `coinbase` adapter + Base Sepolia e2e. **← first demo lives here**
3. `express` adapter + examples + `doctor`.
4. `ingest` client + minimal cloud ingest + dashboard v1 (revenue by route, receipts list).
5. `hono`, then Python core+FastAPI (port with golden files).
6. `payai` adapter (Solana), multi-network challenges.

Milestone gate: after step 3, film the 60-second demo. After step 4, recruit the five design partners.
