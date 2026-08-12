"""The event bus (§7). Mirrors ``events.ts``.

Same rule as TypeScript: ``emit`` is synchronous, never raises, and never waits
on a sink — the request path does not pay for event delivery. Sinks run in emit
order, and one that raises is logged and stepped over rather than stalling the
queue.

Delivery is scheduled on the running event loop, so it happens on its own the
way the TS microtask drain does. With no loop running (a sync script, a test),
the queue holds until :meth:`EventBus.flush` is awaited — an explicit
``flush()`` is always safe and always sufficient.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from typing import Any, Callable, Dict, List, Optional

__all__ = ["EventBus", "EventSink", "TollwayEvent", "EVENT_TYPES"]

TollwayEvent = Dict[str, Any]
EventSink = Callable[[TollwayEvent], Any]

EVENT_TYPES = (
    "challenge.issued",
    "toll.settled",
    "toll.rejected",
    "request.served",
    "request.failed",
    "gate.error",
)

_log = logging.getLogger("tollway")


class EventBus:
    def __init__(
        self,
        sinks: Optional[List[EventSink]] = None,
        merchant: Optional[str] = None,
        clock: Optional[Callable[[], float]] = None,
        new_id: Optional[Callable[[], str]] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._sinks: List[EventSink] = list(sinks or [])
        self._merchant = merchant
        self._clock = clock or (lambda: time.time() * 1000)
        self._new_id = new_id or (lambda: f"evt_{int(time.time() * 1000):x}")
        self._log = logger or _log
        self._queue: List[TollwayEvent] = []
        self._pump: Optional[asyncio.Task] = None

    def add_sink(self, sink: EventSink) -> None:
        self._sinks.append(sink)

    def emit(self, type_: str, route: str, data: Dict[str, Any]) -> TollwayEvent:
        event: TollwayEvent = {
            "id": self._new_id(),
            "v": 1,
            "type": type_,
            "ts": int(self._clock()),
            "route": route,
            "merchant": self._merchant,
            "data": data,
        }
        self._queue.append(event)
        self._schedule()
        return event

    async def flush(self) -> None:
        """Await delivery of everything queued so far."""
        while self._queue or (self._pump is not None and not self._pump.done()):
            if self._pump is not None:
                try:
                    await self._pump
                except asyncio.CancelledError:  # pragma: no cover - shutdown
                    raise
                self._pump = None
            if self._queue:
                await self._drain()

    def _schedule(self) -> None:
        if self._pump is not None and not self._pump.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop: the caller drives delivery with `await flush()`.
            return
        self._pump = loop.create_task(self._drain())

    async def _drain(self) -> None:
        while self._queue:
            event = self._queue.pop(0)
            for sink in self._sinks:
                try:
                    result = sink(event)
                    if inspect.isawaitable(result):
                        await result
                except Exception as error:  # noqa: BLE001 — a sink must not break the queue
                    self._log.warning(
                        "tollway: event sink raised (event %s, %s): %s",
                        event["id"],
                        event["type"],
                        error,
                    )

    @property
    def pending(self) -> int:
        return len(self._queue)
