"""The facilitator interface and registry (§5). Mirrors ``facilitator.ts``."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Union

from .errors import TollwayConfigError

__all__ = [
    "FacilitatorAdapter",
    "VerifyResult",
    "register_facilitator",
    "get_facilitator",
    "registered_facilitators",
    "resolve_facilitator",
    "adapter_for_network",
]


class VerifyResult:
    """Rejections are values; outages are exceptions."""

    def __init__(
        self,
        ok: bool,
        *,
        tx_ref: str = "",
        settled_amount: Union[int, str] = 0,
        payer: str = "",
        code: str = "invalid_payment",
        message: Optional[str] = None,
        raw: Any = None,
    ) -> None:
        self.ok = ok
        self.tx_ref = tx_ref
        self.settled_amount = settled_amount
        self.payer = payer
        self.code = code
        self.message = message
        self.raw = raw

    @classmethod
    def accepted(
        cls, tx_ref: str, settled_amount: Union[int, str], payer: str, raw: Any = None
    ) -> "VerifyResult":
        return cls(True, tx_ref=tx_ref, settled_amount=settled_amount, payer=payer, raw=raw)

    @classmethod
    def rejected(cls, code: str, message: Optional[str] = None, raw: Any = None) -> "VerifyResult":
        return cls(False, code=code, message=message, raw=raw)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"VerifyResult(ok={self.ok}, code={self.code!r}, tx_ref={self.tx_ref!r})"


class FacilitatorAdapter:
    """The whole facilitator surface (§5).

    ``verify`` may be sync or async; the gate awaits either.
    """

    id: str = ""
    networks: Sequence[str] = ()

    def build_challenge(self, req: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def verify(self, payload: Dict[str, Any], ctx: Dict[str, Any]) -> Any:  # pragma: no cover
        raise NotImplementedError


_registry: Dict[str, FacilitatorAdapter] = {}


def register_facilitator(adapter: FacilitatorAdapter) -> None:
    _registry[adapter.id] = adapter


def get_facilitator(id_: str) -> Optional[FacilitatorAdapter]:
    return _registry.get(id_)


def registered_facilitators() -> List[str]:
    return sorted(_registry)


def resolve_facilitator(spec: Union[str, FacilitatorAdapter]) -> FacilitatorAdapter:
    if not isinstance(spec, str):
        return spec
    adapter = _registry.get(spec)
    if adapter is None:
        known = registered_facilitators()
        suffix = f" (registered: {', '.join(known)})" if known else ""
        raise TollwayConfigError(
            f'unknown facilitator "{spec}"; import the adapter module first{suffix}'
        )
    return adapter


def adapter_for_network(
    adapters: Sequence[FacilitatorAdapter], network: str
) -> Optional[FacilitatorAdapter]:
    for adapter in adapters:
        if network in adapter.networks:
            return adapter
    return None
