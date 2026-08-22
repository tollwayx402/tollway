/**
 * Record real facilitator exchanges into `test/fixtures/exchanges.json`.
 *
 *   pnpm --filter @octroi/coinbase record
 *
 * Requires a funded Base Sepolia wallet, because a genuine `settle.ok` can only
 * come from a payment that actually settles:
 *
 *   OCT_AGENT_KEY   private key of a wallet holding Base Sepolia USDC
 *   OCT_PAY_TO      settlement address to pay
 *   OCT_FACILITATOR facilitator URL (default: the public one)
 *   OCT_CDP_JWT     bearer token, if pointing at CDP
 *
 * This is a **manual** job. CI replays what it writes; it never runs this.
 * Faucet flakiness must not be able to turn a build red.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createGate, decodePaymentHeader } from "@octroi/core";
import { wrapFetchWithPayment } from "x402-fetch";
import { coinbaseFacilitator, DEFAULT_FACILITATOR_URL } from "../src/index.ts";
import { agentWallet, capturePaymentHeader } from "../dev/agent.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/exchanges.json");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}. See the header of this script.`);
    process.exit(1);
  }
  return value;
}

const facilitatorUrl = process.env["OCT_FACILITATOR"] ?? DEFAULT_FACILITATOR_URL;
const agentKey = required("OCT_AGENT_KEY") as `0x${string}`;
const payTo = required("OCT_PAY_TO");

const recorded: Record<string, unknown> = {};

/**
 * Wraps fetch so each facilitator exchange lands under the exact fixture key
 * the tests read (`keys.verify` / `keys.settle`). Passing a key as `null`
 * discards that exchange instead of recording it.
 */
function recordingFetch(keys: { verify: string | null; settle: string | null }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const response = await fetch(input as string, init);
    const text = await response.clone().text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const path = url.endsWith("/settle") ? "settle" : "verify";
    const key = keys[path];
    if (key === null) {
      console.log(`  discarded ${path} exchange → ${response.status}`);
      return response;
    }
    recorded[key] = {
      path,
      response:
        body === undefined
          ? {
              status: response.status,
              rawBody: text,
              contentType: response.headers.get("content-type") ?? "text/plain",
            }
          : { status: response.status, body },
    };
    console.log(`  recorded ${key} → ${response.status}`);
    return response;
  }) as typeof fetch;
}

async function main() {
  const { account } = agentWallet(agentKey);
  console.log(`recording against ${facilitatorUrl} as ${account.address}\n`);

  const authHeaders = process.env["OCT_CDP_JWT"]
    ? () => {
        const header = { authorization: `Bearer ${process.env["OCT_CDP_JWT"]}` };
        return { verify: header, settle: header };
      }
    : undefined;

  // 1. A payment that verifies and settles.
  console.log("happy path:");
  const gate = createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo,
    resourceBase: "https://record.octroi.local",
    facilitator: coinbaseFacilitator({
      url: facilitatorUrl,
      fetchImpl: recordingFetch({ verify: "verify.ok", settle: "settle.ok" }),
      ...(authHeaders ? { createAuthHeaders: authHeaders } : {}),
    }),
  });

  const challenge = await gate.handle({ method: "GET", route: "/v1/report", headers: {} });
  if (challenge.type !== "challenge") throw new Error(`expected a challenge, got ${challenge.type}`);

  // Drive the reference client to produce a real signed payload.
  const header = await capturePaymentHeader(
    agentKey,
    "https://record.octroi.local/v1/report",
    challenge.body,
  );

  const paid = await gate.handle({
    method: "GET",
    route: "/v1/report",
    headers: { "x-payment": header },
  });
  console.log(`  gate result: ${paid.type}`);

  // 2. The same payload again — a genuine duplicate_settlement from the
  //    facilitator, which is the one reason we cannot fabricate honestly.
  console.log("replay path:");
  const replayGate = createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo,
    resourceBase: "https://record.octroi.local",
    facilitator: coinbaseFacilitator({
      url: facilitatorUrl,
      // The replay verifies again (same valid authorization) and fails at
      // settle: keep only the duplicate_settlement, the exchange that cannot
      // be honestly fabricated.
      fetchImpl: recordingFetch({ verify: null, settle: "settle.duplicate" }),
      ...(authHeaders ? { createAuthHeaders: authHeaders } : {}),
    }),
  });
  await replayGate.handle({ method: "GET", route: "/v1/report", headers: { "x-payment": header } });

  // 3. A tampered signature — a real invalid_exact_evm_payload_signature.
  console.log("bad signature path:");
  const decoded = decodePaymentHeader(header);
  const tampered = {
    ...decoded,
    payload: { ...decoded.payload, signature: `0x${"11".repeat(65)}` },
  };
  const badGate = createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo,
    resourceBase: "https://record.octroi.local",
    facilitator: coinbaseFacilitator({
      url: facilitatorUrl,
      fetchImpl: recordingFetch({ verify: "verify.badSignature", settle: null }),
      ...(authHeaders ? { createAuthHeaders: authHeaders } : {}),
    }),
  });
  await badGate.handle({
    method: "GET",
    route: "/v1/report",
    headers: { "x-payment": btoa(JSON.stringify(tampered)) },
  });

  const existing = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, unknown>;
  const merged = {
    ...existing,
    ...recorded,
    _provenance: {
      status: "RECORDED from a live facilitator",
      recordedAt: new Date().toISOString(),
      facilitatorUrl,
      network: "base-sepolia",
      note: "Regenerate with `pnpm --filter @octroi/coinbase record`. Entries not overwritten by this run remain synthetic.",
    },
  };
  writeFileSync(FIXTURES, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${Object.keys(recorded).length} exchanges to ${FIXTURES}`);
  console.log("Review the diff before committing — these are the CI contract.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
