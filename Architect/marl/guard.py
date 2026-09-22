"""
guard.py - Atomic Execution Guardrail for NiN MARL Architecture.

Zero-Trust Execution Barrier:
Ensures NO raw neural outputs ever reach exchange or broker gateways without:
1. Decentralized inference isolation (actors only read local obs).
2. Sub-millisecond pre-trade check via StateBus Lua atomic engine.
3. Position bounds and gross delta clamping.
4. Active circuit breaker and tick staleness validation.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from Architect.marl.interfaces import ExecutionAction, PreTradeDecision
from Architect.marl.state_bus import StateBus

logger = logging.getLogger("NiN.ExecutionGuard")


@dataclass
class RoutedOrder:
    """Dispatched order packet ready for exchange FIX / WebSocket gateway."""
    symbol: str
    action: ExecutionAction
    order_delta: float
    side: str                        # "BUY" | "SELL"
    order_type: str                  # "LIMIT" | "MARKET" | "PEGGED"
    price_target: Optional[float]
    timestamp_ms: int
    intent_id: str


class AtomicExecutionGuard:
    """
    Zero-Trust Execution Gateway.
    
    Translates decentralized neural actor decisions into verified, risk-checked
    executable orders.
    """

    def __init__(
        self,
        state_bus: StateBus,
        max_position: float = 2.0,
        min_deadband: float = 0.001,
        max_staleness_ms: int = 500,
        max_gross_delta: Optional[float] = None
    ):
        self.state_bus = state_bus
        self.max_position = max_position
        self.min_deadband = min_deadband
        self.max_staleness_ms = max_staleness_ms
        self.max_gross_delta = max_gross_delta or (max_position * 1.5)

    async def validate_and_route(
        self,
        symbol: str,
        alpha_conviction: float,
        execution_action: ExecutionAction,
        market_mid_price: float,
        current_tick_ts_ms: Optional[int] = None
    ) -> Tuple[PreTradeDecision, Optional[RoutedOrder]]:
        """
        Validates raw neural outputs through atomic state bus.
        
        If approved, constructs a deterministic `RoutedOrder`.
        If rejected, returns the reject decision and None.
        """
        # 1. Evaluate against atomic Redis/Lua state engine
        decision = await self.state_bus.evaluate_and_lock(
            symbol=symbol,
            target_alpha=alpha_conviction,
            action=execution_action,
            max_position=self.max_position,
            deadband=self.min_deadband,
            current_ts_ms=current_tick_ts_ms,
            max_staleness_ms=self.max_staleness_ms,
            max_gross_delta=self.max_gross_delta
        )

        if not decision.approved or abs(decision.order_delta) < 1e-6:
            logger.debug(
                f"Order rejected or NOOP for {symbol}. Reason: {decision.reason}, "
                f"Status: {decision.status_code}"
            )
            return decision, None

        # 2. Build Deterministic RoutedOrder
        side = "BUY" if decision.order_delta > 0 else "SELL"
        delta_qty = abs(decision.order_delta)

        if decision.exec_action == ExecutionAction.AGGRESSIVE_TAKER:
            order_type = "MARKET"
            price_target = None
        elif decision.exec_action == ExecutionAction.PASSIVE_PEGGED:
            order_type = "PEGGED"
            price_target = market_mid_price
        elif decision.exec_action == ExecutionAction.JOIN_BEST:
            order_type = "LIMIT"
            price_target = market_mid_price
        elif decision.exec_action == ExecutionAction.CANCEL_REPLACE:
            order_type = "CANCEL_REPLACE"
            price_target = market_mid_price
        else:
            return decision, None

        intent_id = f"nin_{symbol}_{decision.timestamp_ms}_{decision.status_code}"
        routed = RoutedOrder(
            symbol=symbol,
            action=decision.exec_action,
            order_delta=decision.order_delta,
            side=side,
            order_type=order_type,
            price_target=price_target,
            timestamp_ms=decision.timestamp_ms,
            intent_id=intent_id
        )

        logger.info(
            f"ORDER DISPATCHED: {side} {delta_qty:.4f} {symbol} "
            f"Type={order_type} Reason={decision.reason}"
        )
        return decision, routed

    async def handle_fill(
        self,
        symbol: str,
        filled_qty: float,
        price: float
    ):
        """Notifies StateBus of an execution fill from the exchange."""
        await self.state_bus.record_fill(symbol, filled_qty, price)

    async def trigger_emergency_stop(self, symbol: str, reason: str):
        """Halts all execution on the symbol immediately."""
        await self.state_bus.trigger_circuit_breaker(symbol, reason)

    async def resume_trading(self, symbol: str):
        """Clears emergency circuit breaker."""
        await self.state_bus.reset_circuit_breaker(symbol)
