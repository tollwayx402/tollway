# Tollway ingest + dashboard v1

The cloud side of §8, and the dashboard §12.4 asks for. BSL, private, not
published.

```bash
TW_API_KEYS='sk_live_abc:acct_9d2' pnpm --filter @tollway/service-ingest start
# → http://localhost:8787
```

## API (§8)

| | |
| --- | --- |
| `POST /v1/events` | batch ingest, API-key auth, idempotent by event id |
| `GET /v1/receipts/:id` | receipt lookup **and** signature verification |
| `GET /v1/config` | signed route config, ETag / 60s poll |
| `POST /v1/refunds` | mark a receipt refunded (v1 marks; it does not move money) |
| `GET /v1/dashboard` | the projections, as JSON |
| `GET /` | the dashboard page |

## Storage: the log is the truth

§1.5 says events are facts and the dashboard is a pure function of the event
stream — so that is literally the design. Events append to a JSONL log per
merchant; every number the dashboard shows is folded from that log, and the
projections are rebuilt by replaying it on boot. A test asserts a cold process
folds its way back to byte-identical numbers.

Consequences that are features: a new dashboard view is a new fold rather than a
migration, and no projection can drift from the events, because there is nothing
else to drift from.

This is v1-honest, not web-scale. When the log outgrows one process the
replacement keeps the shape: log authoritative, projections derived.

## What it refuses

- **Unauthenticated anything.** Missing and wrong keys get byte-identical
  answers, so the endpoint cannot be used to discover which keys exist.
- **Cross-merchant reads and writes.** The authenticated account stamps every
  stored event, so a client cannot write into another account's stream by
  setting `merchant` in the body — and receipts and refunds are scoped on read.
- **Gzip bombs.** Bodies are inflated with the size limit enforced *during*
  decompression, so ~10 KB that would expand to 10 MB is cut off mid-inflate
  rather than buffered and then measured.
- **Trusting its own storage.** `GET /v1/receipts/:id` re-verifies the
  signature against the merchant's registered key and reports `verified: false`
  for a receipt that no longer checks out. With no key registered it returns
  `verified: null` and says why, rather than implying it checked.

## Config

| Env | |
| --- | --- |
| `TW_API_KEYS` | **required** — `apiKey:merchant` pairs, comma-separated |
| `TW_DATA_DIR` | default `./data` |
| `PORT` | default 8787 |
| `TW_CONFIG_SIGNER_JWK` | Ed25519 private JWK; without it `/v1/config` answers 503 |
| `TW_RECEIPT_KEYS` | `merchant:publicKeyHex` pairs, for receipt verification |
| `TW_ROUTES` | JSON of per-merchant route config to serve |

## Not in v1, deliberately

Keys live in an env var and are compared by map lookup — fine for a handful of
design partners, not for a real signup flow. Refunds are marked, not executed
(§8 says so). There is no retention policy, no pagination, and no rate limiting
on ingest. Each is a real gap, and each is cheaper to add once the shape of the
data is known than to guess at now.
