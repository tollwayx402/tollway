import type { RejectCode } from "./types.js";

export const DOC_BASE = "https://octroi.ai/docs/errors#";

/** Every 4xx/5xx body the SDK produces (§10). */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    doc: string;
  };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message, doc: `${DOC_BASE}${code}` } };
}

const REJECT_MESSAGES: Record<RejectCode, string> = {
  invalid_payment: "Payment payload was missing, malformed, or failed verification.",
  expired: "Payment authorization expired before it was verified.",
  wrong_amount: "Settled amount is less than the price of this route.",
  wrong_network: "Payment was made on a network this route does not accept.",
  replay: "This payment payload was already used.",
};

export function rejectMessage(code: RejectCode): string {
  return REJECT_MESSAGES[code];
}

/** Thrown for merchant misconfiguration — always at construction time. */
export class OctroiConfigError extends Error {
  readonly code = "invalid_config";
  constructor(message: string) {
    super(message);
    this.name = "OctroiConfigError";
  }
}

/**
 * Facilitator could not be reached or did not answer in time. Adapters throw
 * this (or any error, which the core treats the same way) to trigger the
 * merchant's `mode`.
 */
export class FacilitatorUnreachableError extends Error {
  readonly code = "facilitator_unreachable";
  readonly facilitator: string | undefined;
  constructor(message: string, options?: { facilitator?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FacilitatorUnreachableError";
    this.facilitator = options?.facilitator;
  }
}

/** Value could not be canonicalized byte-identically across languages. */
export class CanonicalJsonError extends Error {
  readonly code = "canonical_json";
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}
