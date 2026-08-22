import type { RejectCode } from "@tollway/core";

/**
 * x402 `invalidReason` / `errorReason` → Tollway `RejectCode`.
 *
 * The enum is taken from `x402@1.2.0`'s `ErrorReasons`. Unknown reasons fall
 * back to `invalid_payment` rather than throwing: a facilitator adding a reason
 * should not take a merchant's route down, and the raw value is preserved in
 * the rejection message either way.
 */
const REASONS: Record<string, RejectCode> = {
  // Timing.
  payment_expired: "expired",
  invalid_exact_evm_payload_authorization_valid_before: "expired",
  invalid_exact_evm_payload_authorization_valid_after: "expired",

  // Amount.
  invalid_exact_evm_payload_authorization_value: "wrong_amount",
  invalid_exact_svm_payload_transaction_amount_mismatch: "wrong_amount",

  // Network / scheme.
  invalid_network: "wrong_network",
  invalid_scheme: "invalid_payment",
  unsupported_scheme: "invalid_payment",
  invalid_x402_version: "invalid_payment",

  // Already settled.
  duplicate_settlement: "replay",

  // Verify-stage faults are still rejections — see the stage note below.
  unexpected_verify_error: "invalid_payment",
  // Observed live from https://x402.org/facilitator (2026-08-12): a malformed
  // payload returns HTTP 500 with `invalidReason: "unexpected_error"` — a
  // string that does not appear in x402@1.2.0's ErrorReasons enum at all.
  // Mapped explicitly so it is a decision rather than a fallback.
  unexpected_error: "invalid_payment",

  // Everything else is a bad payment, including insufficient_funds: the payer
  // authorized something the chain will not honour.
  insufficient_funds: "invalid_payment",
  invalid_payload: "invalid_payment",
  invalid_payment: "invalid_payment",
  invalid_payment_requirements: "invalid_payment",
  invalid_exact_evm_payload_signature: "invalid_payment",
  invalid_exact_evm_payload_recipient_mismatch: "invalid_payment",
  invalid_exact_evm_payload_undeployed_smart_wallet: "invalid_payment",
};

/**
 * Reasons that escalate to {@link FacilitatorUnreachableError}, letting the
 * merchant's fail_open / fail_closed choice apply. The bar is deliberately
 * different per stage:
 *
 * **Verify stage**: only `invalid_payment_requirements` — the facilitator is
 * saying *our* requirements are malformed, which a payer cannot cause and a
 * 402 would misattribute. Everything else, including `unexpected_verify_error`,
 * is a REJECTION. The payload is attacker-controlled input: if a crafted
 * payload that crashes the facilitator's verify counted as an outage, then
 * under `fail_open` it would be a free-content bypass. A verdict-shaped
 * response is a verdict, whatever the reason string says.
 *
 * **Settle stage**: the payment already verified, so a settlement failure is
 * the facilitator FAILING TO BROADCAST a valid payment — a relayer nonce
 * collision, gas, an RPC hiccup, a timeout, a state race. Reported to the
 * payer as `invalid_payment` that would be a lie (observed live: the public
 * facilitator returned a raw viem "nonce too low" error at settle). So the
 * default at settle is INVERTED: treat the failure as the facilitator's
 * unless the reason names a genuinely payment-level cause below.
 */
const VERIFY_FAULTS = new Set(["invalid_payment_requirements"]);

/** Settle-stage reasons that are the PAYMENT's fault, not infrastructure. */
const SETTLE_PAYMENT_REASONS = new Set([
  "duplicate_settlement",
  "insufficient_funds",
  "invalid_exact_evm_payload_authorization_value",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_svm_payload_transaction_amount_mismatch",
]);

export function isFacilitatorFault(
  reason: string | undefined,
  stage: "verify" | "settle",
): boolean {
  if (stage === "verify") return reason !== undefined && VERIFY_FAULTS.has(reason);
  // Settle: default to fault (transient, mode applies) unless the reason is a
  // known payment-level cause. A payment that verified is not the payer's
  // fault if the facilitator then fails to get it on-chain.
  return reason === undefined || !SETTLE_PAYMENT_REASONS.has(reason);
}

export function rejectCodeFor(reason: string | undefined): RejectCode {
  if (reason === undefined) return "invalid_payment";
  return REASONS[reason] ?? "invalid_payment";
}
