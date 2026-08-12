/**
 * `doctor` (§10): checks config, facilitator reachability, clock skew, and
 * fires a testnet self-payment end to end.
 *
 * The design rule here is that a check must be able to *fail*. A doctor that
 * reports green because it skipped the hard part is worse than no doctor — so
 * every check that cannot run says so out loud, and `skipped` is never counted
 * as `ok`.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGate,
  parsePrice,
  runFacilitatorConformance,
  verifyReceipt,
  RECEIPT_HEADER,
  type ConformanceCheck,
  type FacilitatorAdapter,
  type GateOptions,
  type Receipt,
  type TollwayEvent,
} from "@tollway/core";
import { measureClockSkew, SKEW_CRITICAL_MS } from "@tollway/coinbase";

export interface DoctorOptions {
  gate: GateOptions;
  /** Facilitator base URL, for reachability and skew. */
  facilitatorUrl?: string;
  /**
   * Private key for the self-payment. Without it that check is skipped, never
   * silently passed.
   */
  agentKey?: `0x${string}`;
  /** Skip the self-payment even when a key is present. */
  skipSelfPayment?: boolean;
  timeoutMs?: number;
  /** Injected for tests, so doctor's own suite needs no network. */
  fetchImpl?: typeof fetch;
}

export interface DoctorReport {
  checks: ConformanceCheck[];
  ok: boolean;
  /** True when something could not be checked — green here is not "all clear". */
  incomplete: boolean;
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: ConformanceCheck[] = [];
  const add = (check: ConformanceCheck) => checks.push(check);

