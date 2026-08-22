# `@octroi/ingest`

The Octroi Cloud client: batches events to the ingest API, and polls signed
route config.

**BSL 1.1**, unlike the rest of the SDK. Nothing MIT in this repo depends on
it — `@octroi/express` loads it lazily as an *optional* peer — so a standalone
install has no BSL code in its tree, which is what §1.1 requires.

## Events

```ts
import { createIngestClient } from "@octroi/ingest";
import { octroi } from "@octroi/express";

const cloud = createIngestClient({ apiKey: process.env.OCT_KEY! });

app.use("/v1/report", octroi({ …, sinks: [cloud.sink] }));
```

Or let the adapter do it: `octroi({ …, apiKey: process.env.OCT_KEY })`.

Delivery is exactly §7: HTTPS, gzip, at-least-once, flush at 5s or 100 events,
a 10k-event retry buffer, drop-oldest on overflow with a `gate.error` reporting
the loss.

Three properties worth knowing:

- **`sink` never blocks and never throws.** It appends to an array and returns.
  Every network cost is on a timer, because the request path must not pay for
  telemetry.
- **At-least-once means resends carry the same event ids**, and the server is
  idempotent by id. That is what stops a network hiccup from inventing revenue.
- **The overflow report is not buffered.** It rides with the next batch. Held in
  the buffer it would both steal a slot from a real event and — worse — be
  droppable by the next overflow, losing the very notice that says data was
  lost.

A `4xx` is discarded rather than retried (a bad key will never succeed, and
retrying forever means never sending anything again); `5xx` and `429` retry with
exponential backoff and then give up, loudly, rather than growing without bound.

## Signed remote config

```ts
const config = createRemoteConfigClient({
  apiKey: process.env.OCT_KEY!,
  publicKey: process.env.OCT_CONFIG_PUBKEY!,   // pinned, hex
});
config.start();

app.use("/v1/report", octroi({
  price: remotePrice({ config, local: "$0.004" }),
  …
}));
```

This is the only thing in the SDK that lets a remote party change what you
charge, so it refuses more than it accepts:

| Refused | Why |
| --- | --- |
| bad signature | an attacker who can answer the request must not set your prices |
| key from the response | a key fetched from the server it authenticates is not a key — it is **pinned** by you |
| stale config | otherwise replaying an old signed response reverts a price rise forever |
| far-future config | would otherwise pin a config indefinitely |

On any refusal the previous good config stands, and if none ever verified, your
local price applies. **There is no state in which a route becomes unpriced** —
and therefore none in which it becomes free — because the cloud had a bad day.

`configSource: "local"` makes code authoritative and remote config purely
observational (§3.1).

## Self-hosting

`url` points anywhere. `services/ingest` in this repo is a working
implementation of the §8 API, and the client's own tests run against it.
