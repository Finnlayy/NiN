"""
actors.py - Decentralized Actor Implementations for NiN MARL Architecture.

Contains:
1. DecentralizedAlphaActor: Continuous directional conviction [-1.0, 1.0].
2. DecentralizedExecutionActor: Discrete execution action selector (5 actions).
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.distributions import Normal, Categorical
    HAS_TORCH = True
except ImportError:
    # Graceful fallback for environments where torch is dynamically imported
    HAS_TORCH = False
    torch = None
    nn = object
    F = None

from Architect.marl.interfaces import (
    ActionSpaceSpec,
    ActionSpaceType,
    BaseLocalActor,
    ExecutionAction,
    ObservationSpaceSpec,
)


class DecentralizedAlphaActor(nn.Module if HAS_TORCH else BaseLocalActor):
    """
    Alpha / Conviction Agent (Actor 1).
    
    Consumes: Normalized L2/L3 order flow imbalance, micro-price drift,
              momentum oscillators, and local volume volatility.
    Outputs: Continuous directional conviction signal in [-1.0, 1.0].
             (-1.0 = Max Short conviction, +1.0 = Max Long conviction, 0.0 = Flat).
    """

    def __init__(
        self,
        obs_dim: int = 16,
        hidden_dim: int = 128,
        init_log_std: float = -0.5
    ):
        if HAS_TORCH:
            super().__init__()
        self._obs_dim = obs_dim
        self._action_dim = 1

        self._obs_spec = ObservationSpaceSpec(
            name="AlphaObservation",
            feature_names=[
                "obi_level_1", "obi_level_5", "micro_price_drift", "trade_flow_imbalance",
                "volatility_ratio", "spread_bps", "vwap_skew", "order_arrival_skew",
                "depth_pressure_bid", "depth_pressure_ask", "rsi_momentum", "macd_signal",
                "volume_zscore", "cancel_ratio_bid", "cancel_ratio_ask", "inventory_ratio"
            ][:obs_dim],
            dimension=obs_dim,
            is_causal=True
        )

        self._act_spec = ActionSpaceSpec(
            action_type=ActionSpaceType.CONTINUOUS,
            dimension=1,
            min_value=-1.0,
            max_value=1.0
        )

        if HAS_TORCH:
            self.backbone = nn.Sequential(
                nn.Linear(obs_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.LeakyReLU(0.01),
                nn.Linear(hidden_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.LeakyReLU(0.01),
            )
            self.mu_head = nn.Linear(hidden_dim, 1)
            # Log standard deviation parameter for training exploration
            self.log_std = nn.Parameter(torch.full((1,), init_log_std))
        else:
            self.backbone = None

    @property
    def observation_spec(self) -> ObservationSpaceSpec:
        return self._obs_spec

    @property
    def action_spec(self) -> ActionSpaceSpec:
        return self._act_spec

    def forward(self, local_obs: Any) -> Any:
        """Forward pass emitting deterministic conviction mu in [-1.0, 1.0]."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for neural forward pass.")
        features = self.backbone(local_obs)
        raw_mu = self.mu_head(features)
        # Tanh guarantees strict [-1.0, 1.0] conviction bounds
        return torch.tanh(raw_mu)

    def get_distribution(self, local_obs: Any) -> Any:
        """Returns Normal distribution over pre-tanh action for training."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for distribution pass.")
        features = self.backbone(local_obs)
        mu = self.mu_head(features)
        std = self.log_std.exp().expand_as(mu)
        return Normal(mu, std)

    def act(self, local_obs: Any, deterministic: bool = True) -> Tuple[Any, Dict[str, Any]]:
        """
        Emits action value [-1.0, 1.0] and metadata.
        Deterministic=True uses exact tanh(mu) mode.
        Deterministic=False samples from Gaussian with squashing.
        """
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for act().")

        if deterministic:
            action = self.forward(local_obs)
            return action, {"deterministic": True}

        dist = self.get_distribution(local_obs)
        pre_tanh = dist.rsample()
        action = torch.tanh(pre_tanh)
        
        # Enforce numerical stability in log-prob correction for tanh squashing
        log_prob = dist.log_prob(pre_tanh) - torch.log(1.0 - action.pow(2) + 1e-6)
        log_prob = log_prob.sum(dim=-1, keepdim=True)

        return action, {
            "log_prob": log_prob,
            "entropy": dist.entropy().sum(dim=-1, keepdim=True),
            "deterministic": False
        }


class DecentralizedExecutionActor(nn.Module if HAS_TORCH else BaseLocalActor):
    """
    Execution / Router Agent (Actor 2).
    
    Consumes: Queue dynamics, spread tick distribution, alpha urgency,
              current inventory error, and venue latency.
    Outputs: Discrete execution action in {0, 1, 2, 3, 4}:
             0 = IDLE_HOLD
             1 = PASSIVE_PEGGED (Maker)
             2 = JOIN_BEST (Touch)
             3 = AGGRESSIVE_TAKER (Taker Cross)
             4 = CANCEL_REPLACE
    """

    def __init__(
        self,
        obs_dim: int = 12,
        hidden_dim: int = 128,
        num_actions: int = 5
    ):
        if HAS_TORCH:
            super().__init__()
        self._obs_dim = obs_dim
        self._action_dim = num_actions

        self._obs_spec = ObservationSpaceSpec(
            name="ExecutionObservation",
            feature_names=[
                "bid_queue_size", "ask_queue_size", "spread_ticks", "alpha_urgency",
                "inventory_error", "fill_probability_maker", "cancel_rate_touch",
                "effective_spread", "latency_jitter_ms", "slippage_expectation",
                "adverse_selection_risk", "open_orders_count"
            ][:obs_dim],
            dimension=obs_dim,
            is_causal=True
        )

        self._act_spec = ActionSpaceSpec(
            action_type=ActionSpaceType.DISCRETE,
            dimension=1,
            num_discrete_actions=num_actions
        )

        if HAS_TORCH:
            self.net = nn.Sequential(
                nn.Linear(obs_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.LeakyReLU(0.01),
                nn.Linear(hidden_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.LeakyReLU(0.01),
                nn.Linear(hidden_dim, num_actions)
            )
        else:
            self.net = None

    @property
    def observation_spec(self) -> ObservationSpaceSpec:
        return self._obs_spec

    @property
    def action_spec(self) -> ActionSpaceSpec:
        return self._act_spec

    def forward(self, local_obs: Any) -> Any:
        """Forward pass emitting unnormalized action logits."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for neural forward pass.")
        return self.net(local_obs)

    def get_action_probs(self, local_obs: Any) -> Any:
        """Returns softmax action probabilities pi(a | o_2)."""
        logits = self.forward(local_obs)
        return F.softmax(logits, dim=-1)

    def act(self, local_obs: Any, deterministic: bool = True) -> Tuple[Any, Dict[str, Any]]:
        """
        Selects discrete execution action (ExecutionAction).
        When deterministic=True, emits argmax(logits).
        When deterministic=False, samples from categorical distribution.
        """
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for act().")

        logits = self.forward(local_obs)
        probs = F.softmax(logits, dim=-1)

        if deterministic:
            action = torch.argmax(probs, dim=-1, keepdim=True)
            return action, {"probs": probs, "deterministic": True}

        dist = Categorical(probs=probs)
        action = dist.sample().unsqueeze(-1)
        log_prob = dist.log_prob(action.squeeze(-1)).unsqueeze(-1)

        return action, {
            "probs": probs,
            "log_prob": log_prob,
            "entropy": dist.entropy().unsqueeze(-1),
            "deterministic": False
        }
