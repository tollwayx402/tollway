# Contributing to Octroi

Thanks for helping build Octroi. A few things keep the project healthy.

## Ground rules

- **Tests are the contract.** `pnpm -r test` (TypeScript) and
  `pytest` in `packages/python` and `packages/ingest-py` must pass. The
  cross-language `golden/` fixtures are byte-exact — if you change the wire
  format on one side, regenerate and match it on the other.
- **The SDK stays MIT and dependency-light.** No MIT package may take a
  dependency on a BUSL-1.1 package; the SDK must keep working with no cloud and
  no BSL code installed.
- **Match the surrounding code** — naming, comment density, and the "rejections
  are values, outages are exceptions" conventions in the core.

## Developer Certificate of Origin

Contributions are accepted under the **DCO** — sign off each commit:

```bash
git commit -s -m "your message"
```

That line certifies you wrote the change (or have the right to submit it) under
the repository's licenses. See https://developercertificate.org.

> Note: as an open-core project, Octroi may later ask contributors to a CLA if
> we need broader relicensing rights. We'll be explicit if that changes.

## Getting started

```bash
pnpm install && pnpm -r test
cd packages/python && python -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/python -m pytest
```
