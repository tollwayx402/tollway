"""Mirrors the TS ingest client suite. Everything runs without a socket:
tests drive delivery through flush() with an injected transport."""

from __future__ import annotations

import gzip
import json
from typing import Dict, List, Tuple

from octroi_ingest import IngestClient


def event(id_: str, type_: str = "toll.settled") -> Dict:
    return {
        "id": id_,
        "v": 1,
        "type": type_,
        "ts": 1_765_432_100_000,
        "route": "/v1/report",
        "merchant": "acct_9d2",
        "data": {},
    }


class Capture:
    def __init__(self, respond=None):
        self.requests: List[Dict] = []
        self._respond = respond or (lambda attempt: (202, "{}"))
        self.attempt = 0

    def __call__(self, url: str, headers: Dict[str, str], body: bytes) -> Tuple[int, str]:
        self.attempt += 1
        raw = gzip.decompress(body) if headers.get("content-encoding") == "gzip" else body
        self.requests.append(
            {
                "url": url,
                "headers": headers,
                "events": json.loads(raw.decode("utf-8"))["events"],
            }
        )
        return self._respond(self.attempt)


def client(capture: Capture, **overrides) -> IngestClient:
    options = {
        "api_key": "k",
        "url": "https://ingest.test",
        "transport": capture,
        "start_thread": False,  # tests drive delivery with flush()
        "jitter": lambda: 0.0,
        "retry_base_s": 0.0,
    }
    options.update(overrides)
    return IngestClient(**options)


class TestBatching:
    def test_no_network_until_flush(self):
        capture = Capture()
        c = client(capture)
        for i in range(99):
            c.sink(event(f"e{i}"))
        assert capture.requests == []
        assert c.stats["buffered"] == 99

        c.flush()
        assert len(capture.requests) == 1
        assert len(capture.requests[0]["events"]) == 99

    def test_batches_of_at_most_100(self):
        capture = Capture()
        c = client(capture)
        for i in range(250):
            c.sink(event(f"e{i}"))
        c.flush()
        assert [len(r["events"]) for r in capture.requests] == [100, 100, 50]

    def test_sends_the_api_key_and_gzips_over_the_threshold(self):
        capture = Capture()
        c = client(capture, gzip_threshold_bytes=0)
        c.sink(event("e1"))
        c.flush()
        assert capture.requests[0]["headers"]["authorization"] == "Bearer k"
        assert capture.requests[0]["headers"]["content-encoding"] == "gzip"
        assert capture.requests[0]["events"][0]["id"] == "e1"

    def test_small_bodies_stay_uncompressed(self):
        capture = Capture()
        c = client(capture, gzip_threshold_bytes=1_000_000)
        c.sink(event("e1"))
        c.flush()
        assert "content-encoding" not in capture.requests[0]["headers"]

    def test_sink_never_raises(self):
        def explode(*_args):
            raise RuntimeError("network on fire")

        c = client(Capture(), transport=explode)
        c.sink(event("e1"))  # must not raise
        c.flush()  # transport failure absorbed into retry state
        assert c.stats["consecutive_failures"] == 1


class TestAtLeastOnce:
    def test_5xx_retries_with_the_same_ids_in_order(self):
        capture = Capture(lambda attempt: (503, "") if attempt == 1 else (202, "{}"))
        c = client(capture)
        c.sink(event("e1"))
        c.sink(event("e2"))
        c.flush()  # fails, requeues
        c.flush()  # succeeds
        assert [e["id"] for e in capture.requests[0]["events"]] == ["e1", "e2"]
        assert [e["id"] for e in capture.requests[1]["events"]] == ["e1", "e2"]
        assert c.stats["sent"] == 2

    def test_429_retries_rather_than_discarding(self):
        capture = Capture(lambda attempt: (429, "") if attempt == 1 else (202, "{}"))
        c = client(capture)
        c.sink(event("e1"))
        c.flush()
        c.flush()
        assert c.stats["sent"] == 1

    def test_4xx_discards_instead_of_retrying_forever(self):
        capture = Capture(lambda attempt: (401, "bad key"))
        c = client(capture)
        c.sink(event("e1"))
        c.flush()
        assert c.stats["abandoned"] == 1
        assert c.stats["buffered"] == 0
        # And it does not poison the next batch.
        c.sink(event("e2"))
        c.flush()
        assert len(capture.requests) == 2

    def test_gives_up_after_max_attempts(self):
        capture = Capture(lambda attempt: (503, ""))
        c = client(capture, max_attempts=3)
        c.sink(event("e1"))
        for _ in range(4):
            c.flush()
        assert c.stats["abandoned"] > 0
        assert c.stats["buffered"] == 0


class TestOverflow:
    def test_drops_oldest_and_reports_the_loss_in_the_stream(self):
        capture = Capture()
        c = client(capture, max_buffered_events=10)
        for i in range(15):
            c.sink(event(f"e{i}"))
        c.flush()

        assert c.stats["dropped"] == 5
        ids = [e["id"] for r in capture.requests for e in r["events"]]
        assert "e0" not in ids
        assert "e14" in ids

        overflow = [
            e
            for r in capture.requests
            for e in r["events"]
            if e["type"] == "gate.error" and e["data"].get("code") == "ingest_overflow"
        ]
        assert len(overflow) == 1
        assert overflow[0]["data"]["dropped"] == 5

    def test_the_report_survives_a_failed_flush(self):
        # The overflow notice must not be requeued into the buffer where the
        # next overflow could drop it.
        capture = Capture(lambda attempt: (503, "") if attempt == 1 else (202, "{}"))
        c = client(capture, max_buffered_events=5)
        for i in range(9):
            c.sink(event(f"e{i}"))
        c.flush()  # fails
        c.flush()  # succeeds
        overflow = [
            e
            for r in capture.requests[1:]
            for e in r["events"]
            if e["data"].get("code") == "ingest_overflow"
        ]
        assert len(overflow) == 1


class TestLifecycle:
    def test_close_flushes_and_then_ignores(self):
        capture = Capture()
        c = client(capture)
        c.sink(event("e1"))
        c.close()
        assert len(capture.requests) == 1
        c.sink(event("e2"))
        c.flush()
        assert len(capture.requests) == 1

    def test_close_does_not_retry_a_failing_final_flush(self):
        capture = Capture(lambda attempt: (503, ""))
        c = client(capture)
        c.sink(event("e1"))
        c.close()
        after = capture.attempt
        c.flush()
        assert capture.attempt == after

    def test_requires_an_api_key(self):
        import pytest

        with pytest.raises(ValueError, match="api_key is required"):
            IngestClient(api_key="", start_thread=False)


class TestBackgroundThread:
    def test_the_worker_delivers_without_manual_flush(self):
        import time

        capture = Capture()
        c = IngestClient(
            api_key="k",
            url="https://ingest.test",
            transport=capture,
            flush_interval_s=0.05,
            jitter=lambda: 0.0,
        )
        c.sink(event("e1"))
        deadline = time.time() + 2
        while not capture.requests and time.time() < deadline:
            time.sleep(0.01)
        c.close()
        assert len(capture.requests) >= 1
        assert capture.requests[0]["events"][0]["id"] == "e1"
