"""Gravity-field learner: simplex weights, adaptive quantile, log replay."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ARCHITECT = Path(__file__).resolve().parents[1]
if str(ARCHITECT) not in sys.path:
    sys.path.insert(0, str(ARCHITECT))

from core.events import EventBus, validate_telemetry_payload  # noqa: E402
from limbs.math.ac_gravity_engine import ACGravityEngine  # noqa: E402
from limbs.ml.gravity_learner import GravityFieldLearner, main  # noqa: E402
from limbs.telemetry_feed import TelemetryFeed  # noqa: E402


def _tick(l2, l3, poly, mid, forbidden=None):
    tick = {
        "l2_depth": float(l2),
        "l3_iceberg": float(l3),
        "polymarket_prob": float(poly),
        "mid_price": float(mid),
    }
    if forbidden is not None:
        tick["is_forbidden_zone"] = forbidden
    return tick


def _static_breach_rate(prices, quantile, window):
    engine = ACGravityEngine(quantile=quantile)
    breaches = 0
    counted = 0
    history: list[float] = []
    for price in prices:
        if len(history) >= window:
            counted += 1
            if engine.is_in_forbidden_zone(price, history[-window:]):
                breaches += 1
        history.append(price)
    return breaches / counted if counted else 0.0


class GravityEngineTests(unittest.TestCase):
    def test_defaults_match_blueprint_prior(self):
        params = ACGravityEngine().params()
        self.assertEqual(params["w_vis"], 0.25)
        self.assertEqual(params["w_blind"], 0.35)
        self.assertEqual(params["w_poly"], 0.40)
        self.assertEqual(params["quantile"], 0.999)
        self.assertEqual(params["history_window"], 512)

    def test_compute_uses_configured_weights(self):
        engine = ACGravityEngine(weights=(0.5, 0.25, 0.25))
        self.assertAlmostEqual(engine.compute_gravity_field(2.0, 4.0, 8.0), 4.0)

    def test_simplex_and_window_are_validated(self):
        with self.assertRaises(ValueError):
            ACGravityEngine(weights=(0.5, 0.5, 0.5))
        with self.assertRaises(ValueError):
            ACGravityEngine(weights=(-0.1, 0.6, 0.5))
        with self.assertRaises(ValueError):
            ACGravityEngine(quantile=0.2)
        with self.assertRaises(ValueError):
            ACGravityEngine(history_window=1)

    def test_set_weights_round_trips_through_params(self):
        engine = ACGravityEngine()
        engine.set_weights((0.2, 0.3, 0.5))
        engine.set_quantile(0.995)
        params = engine.params()
        self.assertAlmostEqual(params["w_vis"] + params["w_blind"] + params["w_poly"], 1.0)
        self.assertAlmostEqual(params["quantile"], 0.995)


class WeightConvergenceTests(unittest.TestCase):
    def test_predictive_component_takes_the_simplex(self):
        rng = np.random.default_rng(3)
        horizon = 1
        n = 700
        prices = [100.0]
        for _ in range(n):
            prices.append(prices[-1] + float(rng.normal()))

        learner = GravityFieldLearner(eta=0.35, horizon_ticks=horizon, gamma=0.001, min_updates=1)
        for t, mid in enumerate(prices):
            if t + horizon < len(prices):
                label = 1.0 if prices[t + horizon] > mid else -1.0
                l2 = 0.9 if label > 0.0 else 0.1
            else:
                l2 = 0.5
            learner.observe(
                _tick(l2, float(rng.random()), float(rng.random()), mid, forbidden=False)
            )

        weights = learner.weights
        self.assertAlmostEqual(sum(weights), 1.0, places=9)
        self.assertTrue(all(w > 0.0 for w in weights))
        self.assertGreater(weights[0], 0.6)
        self.assertGreater(weights[0], weights[1])
        self.assertGreater(weights[0], weights[2])
        self.assertGreater(learner.report()["hit_rate"], 0.6)
        self.assertEqual(learner.params()["w_vis"], weights[0])


class QuantileCoverageTests(unittest.TestCase):
    def test_breach_raises_quantile_and_coverage_moves_toward_target(self):
        learner = GravityFieldLearner(eta=0.0, gamma=0.1, q_target=0.999, quantile=0.995)
        before = learner.quantile
        learner.observe(_tick(0.5, 0.5, 0.5, 1.0, forbidden=True))
        self.assertGreater(learner.quantile, before)
        raised = learner.quantile
        learner.observe(_tick(0.5, 0.5, 0.5, 2.0, forbidden=False))
        self.assertLess(learner.quantile, raised)
        self.assertGreaterEqual(learner.quantile, 0.99)
        self.assertLessEqual(learner.quantile, 0.9999)

        rng = np.random.default_rng(11)
        n = 4000
        window = 256
        prices = list(np.cumsum(rng.standard_t(df=3, size=n)) + 1000.0)
        start_q = 0.99
        q_target = 0.999
        target_breach = 1.0 - q_target
        rate_start = _static_breach_rate(prices, start_q, window)

        adapted = GravityFieldLearner(
            eta=0.0, horizon_ticks=1, gamma=0.05, q_target=q_target, quantile=start_q
        )
        engine = ACGravityEngine(quantile=start_q)
        history: list[float] = []
        for price in prices:
            ready = len(history) >= window
            forbidden = engine.is_in_forbidden_zone(price, history[-window:]) if ready else None
            adapted.observe(_tick(0.5, 0.5, 0.5, price, forbidden=forbidden))
            if ready:
                engine.set_quantile(adapted.quantile)
            history.append(price)

        rate_final = _static_breach_rate(prices, adapted.quantile, window)
        self.assertGreater(adapted.quantile, start_q)
        self.assertLessEqual(adapted.quantile, 0.9999)
        self.assertLess(abs(rate_final - target_breach), abs(rate_start - target_breach))


class ReplayTests(unittest.TestCase):
    def test_replay_matches_online_and_skips_ticks_without_mid(self):
        rng = np.random.default_rng(1)
        kwargs = dict(eta=0.08, horizon_ticks=4, gamma=0.02, q_target=0.995, min_updates=1, quantile=0.995)
        ticks = []
        price = 50.0
        for i in range(40):
            price += float(rng.normal())
            ticks.append(
                _tick(
                    rng.random(),
                    rng.random(),
                    rng.random(),
                    price,
                    forbidden=(i % 11 == 0),
                )
            )

        online = GravityFieldLearner(**kwargs)
        for tick in ticks:
            self.assertTrue(online.observe(tick))

        lines = []
        for i, tick in enumerate(ticks):
            if i == 10:
                lines.append(
                    json.dumps(
                        {
                            "event_kind": "gravity_tick",
                            "payload": {
                                "l2_depth": 0.2,
                                "l3_iceberg": 0.3,
                                "polymarket_prob": 0.4,
                                "v_total": 0.31,
                            },
                        }
                    )
                )
            lines.append(
                json.dumps(
                    {
                        "event_kind": "gravity_tick",
                        "clock_s": i,
                        "payload": {
                            "l2_depth": tick["l2_depth"],
                            "l3_iceberg": tick["l3_iceberg"],
                            "polymarket_prob": tick["polymarket_prob"],
                            "v_total": 0.3,
                            "mid_price": tick["mid_price"],
                            "w_vis": 0.25,
                            "w_blind": 0.35,
                            "w_poly": 0.40,
                        },
                    }
                )
            )
            lines.append(
                json.dumps(
                    {
                        "event_kind": "regime_tick",
                        "clock_s": i,
                        "payload": {
                            "cluster_id": 0,
                            "confidence": 0.5,
                            "is_forbidden_zone": 1.0 if tick["is_forbidden_zone"] else 0.0,
                            "quantile": 0.995,
                        },
                    }
                )
            )

        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "engine.ndjson"
            out_path = Path(tmp) / "gravity_params.json"
            log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            replayed = GravityFieldLearner(**kwargs)
            report = replayed.replay(log_path)
            self.assertEqual(replayed.weights, online.weights)
            self.assertEqual(replayed.quantile, online.quantile)
            self.assertGreaterEqual(replayed.skipped, 1)
            self.assertEqual(report["w_vis"], replayed.params()["w_vis"])

            restored = GravityFieldLearner.from_json(online.to_json())
            for left, right in zip(restored.weights, online.weights):
                self.assertAlmostEqual(left, right, places=9)
            self.assertAlmostEqual(restored.quantile, online.quantile, places=9)
            self.assertEqual(restored.weight_updates, online.weight_updates)
            self.assertEqual(len(restored._pending), len(online._pending))

            self.assertEqual(main(["--log", str(log_path), "--out", str(out_path), "--horizon-ticks", "4"]), 0)
            written = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(len(written["weights"]), 3)
            self.assertAlmostEqual(sum(written["weights"]), 1.0, places=9)
            self.assertIn("pending", written)
            self.assertEqual(main(["--log", str(Path(tmp) / "missing.ndjson"), "--out", str(out_path)]), 2)

    def test_pending_round_trip_finishes_the_same_horizon(self):
        learner = GravityFieldLearner(eta=0.05, horizon_ticks=2, gamma=0.01)
        learner.observe(_tick(0.2, 0.3, 0.5, 100.0, False))
        learner.observe(_tick(0.8, 0.1, 0.4, 101.0, False))
        self.assertEqual(learner.weight_updates, 0)
        blob = learner.to_json()
        self.assertEqual(len(blob["pending"]), 2)
        restored = GravityFieldLearner.from_json(blob)
        third = _tick(0.4, 0.4, 0.4, 103.0, False)
        restored.observe(third)
        learner.observe(third)
        self.assertEqual(restored.weight_updates, learner.weight_updates)
        self.assertEqual(restored.weights, learner.weights)
        self.assertAlmostEqual(restored.quantile, learner.quantile, places=9)

    def test_validator_accepts_enriched_ticks(self):
        payload = {
            "l2_depth": 0.5,
            "l3_iceberg": 0.4,
            "polymarket_prob": 0.6,
            "v_total": 0.51,
            "mid_price": 100.0,
            "w_vis": 0.25,
            "w_blind": 0.35,
            "w_poly": 0.40,
        }
        ok, reason = validate_telemetry_payload("gravity_tick", payload)
        self.assertTrue(ok, reason)
        ok, reason = validate_telemetry_payload(
            "regime_tick",
            {"cluster_id": 0, "confidence": 0.5, "is_forbidden_zone": 0.0, "quantile": 0.999},
        )
        self.assertTrue(ok, reason)
        ok, reason = validate_telemetry_payload("gravity_tick", {"l2_depth": 0.5, "mid_price": 1.0})
        self.assertFalse(ok)
        self.assertIn("l3_iceberg", reason)


class TelemetryFeedTests(unittest.TestCase):
    def _book(self, price):
        bids = [(price - 0.5 * (i + 1), 2.0) for i in range(4)]
        asks = [(price + 0.5 * (i + 1), 1.0) for i in range(4)]
        trades = [(price, 0.2, False), (price, 0.2, True)]
        return bids, asks, trades

    def test_feed_logs_mid_price_weights_and_bounds_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            bus = EventBus(system_log_path=str(Path(tmp) / "system.log"))
            bus.event_sinks["stderr"] = False
            learner = GravityFieldLearner(eta=0.2, horizon_ticks=1, gamma=0.01, min_updates=1)
            feed = TelemetryFeed(bus, learner=learner, history_window=8)
            for i in range(20):
                sent = feed.on_tape(*self._book(100.0 + i * 0.3))
                self.assertTrue(sent["gravity_tick"])
                self.assertTrue(sent["regime_tick"])

            self.assertEqual(feed._history.maxlen, 8)
            self.assertEqual(len(feed._history), 8)
            tuned = learner.params()
            engine_params = feed.gravity.params()
            self.assertAlmostEqual(engine_params["w_vis"], tuned["w_vis"])
            self.assertAlmostEqual(engine_params["w_blind"], tuned["w_blind"])
            self.assertAlmostEqual(engine_params["w_poly"], tuned["w_poly"])
            self.assertAlmostEqual(
                engine_params["w_vis"] + engine_params["w_blind"] + engine_params["w_poly"], 1.0
            )
            self.assertAlmostEqual(engine_params["quantile"], tuned["quantile"])

            events = [json.loads(line) for line in Path(bus.system_log_path).read_text(encoding="utf-8").splitlines()]
            gravity = [event["payload"] for event in events if event["event_kind"] == "gravity_tick"]
            regime = [event["payload"] for event in events if event["event_kind"] == "regime_tick"]
            self.assertIn("mid_price", gravity[-1])
            for key in ("w_vis", "w_blind", "w_poly"):
                self.assertIn(key, gravity[-1])
            self.assertIn("quantile", regime[-1])
            ok, reason = validate_telemetry_payload("gravity_tick", gravity[-1])
            self.assertTrue(ok, reason)
            ok, reason = validate_telemetry_payload("regime_tick", regime[-1])
            self.assertTrue(ok, reason)
            # Required fields unchanged: a payload with only the original contract still passes.
            original = {key: gravity[-1][key] for key in ("l2_depth", "l3_iceberg", "polymarket_prob", "v_total")}
            ok, reason = validate_telemetry_payload("gravity_tick", original)
            self.assertTrue(ok, reason)


if __name__ == "__main__":
    unittest.main()
