/**
 * `@tollway/ingest` — the cloud client. BSL, and deliberately optional: no MIT
 * package in this repo depends on it, so the SDK works with no Tollway account
 * and no BSL code in the tree (§1.1).
 */
import type { GateRequest, Mode, Price, PriceConfig } from "@tollway/core";
import type { RemoteConfigClient } from "./config.js";

export { createIngestClient, DEFAULT_INGEST_URL } from "./client.js";
export type { IngestClient, IngestClientOptions, IngestStats } from "./client.js";

export {
  createRemoteConfigClient,
  validate as validateSignedConfig,
  DEFAULT_CONFIG_URL,
} from "./config.js";
export type {
  RemoteConfigClient,
  RemoteConfigOptions,
  RemoteRouteConfig,
  SignedConfig,
} from "./config.js";

/** Which side wins when local and dashboard config disagree (§3.1). */
export type ConfigSource = "remote" | "local";

export interface RemotePriceOptions {
  config: RemoteConfigClient;
  /** The price written in code. Always the fallback. */
  local: PriceConfig;
  /** `"local"` makes code authoritative and ignores dashboard prices. */
  configSource?: ConfigSource;
  /** Route to look up when the request carries no route of its own. */
  route?: string;
}

/**
 * A price resolver that prefers verified dashboard config, falling back to the
 * local price (§3.1).
 *
 * Two properties matter more than the feature itself:
 *
 * - `configSource: "local"` means local **always** wins, so a merchant can pin
 *   their prices in code and have remote config be observational only.
 * - If the cloud is unreachable, has never verified, or says nothing about
 *   this route, the local price applies. There is no state in which a route
 *   becomes unpriced — and therefore no state in which it becomes free —
 *   because the cloud had a bad day.
 */
export function remotePrice(
  options: RemotePriceOptions,
): (req: GateRequest) => Price | Promise<Price> {
  return (req: GateRequest): Price | Promise<Price> => {
    // Resolve the remote override first: a local resolver may be async and may
    // be expensive, and there is no reason to run it when the cloud has an
    // answer we are allowed to use.
    if (options.configSource !== "local") {
      const override = options.config.lookup(req.route || options.route || "");
      if (override?.price !== undefined) return override.price;
    }
    return typeof options.local === "function" ? options.local(req) : options.local;
  };
}

/** The verified remote `mode` for a route, or the local one. */
export function remoteMode(options: {
  config: RemoteConfigClient;
  local: Mode;
  route: string;
  configSource?: ConfigSource;
}): Mode {
  if (options.configSource === "local") return options.local;
  return options.config.lookup(options.route)?.mode ?? options.local;
}
