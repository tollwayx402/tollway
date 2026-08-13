/**
 * Hono on Cloudflare Workers + Base.
 *
 * The same 20-line shape as the Express example. Everything here — core,
 * adapter, facilitator — is WebCrypto and fetch, no Node builtins, which is
 * what lets one build run on Workers, Deno, Bun and Node alike.
 */
import { Hono } from "hono";
import { tollway } from "@tollway/hono";
import { coinbaseFacilitator } from "@tollway/coinbase";

type Env = { TW_ADDRESS: string };

const app = new Hono<{ Bindings: Env }>();

// Built once per isolate, on first request (env is not available at module
// scope on Workers).
let middleware: ReturnType<typeof tollway> | undefined;

app.use("/v1/report", (c, next) => {
  middleware ??= tollway({
    price: "$0.004",
    network: "base-sepolia",
    payTo: c.env.TW_ADDRESS,
    facilitator: coinbaseFacilitator(),
    // Per-isolate caveats (see @tollway/hono README): replay protection and
    // the ephemeral receipt key are per-isolate with the defaults. Pass a
    // shared NonceStore (Durable Object / KV) and a stored signer
    // (createSignerFromJwk) for anything that matters.
  });
  return middleware(c, next);
});

app.get("/v1/report", (c) =>
  c.json({ report: "the paid content", servedFrom: "a cloudflare worker" }),
);

export default app;
