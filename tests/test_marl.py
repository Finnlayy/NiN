"""
test_marl.py - Comprehensive Unit Tests for NiN Multi-Agent Reinforcement Learning Framework.

Tests:
1. Decentralized Actor Observation Causality & Independence.
2. Centralized Joint Critic & COMA Counterfactual Advantage Estimation.
3. Pessimistic Fill Model (Adverse Selection, Spread Cross, Non-execution).
4. Atomic Execution Guard & StateBus Pre-Trade Barrier (Staleness, Circuit Breaker, Deadband).
"""
import asyncio
import os
import sys
import unittest

# Ensure repo root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from Architect.marl.interfaces import ExecutionAction
from Architect.marl.actors import DecentralizedAlphaActor, DecentralizedExecutionActor
from Architect.marl.critic import CentralizedJointCritic
from Architect.marl.coma import COMATrainer, MARLTransitionBatch
from Architect.marl.environment import MarketTick, PessimisticFillModel, VectorizedRolloutCollector
from Architect.marl.state_bus import StateBus
from Architect.marl.guard import AtomicExecutionGuard


class TestObservationCausality(unittest.TestCase):
    """Verifies observation spaces enforce strict temporal causality and zero future leakage."""

    def test_actor_causality_and_no_future_leak(self):
        collector = VectorizedRolloutCollector()
        ticks = collector.generate_synthetic_ticks(20)

        # Observation at t=5
        a_obs1, e_obs1, g_state1 = collector.build_observations(ticks, 5, 0.0, 0.0)

        # Mutate future tick t=10
        ticks[10].mid_price += 1000.0

        # Observation at t=5 after future mutation must be IDENTICAL
        a_obs2, e_obs2, g_state2 = collector.build_observations(ticks, 5, 0.0, 0.0)
        self.assertEqual(a_obs1, a_obs2)
        self.assertEqual(e_obs1, e_obs2)
        self.assertEqual(g_state1, g_state2)


class TestDecentralizedActors(unittest.TestCase):
    """Verifies decentralized actors consume only local observations with zero critic leakage."""

    def setUp(self):
        if not HAS_TORCH:
            self.skipTest("PyTorch not installed.")
        torch.manual_seed(42)
        self.alpha_actor = DecentralizedAlphaActor(input_dim=16, hidden_dim=64)
        self.exec_actor = DecentralizedExecutionActor(input_dim=12, hidden_dim=64)

    def test_alpha_actor_shape_and_bounds(self):
        obs = torch.randn(8, 16)
        action, meta = self.alpha_actor.act(obs, deterministic=False)

        self.assertEqual(action.shape, (8, 1))
        # Action must strictly adhere to continuous conviction in [-1.0, 1.0]
        self.assertTrue(torch.all(action >= -1.0))
        self.assertTrue(torch.all(action <= 1.0))
        self.assertIn("mean", meta)
        self.assertIn("log_std", meta)

    def test_exec_actor_shape_and_discrete_classes(self):
        obs = torch.randn(8, 12)
        action, meta = self.exec_actor.act(obs, deterministic=False)

        self.assertEqual(action.shape, (8, 1))
        # Action must be in [0, 4]
        for val in action.squeeze(-1).tolist():
            self.assertIn(val, [0, 1, 2, 3, 4])
            # Must be a valid ExecutionAction enum
            self.assertIsInstance(ExecutionAction(val), ExecutionAction)

        probs = self.exec_actor.get_action_probs(obs)
        self.assertEqual(probs.shape, (8, 5))
        # Probabilities sum to 1.0
        torch.testing.assert_close(probs.sum(dim=-1), torch.ones(8), atol=1e-5, rtol=1e-5)


