import type { Network } from "@tollway/core";

/**
 * Per-network asset facts.
 *
 * Values taken from `x402@1.2.0` (`getUsdcChainConfigForChain`,
 * `getDefaultAsset`) rather than from memory — the EIP-712 domain in
 * particular is load-bearing: the payer signs an EIP-3009 authorization over
 * this exact `{name, version}`, so a wrong value produces signatures the
 * facilitator rejects with no obvious cause.
 */
export interface AssetConfig {
  /** Token contract, checksummed. */
  address: string;
  decimals: number;
  /** EIP-712 domain the payer signs under. */
  eip712: { name: string; version: string };
}

export interface NetworkConfig {
  chainId: number;
  assets: Record<string, AssetConfig>;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    chainId: 8453,
    assets: {
      usdc: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        eip712: { name: "USD Coin", version: "2" },
      },
    },
  },
  "base-sepolia": {
    chainId: 84532,
    assets: {
      usdc: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        // Note: "USDC" here, "USD Coin" on mainnet. Not a typo — the deployed
        // contracts genuinely differ, and signing under the wrong one fails.
        eip712: { name: "USDC", version: "2" },
      },
    },
  },
};

export const SUPPORTED_NETWORKS: Network[] = Object.keys(NETWORKS);

export function assetConfig(network: Network, asset: string): AssetConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `coinbase facilitator does not support network "${network}" ` +
        `(supported: ${SUPPORTED_NETWORKS.join(", ")})`,
    );
  }
  const entry = config.assets[asset.toLowerCase()];
  if (!entry) {
    throw new Error(
      `coinbase facilitator has no address for asset "${asset}" on ${network} ` +
        `(known: ${Object.keys(config.assets).join(", ")})`,
    );
  }
  return entry;
}
