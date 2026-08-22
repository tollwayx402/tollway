# `@octroi/gate`

Batteries-included Octroi: the protocol core, the Express binding, and the
Coinbase facilitator in one install — plus the `doctor` CLI.

```bash
npm install @octroi/gate express
```

```ts
import express from "express";
import { octroi, coinbaseFacilitator } from "@octroi/gate";

const app = express();
app.use("/v1/report", octroi({
  price: "$0.004",
  network: "base",
  payTo: process.env.OCT_ADDRESS,
  facilitator: coinbaseFacilitator(),
}));
```

Prefer the individual packages (`@octroi/core`, `@octroi/express`,
`@octroi/coinbase`) when you want a different framework or facilitator —
nothing here is required, and this package re-exports all of them.

## `doctor`

```bash
npx @octroi/gate doctor --pay-to 0xYourAddress --network base-sepolia
```

```
octroi doctor — https://x402.org/facilitator

  pass  config is valid
  pass  price parses to atomic units — $0.004 → 4000 atomic units of usdc
  pass  a receipt signing key is available — ephemeral (standalone) …
  pass  coinbase: buildChallenge returns a complete scheme
  pass  coinbase: verify returns a rejection value for a bad payload, never throws
  pass  clock skew is within tolerance — 631ms (rtt 91ms)
  skip  self-payment — no OCT_AGENT_KEY …

No failures, but 2 check(s) could not run. This is not a clean bill.
```

What it checks:

1. **Config** — the full §3.1 validation: price parsing, `payTo`, facilitator
   coverage of every configured network, the replay-TTL floor. If this fails,
   doctor stops: nothing downstream would mean anything.
2. **Facilitator** — the shared §11 conformance suite, against your real
   facilitator.
3. **Clock skew** — measured against the facilitator's own clock. This is where
   our challenge expiry meets their timestamp validation, and a drifting clock
   presents as "payments randomly stopped working".
4. **Self-payment** — stands up a real server on your config and pays it with
   the reference x402 client: challenge, client parsing, verify, settle,
   receipt signature, and replay refusal. Needs `OCT_AGENT_KEY`
   (a testnet wallet) and `viem` + `x402-fetch` installed.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | everything checked, everything passed |
| `1` | at least one check failed |
| `2` | nothing failed, but something could not be checked |

`2` exists deliberately. A doctor that reports green because it skipped the
hard part is worse than no doctor, so a skipped check is never counted as a
pass — and a script can tell "all good" from "could not tell".

### Options

```
--config <path>          module whose default export is the gate options
--price / --network / --pay-to / --asset / --mode
--facilitator-url <url>  env: OCT_FACILITATOR
--agent-key <0x…>        env: OCT_AGENT_KEY
--skip-self-payment      config, facilitator and skew only
--json                   machine-readable
```

`--config` is the honest option for a real deployment: point it at a module
exporting the same options your server uses, so doctor checks *your* gate
rather than an approximation of it.
