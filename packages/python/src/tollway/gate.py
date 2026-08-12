"""The protocol core (§4). The Python counterpart of ``gate.ts``.

Every decision here mirrors the TypeScript, because the golden files
(``golden/``) compare the two byte for byte. Where the two languages differ at
all, the difference is in idiom — ``snake_case``, ``await``-anything — never in
what goes on the wire.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import math
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Union
from urllib.parse import urljoin, urlparse

from .canonical import canonical_json
from .challenge import (
    PAYMENT_HEADER,
    RECEIPT_HEADER,
    build_challenge_body,
    decode_payment_header,
    get_header,
    payload_expiry,
)
from .errors import (
    FacilitatorUnreachableError,
    PaymentDecodeError,
    TollwayConfigError,
    error_body,
    reject_message,
)
from .events import EventBus, EventSink
from .facilitator import FacilitatorAdapter, VerifyResult, adapter_for_network, resolve_facilitator
from .nonce import MemoryNonceStore, NonceStore
from .price import asset_decimals, format_atomic, parse_price
from .receipts import Signer, create_ephemeral_signer, make_receipt, sign_receipt

__all__ = ["Gate", "GateRequest", "GateResult", "create_gate", "payment_replay_key"]

DEFAULT_EXPIRY_SECONDS = 120
DEFAULT_VERIFY_TIMEOUT_MS = 8_000
DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1_000

JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
}

_log = logging.getLogger("tollway")


class GateRequest:
    """Framework-neutral view of an inbound request."""

    def __init__(
        self,
        method: str,
        route: str,
        headers: Mapping[str, Any],
        url: Optional[str] = None,
        path: Optional[str] = None,
        ip: Optional[str] = None,
        raw: Any = None,
    ) -> None:
        self.method = method
        self.route = route
        self.headers = headers
        self.url = url
        self.path = path
        self.ip = ip
        self.raw = raw


class GateResult:
    """Either a halt to render, or a pass with an outcome to report."""

    def __init__(
        self,
        type_: str,
        *,
        status: int = 200,
        headers: Optional[Dict[str, str]] = None,
        body: Any = None,
        code: str = "",
        receipt: Optional[Dict[str, Any]] = None,
        report: Optional[Callable[..., None]] = None,
    ) -> None:
        self.type = type_
        self.status = status
        self.headers = headers or {}
        self.body = body
        self.code = code
        self.receipt = receipt
        self.receipt_id = receipt["id"] if receipt else None
        self.payer = receipt["payer"] if receipt else None
        self._report = report or (lambda **_kwargs: None)

    def report(self, status: int, latency_ms: Optional[float] = None, error: Any = None) -> None:
        """Call once the downstream handler has produced a status (§7)."""
        self._report(status=status, latency_ms=latency_ms, error=error)

    @property
    def is_pass(self) -> bool:
        return self.type == "pass"


PriceConfig = Union[str, int, Callable[[GateRequest], Any]]


class Gate:
    def __init__(
        self,
        *,
        price: PriceConfig,
        network: Union[str, Sequence[str]],
        pay_to: str,
        facilitator: Union[str, FacilitatorAdapter, Sequence[Union[str, FacilitatorAdapter]]],
        asset: str = "usdc",
        decimals: Optional[int] = None,
        mode: str = "fail_closed",
        merchant: Optional[str] = None,
        route: Optional[str] = None,
        resource_base: Optional[str] = None,
        description: Optional[str] = None,
        mime_type: str = "application/json",
        expiry_seconds: int = DEFAULT_EXPIRY_SECONDS,
        verify_timeout_ms: int = DEFAULT_VERIFY_TIMEOUT_MS,
        replay_ttl_ms: int = DEFAULT_REPLAY_TTL_MS,
        nonce_store: Optional[NonceStore] = None,
        signer: Optional[Signer] = None,
        on_event: Optional[EventSink] = None,
        sinks: Optional[List[EventSink]] = None,
        logger: Optional[logging.Logger] = None,
        clock: Optional[Callable[[], float]] = None,
        new_nonce: Optional[Callable[[], str]] = None,
        new_id: Optional[Callable[[str], str]] = None,
    ) -> None:
        self._log = logger or _log
        self._clock = clock or (lambda: time.time() * 1000)
        self._new_nonce = new_nonce or (lambda: os.urandom(16).hex())
        self._new_id = new_id or (lambda prefix: f"twy_{prefix}_{os.urandom(12).hex()}")

        self.asset = asset
        self._decimals = asset_decimals(asset, decimals)

        self.networks: List[str] = [network] if isinstance(network, str) else list(network)
        if not self.networks:
            raise TollwayConfigError("at least one network is required")

        specs = (
            [facilitator]
            if isinstance(facilitator, (str, FacilitatorAdapter))
            else list(facilitator)
        )
        if not specs:
            raise TollwayConfigError("a facilitator is required")
        self._adapters = [resolve_facilitator(spec) for spec in specs]

        for net in self.networks:
            if adapter_for_network(self._adapters, net) is None:
                have = ", ".join(f"{a.id}[{','.join(a.networks)}]" for a in self._adapters)
                raise TollwayConfigError(
                    f'no configured facilitator supports network "{net}" (have: {have})'
                )

        if not isinstance(pay_to, str) or not pay_to.strip():
            raise TollwayConfigError("`pay_to` is required — the SDK never holds funds (§1.4)")
        self._pay_to = pay_to

        if resource_base is not None and not _is_absolute_url(resource_base):
            raise TollwayConfigError(f'resource_base must be an absolute URL, got "{resource_base}"')
        self._resource_base = resource_base

        if mode not in ("fail_closed", "fail_open"):
            raise TollwayConfigError(f'mode must be "fail_closed" or "fail_open", got "{mode}"')
        self.mode = mode

        # Catch a mistyped static price at boot, not on the first request.
        self._price = price
        if not callable(price):
            parse_price(price, self.asset, self._decimals)

        self._merchant = merchant
        self._route = route
        self._description = description
        self._mime_type = mime_type
        self._expiry_seconds = expiry_seconds
        self._verify_timeout_ms = verify_timeout_ms
        self._replay_ttl_ms = replay_ttl_ms

        # A payment can be presented any time inside the challenge window, so
        # forgetting it sooner is an open replay hole.
        if replay_ttl_ms < expiry_seconds * 1000:
            raise TollwayConfigError(
                f"replay_ttl_ms ({replay_ttl_ms}) must be at least the challenge window "
                f"(expiry_seconds {expiry_seconds} = {expiry_seconds * 1000}ms), or a payment "
                "could be replayed after the store forgets it but before it expires"
            )

        self._nonces = nonce_store or MemoryNonceStore(clock=self._clock)
        self._signer = signer

        all_sinks: List[EventSink] = []
        if on_event is not None:
            all_sinks.append(on_event)
        if sinks:
            all_sinks.extend(sinks)
        self.events = EventBus(
            sinks=all_sinks,
            merchant=merchant,
            clock=self._clock,
            new_id=lambda: self._new_id("evt"),
            logger=self._log,
        )

    # --- public ------------------------------------------------------------

    async def handle(self, req: GateRequest) -> GateResult:
        """Run the protocol for one request. Never raises for payer-side faults."""
        started_at = self._clock()
        route = req.route or self._route or req.path or "/"

        try:
            amount = await self._resolve_price(req)
        except Exception as error:  # noqa: BLE001 — a broken price is a merchant bug
            message = str(error)
            self.events.emit(
                "gate.error", route, {"code": "invalid_config", "message": message, "mode": "fail_closed"}
            )
            self._log.error("tollway: could not resolve price for %s: %s", route, message)
            return GateResult(
                "error",
                status=500,
                headers=dict(JSON_HEADERS),
                body=error_body("invalid_config", "Route price could not be resolved."),
                code="invalid_config",
            )

        try:
            resource = self._resolve_resource(req, route)
        except TollwayConfigError as error:
            message = str(error)
            self.events.emit(
                "gate.error", route, {"code": "invalid_resource", "message": message, "mode": "fail_closed"}
            )
            self._log.error("tollway: could not build an absolute resource URL: %s", message)
            return GateResult(
                "error",
                status=500,
                headers=dict(JSON_HEADERS),
                body=error_body("invalid_resource", message),
                code="invalid_resource",
            )

        ctx = {
            "req": req,
            "route": route,
            "resource": resource,
            "amount": amount,
            "started_at": started_at,
        }

        header = get_header(req.headers, PAYMENT_HEADER)
        if header is None:
            return self._issue_challenge(ctx)

        try:
            payment = decode_payment_header(header)
        except PaymentDecodeError as error:
            return self._reject(ctx, "invalid_payment", str(error))

        return await self._verify_and_pass(ctx, payment)

    async def flush_events(self) -> None:
        await self.events.flush()

    def public_key(self) -> bytes:
        return self._resolve_signer().public_key()

    # --- challenge ---------------------------------------------------------

    def _issue_challenge(self, ctx: Dict[str, Any]) -> GateResult:
        built = self._build_accepts(ctx)
        if built is None:
            return self._no_scheme(ctx["route"])

        accepts, _requirements, nonce, expires_at = built
        self.events.emit(
            "challenge.issued",
            ctx["route"],
            {
                "price": str(ctx["amount"]),
                "asset": self.asset,
                "networks": [scheme["network"] for scheme in accepts],
                "nonce": nonce,
                "expires_at": expires_at,
            },
        )

        price = format_atomic(ctx["amount"], self._decimals)
        return GateResult(
            "challenge",
            status=402,
            headers=dict(JSON_HEADERS),
            body=build_challenge_body(
                accepts,
                "payment_required",
                f"This route costs {price} {self.asset.upper()}.",
            ),
            code="payment_required",
        )

    def _build_accepts(self, ctx: Dict[str, Any], nonce: Optional[str] = None):
        nonce = nonce or self._new_nonce()
        expires_at = int(self._clock() // 1000) + self._expiry_seconds
        accepts: List[Dict[str, Any]] = []
        requirements: Dict[str, Dict[str, Any]] = {}

        for network in self.networks:
            adapter = adapter_for_network(self._adapters, network)
            if adapter is None:
                continue
            requirement = {
                "route": ctx["route"],
                "resource": ctx["resource"],
                "description": self._description or f"Access to {ctx['route']}",
                "mimeType": self._mime_type,
                "network": network,
                "asset": self.asset,
                "amount": ctx["amount"],
                "payTo": self._pay_to,
                "nonce": nonce,
                "expiresAt": expires_at,
                "maxTimeoutSeconds": self._expiry_seconds,
            }
            try:
                accepts.append(adapter.build_challenge(requirement))
                requirements[network] = requirement
            except Exception as error:  # noqa: BLE001 — one network must not sink the others
                self._log.warning(
                    "tollway: facilitator %s could not build a challenge for %s: %s",
                    adapter.id,
                    network,
                    error,
                )

        if not accepts:
            return None
        return accepts, requirements, nonce, expires_at

    # --- verify ------------------------------------------------------------

    async def _verify_and_pass(self, ctx: Dict[str, Any], payment: Dict[str, Any]) -> GateResult:
        network = payment["network"]
        if network not in self.networks:
            return self._reject(
                ctx,
                "wrong_network",
                f'This route accepts {", ".join(self.networks)}, payment was on "{network}".',
            )

        adapter = adapter_for_network(self._adapters, network)
        if adapter is None:
            return self._reject(ctx, "wrong_network", reject_message("wrong_network"))

        echoed = _read_nonce(payment)
        built = self._build_accepts(ctx, echoed or self._new_nonce())
        if built is None:
            return self._no_scheme(ctx["route"])
        accepts, requirements, _nonce, _expires = built
        requirement = requirements.get(network)
        scheme = next((s for s in accepts if s["network"] == network), None)
        if requirement is None or scheme is None:
            return self._no_scheme(ctx["route"])

        now_ms = self._clock()
        expiry = payload_expiry(payment)
        if expiry is not None and expiry * 1000 <= now_ms:
            return self._reject(ctx, "expired", reject_message("expired"))

        replay_key = payment_replay_key(payment)
        if self._nonces.has(replay_key):
            return self._reject(ctx, "replay", reject_message("replay"))

        verify_ctx = {
            "scheme": scheme,
            "requirements": requirement,
            "route": ctx["route"],
            "now": now_ms,
            "logger": self._log,
        }

        try:
            result = await self._verify_with_timeout(adapter, payment, verify_ctx)
        except Exception as error:  # noqa: BLE001 — any raise means "unreachable"
            return self._facilitator_down(ctx, adapter, error)

        if not result.ok:
            return self._reject(
                ctx, result.code, result.message or reject_message(result.code), adapter.id
            )

        settled = _to_int(result.settled_amount)
        if settled is None or settled < ctx["amount"]:
            return self._reject(
                ctx,
                "wrong_amount",
                f"Route costs {ctx['amount']} atomic units, settled {result.settled_amount}.",
                adapter.id,
            )

        # Consume last: a payload that failed verification stays retriable, one
        # that succeeded is burned for both its hash and its on-chain ref.
        if not self._nonces.consume(replay_key, self._replay_ttl_ms):
            return self._reject(ctx, "replay", reject_message("replay"), adapter.id)
        if not self._nonces.consume(f"tx:{network}:{result.tx_ref}", self._replay_ttl_ms):
            return self._reject(ctx, "replay", reject_message("replay"), adapter.id)

        receipt = sign_receipt(
            make_receipt(
                receipt_id=self._new_id("rcpt"),
                route=ctx["route"],
                amount=settled,
                asset=self.asset,
                network=network,
                payer=result.payer,
                tx_ref=result.tx_ref,
                ts=int(self._clock() // 1000),
                merchant=self._merchant,
            ),
            self._resolve_signer(),
        )
        self.events.emit("toll.settled", ctx["route"], {"receipt": receipt})
        return self._pass(ctx, receipt)

    async def _verify_with_timeout(
        self, adapter: FacilitatorAdapter, payment: Dict[str, Any], ctx: Dict[str, Any]
    ) -> VerifyResult:
        result = adapter.verify(payment, ctx)
        if not inspect.isawaitable(result):
            return result
        try:
            return await asyncio.wait_for(result, timeout=self._verify_timeout_ms / 1000)
        except asyncio.TimeoutError:
            raise FacilitatorUnreachableError(
                f'facilitator "{adapter.id}" did not answer within {self._verify_timeout_ms}ms',
                adapter.id,
            ) from None

    # --- outcomes ----------------------------------------------------------

    def _pass(self, ctx: Dict[str, Any], receipt: Optional[Dict[str, Any]]) -> GateResult:
        reported = {"done": False}
        headers = {RECEIPT_HEADER: receipt["id"]} if receipt else {}

        def report(status: int, latency_ms: Optional[float] = None, error: Any = None) -> None:
            if reported["done"]:
                return
            reported["done"] = True
            latency = latency_ms if latency_ms is not None else self._clock() - ctx["started_at"]
            failed = status >= 500 or error is not None
            data = {
                "receipt_id": receipt["id"] if receipt else None,
                "status": status,
                "latency_ms": int(latency),
            }
            self.events.emit("request.failed" if failed else "request.served", ctx["route"], data)

        return GateResult("pass", headers=headers, receipt=receipt, report=report)

    def _reject(
        self,
        ctx: Dict[str, Any],
        code: str,
        message: str,
        facilitator: Optional[str] = None,
    ) -> GateResult:
        data: Dict[str, Any] = {"code": code, "message": message}
        if facilitator is not None:
            data["facilitator"] = facilitator
        self.events.emit("toll.rejected", ctx["route"], data)

        # Re-advertise so an agent can retry. Deliberately NOT counted as a new
        # challenge.issued — see core/PROTOCOL.md "Event accounting".
        built = self._build_accepts(ctx)
        accepts = built[0] if built else []
        return GateResult(
            "reject",
            status=402,
            headers=dict(JSON_HEADERS),
            body=build_challenge_body(accepts, code, message),
            code=code,
        )

    def _facilitator_down(
        self, ctx: Dict[str, Any], adapter: FacilitatorAdapter, error: Exception
    ) -> GateResult:
        message = str(error)
        self.events.emit(
            "gate.error",
            ctx["route"],
            {
                "code": "facilitator_unreachable",
                "facilitator": adapter.id,
                "message": message,
                "mode": self.mode,
            },
        )
        self._log.error("tollway: facilitator %s unreachable (%s): %s", adapter.id, self.mode, message)

        if self.mode == "fail_open":
            # Explicit merchant choice (§1.3): serve unpaid, with no receipt to
            # imply otherwise.
            return self._pass(ctx, None)

        return GateResult(
            "error",
            status=503,
            headers={**JSON_HEADERS, "retry-after": "5"},
            body=error_body(
                "facilitator_unreachable",
                "Payment facilitator is unavailable; the request was not served.",
            ),
            code="facilitator_unreachable",
        )

    def _no_scheme(self, route: str) -> GateResult:
        self.events.emit("gate.error", route, {"code": "no_scheme_available", "mode": "fail_closed"})
        return GateResult(
            "error",
            status=500,
            headers=dict(JSON_HEADERS),
            body=error_body("no_scheme_available", "No facilitator could price this route."),
            code="no_scheme_available",
        )

    # --- helpers -----------------------------------------------------------

    async def _resolve_price(self, req: GateRequest) -> int:
        value = self._price
        if callable(value):
            value = value(req)
            if inspect.isawaitable(value):
                value = await value
        return parse_price(value, self.asset, self._decimals)

    def _resolve_resource(self, req: GateRequest, route: str) -> str:
        candidate = req.url or req.path or route
        if _is_absolute_url(candidate):
            return candidate
        if self._resource_base is not None:
            return urljoin(self._resource_base, candidate)
        raise TollwayConfigError(
            "x402 requires an absolute URL for `resource`, but this request only supplied "
            f'"{candidate}". Pass `url` from the adapter, or set `resource_base` on the gate.'
        )

    def _resolve_signer(self) -> Signer:
        if self._signer is None:
            self._signer = create_ephemeral_signer()
        return self._signer


def create_gate(**kwargs: Any) -> Gate:
    return Gate(**kwargs)


def payment_replay_key(payment: Mapping[str, Any]) -> str:
    """Replay identity: the hash of the payload's canonical form.

    Needs no cooperation from the facilitator, and works the same standalone,
    single-instance, or behind a shared store.
    """
    canonical = canonical_json(
        {
            "scheme": payment["scheme"],
            "network": payment["network"],
            "payload": payment["payload"],
        }
    )
    return f"pay:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _read_nonce(payment: Mapping[str, Any]) -> Optional[str]:
    body = payment.get("payload") or {}
    direct = body.get("nonce")
    if isinstance(direct, str) and direct:
        return direct
    extra = body.get("extra")
    if isinstance(extra, dict):
        nested = extra.get("nonce")
        if isinstance(nested, str) and nested:
            return nested
    return None


def _to_int(value: Union[int, str]) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _is_absolute_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


_ = math  # re-exported nowhere; kept out of the public surface
