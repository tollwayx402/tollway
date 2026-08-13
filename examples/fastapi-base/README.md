# FastAPI + Base

The §3.2 shape: a route gated by declaring a dependency.

```bash
pip install "tollway[fastapi]" uvicorn
TW_ADDRESS=0xYourSettlementAddress uvicorn main:app --port 8000
```

```bash
curl -i http://localhost:8000/v1/report   # → 402 with the challenge
```

To pay it, use the agent from the Express example (same protocol, same
client):

```bash
cd ../express-base
TW_AGENT_KEY=0x… node agent.js http://localhost:8000/v1/report
```

[facilitator.py](facilitator.py) is a working Python adapter for the x402
facilitator HTTP contract (~40 lines of logic) — the TypeScript
`@tollway/coinbase` adapter's rules, including the one that matters for
security: a verify-stage "unexpected error" is a **rejection**, not an outage,
because the payload that provoked it is attacker-controlled and `fail_open`
must not be purchasable with a crafted payload.

Cloud events, if you have an API key:

```python
from tollway_ingest import IngestClient
tw = Tollway(..., sinks=[IngestClient(api_key=os.environ["TW_KEY"]).sink])
```