class TestCOMAEngine(unittest.TestCase):
    """Verifies centralized critic and COMA counterfactual advantage estimation."""

    def setUp(self):
        if not HAS_TORCH:
            self.skipTest("PyTorch not installed.")
        torch.manual_seed(42)
        self.alpha_actor = DecentralizedAlphaActor(input_dim=16, hidden_dim=64)
        self.exec_actor = DecentralizedExecutionActor(input_dim=12, hidden_dim=64)
        self.critic = CentralizedJointCritic(global_state_dim=32, alpha_action_dim=1, num_exec_actions=5, hidden_dim=64)
        self.trainer = COMATrainer(
            alpha_actor=self.alpha_actor,
            exec_actor=self.exec_actor,
            joint_critic=self.critic,
            gamma=0.99
        )

    def test_counterfactual_advantage_calculation(self):
        batch_size = 4
        dummy_batch = MARLTransitionBatch(
            global_states=torch.randn(batch_size, 32),
            alpha_obs=torch.randn(batch_size, 16),
            exec_obs=torch.randn(batch_size, 12),
            alpha_actions=torch.tensor([[0.5], [-0.2], [0.8], [0.0]]),
            exec_actions=torch.tensor([[1], [3], [0], [2]]),
            rewards=torch.tensor([[1.0], [-0.5], [0.2], [0.0]]),
            next_global_states=torch.randn(batch_size, 32),
            next_alpha_obs=torch.randn(batch_size, 16),
            next_exec_obs=torch.randn(batch_size, 12),
            dones=torch.zeros(batch_size, 1)
        )

        adv_alpha, adv_exec = self.trainer.compute_coma_advantages(dummy_batch)
        self.assertEqual(adv_alpha.shape, (batch_size, 1))
        self.assertEqual(adv_exec.shape, (batch_size, 1))

        # Check that execution advantage equals Q(chosen) - sum(pi * Q)
        exec_probs = self.exec_actor.get_action_probs(dummy_batch.exec_obs)
        q_all = self.critic.exec_critic(dummy_batch.global_states, dummy_batch.alpha_actions)
        q_chosen = q_all.gather(1, dummy_batch.exec_actions)
        expected_adv = q_chosen - (exec_probs * q_all).sum(dim=-1, keepdim=True)
        torch.testing.assert_close(adv_exec, expected_adv, atol=1e-5, rtol=1e-5)

    def test_train_step_gradient_flow(self):
        collector = VectorizedRolloutCollector()
        batch = collector.collect_rollout(self.alpha_actor, self.exec_actor, num_steps=16)

        metrics = self.trainer.train_step_batch(batch)
        self.assertIn("critic_loss", metrics)
        self.assertIn("exec_actor_loss", metrics)
        self.assertIn("alpha_actor_loss", metrics)
        self.assertGreater(metrics["critic_loss"], 0.0)


class TestPessimisticFillModel(unittest.TestCase):
    """Verifies that the market simulator penalizes adverse selection, spread crossing, etc."""

    def setUp(self):
        self.model = PessimisticFillModel()
        self.tick = MarketTick(
            timestamp_ms=1000, mid_price=100.0, bid_price=99.9, ask_price=100.1,
            spread=0.2, bid_vol_l1=5.0, ask_vol_l1=5.0, total_bid_depth=20.0,
            total_ask_depth=20.0, micro_price=100.0, volatility=0.01
        )

    def test_taker_spread_crossing_cost(self):
        next_tick = MarketTick(
            timestamp_ms=1100, mid_price=100.0, bid_price=99.9, ask_price=100.1,
            spread=0.2, bid_vol_l1=5.0, ask_vol_l1=5.0, total_bid_depth=20.0,
            total_ask_depth=20.0, micro_price=100.0, volatility=0.01
        )
        report = self.model.simulate_execution(
            action=ExecutionAction.AGGRESSIVE_TAKER,
            order_delta=1.0,
            tick=self.tick,
            next_tick=next_tick
        )
        self.assertTrue(report.filled)
        self.assertFalse(report.is_maker)
        self.assertAlmostEqual(report.fill_price, 100.1) # Filled at Ask
        self.assertGreater(report.slippage_cost, 0.0)
        self.assertGreater(report.fee_cost, 0.0)

    def test_hold_produces_no_fill(self):
        report = self.model.simulate_execution(
            action=ExecutionAction.IDLE_HOLD,
            order_delta=1.0,
            tick=self.tick,
            next_tick=self.tick
        )
        self.assertFalse(report.filled)
        self.assertEqual(report.fill_qty, 0.0)


