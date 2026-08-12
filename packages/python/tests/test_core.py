"""Unit tests mirroring the TypeScript core suite (§11)."""

from __future__ import annotations

import pytest

from tollway import (
    CanonicalJsonError,
    MemoryNonceStore,
    TollwayConfigError,
    canonical_bytes,
    canonical_json,
    create_ephemeral_signer,
    create_signer_from_jwk,
    decode_payment_header,
    format_atomic,
    parse_price,
    payload_expiry,
    sign_receipt,
    verify_receipt,
)
from tollway.testing import encode_payment_header, mock_payment

FIXED_JWK = {
    "kty": "OKP",
    "crv": "Ed25519",
    "d": "ZKNe5-iXTmtZuK2pSDpvJzoGfu56DfyBi0kd8_mhDuk",
    "x": "0uWeBzd1niqoYVfUexW-vzHi4EUOV8VjxynhWmd0L34",
}


class TestCanonicalJson:
    def test_sorts_keys_at_every_level(self):
        assert canonical_json({"b": 1, "a": 2, "A": 3}) == '{"A":3,"a":2,"b":1}'
        assert canonical_json({"z": {"y": 1, "x": [{"b": 1, "a": 2}]}}) == '{"z":{"x":[{"a":2,"b":1}],"y":1}}'

    def test_is_insensitive_to_insertion_order(self):
        a = canonical_json({"route": "/v1/report", "amount": "4000", "v": 1})
        b = canonical_json({"v": 1, "amount": "4000", "route": "/v1/report"})
        assert a == b

    def test_keeps_nulls(self):
        assert canonical_json({"a": None, "b": 1}) == '{"a":null,"b":1}'

    def test_distinguishes_bool_from_int(self):
        # In Python True is an int; "1" is not "true".
        assert canonical_json({"a": True, "b": 1}) == '{"a":true,"b":1}'

    def test_rejects_values_that_differ_across_languages(self):
        with pytest.raises(CanonicalJsonError):
            canonical_json({"n": 0.1})
        with pytest.raises(CanonicalJsonError):
            canonical_json({"d": object()})

    def test_rejects_circular_structures(self):
        loop = {}
        loop["self"] = loop
        with pytest.raises(CanonicalJsonError, match="circular"):
            canonical_json(loop)

    def test_escapes_like_json_and_keeps_non_ascii_literal(self):
        assert canonical_json({"s": 'a"b\\c\nd'}) == '{"s":"a\\"b\\\\c\\nd"}'
        assert canonical_json({"s": chr(1)}) == '{"s":"\\u0001"}'
        assert canonical_json({"s": "héllo → ok"}) == '{"s":"héllo → ok"}'

    def test_encodes_utf8_bytes(self):
        assert canonical_bytes({"s": "é"}) == '{"s":"é"}'.encode("utf-8")
        assert len(canonical_bytes({"s": "é"})) == 10


class TestPrice:
    def test_parses_usd_strings(self):
        assert parse_price("$0.004", "usdc") == 4_000
        assert parse_price("$1", "usdc") == 1_000_000
        assert parse_price("1.5", "usdc") == 1_500_000
        assert parse_price("$0.000001", "usdc") == 1
        assert parse_price("$1,250.50", "usdc") == 1_250_500_000
        assert parse_price("  $0.02  ", "usdc") == 20_000

    def test_passes_ints_through_as_atomic_units(self):
        assert parse_price(4_000, "usdc") == 4_000

    def test_does_not_accumulate_float_error(self):
        assert parse_price("$0.07", "usdc") == 70_000
        assert parse_price("$29.97", "usdc") == 29_970_000

    def test_rejects_more_precision_than_the_asset_carries(self):
        with pytest.raises(TollwayConfigError, match="7 decimal places but usdc carries 6"):
            parse_price("$0.0000004", "usdc")

    def test_rejects_unparseable_and_non_positive(self):
        for bad in ["free", "0.004 USDC", "-$1", "$0"]:
            with pytest.raises(TollwayConfigError):
                parse_price(bad, "usdc")
        with pytest.raises(TollwayConfigError):
            parse_price(0, "usdc")
        with pytest.raises(TollwayConfigError, match="bool"):
            parse_price(True, "usdc")

    def test_requires_decimals_for_unknown_assets(self):
        with pytest.raises(TollwayConfigError, match="unknown asset"):
            parse_price("$1", "wrappedwidget")
        assert parse_price("$1", "wrappedwidget", decimals=18) == 10**18

    def test_format_atomic(self):
        assert format_atomic(4_000, 6) == "0.004000"
        assert format_atomic(1, 6) == "0.000001"
        assert format_atomic(42, 0) == "42"


