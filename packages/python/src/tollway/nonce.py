"""Replay protection (§4.5). Mirrors ``nonce.ts``."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Callable, Optional

__all__ = ["NonceStore", "MemoryNonceStore"]


class NonceStore:
    """Two methods, so a Redis implementation is an ``EXISTS`` and a ``SET NX PX``."""

    def has(self, key: str) -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    def consume(self, key: str, ttl_ms: int) -> bool:  # pragma: no cover - interface
        """MUST be atomic: only the first caller gets ``True``."""
        raise NotImplementedError


class MemoryNonceStore(NonceStore):
    """In-memory LRU with per-entry TTL. Correct for a single process only.

    Two instances behind a load balancer each keep their own set of burned
    payloads, so the same payment presented to both is accepted twice. Pass a
    shared store for multi-instance deployments.
    """

    def __init__(
        self,
        max_entries: int = 10_000,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        self._entries: "OrderedDict[str, float]" = OrderedDict()
        self._max_entries = max_entries
        self._clock = clock or (lambda: time.time() * 1000)

    def has(self, key: str) -> bool:
        expires_at = self._entries.get(key)
        if expires_at is None:
            return False
        if expires_at <= self._clock():
            del self._entries[key]
            return False
        # Touch: keep live keys away from the eviction end.
        self._entries.move_to_end(key)
        return True

    def consume(self, key: str, ttl_ms: int) -> bool:
        if self.has(key):
            return False
        if len(self._entries) >= self._max_entries:
            # Only pay for the sweep under pressure; steady state is O(1).
            self._sweep()
            while len(self._entries) >= self._max_entries:
                self._entries.popitem(last=False)
        self._entries[key] = self._clock() + ttl_ms
        return True

    @property
    def size(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()

    def _sweep(self) -> None:
        now = self._clock()
        for key in [k for k, expires_at in self._entries.items() if expires_at <= now]:
            del self._entries[key]
