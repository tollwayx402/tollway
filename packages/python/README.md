# octroi

Toll gates for HTTP routes: return a 402, verify the payment, serve the 200.

The Python port of [`@octroi/core`](../core). Same protocol, same wire format —
byte for byte. The golden files in `golden/` are the contract, and
`tests/test_golden.py` holds this package to them.

```bash
pip install octroi[fastapi]
```

## FastAPI

```python
from fastapi import FastAPI
from octroi.fastapi import Octroi

app = FastAPI()
tw = Octroi(pay_to=os.environ["OCT_ADDRESS"], network="base", facilitator=coinbase)
Octroi.install(app)          # renders halts, reports outcomes

@app.get("/v1/report", dependencies=[tw.gate(price="$0.004", asset="usdc")])
async def report():
    return {"report": "the paid content"}
```

`Octroi.install(app)` is **required**, not decoration. Without it a paid
request is served but never reported, so `request.served` / `request.failed` —
and therefore refund candidates — silently never happen.

## Without a framework

```python
from octroi import GateRequest, create_gate

gate = create_gate(
    price="$0.004",
    network="base",
    pay_to=address,
    facilitator=adapter,
)

result = await gate.handle(GateRequest(
    method="GET", route="/v1/report", url=str(request.url), headers=request.headers,
))

if not result.is_pass:
    return render(result.status, result.headers, result.body)

response = await handler()
result.report(status=response.status_code)
```

That is the whole adapter contract: map the request, render a halt, report the
outcome.

## Notes for readers of the TypeScript

The two implementations are deliberately the same shape, so `gate.py` reads as
`gate.ts` with different punctuation. Two idiomatic differences:

- **`snake_case` in Python, `camelCase` on the wire.** Field names in
  challenges, receipts and events are the wire's, never Python's.
- **Events deliver on the running event loop.** `emit` stays synchronous and
  non-blocking, as in TS; with no loop running, `await gate.flush_events()`
  drives delivery.

One documented divergence in `canonical.py`: JavaScript sorts object keys by
UTF-16 code unit, Python by Unicode code point. These agree below U+10000 and
differ only for astral-plane keys. Octroi never emits one — and the golden
files would catch it.

## Develop

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

The golden fixtures are produced by the TypeScript suite
(`cd packages/core && UPDATE_GOLDEN=1 pnpm test`). A mismatch here means one of
the two implementations changed the wire format.