class TestNonceStore:
    def test_consumes_a_key_exactly_once(self):
        store = MemoryNonceStore()
        assert store.consume("pay:a", 60_000) is True
        assert store.consume("pay:a", 60_000) is False
        assert store.has("pay:a") is True
        assert store.has("pay:b") is False

    def test_forgets_keys_after_their_ttl(self):
        now = {"t": 1_000}
        store = MemoryNonceStore(clock=lambda: now["t"])
        assert store.consume("pay:a", 5_000) is True

        now["t"] = 5_999
        assert store.has("pay:a") is True
        now["t"] = 6_000
        assert store.has("pay:a") is False
        assert store.consume("pay:a", 5_000) is True

    def test_evicts_least_recently_used_at_capacity(self):
        store = MemoryNonceStore(max_entries=3)
        for key in ("a", "b", "c"):
            store.consume(key, 60_000)
        assert store.has("a") is True  # touch, so "b" becomes the candidate

        store.consume("d", 60_000)
        assert store.size == 3
        assert store.has("b") is False
        assert store.has("a") and store.has("c") and store.has("d")

    def test_reclaims_expired_before_evicting_live(self):
        now = {"t": 0}
        store = MemoryNonceStore(max_entries=2, clock=lambda: now["t"])
        store.consume("short", 1_000)
        now["t"] = 500
        store.consume("long", 60_000)

        now["t"] = 2_000
        assert store.consume("fresh", 60_000) is True
        assert store.has("long") and store.has("fresh")
        assert store.size == 2

    def test_rejects_a_nonsensical_capacity(self):
        with pytest.raises(ValueError):
            MemoryNonceStore(max_entries=0)


class TestReceipts:
    def _unsigned(self):
        return {
            "id": "twy_rcpt_8f3a2c",
            "v": 1,
            "route": "/v1/report",
            "amount": "4000",
            "asset": "usdc",
            "network": "base",
            "payer": "0xabc",
            "tx_ref": "0xdef",
            "ts": 1_765_432_100,
            "merchant": None,
        }

    def test_signs_and_verifies_a_round_trip(self):
        signer = create_ephemeral_signer()
        receipt = sign_receipt(self._unsigned(), signer)
        assert verify_receipt(receipt, signer.public_key()) is True

    def test_field_order_does_not_matter(self):
        signer = create_ephemeral_signer()
        a = sign_receipt(self._unsigned(), signer)
        reordered = dict(reversed(list(self._unsigned().items())))
        assert sign_receipt(reordered, signer)["sig"] == a["sig"]

    def test_any_alteration_fails_verification(self):
        signer = create_ephemeral_signer()
        receipt = sign_receipt(self._unsigned(), signer)
        key = signer.public_key()
        for field, value in [("amount", "1"), ("route", "/other"), ("payer", "0xbad"), ("sig", "AAAA")]:
            assert verify_receipt({**receipt, field: value}, key) is False

    def test_a_different_key_fails(self):
        mine, theirs = create_ephemeral_signer(), create_ephemeral_signer()
        receipt = sign_receipt(self._unsigned(), mine)
        assert verify_receipt(receipt, theirs.public_key()) is False

    def test_is_deterministic_for_a_fixed_key(self):
        signer = create_signer_from_jwk(FIXED_JWK)
        assert sign_receipt(self._unsigned(), signer) == sign_receipt(self._unsigned(), signer)
        assert signer.public_key().hex() == (
            "d2e59e0737759e2aa86157d47b15bebf31e2e0450e57c563c729e15a67742f7e"
        )


class TestPaymentDecoding:
    def test_decodes_base64_and_bare_json(self):
        payment = mock_payment()
        assert decode_payment_header(encode_payment_header(payment))["scheme"] == "exact"
        import json as _json

        assert decode_payment_header(_json.dumps(payment))["network"] == "base-sepolia"

    def test_accepts_url_safe_base64_like_typescript(self):
        import base64, json as _json

        payment = mock_payment()
        raw = _json.dumps(payment).encode()
        url_safe = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        assert decode_payment_header(url_safe)["scheme"] == "exact"

    def test_non_string_keys_are_this_modules_error(self):
        with pytest.raises(CanonicalJsonError, match="keys must be strings"):
            canonical_json({1: "x"})
        with pytest.raises(CanonicalJsonError, match="keys must be strings"):
            canonical_json({"a": 1, 2: "mixed"})

    def test_rejects_malformed_headers(self):
        from tollway import PaymentDecodeError

        for bad in ["", "not-base64!", encode_payment_header({"scheme": "exact"})]:
            with pytest.raises(PaymentDecodeError):
                decode_payment_header(bad)

    def test_reads_expiry_from_the_exact_scheme_shape(self):
        payment = mock_payment(payload={"authorization": {"validBefore": "1765432220"}})
        assert payload_expiry(payment) == 1_765_432_220
        assert payload_expiry(mock_payment()) is None
