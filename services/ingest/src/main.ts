/**
 * Entry point.
 *
 *   TW_API_KEYS='key1:acct_9d2,key2:acct_abc' node dist/main.js
 *
 * Env:
 *   PORT                 default 8787
 *   TW_DATA_DIR          default ./data
 *   TW_API_KEYS          comma-separated `apiKey:merchant` pairs (required)
 *   TW_CONFIG_SIGNER_JWK Ed25519 private JWK for signing GET /v1/config
 *   TW_RECEIPT_KEYS      comma-separated `merchant:publicKeyHex` for receipt verification
 *   TW_ROUTES            JSON: { "acct_9d2": { "/v1/report": { "price": "$0.02" } } }
 */
import { createSignerFromJwk } from "@tollway/core";
import { createServer, type MerchantAccount } from "./server.js";
import { EventStore } from "./store.js";

function parseKeys(): Map<string, MerchantAccount> {
  const raw = process.env["TW_API_KEYS"];
  if (!raw) {
    console.error("TW_API_KEYS is required, e.g. TW_API_KEYS='sk_live_x:acct_9d2'");
    process.exit(1);
  }

  const receiptKeys = new Map<string, string>();
  for (const pair of (process.env["TW_RECEIPT_KEYS"] ?? "").split(",")) {
    const [merchant, key] = pair.split(":");
    if (merchant && key) receiptKeys.set(merchant.trim(), key.trim());
  }

  let routes: Record<string, MerchantAccount["routes"]> = {};
  if (process.env["TW_ROUTES"]) {
    try {
      routes = JSON.parse(process.env["TW_ROUTES"]) as typeof routes;
    } catch {
      console.error("TW_ROUTES is not valid JSON");
      process.exit(1);
    }
  }

  const keys = new Map<string, MerchantAccount>();
  for (const pair of raw.split(",")) {
    const [apiKey, merchant] = pair.split(":");
    if (!apiKey || !merchant) continue;
    const account: MerchantAccount = { merchant: merchant.trim() };
    const receiptKey = receiptKeys.get(merchant.trim());
    if (receiptKey !== undefined) account.receiptPublicKey = receiptKey;
    const routeConfig = routes[merchant.trim()];
    if (routeConfig !== undefined) account.routes = routeConfig;
    keys.set(apiKey.trim(), account);
  }

  if (keys.size === 0) {
    console.error("TW_API_KEYS contained no valid `apiKey:merchant` pairs");
    process.exit(1);
  }
  return keys;
}

async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8787);
  const dataDir = process.env["TW_DATA_DIR"] ?? "./data";
  const keys = parseKeys();

  const configJwk = process.env["TW_CONFIG_SIGNER_JWK"];
  const configSigner = configJwk
    ? await createSignerFromJwk(JSON.parse(configJwk) as JsonWebKey)
    : undefined;

  const app = createServer({
    store: new EventStore(dataDir),
    keys,
    ...(configSigner === undefined ? {} : { configSigner }),
  });

  app.listen(port, () => {
    console.log(`tollway ingest on :${port}  (data: ${dataDir}, accounts: ${keys.size})`);
    if (configSigner === undefined) {
      console.log("no TW_CONFIG_SIGNER_JWK — GET /v1/config will answer 503");
    }
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
