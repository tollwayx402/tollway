# `@tollway/core`

The Tollway protocol core: 402 challenges, payment verification, receipts,
events and replay protection. No framework, no chain client, no cloud.

Framework adapters (`@tollway/express`, `@tollway/hono`, `tollway[fastapi]`) do
three things: map their request onto `GateRequest`, render a halt, and report
the outcome. That is the whole adapter contract, and it is why they fit in 150
lines.

## Install

```bash
npm install @tollway/core
```

Requires WebCrypto with Ed25519: Node 20+, Deno, Bun, or Workers.

## Use

```ts
import { createGate } from "@tollway/core";

const gate = createGate({
  price: "$0.004",              // USD string, atomic bigint, or (req) => Price
  asset: "usdc",
  network: "base",              // or ["base", "solana"] — ordered, all advertised
  payTo: process.env.TW_ADDRESS!,
  facilitator: "coinbase",      // registered id, or an adapter instance
  mode: "fail_closed",          // or "fail_open" — explicit, never silent
  onEvent: (e) => log.info(e),
});

const result = await gate.handle({
  method: req.method,
  route: "/v1/report",
  url: req.url,
  headers: req.headers,
});

if (result.type !== "pass") {
  res.status(result.status).set(result.headers).json(result.body);
  return;
}

res.set(result.headers);                       // x-tollway-receipt: twy_rcpt_…
const started = Date.now();
await handler(req, res);
result.report({ status: res.statusCode, latencyMs: Date.now() - started });
```

`handle` never throws for a payer-side fault — every payment failure comes back
as a `GateHalt` you render. It throws only for merchant misconfiguration, and
`createGate` throws at boot for anything it can catch there (a mistyped price, a
missing `payTo`, a network no configured facilitator supports).

## Shape of the API

| Export | What it is |
| --- | --- |
| `createGate` / `Gate` | the protocol pipeline (§4) |
| `FacilitatorAdapter` | the four-member interface every facilitator implements (§5) |
| `registerFacilitator` | makes `facilitator: "coinbase"` resolvable, without core depending on the adapter |
| `Receipt`, `signReceipt`, `verifyReceipt` | signed proof that a request was paid (§6) |
| `EventBus`, `TollwayEvent` | the event stream the dashboard is a pure function of (§7) |
| `NonceStore`, `MemoryNonceStore` | replay protection; swap in Redis for multi-instance |
| `parsePrice`, `canonicalJson` | the two things easiest to get subtly wrong |

`@tollway/core/testing` ships a mock facilitator, a deterministic clock and id
generator, and payload helpers — used by the adapter contract-test suite.

## Reading order

- `PROTOCOL.md` — the wire format, the pinned x402 revision, and the reasoning
  behind the replay and event-accounting models.
- `src/gate.ts` — the pipeline itself, in order.

## Test

```bash
pnpm test
```

`golden/` at the repo root holds the byte-level cross-language fixtures (§11).
Regenerate deliberately: `UPDATE_GOLDEN=1 pnpm test`.
