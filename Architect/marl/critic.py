"""
critic.py - Centralized Critic Architecture for NiN MARL CTDE Framework.

During Centralized Training with Decentralized Execution (CTDE):
- The Centralized Critic observes the unconstrained global market state:
  Full L2/L3 orderbook depth, cross-exchange liquidity, aggregate portfolio PnL,
  true latency variance, margin utilization, and systemic risk metrics.
- Provides counterfactual Q-evaluations separating directional signal quality
  from microstructure execution slippage.
"""
from __future__ import annotations

from typing import Any, List, Optional, Tuple

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    torch = None
    nn = object
    F = None

from Architect.marl.interfaces import BaseCentralizedCritic


class CentralizedExecutionCritic(nn.Module if HAS_TORCH else BaseCentralizedCritic):
    """
    Centralized Critic for Execution Agent (Agent 2).
    
    Inputs:
    - global_state: Unconstrained system state (dim = global_state_dim)
    - alpha_action: Continuous conviction signal from Alpha Agent [-1.0, 1.0] (dim = 1)
    
    Outputs:
    - Vector of Q-values for ALL discrete execution actions:
      Q(s, a_alpha, a'_exec) for a'_exec in {0, 1, 2, 3, 4}
      Shape: [batch_size, num_exec_actions]
      
    This enables computing the exact COMA counterfactual baseline in a single forward pass:
      b(s, a_alpha) = sum_{a'_exec} pi(a'_exec | o_exec) * Q(s, a_alpha, a'_exec)
    """

    def __init__(
        self,
        global_state_dim: int = 32,
        alpha_action_dim: int = 1,
        num_exec_actions: int = 5,
        hidden_dim: int = 256
    ):
        if HAS_TORCH:
            super().__init__()
        self.global_state_dim = global_state_dim
        self.alpha_action_dim = alpha_action_dim
        self.num_exec_actions = num_exec_actions

        if HAS_TORCH:
            input_dim = global_state_dim + alpha_action_dim
            self.net = nn.Sequential(
                nn.Linear(input_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Linear(hidden_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Linear(hidden_dim, num_exec_actions)
            )
        else:
            self.net = None

    def forward(self, global_state: Any, alpha_action: Any) -> Any:
        """
        Returns Q-values for all discrete execution actions.
        Output shape: [batch_size, num_exec_actions]
        """
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for Critic.")
        x = torch.cat([global_state, alpha_action], dim=-1)
        return self.net(x)

    def evaluate_counterfactuals(
        self,
        global_state: Any,
        joint_actions: Any,
        target_agent_idx: int = 1
    ) -> Any:
        """Returns Q-values across all discrete actions for agent 1 (Execution)."""
        alpha_action = joint_actions[0]
        return self.forward(global_state, alpha_action)


class CentralizedAlphaCritic(nn.Module if HAS_TORCH else BaseCentralizedCritic):
    """
    Centralized Critic for Alpha Agent (Agent 1).
    
    Inputs:
    - global_state: Unconstrained system state (dim = global_state_dim)
    - exec_action_onehot: One-hot encoded action of Execution Agent (dim = 5)
    - alpha_action: Continuous conviction candidate [-1.0, 1.0] (dim = 1)
    
    Outputs:
    - Scalar Q-value: Q(s, (a_alpha, a_exec))
      Shape: [batch_size, 1]
    """

    def __init__(
        self,
        global_state_dim: int = 32,
        exec_action_dim: int = 5,
        alpha_action_dim: int = 1,
        hidden_dim: int = 256
    ):
        if HAS_TORCH:
            super().__init__()
        self.global_state_dim = global_state_dim
        self.exec_action_dim = exec_action_dim
        self.alpha_action_dim = alpha_action_dim

        if HAS_TORCH:
            input_dim = global_state_dim + exec_action_dim + alpha_action_dim
            self.net = nn.Sequential(
                nn.Linear(input_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Linear(hidden_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Linear(hidden_dim, 1)
            )
        else:
            self.net = None

    def forward(self, global_state: Any, exec_action_onehot: Any, alpha_action: Any) -> Any:
        """
        Returns scalar Q-value for joint continuous alpha + discrete exec action.
        Output shape: [batch_size, 1]
        """
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for Critic.")
        x = torch.cat([global_state, exec_action_onehot, alpha_action], dim=-1)
        return self.net(x)

    def evaluate_counterfactuals(
        self,
        global_state: Any,
        joint_actions: Any,
        target_agent_idx: int = 0,
        num_counterfactual_samples: int = 5
    ) -> Any:
        """
        For continuous Alpha agent, samples counterfactual actions uniformly in [-1, 1]
        or across a discrete conviction grid {-1.0, -0.5, 0.0, 0.5, 1.0}.
        """
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for Critic.")
        exec_action_onehot = joint_actions[1]
        batch_size = global_state.shape[0]

        # Grid of counterfactual convictions: [-1.0, -0.5, 0.0, 0.5, 1.0]
        grid = torch.linspace(-1.0, 1.0, num_counterfactual_samples, device=global_state.device)
        cf_q_vals = []
        for val in grid:
            cf_alpha = val.expand(batch_size, 1)
            q_val = self.forward(global_state, exec_action_onehot, cf_alpha)
            cf_q_vals.append(q_val)

        # Shape: [batch_size, num_counterfactual_samples]
        return torch.cat(cf_q_vals, dim=-1)


class CentralizedJointCritic(nn.Module if HAS_TORCH else BaseCentralizedCritic):
    """
    Combined CTDE Critic holding both the execution-specific Q-function
    and the alpha Q-function with synchronized target networks.
    """

    def __init__(
        self,
        global_state_dim: int = 32,
        alpha_action_dim: int = 1,
        num_exec_actions: int = 5,
        hidden_dim: int = 256
    ):
        if HAS_TORCH:
            super().__init__()
            self.exec_critic = CentralizedExecutionCritic(
                global_state_dim, alpha_action_dim, num_exec_actions, hidden_dim
            )
            self.alpha_critic = CentralizedAlphaCritic(
                global_state_dim, num_exec_actions, alpha_action_dim, hidden_dim
            )
            # State Value baseline estimator V(s)
            self.v_net = nn.Sequential(
                nn.Linear(global_state_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Linear(hidden_dim, 1)
            )
        else:
            self.exec_critic = None
            self.alpha_critic = None
            self.v_net = None

    def get_state_value(self, global_state: Any) -> Any:
        """Returns baseline unconstrained state value V(s)."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required.")
        return self.v_net(global_state)

    def forward(self, global_state: Any, joint_actions: Any) -> Any:
        alpha_act, exec_onehot = joint_actions[0], joint_actions[1]
        q_alpha = self.alpha_critic(global_state, exec_onehot, alpha_act)
        q_exec_all = self.exec_critic(global_state, alpha_act)
        return q_alpha, q_exec_all

    def evaluate_counterfactuals(
        self,
        global_state: Any,
        joint_actions: Any,
        target_agent_idx: int
    ) -> Any:
        if target_agent_idx == 1:
            return self.exec_critic(global_state, joint_actions[0])
        else:
            return self.alpha_critic.evaluate_counterfactuals(global_state, joint_actions, target_agent_idx=0)
