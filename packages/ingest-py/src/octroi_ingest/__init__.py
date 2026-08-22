"""octroi-ingest — the cloud event client, Python side (§7 delivery).

Mirrors ``@octroi/ingest``'s semantics exactly:

- HTTPS, gzip over 1 KiB, at-least-once, flush at 5s or 100 events
- 10k-event retry buffer, drop-oldest on overflow — with the overflow report
  carried alongside the next batch rather than *in* the buffer, so the notice
  that data was lost can never itself be lost to the next overflow
- 4xx discards (a bad key never succeeds; retrying it forever means never
  sending anything again); 5xx/429 retries with exponential backoff, then
  gives up loudly rather than growing without bound
- ``sink`` never blocks and never raises: it appends under a lock and returns.
  Every network cost lives on the worker thread.

BSL-licensed, deliberately separate from the MIT ``octroi`` package — the SDK
works with no cloud and no BSL code installed (spec §1.1).

Usage::

    from octroi_ingest import IngestClient

    client = IngestClient(api_key=os.environ["OCT_KEY"])
    tw = Octroi(..., sinks=[client.sink])
"""

from __future__ import annotations

import gzip
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

__all__ = ["IngestClient", "DEFAULT_INGEST_URL"]

DEFAULT_INGEST_URL = "https://ingest.octroi.sh"

_log = logging.getLogger("octroi")

#: transport(url, headers, body) -> (status, response_text). Injectable so the
#: test suite never touches a socket.
Transport = Callable[[str, Dict[str, str], bytes], Tuple[int, str]]


def _default_transport(timeout_s: float) -> Transport:
    def send(url: str, headers: Dict[str, str], body: bytes) -> Tuple[int, str]:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                return response.status, response.read(200).decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read(200).decode("utf-8", "replace")

    return send


