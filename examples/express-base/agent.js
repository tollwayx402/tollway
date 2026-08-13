/**
 * The other half of the demo: an agent that pays.
 *
 *   TW_AGENT_KEY=0x… node agent.js
 *
 * Needs a Base Sepolia wallet with USDC. Without a key it still shows the 402,
 * which is the interesting half if you only want to see the protocol.
 */
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const URL = process.argv[2] ?? "http://localhost:3000/v1/report";

const unpaid = await fetch(URL);
console.log(`unpaid  → ${unpaid.status}`);
console.log(JSON.stringify(await unpaid.json(), null, 2), "\n");

if (!process.env.TW_AGENT_KEY) {
  console.log("set TW_AGENT_KEY (a funded Base Sepolia wallet) to pay it");
  process.exit(0);
}

const account = privateKeyToAccount(process.env.TW_AGENT_KEY);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() }).extend(
  publicActions,
);

const paid = await wrapFetchWithPayment(fetch, wallet)(URL);
console.log(`paid    → ${paid.status}`);
console.log("receipt →", paid.headers.get("x-tollway-receipt"));
console.log(JSON.stringify(await paid.json(), null, 2));
