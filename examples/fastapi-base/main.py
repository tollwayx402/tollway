"""FastAPI + Base: a paid route in the §3.2 shape.

    TW_ADDRESS=0xYourSettlementAddress uvicorn main:app --port 8000
"""

import os

from fastapi import FastAPI
from tollway.fastapi import Tollway

# The CDP facilitator adapter is TypeScript-only today; Python merchants bring
# a facilitator adapter object. This one speaks the same facilitator HTTP
# contract the TS adapter does, in ~40 lines.
from facilitator import coinbase_facilitator

app = FastAPI()
Tollway.install(app)  # renders 402s, reports outcomes — required, not optional

tw = Tollway(
    pay_to=os.environ["TW_ADDRESS"],
    network="base-sepolia",
    facilitator=coinbase_facilitator(),
    on_event=lambda event: print(event["type"], event["data"]),
)


@app.get("/v1/report", dependencies=[tw.gate(price="$0.004", asset="usdc")])
async def report():
    return {"report": "the paid content"}
