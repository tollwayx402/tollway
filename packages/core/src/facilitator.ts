import { TollwayConfigError } from "./errors.js";
import type { FacilitatorAdapter, Network } from "./types.js";

/**
 * Registry so that `facilitator: "coinbase"` works once the adapter package is
 * imported, without core ever depending on an adapter (§5, facilitator-neutral
 * by construction).
 */
const registry = new Map<string, FacilitatorAdapter>();

export type FacilitatorSpec = string | FacilitatorAdapter;

export function registerFacilitator(adapter: FacilitatorAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getFacilitator(id: string): FacilitatorAdapter | undefined {
  return registry.get(id);
}

export function registeredFacilitators(): string[] {
  return [...registry.keys()].sort();
}

export function resolveFacilitator(spec: FacilitatorSpec): FacilitatorAdapter {
  if (typeof spec !== "string") return spec;
  const adapter = registry.get(spec);
  if (!adapter) {
    const known = registeredFacilitators();
    throw new TollwayConfigError(
      `unknown facilitator "${spec}"; import the adapter package first` +
        (known.length > 0 ? ` (registered: ${known.join(", ")})` : ""),
    );
  }
  return adapter;
}

/** First configured adapter that supports the network, in configured order. */
export function adapterForNetwork(
  adapters: FacilitatorAdapter[],
  network: Network,
): FacilitatorAdapter | undefined {
  return adapters.find((adapter) => adapter.networks.includes(network));
}
