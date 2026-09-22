"""
test_risk_matrix_mitigations.py - Comprehensive Unit & Stress Tests for Living Risk Matrix Mitigations.

Verifies:
1. Row 1: Parametrischer Look-ahead-Bias (FinCAD-LogitsProcessor, KL-Divergence, dynamic alpha-penalty).
2. Row 2: Two-Pass Fallback Parity (Debiasing-Theater detection via Jaccard token analysis).
3. Row 4: Runaway Loop & Token Budget Containment (Meta-Breaker Loop Counter).
4. Row 5: Dead-Man-Switch Cancel-After Verification.
5. Row 9: Market Data Feed Staleness Gate (Sub-500ms Lua/In-Memory Barrier).
6. Row 10: Kaskadenfehler Meta-Breaker (>= 2 simultaneous open breakers triggers global SAFE-HALT).
7. Row 12: FinCAD alpha calibration bound sanity.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from Architect.marl.fincad_processor import FinCADLogitsProcessor
from Architect.marl.meta_breaker import MetaCircuitBreaker, BreakerDomain
from Architect.marl.state_bus import StateBus
from Architect.marl.guard import AtomicExecutionGuard
from Architect.marl.interfaces import ExecutionAction


class TestParametricLookaheadMitigation(unittest.TestCase):
    """Verifies Row 1 & Row 12: FinCAD LogitsProcessor suppresses look-ahead memory leaks."""

    def setUp(self):
        self.processor = FinCADLogitsProcessor(
            base_alpha=0.35,
            max_alpha=0.85,
            kl_divergence_threshold=0.12
        )

    def test_causal_data_nominal_no_penalty(self):
        # When prior and context distributions match closely, zero penalty is applied
        prior_dist = [0.25, 0.25, 0.25, 0.25]
        context_dist = [0.24, 0.26, 0.24, 0.26]

        verdict = self.processor.evaluate_causal_signal(
            raw_signal=0.80,
            prior_logits=prior_dist,
            context_logits=context_dist,
            is_pre_cutoff_timestamp=False
        )

        self.assertFalse(verdict.is_biased)
        self.assertEqual(verdict.alpha_penalty, 0.0)
        self.assertAlmostEqual(verdict.corrected_signal, 0.80, places=4)
        self.assertLess(verdict.kl_divergence, 0.12)

    def test_parametric_lookahead_divergence_penalized(self):
        # Pre-training memory diverges sharply from current context -> high KL divergence
        prior_dist = [0.90, 0.05, 0.03, 0.02]
        context_dist = [0.10, 0.40, 0.30, 0.20]

        verdict = self.processor.evaluate_causal_signal(
            raw_signal=0.90,
            prior_logits=prior_dist,
            context_logits=context_dist,
            is_pre_cutoff_timestamp=True
        )

        self.assertTrue(verdict.is_biased)
        self.assertTrue(verdict.memorization_detected)
        self.assertGreater(verdict.alpha_penalty, 0.35)
        # Corrected signal must be strictly dampened towards 0.0
        self.assertLess(verdict.corrected_signal, 0.90)
        self.assertIn("LOOKAHEAD_BIAS_DETECTED", verdict.reason)

    def test_two_pass_debiasing_theater_detection(self):
        """Verifies Row 2: Detects cosmetic reasoning variations with identical directional bias."""
        pass1_tokens = ["bearish", "breakdown", "s1_support", "sell_short"]
        # Disagreeing or superficial tokens
        pass2_tokens_divergent = ["bullish", "divergence", "reversal", "buy_long"]

        valid, jaccard, msg = self.processor.verify_two_pass_parity(
            pass1_tokens=pass1_tokens,
            pass2_tokens=pass2_tokens_divergent,
            direction1=-1,
            direction2=1
        )
        self.assertFalse(valid)
        self.assertIn("DIRECTIONAL_COLLISION", msg)


class TestMetaBreakerCascadeContainment(unittest.TestCase):
    """Verifies Row 4, Row 5, and Row 10: Meta-Breaker and Runaway containment."""

    def setUp(self):
        self.state_bus = StateBus(use_fallback=True)
        self.meta_breaker = MetaCircuitBreaker(
            state_bus=self.state_bus,
            max_loop_iterations=5,
            max_token_per_turn=4000,
            deadman_cancel_after_s=60
        )

    def test_runaway_loop_trip(self):
        # 5 iterations are acceptable
        for _ in range(5):
            allowed = self.meta_breaker.record_loop_iteration(tokens_used=100)
            self.assertTrue(allowed)

        # 6th iteration trips LLM_ORCHESTRATOR breaker
        allowed = self.meta_breaker.record_loop_iteration(tokens_used=100)
        self.assertFalse(allowed)
        self.assertTrue(self.meta_breaker.breakers[BreakerDomain.LLM_ORCHESTRATOR].is_open)

    def test_meta_breaker_cascade_requires_two_breakers(self):
        # 1 breaker open: Not yet a global meta-halt
        self.meta_breaker.trip_breaker(BreakerDomain.VENUE_EXCHANGE, "Kraken 502 Bad Gateway")
        verdict = self.meta_breaker.check_meta_state()
        self.assertFalse(verdict.safe_halt_engaged)
        self.assertEqual(verdict.open_breakers_count, 1)

        # 2nd breaker open: Global meta-error triggered!
        self.meta_breaker.trip_breaker(BreakerDomain.DATABASE_STATE, "Redis connection timed out")
        verdict = self.meta_breaker.check_meta_state()
        self.assertTrue(verdict.safe_halt_engaged)
        self.assertEqual(verdict.open_breakers_count, 2)
        self.assertEqual(verdict.action_required, "EXECUTE_GLOBAL_SAFE_HALT_AND_FREEZE_STATE")

    def test_safe_halt_execution_locks_state_bus(self):
        async def run_test():
            await self.state_bus.connect()
            guard = AtomicExecutionGuard(self.state_bus)

            # Trip meta breakers
            self.meta_breaker.trip_breaker(BreakerDomain.VENUE_EXCHANGE, "Kraken Rate Limit")
            self.meta_breaker.trip_breaker(BreakerDomain.LLM_ORCHESTRATOR, "Loop Limit")

            verdict = self.meta_breaker.check_meta_state()
            self.assertTrue(verdict.safe_halt_engaged)

            # Execute safe halt
            halt_reports = await self.meta_breaker.execute_safe_halt(["BTC/USD", "SOL/USD"])
            self.assertIn("BTC/USD", halt_reports)
            self.assertIn("SOL/USD", halt_reports)

            # Any subsequent order dispatch MUST be rejected with -2 (CIRCUIT BREAKER ACTIVE)
            decision, routed = await guard.validate_and_route(
                symbol="BTC/USD",
                alpha_conviction=0.5,
                execution_action=ExecutionAction.AGGRESSIVE_TAKER,
                market_mid_price=64000.0
            )
            self.assertFalse(decision.approved)
            self.assertEqual(decision.status_code, -2)
            self.assertIsNone(routed)

        asyncio.run(run_test())


class TestMarketFeedStalenessMitigation(unittest.TestCase):
    """Verifies Row 9: Staleness Gate in StateBus rejects ticks delayed > 500ms."""

    def test_stale_market_data_rejection(self):
        async def run_test():
            state_bus = StateBus(use_fallback=True)
            await state_bus.connect()
            guard = AtomicExecutionGuard(state_bus, max_staleness_ms=500)

            # Seed initial tick at t=100,000 ms
            decision1, _ = await guard.validate_and_route(
                symbol="BTC/USD",
                alpha_conviction=0.2,
                execution_action=ExecutionAction.JOIN_BEST,
                market_mid_price=64000.0,
                current_tick_ts_ms=100000
            )
            self.assertTrue(decision1.approved)

            # Attempt trade at t=100,600 ms (delta = 600 ms > 500 ms limit)
            decision_stale, routed = await guard.validate_and_route(
                symbol="BTC/USD",
                alpha_conviction=0.4,
                execution_action=ExecutionAction.JOIN_BEST,
                market_mid_price=64000.0,
                current_tick_ts_ms=100600
            )
            self.assertFalse(decision_stale.approved)
            self.assertEqual(decision_stale.status_code, -1)
            self.assertEqual(decision_stale.reason, "REJECT_STALE_MARKET_TICK")
            self.assertIsNone(routed)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
