"""
interfaces.py - Abstract Base Classes and Decoupled Contracts for NiN MARL Architecture.

This module guarantees strict decoupling between feature calculation, neural inference,
centralized critic evaluation, and downstream deterministic execution.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import IntEnum, auto
from typing import Any, Dict, List, Optional, Tuple, Union


class ExecutionAction(IntEnum):
    """Discrete execution routing actions for DecentralizedExecutionActor."""
    IDLE_HOLD = 0           # Do not trade or alter open working queue
    PASSIVE_PEGGED = 1      # Post passive pegged limit order at queue back (maker)
    JOIN_BEST = 2           # Join best bid / best offer (touch)
    AGGRESSIVE_TAKER = 3    # Immediate aggressive market cross (taker)
    CANCEL_REPLACE = 4      # Cancel working stale orders and replace


class ActionSpaceType(IntEnum):
    CONTINUOUS = 1
    DISCRETE = 2


@dataclass(frozen=True)
class ObservationSpaceSpec:
    """Specification of local agent observation space with causality constraints."""
    name: str
    feature_names: List[str]
    dimension: int
    is_causal: bool = True
    lookback_window: int = 1


@dataclass(frozen=True)
class ActionSpaceSpec:
    """Specification of agent action space."""
    action_type: ActionSpaceType
    dimension: int
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    num_discrete_actions: Optional[int] = None


@dataclass
class PreTradeDecision:
    """Atomic decision payload emitted by the state guardrail."""
    approved: bool
    status_code: int
    reason: str
    symbol: str
    current_qty: float
    order_delta: float
    target_alpha: float
    exec_action: ExecutionAction
    timestamp_ms: int
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PortfolioState:
    """Snapshot of portfolio risk state in atomic state fabric."""
    symbol: str
    current_qty: float
    allocated_capital: float
    unrealized_pnl: float
    realized_pnl: float
    margin_utilization: float
    risk_halt: bool
    last_tick_ts: int
    pending_delta: float = 0.0
    last_action_id: int = 0


@dataclass
class OrderResult:
    """Broker / Exchange execution report."""
    order_id: str
    symbol: str
    filled_qty: float
    avg_price: float
    fee_paid: float
    is_maker: bool
    status: str
    latency_ms: float


class BaseLocalActor(ABC):
    """
    Abstract Base Class for Decentralized Local Actors (Inference).
    
    Guarantees:
    - Zero access to Centralized Critic during inference.
    - Consumes strictly local observation histories o_i.
    - Deterministic compilation and export capability.
    """

    @property
    @abstractmethod
    def observation_spec(self) -> ObservationSpaceSpec:
        """Returns the local observation specification."""
        pass

    @property
    @abstractmethod
    def action_spec(self) -> ActionSpaceSpec:
        """Returns the action specification."""
        pass

    @abstractmethod
    def forward(self, local_obs: Any) -> Any:
        """Forward pass emitting raw policy distribution parameters / logits."""
        pass

    @abstractmethod
    def act(self, local_obs: Any, deterministic: bool = True) -> Tuple[Any, Dict[str, Any]]:
        """
        Emits executable action and auxiliary info (e.g. log-probs, entropy).
        When deterministic=True, emits mode/argmax/greedy action for production.
        """
        pass


class BaseCentralizedCritic(ABC):
    """
    Abstract Base Class for Centralized Critic V(s) / Q(s, a).
    
    Observes global unconstrained state during training:
    - Full orderbook depth & iceberg estimates
    - Microstructure latency profile & cross-venue data
    - Aggregate PnL, margin utilization, and systemic risk
    """

    @abstractmethod
    def forward(self, global_state: Any, joint_actions: Any) -> Any:
        """Returns Q-values for global state given joint agent actions."""
        pass

    @abstractmethod
    def evaluate_counterfactuals(
        self,
        global_state: Any,
        joint_actions: Any,
        target_agent_idx: int
    ) -> Any:
        """
        Evaluates Q(s, (a'_i, a_{-i})) across all candidate actions of target agent
        while freezing the actions of all other agents.
        """
        pass


class BaseExecutionEngine(ABC):
    """
    Abstract Base Class for Downstream Broker/Exchange Execution.
    
    Enforces zero-trust execution:
    - Rejects unapproved neural outputs.
    - Dispatches only verified PreTradeDecision payloads.
    """

    @abstractmethod
    async def submit_order(self, decision: PreTradeDecision) -> OrderResult:
        """Dispatches an atomically approved order to the venue."""
        pass

    @abstractmethod
    async def cancel_order(self, symbol: str, order_id: str) -> bool:
        """Cancels a working order."""
        pass

    @abstractmethod
    async def query_portfolio(self, symbol: str) -> PortfolioState:
        """Queries current portfolio position and margin state."""
        pass
