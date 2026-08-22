"""Test doubles, mirroring ``testing.ts`` exactly.

The mock's behaviour is part of the cross-language contract: the golden files
are produced by driving this facilitator, so any divergence from the TypeScript
mock shows up as a golden mismatch.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any, Callable, Dict, List, Optional, Sequence

from .errors import FacilitatorUnreachableError
from .facilitator import FacilitatorAdapter, VerifyResult

__all__ = [
    "MockFacilitator",
    "create_mock_facilitator",
    "encode_payment_header",
    "mock_payment",
    "fixed_clock",
    "counter_ids",
]


class MockFacilitator(FacilitatorAdapter):
    """Accepts any payload carrying ``txRef`` and ``payer``, settling whatever
    the payload claims — so tests drive the outcome from the request side."""

    def __init__(
        self,
        id: str = "mock",
        networks: Sequence[str] = ("base-sepolia",),
        scheme: str = "exact",
        asset_address: Optional[str] = None,
        verify_fn: Optional[Callable[[Dict[str, Any], Dict[str, Any]], Any]] = None,
        unreachable: bool = False,
        latency_ms: int = 0,
    ) -> None:
        self.id = id
        self.networks = list(networks)
        self.scheme = scheme
        self.asset_address = asset_address
        self.verify_fn = verify_fn
        self.unreachable = unreachable
        self.latency_ms = latency_ms
        self.calls: List[Dict[str, Any]] = []
        self.challenges: List[Dict[str, Any]] = []

    def build_challenge(self, req: Dict[str, Any]) -> Dict[str, Any]:
        self.challenges.append(req)
        return {
            "scheme": self.scheme,
            "network": req["network"],
            "maxAmountRequired": str(req["amount"]),
            "resource": req["resource"],
            "description": req["description"],
            "mimeType": req["mimeType"],
            "payTo": req["payTo"],
            "maxTimeoutSeconds": req["maxTimeoutSeconds"],
            "asset": self.asset_address or f"0xasset-{req['network']}",
            "extra": {"nonce": req["nonce"], "expiresAt": req["expiresAt"]},
        }

    async def verify(self, payload: Dict[str, Any], ctx: Dict[str, Any]) -> VerifyResult:
        self.calls.append({"payload": payload, "ctx": ctx})
        if self.latency_ms:
            await asyncio.sleep(self.latency_ms / 1000)
        if self.unreachable:
            raise FacilitatorUnreachableError(f'mock facilitator "{self.id}" is down', self.id)
        if self.verify_fn is not None:
            result = self.verify_fn(payload, ctx)
            if asyncio.iscoroutine(result):
                result = await result
            return result

        body = payload.get("payload") or {}
        tx_ref = body.get("txRef")
        payer = body.get("payer")
        if not isinstance(tx_ref, str) or not isinstance(payer, str):
            return VerifyResult.rejected("invalid_payment", "mock payload needs txRef + payer")

        amount = body.get("amount")
        return VerifyResult.accepted(
            tx_ref=tx_ref,
            payer=payer,
            settled_amount=amount if isinstance(amount, str) else ctx["requirements"]["amount"],
        )


def create_mock_facilitator(**kwargs: Any) -> MockFacilitator:
    return MockFacilitator(**kwargs)


def encode_payment_header(payload: Dict[str, Any]) -> str:
    """Encode a payload the way an agent would send it in ``X-PAYMENT``."""
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def mock_payment(
    network: str = "base-sepolia",
    tx_ref: str = "0xtx-1",
    payer: str = "0xpayer-1",
    amount: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    scheme: str = "exact",
) -> Dict[str, Any]:
    """A payment the default mock facilitator accepts."""
    body: Dict[str, Any] = {"txRef": tx_ref, "payer": payer}
    if amount is not None:
        body["amount"] = amount
    if payload:
        body.update(payload)
    return {"x402Version": 1, "scheme": scheme, "network": network, "payload": body}


def fixed_clock(start_ms: float, step_ms: float = 0) -> Callable[[], float]:
    """Deterministic clock for golden files and ordering tests."""
    state = {"now": start_ms}

    def clock() -> float:
        value = state["now"]
        state["now"] += step_ms
        return value

    return clock


def counter_ids() -> Callable[[str], str]:
    """Deterministic ids: ``oct_<prefix>_0001``, ``oct_<prefix>_0002``, …"""
    counters: Dict[str, int] = {}

    def next_id(prefix: str) -> str:
        counters[prefix] = counters.get(prefix, 0) + 1
        return f"oct_{prefix}_{counters[prefix]:04d}"

    return next_id
