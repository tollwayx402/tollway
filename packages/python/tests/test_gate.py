"""The verify pipeline (§4), mirroring the TypeScript gate suite."""

from __future__ import annotations

import pytest

from tollway import (
    GateRequest,
    MemoryNonceStore,
    TollwayConfigError,
    VerifyResult,
    create_gate,
    verify_receipt,
)
from tollway.testing import create_mock_facilitator, encode_payment_header, mock_payment

NOW = 1_765_432_100_000


def build(**overrides):
    events = []
    facilitator = overrides.pop("facilitator", None) or create_mock_facilitator(
        networks=["base-sepolia", "base"]
    )
    ids = {"n": 0}

    def new_id(prefix: str) -> str:
        ids["n"] += 1
        return f"twy_{prefix}_{ids['n']:04d}"

    options = {
        "price": "$0.004",
        "asset": "usdc",
        "network": "base-sepolia",
        "pay_to": "0xmerchant",
        "facilitator": facilitator,
        "on_event": events.append,
        "clock": lambda: NOW,
        "new_nonce": lambda: "nonce-1",
        "new_id": new_id,
    }
    options.update(overrides)
    return create_gate(**options), events, facilitator


def request(headers=None, **kwargs):
    return GateRequest(
        method="GET",
        route="/v1/report",
        url="https://api.example.com/v1/report",
        headers=headers or {},
        **kwargs,
    )


def paid(payment=None):
    return request(headers={"X-PAYMENT": encode_payment_header(payment or mock_payment())})


class TestChallenge:
    async def test_answers_402_with_advertised_schemes(self):
        gate, events, _ = build()
        result = await gate.handle(request())
        await gate.flush_events()

        assert result.type == "challenge"
        assert result.status == 402
        assert result.body["x402Version"] == 1
        # `error` is a closed enum in x402; a first contact is not one of its
        # reasons, so it is omitted rather than filled with our code.
        assert "error" not in result.body
        assert result.body["errorDetail"] == {
            "code": "payment_required",
            "message": "This route costs 0.004000 USDC.",
            "doc": "https://tollway.sh/docs/errors#payment_required",
        }
        assert result.body["accepts"][0]["maxAmountRequired"] == "4000"
        assert [e["type"] for e in events] == ["challenge.issued"]

    async def test_advertises_every_configured_network_in_order(self):
        gate, _, _ = build(network=["base", "base-sepolia"])
        result = await gate.handle(request())
        assert [a["network"] for a in result.body["accepts"]] == ["base", "base-sepolia"]

    async def test_prices_per_request_when_price_is_callable(self):
        gate, _, _ = build(price=lambda req: "$0.02" if req.route == "/v1/deep" else "$0.004")
        result = await gate.handle(
            GateRequest(method="GET", route="/v1/deep", url="https://api.example.com/v1/deep", headers={})
        )
        assert result.body["accepts"][0]["maxAmountRequired"] == "20000"

    async def test_refuses_a_non_absolute_resource(self):
        # x402 validates `resource` as a URL; a bare path would be rejected by
        # the agent's client, where we could never see it.
        gate, _, _ = build()
        result = await gate.handle(GateRequest(method="GET", route="/v1/report", headers={}))
        assert result.status == 500
        assert result.code == "invalid_resource"

    async def test_absolutizes_against_resource_base(self):
        gate, _, _ = build(resource_base="https://api.example.com")
        result = await gate.handle(GateRequest(method="GET", route="/v1/report", headers={}))
        assert result.body["accepts"][0]["resource"] == "https://api.example.com/v1/report"

    async def test_a_broken_price_is_500_not_a_free_route(self):
        def explode(_req):
            raise RuntimeError("pricing service down")

        gate, events, _ = build(price=explode)
        result = await gate.handle(request())
        await gate.flush_events()

        assert result.status == 500
        assert result.body["error"]["code"] == "invalid_config"
        assert [e["type"] for e in events] == ["gate.error"]


