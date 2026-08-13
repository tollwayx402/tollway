# Hono on Cloudflare Workers + Base

The Express example's 20 lines, running at the edge. Same protocol, same
facilitator — core is WebCrypto and `fetch` throughout, so there is nothing to
port.

```bash
pnpm install
pnpm dev            # wrangler dev → http://localhost:8787/v1/report
```

```bash
curl -i http://localhost:8787/v1/report          # → 402 with the challenge
cd ../express-base && TW_AGENT_KEY=0x… node agent.js http://localhost:8787/v1/report
```

Deploy:

```bash
wrangler secret put TW_ADDRESS
pnpm deploy
```

## The two per-isolate caveats

Workers runs many isolates, and the SDK's defaults are per-process:

1. **Replay protection** — the default in-memory `NonceStore` means the same
   payment presented to two isolates is accepted twice. Back it with a Durable
   Object or KV (`nonceStore: yourSharedStore`) for anything that matters.
2. **Receipt keys** — a standalone gate signs with an ephemeral key per
   isolate, so receipts from one isolate will not verify against another's
   public key. Store an Ed25519 JWK as a secret and pass
   `signer: createSignerFromJwk(JSON.parse(env.TW_SIGNING_JWK))`.

The example is itself under test (`pnpm test`): the app runs against
`app.request` with a stubbed env, no wrangler needed.
