"""Online learner for the 3-component gravity field.

Consumes the engine execution log (NDJSON ``gravity_tick`` / ``regime_tick``
events from ``TelemetryFeed``) and adapts two parameter groups:

* simplex weights ``(w_vis, w_blind, w_poly)`` by exponentiated gradient
  (Hedge). Each component is an expert; the label is the sign of the mid-price
  move ``horizon_ticks`` ahead. Weights stay positive and sum to 1.
* the Via-Negativa quantile, by an adaptive-conformal step whose fixed point
  is a breach rate of ``1 - q_target``. ``ACGravityEngine.is_in_forbidden_zone``
  widens the allowed band as the quantile rises, so a breach has to *raise*
  the quantile (negative feedback)::

      q <- clip(q + gamma * (breach_t - (1 - q_target)), 0.99, 0.9999)

Ticks without ``mid_price`` are skipped: that field is what makes the log
learnable, and older logs do not have it.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

DEFAULT_WEIGHTS = (0.25, 0.35, 0.40)
DEFAULT_QUANTILE = 0.999
QUANTILE_FLOOR = 0.99
QUANTILE_CEIL = 0.9999
_WEIGHT_FLOOR = 1e-12

_ARCHITECT = Path(__file__).resolve().parents[2]
if str(_ARCHITECT) not in sys.path:
    sys.path.insert(0, str(_ARCHITECT))


def _clip_quantile(value: float) -> float:
    if value < QUANTILE_FLOOR:
        return QUANTILE_FLOOR
    if value > QUANTILE_CEIL:
        return QUANTILE_CEIL
    return value


def _unpack_scalar(value: Any) -> Any:
    """Turn a numpy scalar into a Python scalar without importing numpy."""
    if isinstance(value, (bool, int, float, str, bytes)) or value is None:
        return value
    item = getattr(value, "item", None)
    if item is None:
        return value
    try:
        return item()
    except (TypeError, ValueError):
        return value


def _as_finite(value: Any) -> float | None:
    value = _unpack_scalar(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def _as_breach(value: Any) -> bool | None:
    if value is None:
        return None
    value = _unpack_scalar(value)
    if isinstance(value, bool):
        return value
    number = _as_finite(value)
    if number is None:
        return None
    return number != 0.0


class GravityFieldLearner:
    """Exponentiated-gradient weights + adaptive Via-Negativa quantile."""

    def __init__(
        self,
        eta: float = 0.05,
        horizon_ticks: int = 5,
        gamma: float = 0.01,
        q_target: float = DEFAULT_QUANTILE,
        min_updates: int = 1,
        weights: Sequence[float] = DEFAULT_WEIGHTS,
        quantile: float = DEFAULT_QUANTILE,
    ) -> None:
        if eta < 0.0 or not math.isfinite(eta):
            raise ValueError("eta must be >= 0")
        if gamma <= 0.0 or not math.isfinite(gamma):
            raise ValueError("gamma must be > 0")
        if isinstance(horizon_ticks, bool) or not isinstance(horizon_ticks, int) or horizon_ticks < 1:
            raise ValueError("horizon_ticks must be an int >= 1")
        if isinstance(min_updates, bool) or not isinstance(min_updates, int) or min_updates < 1:
            raise ValueError("min_updates must be an int >= 1")
        target = _as_finite(q_target)
        if target is None or not (QUANTILE_FLOOR <= target <= QUANTILE_CEIL):
            raise ValueError("q_target must be in [%.4f, %.4f]" % (QUANTILE_FLOOR, QUANTILE_CEIL))
        parsed: list[float] = []
        for weight in weights:
            number = _as_finite(weight)
            if number is None or number <= 0.0:
                raise ValueError("weights must be three finite numbers > 0")
            parsed.append(number)
        if len(parsed) != 3:
            raise ValueError("weights must be three finite numbers > 0")
        total = sum(parsed)
        if abs(total - 1.0) > 1e-6:
            raise ValueError("weights must sum to 1")
        start_q = _as_finite(quantile)
        if start_q is None:
            raise ValueError("quantile must be finite")

        self.eta = float(eta)
        self.horizon_ticks = int(horizon_ticks)
        self.gamma = float(gamma)
        self.q_target = float(target)
        self.min_updates = int(min_updates)
        self.weights = tuple(w / total for w in parsed)
        self._prior_weights = self.weights
        self.quantile = _clip_quantile(start_q)
        self._prior_quantile = self.quantile
        self._pending: list[dict[str, Any]] = []
        self.weight_updates = 0
        self.quantile_updates = 0
        self.breaches = 0
        self.hits = 0
        self.directional = 0
        self.skipped = 0
        self.resolved = 0

    # -- updates ------------------------------------------------------------
    def observe(self, tick: Mapping[str, Any]) -> bool:
        """Buffer one tick. Weight updates fire once the horizon elapses.

        Returns False when the tick has no usable ``mid_price`` (counted as
        skipped) or its components are not finite.
        """
        mid = _as_finite(tick.get("mid_price"))
        components = (
            _as_finite(tick.get("l2_depth")),
            _as_finite(tick.get("l3_iceberg")),
            _as_finite(tick.get("polymarket_prob")),
        )
        if mid is None or any(c is None for c in components):
            self.skipped += 1
            return False

        breach = _as_breach(tick.get("is_forbidden_zone"))
        if breach is not None:
            self._update_quantile(breach)

        self._pending.append({"x": components, "mid": mid})
        self._resolve()
        return True

    def _update_quantile(self, breach: bool) -> None:
        breach_t = 1.0 if breach else 0.0
        target_breach = 1.0 - self.q_target
        self.quantile = _clip_quantile(self.quantile + self.gamma * (breach_t - target_breach))
        self.quantile_updates += 1
        if breach:
            self.breaches += 1

    def _resolve(self) -> None:
        while len(self._pending) > self.horizon_ticks:
            past = self._pending.pop(0)
            future_mid = self._pending[self.horizon_ticks - 1]["mid"]
            move = future_mid - past["mid"]
            self.resolved += 1
            if move == 0.0 or self.eta == 0.0:
                continue
            label = 1.0 if move > 0.0 else -1.0
            self._record_hit(past["x"], label)
            self._update_weights(past["x"], label)

    def _record_hit(self, components: tuple[float, float, float], label: float) -> None:
        mean = sum(components) / 3.0
        score = sum(w * (x - mean) for w, x in zip(self.weights, components))
        if score == 0.0:
            return
        self.directional += 1
        if score * label > 0.0:
            self.hits += 1

    def _update_weights(self, components: tuple[float, float, float], label: float) -> None:
        # Hedge: w_i <- w_i * exp(eta * y * x_i), then project onto the simplex.
        logs = [math.log(max(w, _WEIGHT_FLOOR)) + self.eta * label * x for w, x in zip(self.weights, components)]
        peak = max(logs)
        lifted = [math.exp(v - peak) for v in logs]
        total = sum(lifted)
        self.weights = tuple(max(v / total, _WEIGHT_FLOOR) for v in lifted)
        renormalized = sum(self.weights)
        self.weights = tuple(w / renormalized for w in self.weights)
        self.weight_updates += 1

    # -- snapshot -----------------------------------------------------------
    def params(self) -> dict[str, float]:
        """Engine-facing view. Weights stay at the prior until ``min_updates``."""
        weights = self.weights if self.weight_updates >= self.min_updates else self._prior_weights
        return {
            "w_vis": weights[0],
            "w_blind": weights[1],
            "w_poly": weights[2],
            "quantile": self.quantile,
        }

    def report(self) -> dict[str, Any]:
        snapshot = self.params()
        snapshot.update(
            {
                "weight_updates": self.weight_updates,
                "quantile_updates": self.quantile_updates,
                "resolved": self.resolved,
                "skipped": self.skipped,
                "breach_rate": (self.breaches / self.quantile_updates) if self.quantile_updates else None,
                "hit_rate": (self.hits / self.directional) if self.directional else None,
                "warmed_up": self.weight_updates >= self.min_updates,
                "prior_weights": {
                    "w_vis": self._prior_weights[0],
                    "w_blind": self._prior_weights[1],
                    "w_poly": self._prior_weights[2],
                },
                "prior_quantile": self._prior_quantile,
            }
        )
        return snapshot

    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "eta": self.eta,
            "horizon_ticks": self.horizon_ticks,
            "gamma": self.gamma,
            "q_target": self.q_target,
            "min_updates": self.min_updates,
            "weights": list(self.weights),
            "prior_weights": list(self._prior_weights),
            "quantile": self.quantile,
            "prior_quantile": self._prior_quantile,
            "weight_updates": self.weight_updates,
            "quantile_updates": self.quantile_updates,
            "breaches": self.breaches,
            "hits": self.hits,
            "directional": self.directional,
            "skipped": self.skipped,
            "resolved": self.resolved,
            "pending": [
                {"x": [float(component) for component in item["x"]], "mid": float(item["mid"])}
                for item in self._pending
            ],
        }

    @classmethod
    def from_json(cls, payload: Mapping[str, Any]) -> GravityFieldLearner:
        learner = cls(
            eta=payload.get("eta", 0.05),
            horizon_ticks=payload.get("horizon_ticks", 5),
            gamma=payload.get("gamma", 0.01),
            q_target=payload.get("q_target", DEFAULT_QUANTILE),
            min_updates=payload.get("min_updates", 1),
            weights=payload.get("prior_weights", payload.get("weights", DEFAULT_WEIGHTS)),
            quantile=payload.get("prior_quantile", payload.get("quantile", DEFAULT_QUANTILE)),
        )
        learned = payload.get("weights")
        if learned is not None:
            parsed = tuple(float(w) for w in learned)
            total = sum(parsed)
            learner.weights = tuple(w / total for w in parsed)
        if "quantile" in payload:
            learner.quantile = _clip_quantile(float(payload["quantile"]))
        for field in (
            "weight_updates",
            "quantile_updates",
            "breaches",
            "hits",
            "directional",
            "skipped",
            "resolved",
        ):
            if field in payload:
                setattr(learner, field, int(payload[field]))
        pending = payload.get("pending")
        if isinstance(pending, list):
            restored: list[dict[str, Any]] = []
            for item in pending:
                if not isinstance(item, dict):
                    continue
                raw_x = item.get("x")
                mid = _as_finite(item.get("mid"))
                if not isinstance(raw_x, list) or len(raw_x) != 3 or mid is None:
                    continue
                components = tuple(_as_finite(value) for value in raw_x)
                if any(component is None for component in components):
                    continue
                restored.append({"x": components, "mid": mid})
            learner._pending = restored
        return learner

    # -- log replay ---------------------------------------------------------
    def replay(self, ndjson_path: str | Path) -> dict[str, Any]:
        """Walk an execution log. Gravity ticks without ``mid_price`` are skipped.

        A ``regime_tick`` attaches ``is_forbidden_zone`` to the preceding
        ``gravity_tick`` (same tick in ``TelemetryFeed.on_tape``).
        """
        path = Path(ndjson_path)
        pending: dict[str, Any] | None = None
        with path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    self.skipped += 1
                    continue
                if not isinstance(event, dict):
                    self.skipped += 1
                    continue
                kind = event.get("event_kind")
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    continue
                if kind == "gravity_tick":
                    if pending is not None:
                        self.observe(pending)
                    if _as_finite(payload.get("mid_price")) is None:
                        self.skipped += 1
                        pending = None
                        continue
                    pending = {
                        "l2_depth": payload.get("l2_depth"),
                        "l3_iceberg": payload.get("l3_iceberg"),
                        "polymarket_prob": payload.get("polymarket_prob"),
                        "mid_price": payload.get("mid_price"),
                    }
                elif kind == "regime_tick" and pending is not None:
                    pending["is_forbidden_zone"] = payload.get("is_forbidden_zone")
                    self.observe(pending)
                    pending = None
        if pending is not None:
            self.observe(pending)
        return self.report()


def _format_weights(weights: Mapping[str, float]) -> str:
    return "vis=%.6f blind=%.6f poly=%.6f" % (weights["w_vis"], weights["w_blind"], weights["w_poly"])


def main(argv: Sequence[str] | None = None) -> int:
    """Replay an engine log and write the learned gravity parameters."""
    parser = argparse.ArgumentParser(description="Learn gravity-field weights and quantile from an engine NDJSON log")
    parser.add_argument("--log", required=True, help="NDJSON execution log (gravity_tick / regime_tick)")
    parser.add_argument("--out", required=True, help="Destination gravity_params.json")
    parser.add_argument("--eta", type=float, default=0.05)
    parser.add_argument("--horizon-ticks", type=int, default=5)
    parser.add_argument("--gamma", type=float, default=0.01)
    parser.add_argument("--q-target", type=float, default=DEFAULT_QUANTILE)
    parser.add_argument("--min-updates", type=int, default=1)
    args = parser.parse_args(argv)

    log_path = Path(args.log)
    if not log_path.is_file():
        print("log not found: %s" % (log_path,), file=sys.stderr)
        return 2

    learner = GravityFieldLearner(
        eta=args.eta,
        horizon_ticks=args.horizon_ticks,
        gamma=args.gamma,
        q_target=args.q_target,
        min_updates=args.min_updates,
    )
    before = learner.params()
    report = learner.replay(log_path)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(learner.to_json(), indent=2) + "\n", encoding="utf-8")

    print("prior    weights %s  quantile=%.6f" % (_format_weights(before), before["quantile"]))
    print("learned  weights %s  quantile=%.6f" % (_format_weights(report), report["quantile"]))
    print(
        "breach_rate=%s  hit_rate=%s  weight_updates=%d  skipped=%d"
        % (report["breach_rate"], report["hit_rate"], report["weight_updates"], report["skipped"])
    )
    print("wrote %s" % (out_path,))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