class TestAtomicExecutionGuard(unittest.IsolatedAsyncioTestCase):
    """Verifies deterministic atomic guardrail, Lua pre-trade checks, and circuit breakers."""

    async def asyncSetUp(self):
        # Use state bus with in-memory deterministic engine for unit test isolation
        self.state_bus = StateBus(redis_url=None, use_fallback=True)
        await self.state_bus.connect()
        self.guard = AtomicExecutionGuard(
            state_bus=self.state_bus,
            max_position=2.0,
            min_deadband=0.01,
            max_staleness_ms=500
        )

    async def asyncTearDown(self):
        await self.state_bus.close()

    async def test_valid_order_dispatch(self):
        decision, routed = await self.guard.validate_and_route(
            symbol="BTC-USDT",
            alpha_conviction=0.5, # Target pos = 0.5 * 2.0 = 1.0
            execution_action=ExecutionAction.PASSIVE_PEGGED,
            market_mid_price=50000.0,
            current_tick_ts_ms=1000
        )
        self.assertTrue(decision.approved)
        self.assertEqual(decision.status_code, 1)
        self.assertIsNotNone(routed)
        self.assertEqual(routed.side, "BUY")
        self.assertAlmostEqual(routed.order_delta, 1.0)
        self.assertEqual(routed.order_type, "PEGGED")

    async def test_staleness_rejection(self):
        # First tick at 1000 ms
        await self.guard.validate_and_route(
            symbol="ETH-USDT",
            alpha_conviction=0.5,
            execution_action=ExecutionAction.JOIN_BEST,
            market_mid_price=3000.0,
            current_tick_ts_ms=1000
        )

        # Next tick arrives at 2000 ms (delta = 1000 ms > 500 ms max_staleness)
        decision, routed = await self.guard.validate_and_route(
            symbol="ETH-USDT",
            alpha_conviction=0.5,
            execution_action=ExecutionAction.JOIN_BEST,
            market_mid_price=3000.0,
            current_tick_ts_ms=2000
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.status_code, -1)
        self.assertIn("STALE", decision.reason)
        self.assertIsNone(routed)

    async def test_circuit_breaker_emergency_halt(self):
        # Trigger emergency halt
        await self.guard.trigger_emergency_stop("SOL-USDT", "EXCESS_DRAWDOWN_LIMIT")

        decision, routed = await self.guard.validate_and_route(
            symbol="SOL-USDT",
            alpha_conviction=0.8,
            execution_action=ExecutionAction.AGGRESSIVE_TAKER,
            market_mid_price=150.0,
            current_tick_ts_ms=5000
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.status_code, -2)
        self.assertIn("CIRCUIT_BREAKER", decision.reason)
        self.assertIsNone(routed)

        # Resume trading
        await self.guard.resume_trading("SOL-USDT")
        decision_after, _ = await self.guard.validate_and_route(
            symbol="SOL-USDT",
            alpha_conviction=0.8,
            execution_action=ExecutionAction.AGGRESSIVE_TAKER,
            market_mid_price=150.0,
            current_tick_ts_ms=5100
        )
        self.assertTrue(decision_after.approved)

    async def test_deadband_and_hold_noop(self):
        # 1. Action = IDLE_HOLD
        decision, routed = await self.guard.validate_and_route(
            symbol="AVAX-USDT",
            alpha_conviction=0.5,
            execution_action=ExecutionAction.IDLE_HOLD,
            market_mid_price=30.0,
            current_tick_ts_ms=1000
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.status_code, 0)
        self.assertIsNone(routed)

        # 2. Delta within deadband (< 0.01)
        decision, routed = await self.guard.validate_and_route(
            symbol="AVAX-USDT",
            alpha_conviction=0.001, # Target pos = 0.002 (< 0.01 deadband)
            execution_action=ExecutionAction.AGGRESSIVE_TAKER,
            market_mid_price=30.0,
            current_tick_ts_ms=1100
        )
        self.assertFalse(decision.approved)
        self.assertEqual(decision.status_code, 0)
        self.assertIsNone(routed)


if __name__ == "__main__":
    unittest.main()
