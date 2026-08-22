"""A Python facilitator adapter for the x402 facilitator HTTP contract.

The same POST /verify + POST /settle protocol the TypeScript @octroi/coinbase
adapter speaks, with the same rules: rejections are return values, outages are
exceptions, and a verify-stage "unexpected error" is a REJECTION — the payload
is attacker-controlled input, and under fail_open an outage would be free
content.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict

from octroi import FacilitatorAdapter, FacilitatorUnreachableError, VerifyResult

DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator"

# Verified facts from x402@1.2.0 — see packages/coinbase/src/networks.ts for
# the full 15-network table and the provenance note.
NETWORKS = {
    "base": {"asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "eip712": {"name": "USD Coin", "version": "2"}},
    "base-sepolia": {"asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "eip712": {"name": "USDC", "version": "2"}},
}

_SETTLE_FAULTS = {
    "unexpected_settle_error",
    "invalid_transaction_state",
    "settle_exact_svm_transaction_confirmation_timed_out",
    "settle_exact_svm_block_height_exceeded",
}

_REASONS = {
    "payment_expired": "expired",
    "invalid_exact_evm_payload_authorization_valid_before": "expired",
    "invalid_exact_evm_payload_authorization_value": "wrong_amount",
    "invalid_network": "wrong_network",
    "duplicate_settlement": "replay",
}


class CoinbaseFacilitator(FacilitatorAdapter):
    def __init__(self, url: str = DEFAULT_FACILITATOR_URL, timeout_s: float = 10.0) -> None:
        self.id = "coinbase"
        self.networks = list(NETWORKS)
        self._url = url.rstrip("/")
        self._timeout_s = timeout_s

    def build_challenge(self, req: Dict[str, Any]) -> Dict[str, Any]:
        network = NETWORKS[req["network"]]
        return {
            "scheme": "exact",
            "network": req["network"],
            "maxAmountRequired": str(req["amount"]),
            "resource": req["resource"],
            "description": req["description"],
            "mimeType": req["mimeType"],
            "payTo": req["payTo"],
            "maxTimeoutSeconds": req["maxTimeoutSeconds"],
            "asset": network["asset"],
            # The EIP-712 domain the payer signs under — not a metadata slot.
            "extra": network["eip712"],
        }

    def verify(self, payload: Dict[str, Any], ctx: Dict[str, Any]) -> VerifyResult:
        verify_body = self._call("verify", payload, ctx["scheme"])
        if not isinstance(verify_body.get("isValid"), bool):
            raise FacilitatorUnreachableError("verify returned no verdict", self.id)
        if not verify_body["isValid"]:
            reason = verify_body.get("invalidReason")
            if reason == "invalid_payment_requirements":
                raise FacilitatorUnreachableError(f"verify failed: {reason}", self.id)
            return VerifyResult.rejected(
                _REASONS.get(reason or "", "invalid_payment"),
                f"facilitator rejected the payment: {reason}" if reason else None,
            )

        settle_body = self._call("settle", payload, ctx["scheme"])
        if not isinstance(settle_body.get("success"), bool):
            raise FacilitatorUnreachableError("settle returned no verdict", self.id)
        if not settle_body["success"]:
            reason = settle_body.get("errorReason")
            if reason in _SETTLE_FAULTS:
                raise FacilitatorUnreachableError(f"settle failed: {reason}", self.id)
            return VerifyResult.rejected(_REASONS.get(reason or "", "invalid_payment"))

        transaction = settle_body.get("transaction")
        if not isinstance(transaction, str) or transaction in ("", "0x"):
            raise FacilitatorUnreachableError("settle succeeded with no transaction ref", self.id)
        return VerifyResult.accepted(
            tx_ref=transaction,
            settled_amount=ctx["requirements"]["amount"],
            payer=settle_body.get("payer") or verify_body.get("payer") or "unknown",
        )

    def _call(self, path: str, payload: Dict[str, Any], scheme: Dict[str, Any]) -> Dict[str, Any]:
        body = json.dumps(
            {"x402Version": payload["x402Version"], "paymentPayload": payload, "paymentRequirements": scheme}
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self._url}/{path}", data=body, headers={"content-type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                return json.loads(error.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise FacilitatorUnreachableError(
                    f"{path} returned a non-JSON body (status {error.code})", self.id
                ) from None
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as error:
            raise FacilitatorUnreachableError(f"{path} call failed: {error}", self.id) from None


def coinbase_facilitator(**kwargs: Any) -> CoinbaseFacilitator:
    return CoinbaseFacilitator(**kwargs)