class TestSettlement:
    async def test_verifies_mints_a_receipt_and_passes(self):
        gate, events, _ = build()
        result = await gate.handle(paid())
        await gate.flush_events()

        assert result.is_pass
        assert result.receipt["amount"] == "4000"
        assert result.receipt["payer"] == "0xpayer-1"
        assert result.receipt["tx_ref"] == "0xtx-1"
        assert result.headers["x-tollway-receipt"] == result.receipt["id"]
        assert verify_receipt(result.receipt, gate.public_key()) is True
        assert [e["type"] for e in events] == ["toll.settled"]

    async def test_reports_served_and_failed(self):
        gate, events, _ = build()
        ok = await gate.handle(paid())
        ok.report(status=200, latency_ms=42)

        broken = await gate.handle(paid(mock_payment(tx_ref="0xtx-2")))
        broken.report(status=500, latency_ms=7)
        await gate.flush_events()

        assert [e["type"] for e in events] == [
            "toll.settled",
            "request.served",
            "toll.settled",
            "request.failed",
        ]
        assert events[1]["data"] == {"receipt_id": ok.receipt_id, "status": 200, "latency_ms": 42}

    async def test_reports_at_most_once(self):
        gate, events, _ = build()
        result = await gate.handle(paid())
        result.report(status=200)
        result.report(status=500)
        await gate.flush_events()
        assert [e["type"] for e in events].count("request.served") == 1
        assert "request.failed" not in [e["type"] for e in events]

    async def test_accepts_an_overpayment(self):
        gate, _, _ = build()
        result = await gate.handle(paid(mock_payment(amount="9000")))
        assert result.receipt["amount"] == "9000"


