"""§9 in Python, mirroring the TypeScript ratelimit suite."""

from __future__ import annotations

import pytest

from octroi import (
    GateRequest,
    MemoryRateLimitStore,
    OctroiConfigError,
    VerifyResult,
    create_gate,
    payer_hint,
)
from octroi.testing import create_mock_facilitator, encode_payment_header, mock_payment

NOW = 1_765_432_100_000


def build(**overrides):
    events = []
    now = {"t": NOW}
    facilitator = overrides.pop("facilitator", None) or create_mock_facilitator(
        networks=["base-sepolia"]
    )
    options = {
        "price": "$0.004",
        "network": "base-sepolia",
        "pay_to": "0xmerchant",
        "facilitator": facilitator,
        "on_event": events.append,
        "clock": lambda: now["t"],
        "rate_limit": {"challenges_per_minute_per_ip": 3, "attempts_per_minute_per_payer": 3},
        "rate_limit_store": MemoryRateLimitStore(clock=lambda: now["t"]),
    }
    options.update(overrides)
    return create_gate(**options), events, now, facilitator


def unpaid(ip=None):
    return GateRequest(
        method="GET",
        route="/v1/report",
        url="https://api.example.com/v1/report",
        headers={},
        ip=ip,
    )


def paid(payer="0xpayer-1", tx_ref="0xtx-1", ip="203.0.113.7"):
    return GateRequest(
        method="GET",
        route="/v1/report",
        url="https://api.example.com/v1/report",
        headers={"x-payment": encode_payment_header(mock_payment(payer=payer, tx_ref=tx_ref))},
        ip=ip,
    )


class TestStore:
    def test_burst_refuse_refill(self):
        t = {"n": 0.0}
        store = MemoryRateLimitStore(clock=lambda: t["n"])
        assert store.take("k", 60, 2) is True
        assert store.take("k", 60, 2) is True
        assert store.take("k", 60, 2) is False
        t["n"] += 1_000
        assert store.take("k", 60, 2) is True
        assert store.take("k", 60, 2) is False

    def test_refill_caps_at_burst(self):
        t = {"n": 0.0}
        store = MemoryRateLimitStore(clock=lambda: t["n"])
        store.take("k", 60, 2)
        t["n"] += 3_600_000
        assert store.take("k", 60, 2) is True
        assert store.take("k", 60, 2) is True
        assert store.take("k", 60, 2) is False

    def test_lru_eviction_is_only_ever_generous(self):
        store = MemoryRateLimitStore(max_entries=2, clock=lambda: 0)
        store.take("a", 60, 1)
        store.take("b", 60, 1)
        store.take("c", 60, 1)
        assert store.size == 2
        assert store.take("a", 60, 1) is True


class TestPerIpChallenges:
    async def test_429_then_recovery(self):
        gate, _, now, _ = build()
        for _ in range(3):
            assert (await gate.handle(unpaid("203.0.113.7"))).status == 402

        limited = await gate.handle(unpaid("203.0.113.7"))
        assert limited.status == 429
        assert limited.code == "rate_limited"
        assert limited.headers["retry-after"] == "60"

        now["t"] += 20_000  # 3/min → one token per 20s
        assert (await gate.handle(unpaid("203.0.113.7"))).status == 402

    async def test_per_ip_not_global(self):
        gate, _, _, _ = build()
        for _ in range(3):
            await gate.handle(unpaid("203.0.113.7"))
        assert (await gate.handle(unpaid("203.0.113.7"))).status == 429
        assert (await gate.handle(unpaid("198.51.100.9"))).status == 402

    async def test_inert_without_an_ip(self):
        gate, _, _, _ = build()
        for _ in range(10):
            assert (await gate.handle(unpaid())).status == 402

    async def test_429_emits_no_event(self):
        gate, events, _, _ = build()
        for _ in range(5):
            await gate.handle(unpaid("203.0.113.7"))
        await gate.flush_events()
        assert [e["type"] for e in events] == ["challenge.issued"] * 3

    async def test_off_when_unconfigured(self):
        gate, _, _, _ = build(rate_limit=None)
        for _ in range(10):
            assert (await gate.handle(unpaid("203.0.113.7"))).status == 402


class TestPerPayerAttempts:
    async def test_limits_attempts_per_payer(self):
        gate, _, _, _ = build()
        for i in range(3):
            result = await gate.handle(paid(payer="0xflood", tx_ref=f"0xtx-{i}"))
            assert result.is_pass
        limited = await gate.handle(paid(payer="0xflood", tx_ref="0xtx-9"))
        assert limited.status == 429

    async def test_other_payers_unaffected(self):
        gate, _, _, _ = build()
        for i in range(4):
            await gate.handle(paid(payer="0xflood", tx_ref=f"0xtx-{i}"))
        assert (await gate.handle(paid(payer="0xcalm", tx_ref="0xtx-calm"))).is_pass


class TestDenylist:
    async def test_denied_before_the_facilitator_is_called(self):
        facilitator = create_mock_facilitator(networks=["base-sepolia"])
        gate, events, _, _ = build(facilitator=facilitator, denylist=["0xBADD"])

        result = await gate.handle(paid(payer="0xbadd"))
        await gate.flush_events()

        assert result.status == 403
        assert result.code == "payer_denied"
        assert facilitator.calls == []
        assert events[0]["data"] == {
            "code": "payer_denied",
            "message": "Payer address is denylisted.",
            "payer": "0xbadd",
        }

    async def test_verified_payer_wins_over_the_hint(self):
        def verify(_payload, _ctx):
            return VerifyResult.accepted("0xtx-1", "4000", "0xbadd")

        gate, _, _, _ = build(
            facilitator=create_mock_facilitator(networks=["base-sepolia"], verify_fn=verify),
            denylist=["0xbadd"],
        )
        result = await gate.handle(paid(payer="0xlooks-fine"))
        assert result.status == 403

    async def test_live_denylist_function(self):
        denied = []
        gate, _, _, _ = build(denylist=lambda: denied)
        assert (await gate.handle(paid(payer="0xsoon", tx_ref="0xtx-a"))).is_pass
        denied.append("0xsoon")
        assert (await gate.handle(paid(payer="0xsoon", tx_ref="0xtx-b"))).status == 403


def test_payer_hint_shapes():
    assert payer_hint({"payer": "0xabc"}) == "0xabc"
    assert payer_hint({"authorization": {"from": "0xdef"}}) == "0xdef"
    assert payer_hint({"nothing": True}) is None


def test_rejects_nonsensical_rates():
    with pytest.raises(OctroiConfigError, match="positive number"):
        build(rate_limit={"challenges_per_minute_per_ip": 0})
    with pytest.raises(OctroiConfigError, match="positive number"):
        build(rate_limit={"attempts_per_minute_per_payer": -5})
