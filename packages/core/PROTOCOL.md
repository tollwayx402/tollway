# Wire protocol — `@octroi/core`

**x402 revision pinned: `x402Version: 1`** (constant `X402_VERSION` in `src/challenge.ts`).

Spec drift is a versioned adapter concern (sdk spec §4.1): when x402 revises its
encoding, core gains a second encoder keyed on the revision, and facilitator
adapters declare which revisions they speak. Core never silently follows a
moving target.

### Drift is already here — measured, not speculated

`GET https://x402.org/facilitator/supported` on **2026-08-12** returned:

```json
{"kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:84532"},
          {"x402Version":2,"scheme":"upto","network":"eip155:84532","extra":{…}},
          {"x402Version":2,"scheme":"batch-settlement","network":"eip155:84532"}, …]}
```

Three differences from what we and the reference client speak:

1. **`x402Version: 2`**, where we and `x402@1.2.0` both send `1`.
2. **CAIP-2 network ids** (`eip155:84532`), where we send `base-sepolia`.
3. **New schemes**: `upto` and `batch-settlement` alongside `exact`.

The v1 shape is still accepted — a v1 `/verify` was processed, not refused — so
nothing is broken today, and the client library everyone actually uses is still
v1. But the facilitator is ahead of the client, and this is the seam where that
will first hurt.

What this does **not** justify is guessing at v2. `accepts` entries must keep
matching what the *client* parses, and the client is v1. The move, when it
comes, is: read `/supported`, negotiate a revision per facilitator, and keep a
v1 encoder for as long as clients send v1. That is step-6 work
(multi-network/multi-scheme), not something to retrofit blind.

Adapters should also expect reason strings **outside** the documented enum: the
live facilitator returns `invalidReason: "unexpected_error"` (with an extra
`invalidMessage`) on a malformed payload, which `x402@1.2.0`'s `ErrorReasons`
does not contain. Map unknown reasons to a safe rejection; never assume the
enum is exhaustive.

## 1. Challenge (402)

