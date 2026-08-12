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
 * Reasons that mean "the facilitator itself failed", not "the payment is bad".
 * These become {@link FacilitatorUnreachableError} so the merchant's fail_open
 * / fail_closed choice applies, instead of charging the payer for our outage.
 */
const FACILITATOR_FAULTS = new Set([
  "unexpected_verify_error",
  "unexpected_settle_error",
  "invalid_transaction_state",
  "settle_exact_svm_transaction_confirmation_timed_out",
  "settle_exact_svm_block_height_exceeded",
]);

export function isFacilitatorFault(reason: string | undefined): boolean {
  return reason !== undefined && FACILITATOR_FAULTS.has(reason);
}

export function rejectCodeFor(reason: string | undefined): RejectCode {
  if (reason === undefined) return "invalid_payment";
  return REASONS[reason] ?? "invalid_payment";
}
