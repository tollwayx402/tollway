"""Challenge construction and payment decoding (§4). Mirrors ``challenge.ts``."""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Dict, List, Mapping, Optional

from .errors import PaymentDecodeError, error_body

__all__ = [
    "X402_VERSION",
    "PAYMENT_HEADER",
    "RECEIPT_HEADER",
    "X402_ERROR_REASONS",
    "x402_error_reason",
    "build_challenge_body",
    "decode_payment_header",
    "payload_expiry",
    "read_error_detail",
]

#: Pinned x402 revision — see core/PROTOCOL.md before changing.
X402_VERSION = 1

PAYMENT_HEADER = "x-payment"
RECEIPT_HEADER = "x-octroi-receipt"

#: x402 types ``error`` as an optional *closed enum*, not free text. Our own
#: codes fail its schema outright, so we map onto the enum and keep the precise
#: code in ``errorDetail``. Verified against x402@1.2.0 by the TS interop suite.
X402_ERROR_REASONS = {
    "invalid_payment": "invalid_payment",
    "expired": "payment_expired",
    "wrong_network": "invalid_network",
    "wrong_amount": "invalid_payment",
    "replay": "duplicate_settlement",
}


def x402_error_reason(code: str) -> Optional[str]:
    return X402_ERROR_REASONS.get(code)


def build_challenge_body(accepts: List[Dict[str, Any]], code: str, message: str) -> Dict[str, Any]:
    """A superset, never a replacement: spec fields plus the §10 envelope."""
    body: Dict[str, Any] = {"x402Version": X402_VERSION, "accepts": accepts}
    reason = x402_error_reason(code)
    if reason is not None:
        body["error"] = reason
    body["errorDetail"] = error_body(code, message)["error"]
    return body


def read_error_detail(body: Any) -> Optional[Dict[str, Any]]:
    """Read the Octroi envelope from any SDK body, 402 or not."""
    if not isinstance(body, dict):
        return None
    candidate = body.get("errorDetail", body.get("error"))
    if not isinstance(candidate, dict):
        return None
    if not isinstance(candidate.get("code"), str) or not isinstance(candidate.get("message"), str):
        return None
    return candidate


def decode_payment_header(value: str) -> Dict[str, Any]:
    """Decode ``X-PAYMENT``: base64 JSON per x402, or bare JSON for debugging."""
    trimmed = value.strip()
    if not trimmed:
        raise PaymentDecodeError("payment header is empty")

    if trimmed.startswith("{"):
        raw = trimmed
    else:
        try:
            # The TS decoder accepts both the standard and URL-safe alphabets;
            # match it exactly so the two implementations accept and reject
            # identical inputs. (The reference client itself sends standard
            # base64 — this is parity, not necessity.)
            normalized = trimmed.replace("-", "+").replace("_", "/")
            padded = normalized + "=" * (-len(normalized) % 4)
            raw = base64.b64decode(padded, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            raise PaymentDecodeError("payment header is not valid base64 JSON") from None

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise PaymentDecodeError("payment header did not contain valid JSON") from None

    return _assert_payment_payload(parsed)


def _assert_payment_payload(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise PaymentDecodeError("payment payload must be a JSON object")

    scheme = value.get("scheme")
    network = value.get("network")
    payload = value.get("payload")
    version = value.get("x402Version")

    if not isinstance(scheme, str) or not scheme:
        raise PaymentDecodeError("payment payload is missing `scheme`")
    if not isinstance(network, str) or not network:
        raise PaymentDecodeError("payment payload is missing `network`")
    if not isinstance(payload, dict):
        raise PaymentDecodeError("payment payload is missing `payload`")
    if version is not None and not isinstance(version, int):
        raise PaymentDecodeError("`x402Version` must be a number")

    return {
        "x402Version": version if isinstance(version, int) else X402_VERSION,
        "scheme": scheme,
        "network": network,
        "payload": payload,
    }


def payload_expiry(payment: Mapping[str, Any]) -> Optional[int]:
    """Best-effort expiry, unix seconds. Anything unreadable is the facilitator's call."""
    body = payment.get("payload") or {}
    authorization = body.get("authorization")
    candidates = [
        body.get("validBefore"),
        body.get("expiresAt"),
        authorization.get("validBefore") if isinstance(authorization, dict) else None,
    ]
    for candidate in candidates:
        seconds = _read_unix_seconds(candidate)
        if seconds is not None:
            return seconds
    return None


def _read_unix_seconds(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def get_header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    """Case-insensitive header read from any mapping-ish object."""
    getter = getattr(headers, "get", None)
    if getter is not None:
        direct = getter(name)
        if direct is None:
            direct = getter(name.lower())
        if direct is not None:
            return direct[0] if isinstance(direct, (list, tuple)) else str(direct)

    lower = name.lower()
    for key, value in dict(headers).items():
        if str(key).lower() == lower:
            return value[0] if isinstance(value, (list, tuple)) else str(value)
    return None
