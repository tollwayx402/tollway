"""Price parsing (§3.1). Mirrors ``price.ts``, including what it refuses."""

from __future__ import annotations

import re
from typing import Optional, Union

from .errors import OctroiConfigError

__all__ = ["ASSET_DECIMALS", "asset_decimals", "parse_price", "format_atomic"]

ASSET_DECIMALS = {"usdc": 6, "usdt": 6}

_USD_PATTERN = re.compile(r"^\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$")

Price = Union[str, int]


def asset_decimals(asset: str, override: Optional[int] = None) -> int:
    if override is not None:
        return override
    known = ASSET_DECIMALS.get(asset.lower())
    if known is None:
        raise OctroiConfigError(f'unknown asset "{asset}"; pass `decimals` to price it explicitly')
    return known


def parse_price(price: Price, asset: str, decimals: Optional[int] = None) -> int:
    """Normalize a price to atomic units of the asset.

    An ``int`` is already atomic. A ``str`` is a USD decimal amount, with or
    without the ``$``. More decimal places than the asset carries is a config
    error rather than a silent round: a merchant who writes "$0.0000004" for
    USDC means something, and it is not "free".
    """
    places = asset_decimals(asset, decimals)

    # bool is an int in Python, and `price=True` is a mistake, not 1 atomic unit.
    if isinstance(price, bool):
        raise OctroiConfigError("price must be a string or an integer, got bool")

    if isinstance(price, int):
        if price <= 0:
            raise OctroiConfigError(f"price must be greater than zero, got {price}")
        return price

    if not isinstance(price, str):
        raise OctroiConfigError(f"price must be a string or an integer, got {type(price).__name__}")

    match = _USD_PATTERN.match(price.strip())
    if match is None:
        raise OctroiConfigError(
            f'could not parse price "{price}"; expected a USD amount like "$0.004" '
            "or atomic units as an integer"
        )

    whole = (match.group(1) or "0").replace(",", "")
    fraction = match.group(2) or ""
    if len(fraction) > places:
        raise OctroiConfigError(
            f'price "{price}" has {len(fraction)} decimal places but {asset} carries {places}'
        )

    atomic = int(whole + fraction.ljust(places, "0"))
    if atomic <= 0:
        raise OctroiConfigError(f'price must be greater than zero, got "{price}"')
    return atomic


def format_atomic(amount: int, decimals: int) -> str:
    """Atomic units back to a decimal string, for logs and messages."""
    negative = amount < 0
    digits = str(abs(amount)).rjust(decimals + 1, "0")
    whole = digits[: len(digits) - decimals] if decimals else digits
    fraction = f".{digits[len(digits) - decimals:]}" if decimals else ""
    return f"{'-' if negative else ''}{whole}{fraction}"

