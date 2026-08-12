import type { Network } from "@tollway/core";

/**
 * Per-network asset facts for every EVM network the reference client can
 * parse.
 *
 * Every value here was extracted mechanically from `x402@1.2.0`
 * (`getDefaultAsset`, `getNetworkId`) on 2026-08-12 — never from memory. The
 * EIP-712 domain is the load-bearing part: the payer signs an EIP-3009
 * authorization over this exact `{name, version}`, and the deployed contracts
 * genuinely differ — three different names across mainnets ("USD Coin",
 * "USDC", "Bridged USDC") plus long-form bridge names. A wrong value produces
 * signatures the facilitator rejects with no useful error.
 *
 * Being IN this table means "the client can parse it and we know the asset
 * facts" — NOT "your facilitator will settle it". See DEFAULT_NETWORKS.
 */
export interface AssetConfig {
  /** Token contract, checksummed as the reference package returns it. */
  address: string;
  decimals: number;
  /** EIP-712 domain the payer signs under. */
  eip712: { name: string; version: string };
}

export interface NetworkConfig {
  chainId: number;
  assets: Record<string, AssetConfig>;
}

const usdc = (address: string, name: string): Record<string, AssetConfig> => ({
  usdc: { address, decimals: 6, eip712: { name, version: "2" } },
});

export const NETWORKS: Record<string, NetworkConfig> = {
  base: { chainId: 8453, assets: usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin") },
  "base-sepolia": {
    chainId: 84532,
    assets: usdc("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC"),
  },
  avalanche: {
    chainId: 43114,
    assets: usdc("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USD Coin"),
  },
  "avalanche-fuji": {
    chainId: 43113,
    assets: usdc("0x5425890298aed601595a70AB815c96711a31Bc65", "USD Coin"),
  },
  polygon: { chainId: 137, assets: usdc("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "USD Coin") },
  "polygon-amoy": {
    chainId: 80002,
    assets: usdc("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", "USDC"),
  },
  sei: { chainId: 1329, assets: usdc("0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", "USDC") },
  "sei-testnet": {
    chainId: 1328,
    assets: usdc("0x4fcf1784b31630811181f670aea7a7bef803eaed", "USDC"),
  },
  iotex: { chainId: 4689, assets: usdc("0xcdf79194c6c285077a58da47641d4dbe51f63542", "Bridged USDC") },
  peaq: { chainId: 3338, assets: usdc("0xbbA60da06c2c5424f03f7434542280FCAd453d10", "USDC") },
  story: { chainId: 1514, assets: usdc("0xF1815bd50389c46847f0Bda824eC8da914045D14", "Bridged USDC") },
  educhain: {
    chainId: 41923,
    assets: usdc("0x12a272A581feE5577A5dFa371afEB4b2F3a8C2F8", "Bridged USDC (Stargate)"),
  },
  abstract: {
    chainId: 2741,
    assets: usdc("0x84a71ccd554cc1b02749b35d22f684cc8ec987e1", "Bridged USDC"),
  },
  "abstract-testnet": {
    chainId: 11124,
    assets: usdc("0xe4C7fBB0a626ed208021ccabA6Be1566905E2dFc", "Bridged USDC"),
  },
  "skale-base-sepolia": {
    chainId: 324705682,
    assets: usdc("0x2e08028E3C4c2356572E096d8EF835cD5C6030bD", "Bridged USDC (SKALE Bridge)"),
  },
};

/** Every network this adapter has verified facts for. */
export const KNOWN_NETWORKS: Network[] = Object.keys(NETWORKS);

/** @deprecated Renamed {@link KNOWN_NETWORKS} — "supported" was ambiguous. */
export const SUPPORTED_NETWORKS = KNOWN_NETWORKS;

/**
 * What the adapter advertises when the merchant does not choose.
 *
 * Deliberately NOT all fifteen: a network is only worth advertising if the
 * configured facilitator will settle it, and today that reliably means Base
 * (mainnet via CDP, testnet via the public facilitator). Advertising a network
 * nobody settles fails the payer AFTER they signed — the worst place to fail.
 * Merchants opt into more with `networks: [...]`, and `doctor` checks the
 * chosen set against the facilitator's own /supported list.
 */
export const DEFAULT_NETWORKS: Network[] = ["base", "base-sepolia"];

export function assetConfig(network: Network, asset: string): AssetConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `coinbase facilitator does not support network "${network}" ` +
        `(known: ${KNOWN_NETWORKS.join(", ")})`,
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

/** Network name for a CAIP-2 id like `eip155:84532`, if we know the chain. */
export function networkForCaip2(caip2: string): Network | undefined {
  const match = /^eip155:(\d+)$/.exec(caip2);
  if (!match) return undefined;
  const chainId = Number(match[1]);
  for (const [name, config] of Object.entries(NETWORKS)) {
    if (config.chainId === chainId) return name;
  }
  return undefined;
}