An unpaid request gets `402` with `content-type: application/json` and:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "4000",
      "resource": "https://api.example.com/v1/report",
      "description": "Access to /v1/report",
      "mimeType": "application/json",
      "payTo": "0x…",
      "maxTimeoutSeconds": 120,
      "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "extra": { "nonce": "…", "expiresAt": 1765432220 }
    }
  ],
  "error": "payment_required",
  "errorDetail": {
    "code": "payment_required",
    "message": "This route costs 0.004000 USDC.",
    "doc": "https://octroi.ai/docs/errors#payment_required"
  }
}
```

`accepts` entries are produced by the facilitator adapter — core supplies the
requirements (amount, `payTo`, nonce, expiry) and the adapter decides how to
express them on its network. With several networks configured, one entry per
network is advertised in configured order (§5).

**`resource` must be an absolute URL.** x402 validates it as one, so a bare path
produces a challenge the agent's client rejects. Adapters pass `req.url`;
merchants whose adapter cannot supply an origin set `resourceBase`. When neither
yields an absolute URL, core returns `500 invalid_resource` and emits
`gate.error` rather than putting an unusable challenge on the wire.

### `error` is a superset, not a replacement

x402 defines `error`, and §10 of the SDK spec requires every 4xx/5xx body to
carry `{ code, message, doc }`. Both are satisfied:

- **`error`** keeps the spec's name and type.
- **`errorDetail`** carries the §10 envelope for humans and merchant tooling.

The reasoning: the party parsing a 402 body is the *agent's* client library, not
the merchant. Replacing a spec-typed field with an object of our own would break
retry loops on the agent side — in someone else's code, invisible to our own
tests. Bodies that x402 does not define (`500`, `503`) keep the plain §10 shape,
with the envelope under `error`.

Use `readErrorDetail(body)` rather than reaching for either key directly.

#### `error` is a closed enum, not free text

Verified against `x402@1.2.0` (`test/interop.test.ts`, run in CI):
`x402ResponseSchema` types `error` as an **optional enum of fixed reasons**. Our
own codes fail `parse` outright. So core maps onto the enum and keeps the
precise code in `errorDetail.code`:

| Octroi code | x402 `error` | Note |
| --- | --- | --- |
| `payment_required` | *omitted* | a first contact is not one of the enum's reasons |
| `invalid_payment` | `invalid_payment` | |
| `expired` | `payment_expired` | |
| `wrong_network` | `invalid_network` | |
| `wrong_amount` | `invalid_payment` | no generic underpayment reason exists; the value-level ones are chain-specific |
| `replay` | `duplicate_settlement` | exact match |

`network` is a closed enum client-side too. A custom network id does not merely
go unrecognised — it makes the whole `accepts` entry unparseable for the agent.

#### What the reference client actually reads

`x402-fetch@1.2.0` destructures `{ x402Version, accepts }` and **ignores
`error`**, then `PaymentRequirementsSchema.parse`s every `accepts` entry. Two
consequences:

- The `accepts` entries are the load-bearing part. An invalid one fails the
  agent's payment attempt outright.
- It retries **once** (`__is402Retry`), then throws "Payment already attempted".
  Re-advertising `accepts` on a rejection is still right for other clients, but
  do not assume an agent will act on it.

Still open for the live testnet run: whether CDP's own facilitator surfaces
reasons we should map more precisely than `invalid_payment`.

## 2. Payment

The agent retries with the `X-PAYMENT` header: base64 of

```json
{ "x402Version": 1, "scheme": "exact", "network": "base", "payload": { … } }
```

Core also accepts an unencoded JSON object in the header — strictly a debugging
affordance, not part of the protocol.

`payload` is opaque to core and belongs to the scheme/facilitator, with two
exceptions core reads best-effort:

- **expiry** — `payload.validBefore`, `payload.expiresAt`, or
  `payload.authorization.validBefore` (unix seconds, number or numeric string).
  A lapsed value is rejected as `expired` without spending a facilitator call.
  If none is present, expiry is entirely the facilitator's judgement.
- **nonce** — `payload.nonce` or `payload.extra.nonce`. When present it is
  re-bound into the `ChallengeRequest` handed to `verify`, so adapters that
  echo the challenge nonce can check it.

## 3. Success

- `200` (whatever the handler returns) with `x-octroi-receipt: <receipt id>`.
- `toll.settled` carries the full receipt; `x-octroi-receipt` carries only the
  id, since the receipt object exceeds a comfortable header budget.

## 4. Failure

`402` again, same body shape, with `error.code` one of:

| code              | meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `invalid_payment` | missing, malformed, or facilitator-rejected payload  |
| `expired`         | authorization lapsed before verification             |
| `wrong_amount`    | settled less than the route's price                  |
| `wrong_network`   | paid on a network this route does not accept         |
| `replay`          | this payload (or its transaction) was already used   |

Non-payment failures use their own codes and statuses: `503`
`facilitator_unreachable` (fail_closed), `500` `invalid_config`, `500`
`no_scheme_available`.

## 5. Replay protection

The replay identity of a payment is `sha256` over the canonical JSON of
`{ scheme, network, payload }`, stored as `pay:<hash>`. After a successful
verification core also burns `tx:<network>:<txRef>`, so re-wrapping the same
settled transaction in a fresh payload is caught too.

Two properties this buys:

- **No facilitator cooperation required.** Nothing depends on a facilitator
  echoing a server-issued nonce, which not every scheme does.
- **Failed payments stay retriable.** Keys are consumed *after* a successful
  verify, so a payload rejected for a transient reason can be resubmitted.

### Deployment shape decides whether this actually protects you

The default store is an in-memory LRU (10k entries, 15-minute TTL). **Replay
protection is therefore per-process.** Two instances behind a load balancer each
keep their own set of burned payloads, so the same payment presented to instance
A and then instance B is accepted twice. This is a property of the default, not
of the protocol.

Multi-instance deployments **must** pass a shared `NonceStore`. The interface is
two methods so a Redis implementation is an `EXISTS` and a `SET NX PX`.
`consume` **must** be atomic: correctness depends on exactly one caller getting
`true`. A non-atomic implementation (read, then write) reintroduces the hole
under concurrency, which is exactly when it will be exercised.

Until the Redis store ships, the honest statement is: single instance, or
`fail_open` risk you have accepted deliberately.

### Two floors on `replayTtlMs`

1. **The challenge window.** A payment may be presented at any point before the
   challenge expires, so forgetting it sooner leaves a window where a replay
   sails through — evicted from the store, still valid on the wire. `Gate`
   enforces `replayTtlMs >= expirySeconds * 1000` at construction and refuses to
   start otherwise.
2. **The facilitator's settlement window**, which the SDK cannot see. If a
   facilitator will still settle a payload after our TTL lapses, raise the TTL
   to cover it.

The 10k-entry cap is a third, quieter floor: at high volume, entries can be
evicted by *pressure* well before their TTL. Size the store for peak
challenge-window throughput, or use a store that does not evict early.

## 6. Receipts

Signature covers the canonical JSON (§7) of the receipt **minus `sig`**,
Ed25519, encoded base64url without padding.

Standalone mode generates an ephemeral key at first use: receipts verify inside
the merchant's own system for the life of the process. Cloud mode passes the
account key, making receipts portable and third-party verifiable.

The key id is deliberately *not* in the receipt. Callers verify against a key
they already trust (`gate.publicKey()`), rather than one the receipt names.

## 7. Canonical JSON

Signing and the cross-language golden files depend on byte-identical
serialization, so `canonicalJson` is stricter than `JSON.stringify`:

- object keys sorted by UTF-16 code unit, no insignificant whitespace
- `undefined` properties dropped; `undefined` array entries become `null`
- non-integer and non-finite numbers **rejected** — float formatting differs
  between languages, so fractional values are decimal strings (this is why
  receipt `amount` is `"4000"`, not `4000.0`)
- bigints rejected — encode as decimal strings
- non-ASCII stays literal; the contract is UTF-8 bytes, not `\u` escapes
- strings must be well-formed UTF-8 (no lone surrogates)

## 8. Event accounting

`challenge.issued` counts **unpaid first contacts** only. A 402 re-issued after
a rejection re-advertises `accepts` in its body but emits `toll.rejected`, not a
second `challenge.issued` — otherwise a retry loop would inflate challenge
counts and skew the reject rate the dashboard derives (sdk spec §8).

### Funnel definitions — normative for dashboard queries

Step 4 queries must be written against these definitions. They are the reason
the emission rule above exists; a query that assumes "every 402 emits
`challenge.issued`" will silently disagree with the SDK.

| Metric | Definition |
| --- | --- |
| Challenges | `count(challenge.issued)` — one per unpaid first contact |
| Verification attempts | `count(toll.settled) + count(toll.rejected)` |
| Reject rate | `count(toll.rejected) / verification attempts` |
| Conversion | `count(toll.settled) / count(challenge.issued)` |
| Revenue | `sum(toll.settled.data.receipt.amount)`, atomic units, grouped by asset |
| Refund candidates | `request.failed` whose `receipt_id` is non-null |

Consequences worth stating outright, because each looks like a bug otherwise:

- **Reject rate can exceed 100% of challenges.** One challenge can produce many
  rejected attempts. It cannot exceed 100% of *attempts*, which is why the
  denominator is attempts.
- **Conversion can exceed 100%.** A client that caches a challenge and pays a
  later request settles without a fresh `challenge.issued`.
- **`request.served` with `receipt_id: null` is a `fail_open` pass-through**, not
  revenue. Exclude it from paid-traffic counts or it will flatter the numbers.

`request.failed` is emitted when the downstream handler returns `>= 500` or the
adapter reports an error — those are the refund candidates.

Under `fail_open`, an unpaid request that gets served emits `gate.error` then
`request.served` with `receipt_id: null`. There is no receipt, because nothing
was paid.

## 9. What core does not do

Deliberately out of scope for this package: HTTP framework binding (adapters),
facilitator implementations, the cloud ingest client and remote config, and the
§9 rate limiting / denylist. Each has a build-order slot of its own.
