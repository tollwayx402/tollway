# `@tollway/hono`

Hono middleware for Tollway. Runs on Cloudflare Workers, Deno, Bun and Node
from the same build.

```ts
import { Hono } from "hono";
import { tollway } from "@tollway/hono";
import { coinbaseFacilitator } from "@tollway/coinbase";

const app = new Hono();

app.use("/v1/report", tollway({
  price: "$0.004",
  network: "base",
  payTo: c.env.TW_ADDRESS,
  facilitator: coinbaseFacilitator(),
}));

app.get("/v1/report", (c) => c.json({ report: "the paid content" }));
```

## Why this one is simpler than Express

Hono's `next()` returns when the handler is done, so the outcome is reported at
a plain `await` rather than through response events. And `c.req.url` is always
absolute, so the x402 `resource` needs no `resourceBase` and no `trust proxy`
— there is no Host header to reconstruct it from.

Route labels come from `c.req.routePath`, so `/v1/:kind` is one label rather
than one per parameter value.

## Workers

`@tollway/core` and this package import **no** Node builtins and use no
Node-only globals: crypto is WebCrypto, encoding is `TextEncoder`/`btoa`,
transport is `fetch`. A test (`test/portability.test.ts`) enforces that over
the source, because a stray `import { randomBytes } from "node:crypto"`
compiles fine, passes tests on Node, and only fails at deploy.

Two consequences worth knowing on Workers:

- **Replay protection is per-isolate** with the default in-memory store, and
  Workers gives you many isolates. Pass a shared `NonceStore` backed by Durable
  Objects or KV for anything that matters. This is the same caveat as
  multi-instance Node, only more so.
- **Receipt keys are per-isolate too.** A standalone gate generates an
  ephemeral signing key at first use, so receipts issued by one isolate do not
  verify against another's public key. Pass a `signer` built from a stored key
  (`createSignerFromJwk`) if receipts need to outlive an isolate.

## Client disconnects

Express reports a client that hangs up after paying as `request.failed` — a
refund candidate. Hono has no portable equivalent, so a disconnect mid-response
is reported by whatever status the runtime ends up with. Not a silent gap, just
a smaller one than the Express adapter's.