  const run = async (name: string, fn: () => Promise<string | undefined> | string | undefined) => {
    try {
      const detail = await fn();
      add(detail === undefined ? { name, ok: true } : { name, ok: true, detail });
      return true;
    } catch (error) {
      add({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  // --- 1. config -----------------------------------------------------------

  const configOk = await run("config is valid", () => {
    // createGate performs the full §3.1 validation: price, payTo, networks,
    // facilitator coverage, and the replay-TTL floor.
    createGate(options.gate);
    return undefined;
  });

  if (!configOk) {
    return { checks, ok: false, incomplete: true };
  }

  const gate = createGate(options.gate);

  await run("price parses to atomic units", () => {
    if (typeof options.gate.price === "function") {
      return "dynamic — resolved per request, not checkable here";
    }
    const asset = options.gate.asset ?? "usdc";
    const atomic = parsePrice(options.gate.price, {
      asset,
      ...(options.gate.decimals === undefined ? {} : { decimals: options.gate.decimals }),
    });
    return `${String(options.gate.price)} → ${atomic} atomic units of ${asset}`;
  });

  await run("a receipt signing key is available", async () => {
    const key = await gate.publicKey();
    if (key.length !== 32) throw new Error(`expected a 32-byte Ed25519 key, got ${key.length}`);
    return options.gate.signer === undefined
      ? "ephemeral (standalone) — receipts verify only within this process"
      : "configured";
  });

  // --- 2. facilitator ------------------------------------------------------

  const adapters = (
    Array.isArray(options.gate.facilitator) ? options.gate.facilitator : [options.gate.facilitator]
  ).filter((spec): spec is FacilitatorAdapter => typeof spec !== "string");

  for (const adapter of adapters) {
    const results = await runFacilitatorConformance(adapter, {
      ...(options.gate.network !== undefined
        ? { network: Array.isArray(options.gate.network) ? options.gate.network[0]! : options.gate.network }
        : {}),
    });
    for (const result of results) add({ ...result, name: `${adapter.id}: ${result.name}` });
  }

  // --- 3. clock skew -------------------------------------------------------

  if (options.facilitatorUrl === undefined) {
    add({
      name: "clock skew",
      ok: true,
      skipped: true,
      detail: "no facilitator URL supplied — pass --facilitator-url to measure it",
    });
  } else {
    await run("clock skew is within tolerance", async () => {
      const skew = await measureClockSkew({
        url: options.facilitatorUrl!,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const summary = `${skew.skewMs}ms (rtt ${skew.rttMs}ms)`;
      if (skew.severity === "critical") {
        throw new Error(`${summary} — beyond ${SKEW_CRITICAL_MS}ms. ${skew.advice ?? ""}`.trim());
      }
      return skew.severity === "warn" ? `${summary} — ${skew.advice ?? "worth watching"}` : summary;
    });
  }

  // --- 4. end-to-end self-payment -----------------------------------------

  if (options.skipSelfPayment === true) {
    add({ name: "self-payment", ok: true, skipped: true, detail: "explicitly skipped" });
  } else if (options.agentKey === undefined) {
    add({
      name: "self-payment",
      ok: true,
      skipped: true,
      detail:
        "no TW_AGENT_KEY — set one (a testnet wallet with USDC) to check the whole path end to end",
    });
  } else {
    await run("self-payment settles end to end", () => selfPayment(options, add));
  }

  return {
    checks,
    ok: checks.every((check) => check.ok),
    incomplete: checks.some((check) => check.skipped === true),
  };
}

/**
 * Stands up a real server on this gate's config and pays it with the reference
 * x402 client. Every hop the merchant depends on is exercised: challenge,
 * client parsing, facilitator verify+settle, receipt, and replay refusal.
 */
async function selfPayment(
  options: DoctorOptions,
  add: (check: ConformanceCheck) => void,
): Promise<string> {
  let wrapFetchWithPayment: typeof import("x402-fetch").wrapFetchWithPayment;
  let viem: typeof import("viem");
  let accounts: typeof import("viem/accounts");
  let chains: typeof import("viem/chains");
  try {
    ({ wrapFetchWithPayment } = await import("x402-fetch"));
    viem = await import("viem");
    accounts = await import("viem/accounts");
    chains = await import("viem/chains");
  } catch {
    throw new Error(
      "the self-payment needs `viem` and `x402-fetch` installed alongside @tollway/gate",
    );
  }

  const events: TollwayEvent[] = [];
  const gate = createGate({ ...options.gate, onEvent: (event) => void events.push(event) });

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
      res.end(JSON.stringify({ ok: true }));
      result.report({ status: 200 });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const target = `http://127.0.0.1:${port}/doctor`;

  try {
    const account = accounts.privateKeyToAccount(options.agentKey!);
    const network = Array.isArray(options.gate.network)
      ? options.gate.network[0]
      : options.gate.network;
    const chain = network === "base" ? chains.base : chains.baseSepolia;
    const wallet = viem
      .createWalletClient({ account, chain, transport: viem.http() })
      .extend(viem.publicActions);

    let sentPayment: string | undefined;
    const capturing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("X-PAYMENT");
      if (header) sentPayment = header;
      return fetch(input as string, init);
    }) as typeof fetch;

    // x402's SignerWallet is invariant over viem's chain formatters; an
    // OP-stack chain does not match structurally despite being what the client
    // reads at runtime (`chain.id` and the account).
    const paid = wrapFetchWithPayment(
      capturing,
      wallet as unknown as Parameters<typeof wrapFetchWithPayment>[1],
    ) as typeof fetch;

    const response = await paid(target);
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`gate answered ${response.status}: ${body.slice(0, 200)}`);
    }

    const receiptId = response.headers.get(RECEIPT_HEADER);
    if (receiptId === null) throw new Error("served without a receipt header");

    await gate.flushEvents();
    const settled = events.find((event) => event.type === "toll.settled");
    const receipt = settled?.data["receipt"] as Receipt | undefined;
    if (receipt === undefined) throw new Error("no toll.settled event was emitted");

    if (!(await verifyReceipt(receipt, await gate.publicKey()))) {
      throw new Error("the receipt did not verify under the gate's own key");
    }

    add({
      name: "receipt payer is the paying account",
      ok: receipt.payer.toLowerCase() === account.address.toLowerCase(),
      detail: `${receipt.payer} (signed by ${account.address})`,
    });

    if (sentPayment !== undefined) {
      const replay = await fetch(target, { headers: { "x-payment": sentPayment } });
      const body = (await replay.json()) as { errorDetail?: { code?: string } };
      add({
        name: "a replayed payment is refused",
        ok: replay.status === 402 && body.errorDetail?.code === "replay",
        detail: `status ${replay.status}, code ${body.errorDetail?.code ?? "none"}`,
      });
    }

    return `tx ${receipt.tx_ref}, receipt ${receiptId}`;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Human-readable report. Returns the text; the CLI decides where it goes. */
export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    const mark = check.skipped === true ? "skip" : check.ok ? "pass" : "FAIL";
    return `  ${mark}  ${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`;
  });

  const failed = report.checks.filter((check) => !check.ok).length;
  const skipped = report.checks.filter((check) => check.skipped === true).length;

  lines.push("");
  if (failed > 0) {
    lines.push(`${failed} check(s) failed.`);
  } else if (skipped > 0) {
    // Never let a run that skipped the hard parts read as a clean bill.
    lines.push(`No failures, but ${skipped} check(s) could not run. This is not a clean bill.`);
  } else {
    lines.push("All checks passed.");
  }
  return lines.join("\n");
}
