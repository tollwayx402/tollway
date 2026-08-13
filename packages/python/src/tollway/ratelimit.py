"""§9 spam & abuse: token buckets and the payer denylist. Mirrors ``ratelimit.ts``."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterable, Optional, Tuple, Union

__all__ = ["RateLimitStore", "MemoryRateLimitStore", "is_denied", "payer_hint"]

Denylist = Union[Iterable[str], Callable[[], Iterable[str]]]


class RateLimitStore:
    """One method, so a shared (Redis) implementation stays trivial."""

    def take(self, key: str, rate_per_minute: float, burst: float) -> bool:  # pragma: no cover
        raise NotImplementedError


class MemoryRateLimitStore(RateLimitStore):
    """Token bucket over an LRU map.

    Eviction forgets a bucket, which refills it — an attacker cycling millions
    of keys gets fresh buckets anyway, so the cap costs nothing they could not
    already have, while bounding memory.
    """

    def __init__(
        self,
        max_entries: int = 50_000,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        self._buckets: "OrderedDict[str, Tuple[float, float]]" = OrderedDict()
        self._max_entries = max_entries
        self._clock = clock or (lambda: time.time() * 1000)

    def take(self, key: str, rate_per_minute: float, burst: float) -> bool:
        now = self._clock()
        existing = self._buckets.pop(key, None)
        if existing is None:
            tokens = float(burst)
        else:
            prev_tokens, updated_at = existing
            tokens = min(float(burst), prev_tokens + (now - updated_at) / 60_000.0 * rate_per_minute)

        while len(self._buckets) >= self._max_entries:
            self._buckets.popitem(last=False)

        if tokens < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1, now)
        return True

    @property
    def size(self) -> int:
        return len(self._buckets)


def is_denied(denylist: Optional[Denylist], payer: Optional[str]) -> bool:
    if denylist is None or payer is None:
        return False
    entries = denylist() if callable(denylist) else denylist
    needle = payer.lower()
    return any(str(entry).lower() == needle for entry in entries)


def payer_hint(payload: Dict[str, Any]) -> Optional[str]:
    """Best-effort payer from an unverified payload — cost shedding, not the
    enforcement point. The verified payer is checked again after."""
    direct = payload.get("payer")
    if isinstance(direct, str) and direct:
        return direct
    authorization = payload.get("authorization")
    if isinstance(authorization, dict):
        from_ = authorization.get("from")
        if isinstance(from_, str) and from_:
            return from_
    return None
