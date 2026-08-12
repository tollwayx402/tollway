/**
 * Shared protocol types. Nothing in here imports a framework — adapters map
 * their own request objects onto {@link GateRequest} and their responses back
 * out of {@link GateResult}.
 */

/** Known networks. Custom adapters may introduce their own ids. */
export type Network =
  | "base"
  | "base-sepolia"
  | "solana"
  | "solana-devnet"
  | (string & {});

/** Asset symbol, lowercase. Decimals resolved via {@link ASSET_DECIMALS}. */
export type Asset = "usdc" | "usdt" | (string & {});

/** A price is either a USD string ("$0.004") or atomic units of the asset. */
export type Price = string | bigint;

export type PriceResolver = (req: GateRequest) => Price | Promise<Price>;

export type PriceConfig = Price | PriceResolver;

/** §1.3 — never silent: the merchant picks what happens when a facilitator is down. */
export type Mode = "fail_closed" | "fail_open";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Framework-neutral view of an inbound request. Adapters fill what they have;
 * only `method`, `route` and `headers` are required.
 */
export interface GateRequest {
  method: string;
  /** Route identity used in events and receipts, e.g. "/v1/report". */
  route: string;
  /** Absolute URL when the adapter can produce one; used as the x402 `resource`. */
  url?: string;
  path?: string;
  /** Either a plain header bag or anything with a Headers-style `get`. */
  headers: HeaderSource;
  /** Client IP, when the adapter can resolve it. Reserved for §9 rate limits. */
  ip?: string;
  /** The underlying framework request, passed through to price resolvers. */
  raw?: unknown;
}

export type HeaderSource =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

/** What the core needs a facilitator to advertise for one network. */
export interface ChallengeRequest {
  route: string;
  /** Absolute URL when known, else the route. */
  resource: string;
  description: string;
  mimeType: string;
  network: Network;
  asset: Asset;
  /** Amount owed, atomic units of `asset`. */
  amount: bigint;
  payTo: string;
  /** Server-issued nonce for this challenge. */
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
  maxTimeoutSeconds: number;
}

/**
 * One entry of the x402 `accepts` array. Field names follow the pinned x402
 * revision — see PROTOCOL.md.
 */
export interface ChallengeScheme {
  scheme: string;
  network: Network;
  /** Atomic units, decimal string. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** Asset contract address / mint, per network. */
  asset: string;
  extra?: Record<string, unknown> | null;
}

/** Decoded `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: Network;
  payload: Record<string, unknown>;
}

export interface VerifyContext {
  /** The advertised scheme the payer is claiming to satisfy. */
  scheme: ChallengeScheme;
  /** Canonical requirements the core built the challenge from. */
  requirements: ChallengeRequest;
  route: string;
  /** Unix milliseconds, from the gate's injected clock. */
  now: number;
  /** Aborted when the verify timeout elapses. */
  signal: AbortSignal;
  logger: Logger;
}

/** Machine-readable rejection codes (§4.4). */
export type RejectCode =
  | "invalid_payment"
  | "expired"
  | "wrong_amount"
  | "wrong_network"
  | "replay";

export type VerifyResult =
  | {
      ok: true;
      txRef: string;
      /** Atomic units actually settled. */
      settledAmount: bigint | string;
      payer: string;
      raw?: unknown;
    }
  | {
      ok: false;
      code: RejectCode;
      message?: string;
      raw?: unknown;
    };

/**
 * §5 — the whole facilitator surface. Rejections are values; outages are
 * exceptions (throw {@link FacilitatorUnreachableError}) so the core can apply
 * the merchant's fail_open / fail_closed choice.
 */
export interface FacilitatorAdapter {
  readonly id: string;
  readonly networks: Network[];
  buildChallenge(req: ChallengeRequest): ChallengeScheme;
  verify(payload: PaymentPayload, ctx: VerifyContext): Promise<VerifyResult>;
}
