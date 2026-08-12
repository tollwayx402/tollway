/**
 * Facilitator endpoints. Kept in their own module so `skew.ts` and `index.ts`
 * can both use them without importing each other.
 */

/** The public facilitator, matching `x402`'s `DEFAULT_FACILITATOR_URL`. */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** CDP's hosted facilitator. Requires auth headers. */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
