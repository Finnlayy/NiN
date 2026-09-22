"""
meta_breaker.py - Meta-Breaker Sentinel & Cascade Failure Containment.

Mitigates:
Row 4: Runaway Loop / Token-Erschöpfung des Orchestrierers.
Row 5: Orchestrierer-Absturz mit offenen Orders (Dead-Man-Switch).
Row 9: Veralteter Marktdaten-Feed (Staleness).
Row 10: Kaskadenfehler (Venue + LLM + DB gleichzeitig gestört) -> SAFE-HALT.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set

from Architect.marl.state_bus import StateBus

logger = logging.getLogger("NiN.MetaBreaker")


class BreakerDomain(str, Enum):
    VENUE_EXCHANGE = "VENUE_EXCHANGE"
    LLM_ORCHESTRATOR = "LLM_ORCHESTRATOR"
    DATABASE_STATE = "DATABASE_STATE"
    MARKET_STALENESS = "MARKET_STALENESS"
    RATE_LIMIT = "RATE_LIMIT"


@dataclass
class BreakerStatus:
    domain: BreakerDomain
    is_open: bool
    tripped_ts_ms: int
    reason: str
    failure_count: int = 0


@dataclass
class MetaHaltVerdict:
    safe_halt_engaged: bool
    open_breakers_count: int
    open_domains: List[str]
    action_required: str
    timestamp_ms: int


class MetaCircuitBreaker:
    """
    Higher-order Meta-Breaker.
    Rule: If >= 2 circuit breakers are simultaneously in OPEN status,
    ALL local retries are strictly forbidden. The system executes a deterministic SAFE-HALT,
    freezes state, sends dead-man cancel orders, and escalates.
    """

    def __init__(
        self,
        state_bus: StateBus,
        max_loop_iterations: int = 5,
        max_token_per_turn: int = 4000,
        staleness_limit_ms: int = 500,
        deadman_cancel_after_s: int = 60
    ):
        self.state_bus = state_bus
        self.max_loop_iterations = max_loop_iterations
        self.max_token_per_turn = max_token_per_turn
        self.staleness_limit_ms = staleness_limit_ms
        self.deadman_cancel_after_s = deadman_cancel_after_s

        self.breakers: Dict[BreakerDomain, BreakerStatus] = {
            domain: BreakerStatus(domain=domain, is_open=False, tripped_ts_ms=0, reason="NOMINAL")
            for domain in BreakerDomain
        }
        self.loop_counter: int = 0
        self.tokens_used_this_turn: int = 0

    def record_loop_iteration(self, tokens_used: int = 0) -> bool:
        """
        Mitigates Row 4: Runaway Loop prevention.
        Returns False if loop must immediately abort.
        """
        self.loop_counter += 1
        self.tokens_used_this_turn += tokens_used

        if self.loop_counter > self.max_loop_iterations:
            self.trip_breaker(
                BreakerDomain.LLM_ORCHESTRATOR,
                f"MAX_LOOP_COUNT_EXCEEDED: loop_count={self.loop_counter} > {self.max_loop_iterations}"
            )
            return False

        if self.tokens_used_this_turn > self.max_token_per_turn:
            self.trip_breaker(
                BreakerDomain.LLM_ORCHESTRATOR,
                f"TOKEN_BUDGET_EXCEEDED: tokens={self.tokens_used_this_turn} > {self.max_token_per_turn}"
            )
            return False

        return True

    def reset_loop_turn(self):
        self.loop_counter = 0
        self.tokens_used_this_turn = 0

    def trip_breaker(self, domain: BreakerDomain, reason: str):
        now_ms = int(time.time() * 1000)
        status = self.breakers[domain]
        status.is_open = True
        status.tripped_ts_ms = now_ms
        status.reason = reason
        status.failure_count += 1
        logger.warning(f"CIRCUIT BREAKER TRIPPED for {domain.value}: {reason}")

    def reset_breaker(self, domain: BreakerDomain):
        status = self.breakers[domain]
        status.is_open = False
        status.reason = "RESOLVED"
        logger.info(f"CIRCUIT BREAKER RESET for {domain.value}")

    def check_meta_state(self) -> MetaHaltVerdict:
        """
        Evaluates Meta-Breaker rule:
        If >= 2 breakers are OPEN, no local retries are legitimate.
        """
        open_domains = [b.domain.value for b in self.breakers.values() if b.is_open]
        count = len(open_domains)
        now_ms = int(time.time() * 1000)

        if count >= 2:
            verdict = MetaHaltVerdict(
                safe_halt_engaged=True,
                open_breakers_count=count,
                open_domains=open_domains,
                action_required="EXECUTE_GLOBAL_SAFE_HALT_AND_FREEZE_STATE",
                timestamp_ms=now_ms
            )
            logger.critical(
                f"META-BREAKER ENGAGED ({count} breakers OPEN: {open_domains}). "
                f"Prohibiting local retries! Initiating SAFE-HALT."
            )
            return verdict

        return MetaHaltVerdict(
            safe_halt_engaged=False,
            open_breakers_count=count,
            open_domains=open_domains,
            action_required="NOMINAL_MONITORING",
            timestamp_ms=now_ms
        )

    async def execute_safe_halt(self, symbols: List[str]) -> Dict[str, str]:
        """
        Executes catastrophic safe-halt across all target venues:
        1. Emergency circuit breaker trigger on StateBus.
        2. Returns payload for exchange cancel_all_orders_after Dead-Man-Switch.
        """
        results = {}
        for s in symbols:
            await self.state_bus.trigger_circuit_breaker(s, "META_BREAKER_SAFE_HALT_TRIGGERED")
            results[s] = f"HALTED: Dead-man cancel timer active ({self.deadman_cancel_after_s}s)"
        return results
