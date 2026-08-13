# tollway-ingest

The Tollway cloud event client for Python. BSL 1.1, deliberately separate from
the MIT `tollway` package — the SDK works with no cloud and no BSL code
installed (spec §1.1).

```bash
pip install tollway-ingest
```

```python
from tollway_ingest import IngestClient
from tollway.fastapi import Tollway

client = IngestClient(api_key=os.environ["TW_KEY"])
tw = Tollway(..., sinks=[client.sink])
```

Zero runtime dependencies: stdlib threading, gzip and urllib.

Delivery is §7 verbatim, matching the TypeScript client behaviour for
behaviour: batches of 100 or every 5s, gzip over 1 KiB, at-least-once with the
same event ids on retry, a 10k retry buffer that drops oldest on overflow —
with the loss reported *in the stream* via a `gate.error` that rides alongside
the next batch, so it can never itself be dropped. `sink()` appends under a
lock and returns; every network cost lives on the worker thread. A 4xx
discards (a bad key never succeeds), 5xx/429 backs off exponentially and
eventually gives up loudly rather than growing without bound.

`close()` stops accepting first, then makes one final best-effort flush — a
failing final flush never schedules retries after you were told it stopped.
