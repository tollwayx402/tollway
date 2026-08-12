# `@tollway/coinbase`

The Coinbase/CDP x402 facilitator adapter: Base and Base Sepolia, USDC.

## Use

```ts
import { createGate } from "@tollway/core";
import { coinbaseFacilitator } from "@tollway/coinbase";

const gate = createGate({
  price: "$0.004",
  network: "base",
  payTo: process.env.TW_ADDRESS!,
  facilitator: coinbaseFacilitator(),
});
```

Against CDP's hosted facilitator, supply auth headers. The adapter never sees a
key — you hand it a function that returns headers:

```ts
coinbaseFacilitator({
  url: CDP_FACILITATOR_URL,
  createAuthHeaders: () => createCdpAuthHeaders(),  // from @coinbase/x402
});
```

`registerCoinbaseFacilitator()` registers the same adapter under the id
`"coinbase"`, so `facilitator: "coinbase"` resolves by string.

## Things worth knowing

**Settlement happens during verification.** `verify()` calls the facilitator's
`/verify` and then `/settle`, so money moves before your handler runs. That is
the safe order for a merchant, and it means a request that later 500s has
already been paid — which is exactly what `request.failed` exists to flag as a
refund candidate (core §7). Pass `settle: false` to verify only.

**`extra` is the EIP-712 domain, not a metadata slot.** The payer signs an
EIP-3009 authorization over `{name, version}`, and those values genuinely
differ between networks — mainnet USDC is `"USD Coin"`, Base Sepolia's is
`"USDC"`. A wrong value produces signatures that fail verification with no
useful error. This is also why the challenge nonce is not carried there; core
keys replay protection on the payload hash instead.

**Outages are not rejections — but a verdict is a verdict.** A non-JSON body,
a body with no verdict, a transport failure, or a timeout raises
`FacilitatorUnreachableError`, letting the merchant's `fail_open`/`fail_closed`
choice decide. A payer is never told their payment is bad because our
facilitator had a bad minute.

The escalation bar differs by stage, deliberately:

- **Verify stage:** any answered `isValid: false` is a rejection — including
  `unexpected_verify_error`. The payload is attacker-controlled input, so if a
  crafted payload that crashes the facilitator's verify counted as an outage,
  `fail_open` would be a free-content bypass. Only
  `invalid_payment_requirements` escalates: it means *our* requirements are
  malformed, which no payer can cause.
- **Settle stage:** `unexpected_settle_error`, confirmation timeouts, and state
  races escalate, because money may have moved without a usable answer.
  Calling the payment "bad" there could be a lie.

Even so, `fail_open` remains what it says: a genuine facilitator outage serves
content unpaid, and outages can be induced from outside our input path (e.g.
traffic floods). Merchants gating anything expensive should run `fail_closed`
and treat `gate.error` spikes as an alert, not a shrug.

## Tests

```bash
pnpm --filter @tollway/coinbase test
```

Three suites, none of which touch the network:

- **`adapter.test.ts`** — the HTTP contract, replayed from
  `test/fixtures/exchanges.json`.
- **`conformance.test.ts`** — the shared §11 contract suite from
  `@tollway/core`, plus clock-skew handling.
- **`client-walk.test.ts`** — the **official** `x402-fetch` client walking
  402 → pay → 200 against a real HTTP server running our gate. The client signs
  with a throwaway key; signing is free, so this needs no funds. This is the
  test that catches breakage in the part we do not control.

### Fixtures

`test/fixtures/exchanges.json` carries a `_provenance` block saying whether its
entries were recorded from a live facilitator or hand-authored. Either way,
every response body is validated against `x402@1.2.0`'s own
`VerifyResponseSchema` / `SettleResponseSchema`, so a fixture cannot drift into
a shape the real facilitator would never send.

To record real ones (needs a funded Base Sepolia wallet):

```bash
TW_AGENT_KEY=0x… TW_PAY_TO=0x… pnpm --filter @tollway/coinbase record
```

## The live run

```bash
TW_AGENT_KEY=0x… TW_PAY_TO=0x… pnpm --filter @tollway/coinbase e2e:testnet
```

Manual, or nightly via `.github/workflows/nightly.yml` — **never in PR CI**.
It depends on a faucet and a third party, and a build that goes red for reasons
outside the diff teaches everyone to ignore red builds.

It checks the things fixtures structurally cannot:

- the payer on the receipt is the account that actually signed
- the amount that settled is the amount advertised
- real reason strings from the facilitator, to sharpen `src/reasons.ts`
- clock skew against the facilitator's own clock

## Open watch items

1. **Reason mapping is coarse in one place.** `wrong_amount` maps from
   `invalid_exact_evm_payload_authorization_value`; anything unrecognised falls
   back to `invalid_payment`. The live run prints the reasons CDP actually
   sends — use them to sharpen `src/reasons.ts`.
2. **The skew thresholds are provisional.** `SKEW_WARN_MS` (5s) and
   `SKEW_CRITICAL_MS` (30s) in `src/skew.ts` are guesses until measured against
   real facilitator behaviour. This is where our challenge expiry meets their
   timestamp validation, so `doctor` (§12.3) should adopt whatever the live run
   shows, not these numbers.
3. **`settle.ok` is the fixture most worth recording for real.** A successful
   settlement is the one exchange that cannot be honestly fabricated.
