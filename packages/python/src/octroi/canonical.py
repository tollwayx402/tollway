"""Deterministic JSON serialization.

This is the byte-level contract behind receipt signatures and the §11
cross-language golden files, so it mirrors ``canonical.ts`` exactly: object
keys sorted, no insignificant whitespace, ``None``-valued keys kept, missing
keys dropped, and anything whose textual form differs between languages
refused outright.

The one documented divergence: JavaScript sorts keys by UTF-16 code unit,
Python by Unicode code point. These agree for every character below U+10000,
and differ only for astral-plane keys (emoji, rare CJK). Octroi never emits
such keys; if you add one, the golden files will catch it.
"""

from __future__ import annotations

import json
from typing import Any, Set

__all__ = ["CanonicalJsonError", "canonical_json", "canonical_bytes"]


class CanonicalJsonError(ValueError):
    """A value cannot be canonicalized byte-identically across languages."""

    code = "canonical_json"


def canonical_json(value: Any) -> str:
    return _write(value, set())


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def _write(value: Any, seen: Set[int]) -> str:
    if value is None:
        return "null"

    # bool before int: in Python, True is an int, and "1" is not "true".
    if isinstance(value, bool):
        return "true" if value else "false"

    if isinstance(value, str):
        # ensure_ascii=False keeps non-ASCII literal, matching JSON.stringify;
        # control characters still take the \u form in both languages.
        return json.dumps(value, ensure_ascii=False)

    if isinstance(value, int):
        return str(value)

    if isinstance(value, float):
        # Float formatting differs between languages, so fractional values are
        # decimal strings — which is why receipt `amount` is "4000".
        raise CanonicalJsonError(
            f"non-integer number {value!r} is not canonicalizable; use a decimal string"
        )

    if isinstance(value, (list, tuple)):
        if id(value) in seen:
            raise CanonicalJsonError("circular reference")
        seen.add(id(value))
        try:
            return "[" + ",".join(_write(item, seen) for item in value) + "]"
        finally:
            seen.discard(id(value))

    if isinstance(value, dict):
        if id(value) in seen:
            raise CanonicalJsonError("circular reference")
        seen.add(id(value))
        try:
            for key in value.keys():
                if not isinstance(key, str):
                    # Checked before sorted(): mixed-type keys make sorted()
                    # raise a bare TypeError, which is not this module's error.
                    raise CanonicalJsonError(
                        f"object keys must be strings, got {type(key).__name__}"
                    )
            items = []
            for key in sorted(value.keys()):
                item = value[key]
                # A key explicitly set to None survives as null (JS keeps null
                # too); only absent keys are absent.
                items.append(f"{json.dumps(key, ensure_ascii=False)}:{_write(item, seen)}")
            return "{" + ",".join(items) + "}"
        finally:
            seen.discard(id(value))

    raise CanonicalJsonError(f"{type(value).__name__} is not canonicalizable")