class TestRejections:
    async def test_malformed_payment_header(self):
        gate, events, _ = build()
        result = await gate.handle(request(headers={"x-payment": "not-base64!"}))
        await gate.flush_events()

        assert result.status == 402
        assert result.code == "invalid_payment"
        assert result.body["error"] == "invalid_payment"  # mapped onto the x402 enum
        assert result.body["accepts"]  # re-advertised so an agent can retry
        assert [e["type"] for e in events] == ["toll.rejected"]

    async def test_wrong_network_never_reaches_the_facilitator(self):
        gate, _, facilitator = build()
        result = await gate.handle(paid(mock_payment(network="solana")))
        assert result.code == "wrong_network"
        assert facilitator.calls == []

    async def test_underpayment(self):
        gate, _, _ = build()
        result = await gate.handle(paid(mock_payment(amount="3999")))
        assert result.code == "wrong_amount"

    async def test_expired_authorization_never_reaches_the_facilitator(self):
        gate, _, facilitator = build()
        expired = mock_payment(payload={"authorization": {"validBefore": str(NOW // 1000 - 1)}})
        result = await gate.handle(paid(expired))
        assert result.code == "expired"
        assert facilitator.calls == []

    async def test_a_rechallenge_is_not_counted_as_a_new_challenge(self):
        gate, events, _ = build()
        await gate.handle(paid(mock_payment(amount="1")))
        await gate.flush_events()
        assert [e["type"] for e in events] == ["toll.rejected"]


class TestReplayProtection:
    async def test_rejects_the_same_payload_twice(self):
        gate, events, facilitator = build()
        payment = mock_payment()

        assert (await gate.handle(paid(payment))).is_pass
        second = await gate.handle(paid(payment))
        await gate.flush_events()

        assert second.code == "replay"
        assert second.body["error"] == "duplicate_settlement"
        assert len(facilitator.calls) == 1  # not re-verified

    async def test_rejects_a_rewrapped_payload_settling_the_same_tx(self):
        gate, _, _ = build()
        await gate.handle(paid(mock_payment(payload={"pad": "a"})))
        second = await gate.handle(paid(mock_payment(payload={"pad": "b"})))
        assert second.code == "replay"

    async def test_keeps_a_failed_payment_retriable(self):
        attempts = {"n": 0}

        def verify(_payload, _ctx):
            attempts["n"] += 1
            if attempts["n"] == 1:
                return VerifyResult.rejected("invalid_payment")
            return VerifyResult.accepted("0xtx-1", "4000", "0xpayer-1")

        gate, _, _ = build(facilitator=create_mock_facilitator(networks=["base-sepolia"], verify_fn=verify))
        payment = mock_payment()
        assert (await gate.handle(paid(payment))).type == "reject"
        assert (await gate.handle(paid(payment))).is_pass

    async def test_honours_the_ttl_floor_at_runtime(self):
        now = {"t": NOW}
        gate, _, _ = build(
            expiry_seconds=60,
            replay_ttl_ms=60_000,
            clock=lambda: now["t"],
            nonce_store=MemoryNonceStore(clock=lambda: now["t"]),
        )
        payment = mock_payment()
        assert (await gate.handle(paid(payment))).is_pass

        now["t"] = NOW + 59_000
        assert (await gate.handle(paid(payment))).code == "replay"


class TestFacilitatorOutages:
    async def test_fails_closed_by_default(self):
        gate, events, _ = build(
            facilitator=create_mock_facilitator(networks=["base-sepolia"], unreachable=True)
        )
        result = await gate.handle(paid())
        await gate.flush_events()

        assert result.status == 503
        assert result.headers["retry-after"] == "5"
        assert events[0]["data"]["mode"] == "fail_closed"

    async def test_fail_open_serves_without_a_receipt(self):
        gate, events, _ = build(
            mode="fail_open",
            facilitator=create_mock_facilitator(networks=["base-sepolia"], unreachable=True),
        )
        result = await gate.handle(paid())
        assert result.is_pass
        assert result.receipt is None
        assert "x-tollway-receipt" not in result.headers

        result.report(status=200, latency_ms=3)
        await gate.flush_events()
        assert [e["type"] for e in events] == ["gate.error", "request.served"]
        assert events[1]["data"]["receipt_id"] is None

    async def test_a_slow_facilitator_is_unreachable(self):
        gate, _, _ = build(
            verify_timeout_ms=20,
            facilitator=create_mock_facilitator(networks=["base-sepolia"], latency_ms=500),
        )
        result = await gate.handle(paid())
        assert result.status == 503


class TestConfiguration:
    def test_rejects_a_mistyped_static_price_at_construction(self):
        with pytest.raises(TollwayConfigError, match="could not parse price"):
            build(price="4 dollars")

    def test_requires_a_settlement_address(self):
        with pytest.raises(TollwayConfigError, match="pay_to"):
            build(pay_to="   ")

    def test_requires_facilitator_coverage_for_every_network(self):
        with pytest.raises(TollwayConfigError, match='no configured facilitator supports network "solana"'):
            build(network=["base-sepolia", "solana"])

    def test_rejects_an_unknown_facilitator_id(self):
        with pytest.raises(TollwayConfigError, match='unknown facilitator "coinbase"'):
            build(facilitator="coinbase")

    def test_refuses_to_forget_a_payment_before_its_window_closes(self):
        with pytest.raises(TollwayConfigError, match="at least the challenge window"):
            build(expiry_seconds=120, replay_ttl_ms=119_000)
        build(expiry_seconds=120, replay_ttl_ms=120_000)

    async def test_routes_each_network_to_its_adapter(self):
        base = create_mock_facilitator(id="coinbase-ish", networks=["base"])
        solana = create_mock_facilitator(id="payai-ish", networks=["solana"])
        gate, _, _ = build(network=["base", "solana"], facilitator=[base, solana])

        result = await gate.handle(paid(mock_payment(network="solana")))
        assert result.is_pass
        assert len(solana.calls) == 1 and base.calls == []
