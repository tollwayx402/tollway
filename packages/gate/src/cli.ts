#!/usr/bin/env node
/**
 * `npx @octroi/gate doctor` (§10).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { coinbaseFacilitator, DEFAULT_FACILITATOR_URL } from "@octroi/coinbase";
import type { GateOptions, Network } from "@octroi/core";
import { doctor, formatReport, type DoctorOptions } from "./doctor.js";

const USAGE = `octroi doctor — check a gate's config, its facilitator, and the whole payment path

Usage:
  npx @octroi/gate doctor [options]

Options:
  --config <path>          module whose default export is the gate options
  --price <price>          e.g. '$0.004'
  --network <network>      e.g. base-sepolia            (default: base-sepolia)
  --pay-to <address>       settlement address           (env: OCT_ADDRESS)
  --asset <asset>          default: usdc
  --mode <mode>            fail_closed | fail_open
  --facilitator-url <url>  default: ${DEFAULT_FACILITATOR_URL}   (env: OCT_FACILITATOR)
  --agent-key <0x…>        testnet key for the self-payment (env: OCT_AGENT_KEY)
  --skip-self-payment      config, facilitator and skew only
  --json                   machine-readable output
  -h, --help

The self-payment spends real testnet funds from --agent-key. Without it that
check is skipped, and the run is reported as incomplete rather than clean.`;

interface Args {
  flags: Record<string, string>;
  bools: Set<string>;
  command: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      command ??= token;
      continue;
    }
    const name = token.replace(/^--?/, "");
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[name] = next;
      i++;
    } else {
      bools.add(name);
    }
  }
  return { flags, bools, command };
}

async function loadConfig(path: string): Promise<GateOptions> {
  const imported = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: GateOptions;
    gate?: GateOptions;
  };
  const config = imported.default ?? imported.gate;
  if (config === undefined) {
    throw new Error(`${path} has no default export of gate options`);
  }
  return config;
}

async function main(): Promise<number> {
  const { flags, bools, command } = parseArgs(process.argv.slice(2));

  if (bools.has("h") || bools.has("help") || command === undefined || command === "help") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command !== "doctor") {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const facilitatorUrl =
    flags["facilitator-url"] ?? process.env["OCT_FACILITATOR"] ?? DEFAULT_FACILITATOR_URL;
  const network = (flags["network"] ?? "base-sepolia") as Network;

  let gateOptions: GateOptions;
  if (flags["config"] !== undefined) {
    gateOptions = await loadConfig(flags["config"]);
  } else {
    const payTo = flags["pay-to"] ?? process.env["OCT_ADDRESS"];
    if (payTo === undefined) {
      console.error("missing --pay-to (or OCT_ADDRESS)\n\n" + USAGE);
      return 1;
    }
    gateOptions = {
      price: flags["price"] ?? "$0.004",
      asset: flags["asset"] ?? "usdc",
      network,
      payTo,
      facilitator: coinbaseFacilitator({ url: facilitatorUrl, networks: [network] }),
      ...(flags["mode"] === undefined ? {} : { mode: flags["mode"] as GateOptions["mode"] }),
      resourceBase: "https://doctor.octroi.local",
    };
  }

  const agentKey = flags["agent-key"] ?? process.env["OCT_AGENT_KEY"];
  const options: DoctorOptions = {
    gate: gateOptions,
    facilitatorUrl,
    ...(agentKey === undefined ? {} : { agentKey: agentKey as `0x${string}` }),
    ...(bools.has("skip-self-payment") ? { skipSelfPayment: true } : {}),
  };

  const report = await doctor(options);

  if (bools.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`octroi doctor — ${facilitatorUrl}\n`);
    console.log(formatReport(report));
  }

  // Incomplete is not failure, but it is not success either: exit 2 so a
  // script can tell "all good" from "could not check".
  if (!report.ok) return 1;
  return report.incomplete ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
