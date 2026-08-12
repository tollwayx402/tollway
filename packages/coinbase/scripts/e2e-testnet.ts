/**
 * The live Base Sepolia end-to-end run — **manual or nightly, never in PR CI**.
 *
 *   pnpm --filter @tollway/coinbase e2e:testnet
 *
 *   TW_AGENT_KEY   private key of a wallet holding Base Sepolia USDC
 *   TW_PAY_TO      settlement address to pay
 *   TW_FACILITATOR facilitator URL (default: the public one)
 *   TW_CDP_JWT     bearer token, if pointing at CDP
 *
 * A real server, the reference client, a real facilitator, real (testnet)
 * money. This is what proves the fixtures still describe reality — and the
 * only place the payer↔signer binding and CDP's real reason strings can be
 * checked at all.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGate,
  formatConformance,
  runFacilitatorConformance,
  verifyReceipt,
  RECEIPT_HEADER,
  type TollwayEvent,
} from "@tollway/core";
import { coinbaseFacilitator, DEFAULT_FACILITATOR_URL } from "../src/index.ts";
import { measureClockSkew } from "../src/skew.ts";
import { agentFetch, agentWallet } from "../dev/agent.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}. See the header of this script.`);
    process.exit(1);
  }
  return value;
}

const facilitatorUrl = process.env["TW_FACILITATOR"] ?? DEFAULT_FACILITATOR_URL;
const agentKey = required("TW_AGENT_KEY") as `0x${string}`;
const payTo = required("TW_PAY_TO");

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  const { account } = agentWallet(agentKey);
  console.log(`live run against ${facilitatorUrl}`);
  console.log(`paying from ${account.address} to ${payTo}\n`);

  const authHeaders = process.env["TW_CDP_JWT"]
    ? () => {
        const header = { authorization: `Bearer ${process.env["TW_CDP_JWT"]}` };
        return { verify: header, settle: header };
      }
    : undefined;

  const facilitator = coinbaseFacilitator({
    url: facilitatorUrl,
    networks: ["base-sepolia"],
    ...(authHeaders ? { createAuthHeaders: authHeaders } : {}),
  });

  // 1. Clock skew — where our expiry meets their timestamp validation.
  console.log("clock skew:");
  try {
    const skew = await measureClockSkew({ url: facilitatorUrl });
    check(
      `skew ${skew.skewMs}ms (rtt ${skew.rttMs}ms, ${skew.severity})`,
      skew.severity !== "critical",
      skew.advice,
    );
    console.log(
      `        ^ record this number: SKEW_WARN_MS/SKEW_CRITICAL_MS in src/skew.ts are\n` +
        `          provisional until measured against real facilitator behaviour.`,
    );
  } catch (error) {
    check("clock skew measurable", false, error instanceof Error ? error.message : String(error));
  }

  // 2. The shared contract suite against the live facilitator.
  console.log("\nfacilitator contract suite:");
  const checks = await runFacilitatorConformance(facilitator, { network: "base-sepolia" });
  console.log(formatConformance(checks));
  for (const item of checks) if (!item.ok) failures.push(item.name);

  // 3. A real payment, end to end.
  console.log("\nend-to-end payment:");
  const events: TollwayEvent[] = [];
  const gate = createGate({
    price: "$0.004",
    asset: "usdc",
    network: "base-sepolia",
    payTo,
    facilitator,
    onEvent: (event) => void events.push(event),
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const result = await gate.handle({
        method: req.method ?? "GET",
        route: url.pathname,
        url: url.toString(),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (result.type !== "pass") {
        res.writeHead(result.status, result.headers);
        res.end(JSON.stringify(result.body));
        return;
      }
      res.writeHead(200, { ...result.headers, "content-type": "application/json" });
      res.end(JSON.stringify({ report: "live testnet content" }));
      result.report({ status: 200 });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // Capture the X-PAYMENT header the client sends, at the transport — the
    // client does not expose it, and the replay check below needs the real one.
    let sentPayment: string | undefined;
    const capturingTransport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("X-PAYMENT");
      if (header) sentPayment = header;
      return fetch(input as string, init);
    }) as typeof fetch;
    const paidFetch = agentFetch(agentKey, capturingTransport).fetch;

    const started = Date.now();
    const response = await paidFetch(`${baseUrl}/v1/report`);
    const elapsed = Date.now() - started;

    check(`served in ${elapsed}ms`, response.status === 200, `status ${response.status}`);

    const receiptId = response.headers.get(RECEIPT_HEADER);
    check("receipt id returned", Boolean(receiptId), receiptId ?? "none");

    await gate.flushEvents();
    const settled = events.find((event) => event.type === "toll.settled");
    const receipt = settled?.data["receipt"] as
      | { payer: string; tx_ref: string; amount: string }
      | undefined;

    check("toll.settled emitted", Boolean(receipt));
    if (receipt) {
      // Only checkable live: the fixtures cannot bind a payer to a signer.
      check("payer is the signing account", receipt.payer.toLowerCase() === account.address.toLowerCase(),
        `${receipt.payer} vs ${account.address}`);
      check("settled the advertised amount", receipt.amount === "4000", receipt.amount);
      console.log(`        tx: ${receipt.tx_ref}`);
    }

    const signedReceipt = settled?.data["receipt"] as Parameters<typeof verifyReceipt>[0];
    if (signedReceipt) {
      check("receipt signature verifies", await verifyReceipt(signedReceipt, await gate.publicKey()));
    }

    // 4. Replay the exact payment the client sent: our nonce store should
    //    refuse it before the facilitator is even consulted.
    console.log("\nreplay:");
    check("captured the client's X-PAYMENT header", Boolean(sentPayment));
    if (sentPayment) {
      const replayResponse = await fetch(`${baseUrl}/v1/report`, {
        headers: { "x-payment": sentPayment },
      });
      const replayBody = (await replayResponse.json()) as { errorDetail?: { code?: string } };
      check(
        "replayed payment is rejected as a replay",
        replayResponse.status === 402 && replayBody.errorDetail?.code === "replay",
        `status ${replayResponse.status}, code ${replayBody.errorDetail?.code ?? "none"}`,
      );
    }

    console.log(`\nevents: ${events.map((event) => event.type).join(" → ")}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("all live checks passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
