"""Receipts and the one signing rule (§6).

Ed25519 over the canonical JSON of the document minus its ``sig`` field,
base64url without padding. Receipts use it; so does signed remote config.
Identical to ``receipts.ts`` — the golden files prove it byte for byte.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Dict, Optional, Union

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.exceptions import InvalidSignature

from .canonical import canonical_bytes

__all__ = [
    "Signer",
    "create_ephemeral_signer",
    "create_signer_from_jwk",
    "document_signing_bytes",
    "sign_document",
    "verify_document",
    "sign_receipt",
    "verify_receipt",
    "public_key_hex",
]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


class Signer:
    """An Ed25519 signing key.

    Standalone mode generates an ephemeral one at boot: receipts verify inside
    the merchant's own system for the life of the process. Cloud mode loads the
    account key, which makes receipts portable.
    """

    algorithm = "ed25519"

    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._private_key = private_key
        self._public = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.key_id = hashlib.sha256(self._public).hexdigest()[:16]

    def sign(self, data: bytes) -> bytes:
        return self._private_key.sign(data)

    def public_key(self) -> bytes:
        return self._public


def create_ephemeral_signer() -> Signer:
    return Signer(Ed25519PrivateKey.generate())


def create_signer_from_jwk(jwk: Dict[str, str]) -> Signer:
    """Load a persistent key from ``{"kty":"OKP","crv":"Ed25519","d":…,"x":…}``."""
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        raise ValueError("expected an Ed25519 OKP JWK")
    seed = _b64url_decode(jwk["d"])
    return Signer(Ed25519PrivateKey.from_private_bytes(seed))


def document_signing_bytes(document: Dict[str, Any]) -> bytes:
    """The bytes a signature covers: canonical JSON minus ``sig``."""
    return canonical_bytes({k: v for k, v in document.items() if k != "sig"})


def sign_document(document: Dict[str, Any], signer: Signer) -> Dict[str, Any]:
    signature = signer.sign(document_signing_bytes(document))
    return {**document, "sig": _b64url(signature)}


def verify_document(
    document: Dict[str, Any], public_key: Union[bytes, Ed25519PublicKey]
) -> bool:
    key = (
        public_key
        if isinstance(public_key, Ed25519PublicKey)
        else Ed25519PublicKey.from_public_bytes(public_key)
    )
    signature = document.get("sig")
    if not isinstance(signature, str):
        return False
    try:
        key.verify(_b64url_decode(signature), document_signing_bytes(document))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


# Receipts are just signed documents; the vocabulary is kept for readability.
sign_receipt = sign_document
verify_receipt = verify_document


def public_key_hex(signer: Signer) -> str:
    return signer.public_key().hex()


def make_receipt(
    *,
    receipt_id: str,
    route: str,
    amount: int,
    asset: str,
    network: str,
    payer: str,
    tx_ref: str,
    ts: int,
    merchant: Optional[str],
) -> Dict[str, Any]:
    """The §6 body, field order irrelevant — canonicalization sorts it."""
    return {
        "id": receipt_id,
        "v": 1,
        "route": route,
        "amount": str(amount),
        "asset": asset,
        "network": network,
        "payer": payer,
        "tx_ref": tx_ref,
        "ts": ts,
        "merchant": merchant,
    }
