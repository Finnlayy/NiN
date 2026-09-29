"""Discrete density of a Polymarket "BTC above strike" ladder.

Yes is cumulative, C(K) = P(S > K). The bin that contains spot is not split.
"""

from __future__ import annotations

import math
from typing import Any

RISE_TOLERANCE = 0.02
MIN_RUNGS = 3


def _finite(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number)


def _contains_spot(bin_row: dict[str, float | None], spot: float) -> bool:
    lo = bin_row["lo"]
    hi = bin_row["hi"]
    if lo is None and hi is not None:
        return spot <= hi
    if lo is not None and hi is None:
        return spot > lo
    if lo is not None and hi is not None:
        return lo < spot <= hi
    return False


def density_from_ladder(rungs: list[dict[str, Any]], spot: float) -> dict[str, Any] | None:
    """Return ``{bins, poly}`` or None when the ladder cannot be used.

    A later rung is dropped when its Yes price rises by more than 0.02 or its
    strike does not move up. Fewer than three rungs left is unusable.
    ``poly`` is the mass in bins that lie entirely above ``spot``.
    """
    if not _finite(spot):
        return None
    points: list[tuple[float, float]] = []
    for rung in rungs:
        strike = rung.get("strike")
        yes = rung.get("yes")
        if not _finite(strike) or not _finite(yes):
            continue
        strike_f = float(strike)
        yes_f = float(yes)
        if strike_f <= 0 or yes_f < 0 or yes_f > 1:
            continue
        points.append((strike_f, yes_f))
    points.sort(key=lambda row: row[0])

    kept: list[tuple[float, float]] = []
    for strike, yes in points:
        if kept and strike <= kept[-1][0]:
            continue
        if kept and yes > kept[-1][1] + RISE_TOLERANCE:
            continue
        kept.append((strike, yes))
    if len(kept) < MIN_RUNGS:
        return None

    first_strike, first_yes = kept[0]
    last_strike, last_yes = kept[-1]
    raw: list[dict[str, float | None]] = [
        {"lo": None, "hi": first_strike, "mass": max(0.0, 1.0 - first_yes)}
    ]
    for index in range(len(kept) - 1):
        left_strike, left_yes = kept[index]
        right_strike, right_yes = kept[index + 1]
        raw.append(
            {
                "lo": left_strike,
                "hi": right_strike,
                "mass": max(0.0, left_yes - right_yes),
            }
        )
    raw.append({"lo": last_strike, "hi": None, "mass": max(0.0, last_yes)})

    total = sum(float(row["mass"] or 0.0) for row in raw)
    if not total > 0:
        return None
    bins: list[dict[str, float | None]] = []
    poly = 0.0
    for row in raw:
        mass = float(row["mass"] or 0.0) / total
        bin_row = {"lo": row["lo"], "hi": row["hi"], "mass": mass}
        bins.append(bin_row)
        if _contains_spot(bin_row, float(spot)):
            continue
        lo = bin_row["lo"]
        if lo is not None and lo >= float(spot):
            poly += mass
    return {"bins": bins, "poly": poly}
