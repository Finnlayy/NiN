"""
state_bus.py - Asynchronous StateBus Wrapper & Redis Atomic Guardrail for NiN.

Guarantees:
- Sub-millisecond pre-trade execution checks via compiled Redis Lua SHA scripts.
- Circuit-breaker state management with automatic emergency halt.
- Built-in deterministic fallback engine for offline development and testing.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional, Tuple

try:
    import redis.asyncio as aioredis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False
    aioredis = None

from Architect.marl.interfaces import ExecutionAction, PortfolioState, PreTradeDecision
from Architect.marl.lua_scripts import (
    LUA_ATOMIC_PRE_TRADE_ENGINE,
    LUA_CIRCUIT_BREAKER_TRIGGER,
    LUA_FILL_UPDATE_ENGINE,
)

logger = logging.getLogger("NiN.StateBus")


class InMemoryStateBusEngine:
    """
    Deterministic In-Memory State Fabric replicating Redis Lua logic.
    Used when Redis is not running or during unit testing.
    """

    def __init__(self):
        self.state: Dict[str, Dict[str, Any]] = {}

    def _get_portfolio(self, symbol: str) -> Dict[str, Any]:
        if symbol not in self.state:
            self.state[symbol] = {
                "current_qty": 0.0,
                "allocated_capital": 100000.0,
                "risk_halt": 0,
                "last_tick_ts": 0,
                "margin_headroom": 1.0,
                "pending_delta": 0.0,
                "last_action_id": 0,
                "target_position": 0.0,
                "realized_pnl": 0.0,
                "unrealized_pnl": 0.0
            }
        return self.state[symbol]

    def evaluate_pre_trade(
        self,
        symbol: str,
        target_alpha: float,
        exec_action: int,
        max_pos: float,
        deadband: float,
        current_ts: int,
        max_staleness: int,
        max_gross_delta: float
    ) -> Tuple[int, str, float, float, int, int]:
        port = self._get_portfolio(symbol)

        current_qty = float(port["current_qty"])
        risk_halt = int(port["risk_halt"])
        last_ts = int(port["last_tick_ts"])
        margin_headroom = float(port["margin_headroom"])

        # 1. Staleness & Monotonicity
        if last_ts > 0:
            if current_ts < last_ts:
                return -10, "REJECT_OUT_OF_ORDER_TIMESTAMP", current_qty, 0.0, exec_action, current_ts
            if (current_ts - last_ts) > max_staleness:
                return -1, "REJECT_STALE_MARKET_TICK", current_qty, 0.0, exec_action, current_ts

        # 2. Circuit Breaker
        if risk_halt == 1:
            return -2, "REJECT_CIRCUIT_BREAKER_ACTIVE", current_qty, 0.0, exec_action, current_ts

        # 3. Margin Headroom
        if margin_headroom < 0.05:
            return -3, "REJECT_INSUFFICIENT_MARGIN_HEADROOM", current_qty, 0.0, exec_action, current_ts

        # 4. Bounds Clamping
        target_alpha = max(-1.0, min(1.0, float(target_alpha)))
        target_pos = target_alpha * max_pos

        # 5. Delta & Gross limit
        delta = target_pos - current_qty
        if abs(delta) > max_gross_delta:
            delta = max_gross_delta if delta > 0 else -max_gross_delta

        # 6. Deadband & Hold
        if abs(delta) < deadband or exec_action == 0:
            port["last_tick_ts"] = current_ts
            return 0, "NOOP_DEADBAND_OR_HOLD", current_qty, 0.0, exec_action, current_ts

        # 7. Atomic Commit
        port["pending_delta"] = delta
        port["last_action_id"] = exec_action
        port["last_tick_ts"] = current_ts
        port["target_position"] = target_pos

        return 1, "APPROVED_FOR_DISPATCH", current_qty, delta, exec_action, current_ts

    def trigger_halt(self, symbol: str, halt: bool, reason: str, ts: int):
        port = self._get_portfolio(symbol)
        port["risk_halt"] = 1 if halt else 0
        port["halt_reason"] = reason
        port["halt_ts"] = ts
        port["pending_delta"] = 0.0

    def record_fill(self, symbol: str, filled_qty: float, price: float, ts: int):
        port = self._get_portfolio(symbol)
        port["current_qty"] += filled_qty
        port["pending_delta"] = 0.0
        port["last_fill_price"] = price
        port["last_fill_ts"] = ts


class StateBus:
    """
    Production-ready Async StateBus client.
    Manages Redis connection pooling, Lua script pre-compilation (SHA caching),
    and automatic failover to the in-memory engine when operating standalone.
    """

    def __init__(
        self,
        redis_url: Optional[str] = "redis://localhost:6379/0",
        use_fallback: bool = True
    ):
        self.redis_url = redis_url
        self.use_fallback = use_fallback
        self.client: Optional[Any] = None
        self._sha_pre_trade: Optional[str] = None
        self._sha_halt: Optional[str] = None
        self._sha_fill: Optional[str] = None
        self.fallback_engine = InMemoryStateBusEngine()
        self._is_connected_to_redis = False

    async def connect(self):
        """Attempts connection to Redis; falls back to in-memory engine if unavailable."""
        if HAS_REDIS and self.redis_url:
            try:
                self.client = aioredis.from_url(
                    self.redis_url, encoding="utf-8", decode_responses=True
                )
                # Test ping
                await self.client.ping()
                # Pre-load and cache Lua scripts
                self._sha_pre_trade = await self.client.script_load(LUA_ATOMIC_PRE_TRADE_ENGINE)
                self._sha_halt = await self.client.script_load(LUA_CIRCUIT_BREAKER_TRIGGER)
                self._sha_fill = await self.client.script_load(LUA_FILL_UPDATE_ENGINE)
                self._is_connected_to_redis = True
                logger.info(f"StateBus connected to Redis. Pre-Trade SHA: {self._sha_pre_trade}")
                return
            except Exception as e:
                logger.warning(f"Failed to connect to Redis ({e}). Activating in-memory fallback.")
                self.client = None
                self._is_connected_to_redis = False

        if not self.use_fallback:
            raise RuntimeError("Redis connection failed and use_fallback is False.")
        logger.info("StateBus initialized with in-memory deterministic state engine.")

    async def close(self):
        if self.client:
            await self.client.close()

    async def evaluate_and_lock(
        self,
        symbol: str,
        target_alpha: float,
        action: ExecutionAction,
        max_position: float = 2.0,
        deadband: float = 0.001,
        current_ts_ms: Optional[int] = None,
        max_staleness_ms: int = 500,
        max_gross_delta: Optional[float] = None
    ) -> PreTradeDecision:
        """
        Submits (target_alpha, execution_action) to atomic pre-trade check.
        Returns immutable PreTradeDecision.
        """
        now_ms = current_ts_ms if current_ts_ms is not None else int(time.time() * 1000)
        gross_delta = max_gross_delta if max_gross_delta is not None else (max_position * 1.5)
        action_id = int(action)

        if self._is_connected_to_redis and self.client and self._sha_pre_trade:
            key = f"portfolio:{symbol}"
            try:
                raw_res = await self.client.evalsha(
                    self._sha_pre_trade,
                    1,
                    key,
                    float(target_alpha),
                    action_id,
                    float(max_position),
                    float(deadband),
                    now_ms,
                    max_staleness_ms,
                    float(gross_delta)
                )
                code = int(raw_res[0])
                msg = str(raw_res[1])
                curr_qty = float(raw_res[2])
                delta = float(raw_res[3])
                act_ret = int(raw_res[4]) if len(raw_res) > 4 else action_id
            except Exception as e:
                logger.error(f"Redis evalsha error ({e}). Using in-memory fallback.")
                code, msg, curr_qty, delta, act_ret, _ = self.fallback_engine.evaluate_pre_trade(
                    symbol, target_alpha, action_id, max_position, deadband,
                    now_ms, max_staleness_ms, gross_delta
                )
        else:
            code, msg, curr_qty, delta, act_ret, _ = self.fallback_engine.evaluate_pre_trade(
                symbol, target_alpha, action_id, max_position, deadband,
                now_ms, max_staleness_ms, gross_delta
            )

        approved = (code == 1)
        return PreTradeDecision(
            approved=approved,
            status_code=code,
            reason=msg,
            symbol=symbol,
            current_qty=curr_qty,
            order_delta=delta,
            target_alpha=target_alpha,
            exec_action=ExecutionAction(act_ret),
            timestamp_ms=now_ms
        )

    async def trigger_circuit_breaker(self, symbol: str, reason: str):
        """Emergency circuit breaker halt."""
        now_ms = int(time.time() * 1000)
        logger.critical(f"EMERGENCY CIRCUIT BREAKER for {symbol}: {reason}")
        if self._is_connected_to_redis and self.client and self._sha_halt:
            try:
                await self.client.evalsha(
                    self._sha_halt, 1, f"portfolio:{symbol}", 1, reason, now_ms
                )
                return
            except Exception as e:
                logger.error(f"Redis halt evalsha error ({e}).")
        self.fallback_engine.trigger_halt(symbol, True, reason, now_ms)

    async def reset_circuit_breaker(self, symbol: str):
        """Resumes trading after circuit breaker inspection."""
        now_ms = int(time.time() * 1000)
        logger.info(f"Resetting circuit breaker for {symbol}")
        if self._is_connected_to_redis and self.client and self._sha_halt:
            try:
                await self.client.evalsha(
                    self._sha_halt, 1, f"portfolio:{symbol}", 0, "MANUAL_RESET", now_ms
                )
                return
            except Exception as e:
                logger.error(f"Redis reset evalsha error ({e}).")
        self.fallback_engine.trigger_halt(symbol, False, "MANUAL_RESET", now_ms)

    async def record_fill(self, symbol: str, filled_qty: float, price: float):
        """Updates portfolio state following an order fill."""
        now_ms = int(time.time() * 1000)
        if self._is_connected_to_redis and self.client and self._sha_fill:
            try:
                await self.client.evalsha(
                    self._sha_fill, 1, f"portfolio:{symbol}", filled_qty, price, 0.0, now_ms
                )
                return
            except Exception as e:
                logger.error(f"Redis record fill error ({e}).")
        self.fallback_engine.record_fill(symbol, filled_qty, price, now_ms)

    async def get_portfolio_state(self, symbol: str) -> PortfolioState:
        """Reads current portfolio state."""
        if self._is_connected_to_redis and self.client:
            try:
                raw = await self.client.hgetall(f"portfolio:{symbol}")
                return PortfolioState(
                    symbol=symbol,
                    current_qty=float(raw.get("current_qty", 0.0)),
                    allocated_capital=float(raw.get("allocated_capital", 100000.0)),
                    unrealized_pnl=float(raw.get("unrealized_pnl", 0.0)),
                    realized_pnl=float(raw.get("realized_pnl", 0.0)),
                    margin_utilization=1.0 - float(raw.get("margin_headroom", 1.0)),
                    risk_halt=bool(int(raw.get("risk_halt", 0))),
                    last_tick_ts=int(raw.get("last_tick_ts", 0)),
                    pending_delta=float(raw.get("pending_delta", 0.0)),
                    last_action_id=int(raw.get("last_action_id", 0))
                )
            except Exception as e:
                logger.error(f"Redis get portfolio state error ({e}).")

        raw = self.fallback_engine._get_portfolio(symbol)
        return PortfolioState(
            symbol=symbol,
            current_qty=float(raw.get("current_qty", 0.0)),
            allocated_capital=float(raw.get("allocated_capital", 100000.0)),
            unrealized_pnl=float(raw.get("unrealized_pnl", 0.0)),
            realized_pnl=float(raw.get("realized_pnl", 0.0)),
            margin_utilization=1.0 - float(raw.get("margin_headroom", 1.0)),
            risk_halt=bool(raw.get("risk_halt", 0)),
            last_tick_ts=int(raw.get("last_tick_ts", 0)),
            pending_delta=float(raw.get("pending_delta", 0.0)),
            last_action_id=int(raw.get("last_action_id", 0))
        )
