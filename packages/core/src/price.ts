import { TollwayConfigError } from "./errors.js";
import type { Asset, GateRequest, Price, PriceConfig } from "./types.js";

/** Decimals for assets the SDK ships knowledge of. */
export const ASSET_DECIMALS: Record<string, number> = {
  usdc: 6,
  usdt: 6,
};

export function assetDecimals(asset: Asset, override?: number): number {
  if (override !== undefined) return override;
  const known = ASSET_DECIMALS[asset.toLowerCase()];
  if (known === undefined) {
    throw new TollwayConfigError(
      `unknown asset "${asset}"; pass \`decimals\` to price it explicitly`,
    );
  }
  return known;
}

const USD_PATTERN = /^\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/;

/**
 * Normalize a price to atomic units of the asset.
 *
 * - `bigint` is already atomic and passes through
 * - a string is a USD decimal amount, with or without the `$`
 *
 * More decimal places than the asset carries is a config error rather than a
 * silent round — a merchant who writes "$0.0000004" for USDC means something,
 * and it is not "free".
 */
export function parsePrice(price: Price, opts: { asset: Asset; decimals?: number }): bigint {
  const decimals = assetDecimals(opts.asset, opts.decimals);

  if (typeof price === "bigint") {
    if (price <= 0n) throw new TollwayConfigError(`price must be greater than zero, got ${price}`);
    return price;
  }

  if (typeof price !== "string") {
    throw new TollwayConfigError(`price must be a string or bigint, got ${typeof price}`);
  }

  const trimmed = price.trim();
  const match = USD_PATTERN.exec(trimmed);
  if (!match) {
    throw new TollwayConfigError(
      `could not parse price "${price}"; expected a USD amount like "$0.004" or atomic units as a bigint`,
    );
  }

  const whole = (match[1] ?? "0").replace(/,/g, "");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new TollwayConfigError(
      `price "${price}" has ${fraction.length} decimal places but ${opts.asset} carries ${decimals}`,
    );
  }

  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (atomic <= 0n) throw new TollwayConfigError(`price must be greater than zero, got "${price}"`);
  return atomic;
}

/** Resolve a static or per-request price to atomic units. */
export async function resolvePrice(
  config: PriceConfig,
  req: GateRequest,
  opts: { asset: Asset; decimals?: number },
): Promise<bigint> {
  const value = typeof config === "function" ? await config(req) : config;
  return parsePrice(value, opts);
}

/** Format atomic units back to a decimal string, for logs and error messages. */
export function formatAtomic(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
