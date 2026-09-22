"""
environment.py - Pessimistic Fill Simulator and Vectorized Rollout Collector for NiN MARL.

Implements:
1. PessimisticFillModel: Realistic orderbook queue simulation penalizing adverse selection,
   spread-crossing friction, maker non-execution risk, and latency lag.
2. VectorizedRolloutCollector: Collects causal trajectory batches without lookahead leakage.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    torch = None

from Architect.marl.interfaces import ExecutionAction
from Architect.marl.coma import MARLTransitionBatch


@dataclass
class MarketTick:
    """Microstructure tick snapshot at time t."""
    timestamp_ms: int
    mid_price: float
    bid_price: float
    ask_price: float
    spread: float
    bid_vol_l1: float
    ask_vol_l1: float
    total_bid_depth: float
    total_ask_depth: float
    micro_price: float
    volatility: float
    latency_ms: float = 5.0


@dataclass
class FillReport:
    """Execution outcome for a simulated tick."""
    filled: bool
    fill_qty: float
    fill_price: float
    is_maker: bool
    fee_cost: float
    slippage_cost: float
    adverse_selection_cost: float
    realized_cash_flow: float


class PessimisticFillModel:
    """
    Pessimistic Order Execution Simulator.
    
    Guarantees that RL agents cannot exploit optimistic fill assumptions:
    - Maker orders (Passive Pegged / Join Best) must wait behind existing queue depth.
    - Orders are disproportionately filled when price moves *against* the position (Adverse Selection).
    - Taker orders suffer full half-spread crossing cost plus aggressive taker fee.
    - Idle/Hold suffers inventory risk if position is non-zero.
    """

    def __init__(
        self,
        maker_fee_bps: float = -0.5,    # Rebate of 0.5 bps
        taker_fee_bps: float = 3.0,     # Taker fee of 3.0 bps
        adverse_selection_alpha: float = 1.5,
        passive_fill_prob_base: float = 0.45,
        touch_fill_prob_base: float = 0.65
    ):
        self.maker_fee_bps = maker_fee_bps
        self.taker_fee_bps = taker_fee_bps
        self.adverse_selection_alpha = adverse_selection_alpha
        self.passive_fill_prob_base = passive_fill_prob_base
        self.touch_fill_prob_base = touch_fill_prob_base

    def simulate_execution(
        self,
        action: ExecutionAction,
        order_delta: float,
        tick: MarketTick,
        next_tick: MarketTick
    ) -> FillReport:
        """
        Simulates execution outcome between tick t and next_tick t+1.
        """
        if abs(order_delta) < 1e-6 or action == ExecutionAction.IDLE_HOLD:
            return FillReport(
                filled=False, fill_qty=0.0, fill_price=tick.mid_price,
                is_maker=True, fee_cost=0.0, slippage_cost=0.0,
                adverse_selection_cost=0.0, realized_cash_flow=0.0
            )

        is_buy = order_delta > 0
        qty = abs(order_delta)

        # ---------------------------------------------------------------------
        # AGGRESSIVE TAKER (Spread Cross)
        # ---------------------------------------------------------------------
        if action == ExecutionAction.AGGRESSIVE_TAKER:
            # Immediate fill at touch + slippage
            fill_price = tick.ask_price if is_buy else tick.bid_price
            half_spread = tick.spread / 2.0
            fee = (qty * fill_price) * (self.taker_fee_bps / 10000.0)
            slippage = qty * half_spread

            # Adverse selection drift if price moves away
            price_drift = (next_tick.mid_price - tick.mid_price)
            adverse = qty * max(0.0, -price_drift if is_buy else price_drift) * 0.5

            cash_flow = -(qty * fill_price) if is_buy else (qty * fill_price)

            return FillReport(
                filled=True,
                fill_qty=order_delta,
                fill_price=fill_price,
                is_maker=False,
                fee_cost=fee,
                slippage_cost=slippage,
                adverse_selection_cost=adverse,
                realized_cash_flow=cash_flow
            )

        # ---------------------------------------------------------------------
        # PASSIVE PEGGED (Back of queue maker)
        # ---------------------------------------------------------------------
        if action == ExecutionAction.PASSIVE_PEGGED:
            # Price at level: 1 tick better or inside depth
            target_price = tick.bid_price if is_buy else tick.ask_price
            # Probability scaled down if queue is thick
            queue_depth = tick.bid_vol_l1 if is_buy else tick.ask_vol_l1
            prob = self.passive_fill_prob_base / (1.0 + (queue_depth / 10.0))

            # Adverse selection trigger: if next tick moved against us, fill probability jumps
            price_moved_against = (next_tick.mid_price < tick.mid_price) if is_buy else (next_tick.mid_price > tick.mid_price)
            if price_moved_against:
                prob = min(0.95, prob * 2.2) # High chance of getting filled when being run over!

            filled = random.random() < prob
            if filled:
                fee = (qty * target_price) * (self.maker_fee_bps / 10000.0)
                adverse_drift = abs(next_tick.mid_price - tick.mid_price) if price_moved_against else 0.0
                adverse = qty * adverse_drift * self.adverse_selection_alpha
                cash_flow = -(qty * target_price) if is_buy else (qty * target_price)
                return FillReport(
                    filled=True, fill_qty=order_delta, fill_price=target_price,
                    is_maker=True, fee_cost=fee, slippage_cost=0.0,
                    adverse_selection_cost=adverse, realized_cash_flow=cash_flow
                )
            else:
                return FillReport(
                    filled=False, fill_qty=0.0, fill_price=target_price,
                    is_maker=True, fee_cost=0.0, slippage_cost=0.0,
                    adverse_selection_cost=0.0, realized_cash_flow=0.0
                )

        # ---------------------------------------------------------------------
        # JOIN BEST (Join best bid/offer)
        # ---------------------------------------------------------------------
        if action == ExecutionAction.JOIN_BEST:
            target_price = tick.bid_price if is_buy else tick.ask_price
            prob = self.touch_fill_prob_base
            price_moved_against = (next_tick.mid_price < tick.mid_price) if is_buy else (next_tick.mid_price > tick.mid_price)
            if price_moved_against:
                prob = min(0.98, prob * 1.8)

            filled = random.random() < prob
            if filled:
                fee = (qty * target_price) * (self.maker_fee_bps / 10000.0)
                adverse = (qty * abs(next_tick.mid_price - tick.mid_price) * self.adverse_selection_alpha) if price_moved_against else 0.0
                cash_flow = -(qty * target_price) if is_buy else (qty * target_price)
                return FillReport(
                    filled=True, fill_qty=order_delta, fill_price=target_price,
                    is_maker=True, fee_cost=fee, slippage_cost=0.0,
                    adverse_selection_cost=adverse, realized_cash_flow=cash_flow
                )
            else:
                return FillReport(
                    filled=False, fill_qty=0.0, fill_price=target_price,
                    is_maker=True, fee_cost=0.0, slippage_cost=0.0,
                    adverse_selection_cost=0.0, realized_cash_flow=0.0
                )

        # CANCEL_REPLACE
        return FillReport(
            filled=False, fill_qty=0.0, fill_price=tick.mid_price,
            is_maker=True, fee_cost=0.0, slippage_cost=0.001 * qty,
            adverse_selection_cost=0.0, realized_cash_flow=0.0
        )


class VectorizedRolloutCollector:
    """
    Simulates multi-agent rollouts with strict temporal causality.
    Generates PyTorch MARLTransitionBatch objects for the COMATrainer.
    """

    def __init__(
        self,
        fill_model: Optional[PessimisticFillModel] = None,
        inventory_risk_penalty: float = 0.05
    ):
        self.fill_model = fill_model or PessimisticFillModel()
        self.inventory_risk_penalty = inventory_risk_penalty

    def generate_synthetic_ticks(self, num_ticks: int = 120, initial_price: float = 3000.0) -> List[MarketTick]:
        """Generates synthetic microstructure tick sequence with realistic random walks."""
        ticks: List[MarketTick] = []
        current_p = initial_price
        for i in range(num_ticks):
            drift = random.gauss(0, 0.5)
            current_p = max(100.0, current_p + drift)
            spread = max(0.1, random.uniform(0.1, 0.8))
            bid = current_p - spread / 2.0
            ask = current_p + spread / 2.0
            bid_vol = random.uniform(0.5, 5.0)
            ask_vol = random.uniform(0.5, 5.0)
            micro = (bid * ask_vol + ask * bid_vol) / (bid_vol + ask_vol)
            ticks.append(MarketTick(
                timestamp_ms=1700000000000 + i * 100,
                mid_price=current_p,
                bid_price=bid,
                ask_price=ask,
                spread=spread,
                bid_vol_l1=bid_vol,
                ask_vol_l1=ask_vol,
                total_bid_depth=bid_vol * 4.0,
                total_ask_depth=ask_vol * 4.0,
                micro_price=micro,
                volatility=random.uniform(0.01, 0.05),
                latency_ms=random.uniform(2.0, 15.0)
            ))
        return ticks

    def build_observations(
        self,
        ticks: List[MarketTick],
        current_idx: int,
        current_inventory: float,
        alpha_urgency: float
    ) -> Tuple[List[float], List[float], List[float]]:
        """
        Builds local alpha observation (16d), execution observation (12d),
        and global critic state (32d) using ONLY ticks up to current_idx.
        Strictly guarantees NO FUTURE LEAK.
        """
        tick = ticks[current_idx]
        prev_tick = ticks[current_idx - 1] if current_idx > 0 else tick

        # 1. Alpha features (16d)
        obi_l1 = (tick.bid_vol_l1 - tick.ask_vol_l1) / (tick.bid_vol_l1 + tick.ask_vol_l1 + 1e-6)
        obi_total = (tick.total_bid_depth - tick.total_ask_depth) / (tick.total_bid_depth + tick.total_ask_depth + 1e-6)
        micro_drift = (tick.micro_price - tick.mid_price) / tick.mid_price
        ret_1 = (tick.mid_price - prev_tick.mid_price) / prev_tick.mid_price
        spread_bps = (tick.spread / tick.mid_price) * 10000.0

        alpha_obs = [
            obi_l1, obi_total, micro_drift, ret_1,
            spread_bps / 10.0, tick.volatility * 100.0, micro_drift * 5.0, ret_1 * 10.0,
            tick.bid_vol_l1 / 10.0, tick.ask_vol_l1 / 10.0, 0.0, 0.0,
            0.5, 0.1, 0.1, current_inventory / 2.0
        ]

        # 2. Execution features (12d)
        exec_obs = [
            tick.bid_vol_l1 / 10.0, tick.ask_vol_l1 / 10.0, tick.spread / 0.5,
            alpha_urgency, current_inventory / 2.0, 0.5, 0.1,
            spread_bps / 10.0, tick.latency_ms / 10.0, 0.01,
            0.02, 0.0
        ]

        # 3. Global Critic State (32d) - Unconstrained market state
        global_state = alpha_obs + exec_obs + [
            tick.total_bid_depth / 20.0, tick.total_ask_depth / 20.0,
            current_inventory, 0.0 # PnL & margin
        ]

        return alpha_obs, exec_obs, global_state

    def collect_rollout(
        self,
        alpha_actor: Any,
        exec_actor: Any,
        num_steps: int = 64,
        max_pos: float = 2.0,
        device: str = "cpu"
    ) -> MARLTransitionBatch:
        """Collects a rollout batch using the current actors."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch required.")

        ticks = self.generate_synthetic_ticks(num_steps + 10)
        global_states = []
        alpha_obs_list = []
        exec_obs_list = []
        alpha_acts = []
        exec_acts = []
        rewards = []
        next_global_states = []
        next_alpha_obs_list = []
        next_exec_obs_list = []
        dones = []

        current_inventory = 0.0
        current_urgency = 0.0

        for t in range(num_steps):
            a_obs, e_obs, g_state = self.build_observations(
                ticks, t, current_inventory, current_urgency
            )

            # Convert to tensors
            t_a_obs = torch.tensor([a_obs], dtype=torch.float32, device=device)
            t_e_obs = torch.tensor([e_obs], dtype=torch.float32, device=device)

            # Actor passes
            with torch.no_grad():
                alpha_act_tensor, alpha_meta = alpha_actor.act(t_a_obs, deterministic=False)
                exec_act_tensor, exec_meta = exec_actor.act(t_e_obs, deterministic=False)

            alpha_val = float(alpha_act_tensor[0, 0].item())
            exec_val = int(exec_act_tensor[0, 0].item())
            action_enum = ExecutionAction(exec_val)

            target_pos = alpha_val * max_pos
            delta = target_pos - current_inventory
            current_urgency = abs(delta)

            # Simulate execution against market
            fill = self.fill_model.simulate_execution(
                action=action_enum,
                order_delta=delta,
                tick=ticks[t],
                next_tick=ticks[t + 1]
            )

            if fill.filled:
                current_inventory += fill.fill_qty

            # Calculate step reward:
            # R = Price Drift on Inventory - Slippage - Fees - Adverse Selection - Inventory Penalty
            price_change = ticks[t + 1].mid_price - ticks[t].mid_price
            inventory_pnl = current_inventory * price_change
            step_reward = (
                inventory_pnl
                - fill.fee_cost
                - fill.slippage_cost
                - fill.adverse_selection_cost
                - self.inventory_risk_penalty * (current_inventory ** 2)
            )

            # Next observations
            next_a_obs, next_e_obs, next_g_state = self.build_observations(
                ticks, t + 1, current_inventory, current_urgency
            )

            global_states.append(g_state)
            alpha_obs_list.append(a_obs)
            exec_obs_list.append(e_obs)
            alpha_acts.append([alpha_val])
            exec_acts.append([exec_val])
            rewards.append([step_reward])
            next_global_states.append(next_g_state)
            next_alpha_obs_list.append(next_a_obs)
            next_exec_obs_list.append(next_e_obs)
            dones.append([1.0 if t == num_steps - 1 else 0.0])

        return MARLTransitionBatch(
            global_states=torch.tensor(global_states, dtype=torch.float32, device=device),
            alpha_obs=torch.tensor(alpha_obs_list, dtype=torch.float32, device=device),
            exec_obs=torch.tensor(exec_obs_list, dtype=torch.float32, device=device),
            alpha_actions=torch.tensor(alpha_acts, dtype=torch.float32, device=device),
            exec_actions=torch.tensor(exec_acts, dtype=torch.long, device=device),
            rewards=torch.tensor(rewards, dtype=torch.float32, device=device),
            next_global_states=torch.tensor(next_global_states, dtype=torch.float32, device=device),
            next_alpha_obs=torch.tensor(next_alpha_obs_list, dtype=torch.float32, device=device),
            next_exec_obs=torch.tensor(next_exec_obs_list, dtype=torch.float32, device=device),
            dones=torch.tensor(dones, dtype=torch.float32, device=device),
        )
