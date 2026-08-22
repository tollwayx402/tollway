"""Error codes and the §10 envelope."""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = [
    "DOC_BASE",
    "OctroiConfigError",
    "FacilitatorUnreachableError",
    "PaymentDecodeError",
    "error_body",
    "reject_message",
]

DOC_BASE = "https://octroi.ai/docs/errors#"

_REJECT_MESSAGES = {
    "invalid_payment": "Payment payload was missing, malformed, or failed verification.",
    "expired": "Payment authorization expired before it was verified.",
    "wrong_amount": "Settled amount is less than the price of this route.",
    "wrong_network": "Payment was made on a network this route does not accept.",
    "replay": "This payment payload was already used.",
}


def error_body(code: str, message: str) -> Dict[str, Any]:
    """Every 4xx/5xx body the SDK produces (§10)."""
    return {"error": {"code": code, "message": message, "doc": f"{DOC_BASE}{code}"}}


def reject_message(code: str) -> str:
    return _REJECT_MESSAGES.get(code, "Payment was rejected.")


class OctroiConfigError(ValueError):
    """Merchant misconfiguration — always raised at construction time."""

    code = "invalid_config"


class FacilitatorUnreachableError(RuntimeError):
    """The facilitator could not be reached, or did not answer in time.

    Adapters raise this (or any exception, which the core treats the same way)
    so the merchant's ``mode`` decides what happens. Rejections are return
    values; outages are exceptions.
    """

    code = "facilitator_unreachable"

    def __init__(self, message: str, facilitator: Optional[str] = None) -> None:
        super().__init__(message)
        self.facilitator = facilitator


class PaymentDecodeError(ValueError):
    """The ``X-PAYMENT`` header could not be decoded."""

    code = "invalid_payment"
