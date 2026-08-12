# `@tollway/express`

Express middleware for Tollway. Gate a route, get paid, serve the 200.

```ts
import { tollway } from "@tollway/express";

app.use("/v1/report", tollway({
  price: "$0.004",                 // USD string, atomic bigint, or (req) => Price
  asset: "usdc",
  network: "base",
  payTo: process.env.TW_ADDRESS,
  facilitator: "coinbase",
  mode: "fail_closed",
  onEvent: (e) => log.info(e),
}));
```

Everything is `@tollway/core`'s `GateOptions`, plus:

| Option | |
| --- | --- |
| `route` | label for events and receipts; defaults to the mount path, never the query string. A function gets the raw request. |
| `apiKey` | reserved for cloud events (§12.4). Passing it today logs a warning — it does not silently ship your events anywhere. |

The middleware exposes `.gate` for event sinks, `publicKey()`, and `doctor`.

## What it does

- **Unpaid** → `402` with the challenge body, handler never runs.
- **Paid** → sets `x-tollway-receipt`, calls `next()`.
- **After the response** → reports the outcome. `finish` with `< 500` is
  `request.served`; `>= 500` is `request.failed`. A client that hangs up before
  the response completes is *also* `request.failed` — they paid and got
  nothing, which is a refund candidate, not a sale.
- **Merchant misconfiguration** → passed to your error middleware via
  `next(error)`, rather than inventing a response shape. (A price function that
  throws is handled by the gate itself as a `500 invalid_config`, because a
  route that cannot be priced must never be served.)

Dynamic pricing gets the Express request:

```ts
tollway({ price: (req) => (req.raw as Request).query.deep ? "$0.02" : "$0.004", … })
```

## Behind a proxy

The x402 `resource` is built from `req.protocol` + `Host` + `req.originalUrl`,
and x402 requires it to be an absolute URL. `req.protocol` honours Express's
`trust proxy`, so behind a TLS-terminating proxy **set it**:

```ts
app.set("trust proxy", true);
```

Without it you advertise `http://` for an HTTPS route. Alternatively pin
`resourceBase` on the gate and stop depending on the `Host` header entirely.
