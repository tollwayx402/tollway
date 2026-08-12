/**
 * Probe a facilitator's `GET /supported` and normalize the answer.
 *
 * Why this exists: a network in our table is merely *parseable*. Advertising
 * one the facilitator will not settle fails the payer after they signed — in
 * their process, invisible to us. `doctor` uses this to turn that silent
 * agent-side failure into a loud merchant-side config error.
 *
 * Measured shape (x402.org, 2026-08-12): `kinds` mixes v1 entries with plain
 * names (`base-sepolia`) and v2 entries with CAIP-2 ids (`eip155:84532`,
 * `solana:…`). Both count as settlement support; unknown chains are reported
 * rather than dropped.
 */
import { FacilitatorUnreachableError, type Network } from "@tollway/core";
import { networkForCaip2 } from "./networks.js";

export interface SupportedNetworks {
  /** v1-style network names this facilitator settles, that we recognize. */
  networks: Set<Network>;
  /** Entries we could not map to a known network (non-EVM chains, new ids). */
  unrecognized: string[];
  /** The raw kinds, for doctor output and debugging. */
  kinds: Array<{ network: string; scheme: string; x402Version: number }>;
}

export interface FetchSupportedOptions {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchSupportedNetworks(
  options: FetchSupportedOptions,
): Promise<SupportedNetworks> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);

  let body: unknown;
  try {
    const response = await fetchImpl(`${options.url.replace(/\/+$/, "")}/supported`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new FacilitatorUnreachableError(
        `facilitator /supported answered ${response.status}`,
      );
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof FacilitatorUnreachableError) throw error;
    throw new FacilitatorUnreachableError(
      `could not fetch facilitator /supported: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  const kinds = extractKinds(body);
  if (kinds === undefined) {
    throw new FacilitatorUnreachableError(
      "facilitator /supported returned an unrecognised body (no `kinds` array)",
    );
  }

  const networks = new Set<Network>();
  const unrecognized: string[] = [];
  for (const kind of kinds) {
    const mapped = kind.network.includes(":") ? networkForCaip2(kind.network) : kind.network;
    if (mapped !== undefined && !mapped.includes(":")) networks.add(mapped);
    else unrecognized.push(kind.network);
  }

  return { networks, unrecognized: [...new Set(unrecognized)], kinds };
}

function extractKinds(
  body: unknown,
): Array<{ network: string; scheme: string; x402Version: number }> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const kinds = (body as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds)) return undefined;
  const out: Array<{ network: string; scheme: string; x402Version: number }> = [];
  for (const entry of kinds) {
    if (typeof entry !== "object" || entry === null) continue;
    const kind = entry as Record<string, unknown>;
    if (typeof kind["network"] !== "string" || typeof kind["scheme"] !== "string") continue;
    out.push({
      network: kind["network"],
      scheme: kind["scheme"],
      x402Version: typeof kind["x402Version"] === "number" ? kind["x402Version"] : 1,
    });
  }
  return out;
}
