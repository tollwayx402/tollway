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
 * **Settle stage**: faults where money may have moved without a usable answer
 * (`unexpected_settle_error`, confirmation timeouts, state races). Calling the
 * payment "bad" there could be a lie; the merchant's mode must decide.
 */
const VERIFY_FAULTS = new Set(["invalid_payment_requirements"]);

const SETTLE_FAULTS = new Set([
  "unexpected_settle_error",
  "invalid_transaction_state",
  "settle_exact_svm_transaction_confirmation_timed_out",
  "settle_exact_svm_block_height_exceeded",
]);

export function isFacilitatorFault(
  reason: string | undefined,
  stage: "verify" | "settle",
): boolean {
  if (reason === undefined) return false;
  return stage === "verify" ? VERIFY_FAULTS.has(reason) : SETTLE_FAULTS.has(reason);
}

export function rejectCodeFor(reason: string | undefined): RejectCode {
  if (reason === undefined) return "invalid_payment";
  return REASONS[reason] ?? "invalid_payment";
}
