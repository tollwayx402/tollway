"""FastAPI adapter (§3.2).

``tw.gate(...)`` returns a dependency, so a route is gated by declaring it:

    tw = Octroi(pay_to=..., network="base", facilitator=coinbase)

    @app.get("/v1/report", dependencies=[tw.gate(price="$0.004")])
    async def report(): ...

The dependency raises to halt, and registers a background task to report the
outcome — the same three-step adapter contract as Express and Hono.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional, Sequence, Union

from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

from .facilitator import FacilitatorAdapter
from .gate import Gate, GateRequest, GateResult

__all__ = ["Octroi", "OctroiHalt"]


class OctroiHalt(Exception):
    """Raised to stop a request with a rendered 402/500/503 body.

    FastAPI turns this into a response through the handler installed by
    :meth:`Octroi.install`, which the constructor does for you.
    """

    def __init__(self, result: GateResult) -> None:
        super().__init__(result.code)
        self.result = result


class Octroi:
    """Per-app configuration; ``gate()`` adds the per-route parts (§3.2)."""

    def __init__(
        self,
        *,
        pay_to: str,
        network: Union[str, Sequence[str]],
        facilitator: Union[str, FacilitatorAdapter, Sequence[Union[str, FacilitatorAdapter]]],
        api_key: Optional[str] = None,
        **defaults: Any,
    ) -> None:
        self._pay_to = pay_to
        self._network = network
        self._facilitator = facilitator
        self._defaults = defaults

        if api_key is not None:
            # The cloud client is a separate, differently licensed package.
            import logging

            logging.getLogger("octroi").warning(
                "octroi: `api_key` needs the cloud client; pass its sink via `sinks=[...]` "
                "until the Python ingest client ships"
            )

    def gate(self, *, price: Any, route: Optional[str] = None, **overrides: Any) -> Any:
        """Return a FastAPI dependency that gates the route it is attached to."""
        options = {**self._defaults, **overrides}
        gate = Gate(
            price=price,
            pay_to=self._pay_to,
            network=self._network,
            facilitator=self._facilitator,
            **options,
        )

        async def dependency(request: Request) -> None:
            label = route or _route_label(request)
            # Stashed before handle(), so the halt renderer can flush events in
            # the background — never inline on the payer's request path (§7).
            request.state.octroi_gate = gate
            result = await gate.handle(
                GateRequest(
                    method=request.method,
                    route=label,
                    url=str(request.url),
                    path=request.url.path,
                    headers=request.headers,
                    ip=request.client.host if request.client else None,
                    raw=request,
                )
            )

            if not result.is_pass:
                raise OctroiHalt(result)

            # Stash on the request so the response hook can finish the job.
            request.state.octroi_result = result
            request.state.octroi_started = time.time() * 1000

        return Depends(dependency)

    @staticmethod
    def install(app: Any) -> None:
        """Register the halt renderer and the outcome reporter.

        Both are required: without the middleware, a paid request is served but
        never reported, so `request.served` / `request.failed` — and therefore
        refund candidates — would silently never happen.
        """

        @app.exception_handler(OctroiHalt)
        async def _render_halt(request: Request, exc: OctroiHalt) -> Response:  # noqa: ANN202
            response = JSONResponse(
                status_code=exc.result.status,
                content=exc.result.body,
                headers=exc.result.headers,
            )
            gate: Optional[Gate] = getattr(request.state, "octroi_gate", None)
            if gate is not None:
                # Event delivery happens after the response is sent (§7).
                response.background = BackgroundTask(gate.flush_events)
            return response

        @app.middleware("http")
        async def _report_outcome(request: Request, call_next: Callable[..., Any]) -> Response:
            try:
                response = await call_next(request)
            except Exception:
                result = getattr(request.state, "octroi_result", None)
                if result is not None:
                    result.report(status=500, error="handler raised")
                    await _flush(request)
                raise

            result: Optional[GateResult] = getattr(request.state, "octroi_result", None)
            if result is None:
                return response

            for name, value in result.headers.items():
                response.headers[name] = value

            started = getattr(request.state, "octroi_started", None)
            latency = (time.time() * 1000 - started) if started else None
            result.report(status=response.status_code, latency_ms=latency)

            gate: Optional[Gate] = getattr(request.state, "octroi_gate", None)
            if gate is not None:
                # Flush after the response is sent, so event delivery never sits
                # on the payer's request path.
                response.background = _chain(response.background, gate.flush_events)
            return response


async def _flush(request: Request) -> None:
    gate: Optional[Gate] = getattr(request.state, "octroi_gate", None)
    if gate is not None:
        await gate.flush_events()


def _chain(existing: Any, flush: Callable[[], Any]) -> BackgroundTask:
    if existing is None:
        return BackgroundTask(flush)

    async def both() -> None:
        await existing()
        await flush()

    return BackgroundTask(both)


def _route_label(request: Request) -> str:
    """The registered path pattern, so one label per route, not per parameter."""
    route = request.scope.get("route")
    path_format = getattr(route, "path_format", None) or getattr(route, "path", None)
    return path_format or request.url.path


def gate_dependency(gate: Gate, route: Optional[str] = None) -> Any:
    """Escape hatch: gate a route with a Gate you built yourself."""

    async def dependency(request: Request) -> None:
        request.state.octroi_gate = gate
        result = await gate.handle(
            GateRequest(
                method=request.method,
                route=route or _route_label(request),
                url=str(request.url),
                path=request.url.path,
                headers=request.headers,
                raw=request,
            )
        )
        if not result.is_pass:
            raise OctroiHalt(result)
        request.state.octroi_result = result
        request.state.octroi_started = time.time() * 1000

    return Depends(dependency)
