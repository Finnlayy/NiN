"""Blend for the gravity field's third component.

Several intel sources share one slot. A source with no live value is left
out. Fallbacks are used only when every enabled primary is dark.
"""

from __future__ import annotations

import math
from typing import Any


def _usable(source: dict[str, Any]) -> bool:
    if not source.get("enabled"):
        return False
    try:
        weight = float(source.get("weight"))
        value = source.get("value")
        number = float(value) if value is not None else None
    except (TypeError, ValueError):
        return False
    if not math.isfinite(weight) or weight <= 0 or number is None or not math.isfinite(number):
        return False
    if number < 0 or number > 1:
        return False
    return source.get("status") in ("live", "stale")


def mix_intel(sources: list[dict[str, Any]]) -> dict[str, Any]:
    """Return ``{value, contributions, sources}``.

    ``value`` is None when nothing contributed. Contributing weights are
    renormalized to 1.
    """
    listed = [dict(source) for source in sources]
    primaries = [source for source in listed if not source.get("fallback") and _usable(source)]
    chosen = primaries or [source for source in listed if source.get("fallback") and _usable(source)]
    if not chosen:
        return {"value": None, "contributions": [], "sources": listed}

    total = sum(float(source["weight"]) for source in chosen)
    contributions: list[dict[str, Any]] = []
    for source in chosen:
        contributions.append(
            {
                "id": source.get("id"),
                "label": source.get("label"),
                "value": float(source["value"]),
                "weight": float(source["weight"]) / total,
                "fallback": bool(source.get("fallback")),
                "status": source.get("status"),
            }
        )
    value = sum(item["weight"] * item["value"] for item in contributions)
    return {"value": value, "contributions": contributions, "sources": listed}
