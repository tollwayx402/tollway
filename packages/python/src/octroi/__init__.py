"""Octroi — toll gates for HTTP routes.

The Python port of ``@octroi/core``. One protocol core, thin adapters; the
FastAPI binding lives in :mod:`octroi.fastapi` and needs ``octroi[fastapi]``.

The wire format is identical to the TypeScript SDK, byte for byte — the golden
files in ``golden/`` are the contract, and ``tests/test_golden.py`` holds this
package to them.
"""

from __future__ import annotations

from .canonical import CanonicalJsonError, canonical_bytes, canonical_json
from .challenge import (
    PAYMENT_HEADER,
    RECEIPT_HEADER,
    X402_ERROR_REASONS,
    X402_VERSION,
    build_challenge_body,
    decode_payment_header,
    get_header,
    payload_expiry,
    read_error_detail,
    x402_error_reason,
)
from .errors import (
    DOC_BASE,
    FacilitatorUnreachableError,
    PaymentDecodeError,
    OctroiConfigError,
    error_body,
    reject_message,
)
from .events import EventBus, EventSink, OctroiEvent
from .facilitator import (
    FacilitatorAdapter,
    VerifyResult,
    adapter_for_network,
    get_facilitator,
    register_facilitator,
    registered_facilitators,
    resolve_facilitator,
)
from .gate import Gate, GateRequest, GateResult, create_gate, payment_replay_key
from .nonce import MemoryNonceStore, NonceStore
from .price import ASSET_DECIMALS, asset_decimals, format_atomic, parse_price
from .ratelimit import MemoryRateLimitStore, RateLimitStore, is_denied, payer_hint
from .receipts import (
    Signer,
    create_ephemeral_signer,
    create_signer_from_jwk,
    document_signing_bytes,
    make_receipt,
    public_key_hex,
    sign_document,
    sign_receipt,
    verify_document,
    verify_receipt,
)

__version__ = "0.1.0"

__all__ = [
    "ASSET_DECIMALS",
    "DOC_BASE",
    "PAYMENT_HEADER",
    "RECEIPT_HEADER",
    "X402_ERROR_REASONS",
    "X402_VERSION",
    "CanonicalJsonError",
    "EventBus",
    "EventSink",
    "FacilitatorAdapter",
    "FacilitatorUnreachableError",
    "Gate",
    "GateRequest",
    "GateResult",
    "MemoryNonceStore",
    "MemoryRateLimitStore",
    "RateLimitStore",
    "NonceStore",
    "PaymentDecodeError",
    "Signer",
    "OctroiConfigError",
    "OctroiEvent",
    "VerifyResult",
    "adapter_for_network",
    "asset_decimals",
    "build_challenge_body",
    "canonical_bytes",
    "canonical_json",
    "create_ephemeral_signer",
    "create_gate",
    "create_signer_from_jwk",
    "decode_payment_header",
    "document_signing_bytes",
    "error_body",
    "format_atomic",
    "get_facilitator",
    "get_header",
    "is_denied",
    "make_receipt",
    "parse_price",
    "payer_hint",
    "payload_expiry",
    "payment_replay_key",
    "public_key_hex",
    "read_error_detail",
    "register_facilitator",
    "registered_facilitators",
    "reject_message",
    "resolve_facilitator",
    "sign_document",
    "sign_receipt",
    "verify_document",
    "verify_receipt",
    "x402_error_reason",
]