class IngestClient:
    def __init__(
        self,
        api_key: str,
        url: str = DEFAULT_INGEST_URL,
        *,
        flush_interval_s: float = 5.0,
        max_batch_size: int = 100,
        max_buffered_events: int = 10_000,
        gzip_threshold_bytes: int = 1024,
        max_attempts: int = 6,
        retry_base_s: float = 0.5,
        request_timeout_s: float = 10.0,
        transport: Optional[Transport] = None,
        clock: Optional[Callable[[], float]] = None,
        jitter: Optional[Callable[[], float]] = None,
        # start_thread=False lets tests drive delivery with flush() alone.
        start_thread: bool = True,
    ) -> None:
        if not api_key:
            raise ValueError("octroi-ingest: api_key is required")

        self._url = url.rstrip("/") + "/v1/events"
        self._api_key = api_key
        self._flush_interval_s = flush_interval_s
        self._max_batch_size = max_batch_size
        self._max_buffered_events = max_buffered_events
        self._gzip_threshold = gzip_threshold_bytes
        self._max_attempts = max_attempts
        self._retry_base_s = retry_base_s
        self._transport = transport or _default_transport(request_timeout_s)
        self._clock = clock or time.time
        self._jitter = jitter or random.random

        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._buffer: List[Dict[str, Any]] = []
        self._pending_overflow: Optional[Dict[str, Any]] = None
        self._closed = False
        self._next_retry_at: float = 0.0

        self.stats = {
            "buffered": 0,
            "sent": 0,
            "dropped": 0,
            "abandoned": 0,
            "consecutive_failures": 0,
        }

        self._thread: Optional[threading.Thread] = None
        if start_thread:
            self._thread = threading.Thread(
                target=self._run, name="octroi-ingest", daemon=True
            )
            self._thread.start()

    # --- the request-path surface ------------------------------------------

    def sink(self, event: Dict[str, Any]) -> None:
        """Append and return. Never blocks on the network, never raises."""
        try:
            with self._lock:
                if self._closed:
                    return
                self._buffer.append(event)
                if len(self._buffer) > self._max_buffered_events:
                    self._drop_oldest_locked()
                self.stats["buffered"] = len(self._buffer)
                if len(self._buffer) >= self._max_batch_size:
                    self._wake.notify()
        except Exception:  # pragma: no cover — the request path must not pay
            pass

    # --- delivery -----------------------------------------------------------

    def flush(self) -> None:
        """Send everything buffered now. Thread-safe; also used by the worker."""
        while True:
            with self._lock:
                report = self._pending_overflow
                batch = self._buffer[: self._max_batch_size]
                del self._buffer[: len(batch)]
                self.stats["buffered"] = len(self._buffer)
            if not batch and report is None:
                return

            wire = ([self._overflow_event(report)] if report is not None else []) + batch
            try:
                self._post(wire)
            except _PermanentRejection as error:
                self.stats["abandoned"] += len(wire)
                self.stats["consecutive_failures"] = 0
                _log.error("octroi: ingest rejected a batch permanently, discarding it: %s", error)
                continue
            except Exception as error:  # noqa: BLE001 — transient: retry later
                with self._lock:
                    # Back at the front: order is part of the contract. The
                    # overflow report is NOT a buffered event and must not be
                    # requeued where the next overflow could drop it.
                    self._buffer[:0] = batch
                    if len(self._buffer) > self._max_buffered_events:
                        self._drop_oldest_locked()
                    self.stats["buffered"] = len(self._buffer)
                    self.stats["consecutive_failures"] += 1
                    failures = self.stats["consecutive_failures"]

                    if failures >= self._max_attempts:
                        self.stats["abandoned"] += len(self._buffer)
                        _log.error(
                            "octroi: ingest unreachable after %d attempts, giving up on %d events",
                            failures,
                            len(self._buffer),
                        )
                        self._buffer.clear()
                        self.stats["buffered"] = 0
                        self.stats["consecutive_failures"] = 0
                        return

                    exponent = min(failures, 6)
                    delay = self._retry_base_s * (2 ** (exponent - 1)) * (0.5 + self._jitter())
                    self._next_retry_at = self._clock() + delay
                _log.warning("octroi: ingest flush failed (attempt %d): %s", failures, error)
                return

            self.stats["sent"] += len(wire)
            self.stats["consecutive_failures"] = 0
            with self._lock:
                # Cleared only once accepted — and only if no further drop
                # happened while this batch was in flight.
                if report is not None and self._pending_overflow is report:
                    self._pending_overflow = None

    def close(self) -> None:
        """Stop accepting, final best-effort flush, stop the thread."""
        with self._lock:
            if self._closed:
                return
            # Before the final flush: a failing final flush must not schedule
            # more retries after the caller was told we stopped.
            self._closed = True
            self._wake.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._max_attempts = 1  # the final flush gets one shot, not a backoff loop
        self.flush()

    # --- internals ----------------------------------------------------------

    def _run(self) -> None:
        while True:
            with self._lock:
                if self._closed:
                    return
                self._wake.wait(timeout=self._flush_interval_s)
                if self._closed:
                    return
                if self._clock() < self._next_retry_at:
                    continue
                has_work = bool(self._buffer) or self._pending_overflow is not None
            if has_work:
                self.flush()

    def _drop_oldest_locked(self) -> None:
        overflow = len(self._buffer) - self._max_buffered_events
        if overflow <= 0:
            return
        del self._buffer[:overflow]
        self.stats["dropped"] += overflow
        first = self._pending_overflow is None
        self._pending_overflow = {"dropped": self.stats["dropped"], "at": int(self._clock() * 1000)}
        if first:
            _log.warning(
                "octroi: ingest buffer overflowed, dropping oldest events (dropped=%d)",
                self.stats["dropped"],
            )

    def _overflow_event(self, report: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": f"oct_evt_overflow_{report['at']:x}_{report['dropped']}",
            "v": 1,
            "type": "gate.error",
            "ts": report["at"],
            "route": "",
            "merchant": None,
            "data": {
                "code": "ingest_overflow",
                "message": (
                    f"ingest buffer exceeded {self._max_buffered_events} events; oldest dropped"
                ),
                "dropped": report["dropped"],
            },
        }

    def _post(self, events: List[Dict[str, Any]]) -> None:
        body = json.dumps({"events": events}, separators=(",", ":")).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self._api_key}",
        }
        if len(body) >= self._gzip_threshold:
            body = gzip.compress(body)
            headers["content-encoding"] = "gzip"

        status, text = self._transport(self._url, headers, body)
        if status >= 500 or status == 429:
            raise RuntimeError(f"ingest responded {status}")
        if status >= 400:
            raise _PermanentRejection(f"ingest rejected the batch: {status} {text[:200]}")


class _PermanentRejection(RuntimeError):
    """A 4xx: our fault, unfixable by retry."""
