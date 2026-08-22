"""The §11 cross-language contract.

Same inputs, byte-identical output in TypeScript and Python. The fixtures in
``golden/`` are produced by the TS suite; this file drives the Python port
through the same case and compares the bytes.

If this fails, one of the two implementations has changed the wire format —
which is exactly what these files exist to catch.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from octroi import GateRequest, canonical_json, create_gate, create_signer_from_jwk
from octroi.testing import create_mock_facilitator, encode_payment_header, mock_payment

GOLDEN_DIR = Path(__file__).resolve().parents[3] / "golden"

GOLDEN_CLOCK_MS = 1_765_432_100_000
GOLDEN_NONCE = "9f86d081884c7d659a2feaa0c55ad015"

# The same throwaway key the TS fixtures use. NOT A SECRET.
FIXED_SIGNING_JWK = {
    "kty": "OKP",
    "crv": "Ed25519",
    "d": "ZKNe5-iXTmtZuK2pSDpvJzoGfu56DfyBi0kd8_mhDuk",
    "x": "0uWeBzd1niqoYVfUexW-vzHi4EUOV8VjxynhWmd0L34",
}

REQUEST = GateRequest(
    method="GET",
    route="/v1/report",
    url="https://api.example.com/v1/report",
    headers={},
)

PAYMENT = mock_payment(
    network="base",
    tx_ref="0xdeadbeef",
    payer="0xabc0000000000000000000000000000000000001",
    amount="4000",
)


def golden_gate():
    counters = {"rcpt": 0, "evt": 0}

    def new_id(prefix: str) -> str:
        counters[prefix] = counters.get(prefix, 0) + 1
        return f"oct_{prefix}_{counters[prefix]:06d}"

    return create_gate(
        price="$0.004",
        asset="usdc",
        network="base",
        pay_to="0xmerchant000000000000000000000000000000ff",
        facilitator=create_mock_facilitator(
            id="golden",
            networks=["base"],
            asset_address="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        ),
        merchant="acct_9d2",
        description="Access to /v1/report",
        mime_type="application/json",
        clock=lambda: GOLDEN_CLOCK_MS,
        new_nonce=lambda: GOLDEN_NONCE,
        new_id=new_id,
        signer=create_signer_from_jwk(FIXED_SIGNING_JWK),
    )


def read_golden(name: str) -> str:
    path = GOLDEN_DIR / name
    if not path.exists():  # pragma: no cover - misconfiguration, not a code path
        pytest.fail(
            f"missing {path}. The golden files are produced by the TypeScript suite: "
            "cd packages/core && UPDATE_GOLDEN=1 pnpm test"
        )
    return path.read_text(encoding="utf-8").rstrip("\n")


async def test_challenge_matches_typescript_byte_for_byte():
    gate = golden_gate()
    result = await gate.handle(REQUEST)
    assert result.type == "challenge", result.body
    assert canonical_json(result.body) == read_golden("challenge.json")


async def test_receipt_matches_typescript_byte_for_byte():
    gate = golden_gate()
    result = await gate.handle(
        GateRequest(
            method="GET",
            route="/v1/report",
            url="https://api.example.com/v1/report",
            headers={"x-payment": encode_payment_header(PAYMENT)},
        )
    )
    assert result.is_pass, result.body
    # Ed25519 is deterministic, so a fixed key gives a fixed signature — which
    # is what makes a receipt comparable across languages at all.
    assert canonical_json(result.receipt) == read_golden("receipt.json")


async def test_event_stream_matches_typescript_byte_for_byte():
    gate = golden_gate()
    events = []
    gate.events.add_sink(events.append)

    await gate.handle(REQUEST)
    paid = await gate.handle(
        GateRequest(
            method="GET",
            route="/v1/report",
            url="https://api.example.com/v1/report",
            headers={"x-payment": encode_payment_header(PAYMENT)},
        )
    )
    assert paid.is_pass
    paid.report(status=200, latency_ms=37)
    await gate.flush_events()

    assert canonical_json(events) == read_golden("events.json")


def test_the_golden_files_are_the_shape_we_think():
    """A guard against comparing against an empty or truncated file."""
    challenge = json.loads(read_golden("challenge.json"))
    assert challenge["x402Version"] == 1
    assert challenge["accepts"][0]["network"] == "base"
    # `error` is omitted on a first contact: it is a closed enum in x402 and a
    # challenge is not one of its reasons.
    assert "error" not in challenge

    receipt = json.loads(read_golden("receipt.json"))
    assert receipt["amount"] == "4000"
    assert receipt["merchant"] == "acct_9d2"
    assert len(receipt["sig"]) > 40

    events = json.loads(read_golden("events.json"))
    assert [event["type"] for event in events] == [
        "challenge.issued",
        "toll.settled",
        "request.served",
    ]
