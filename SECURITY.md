# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hello@danield.dev**. Do not open a
public issue for a vulnerability.

Include what you can: affected package and version, a description, and a
reproduction if possible. We'll acknowledge within a few business days and keep
you updated as we work a fix.

## Scope worth noting

- Tollway is **zero-custody** — the SDK never holds keys or funds; settlement
  is delegated to facilitators. Reports about key/fund handling in the SDK
  itself are especially welcome.
- Payment verification, replay protection, receipt signing, remote-config
  signature verification, and the §9 rate-limit/denylist paths are the
  security-sensitive core.
- Receipts and signed config use Ed25519 over canonical JSON; the canonical
  form is a byte-level contract (`golden/`).

## Supported versions

Pre-1.0: only the latest release line receives security fixes.
