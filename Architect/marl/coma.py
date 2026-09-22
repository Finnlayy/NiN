"""
coma.py - Counterfactual Multi-Agent (COMA) Advantage Estimation & Trainer.

Implements:
1. Exact discrete counterfactual baseline for Execution Agent:
   A_exec(s, (a_alpha, a_exec)) = Q(s, (a_alpha, a_exec)) - sum_{a'} pi(a'|o_exec) * Q(s, (a_alpha, a'))
2. Advantage estimation for Alpha Agent separating signal alpha error from execution slippage:
   A_alpha(s, (a_alpha, a_exec)) = Q(s, (a_alpha, a_exec)) - V(s)
3. Full vectorized training loop with target network synchronization, TD(0) / GAE targets,
   and gradient clipping.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

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

from Architect.marl.actors import DecentralizedAlphaActor, DecentralizedExecutionActor
from Architect.marl.critic import CentralizedJointCritic


@dataclass
class MARLTransitionBatch:
    """Vectorized transition batch from rollouts."""
    global_states: Any              # [batch, global_state_dim]
    alpha_obs: Any                  # [batch, alpha_obs_dim]
    exec_obs: Any                   # [batch, exec_obs_dim]
    alpha_actions: Any              # [batch, 1] (Continuous conviction in [-1, 1])
    exec_actions: Any               # [batch, 1] (Discrete action index 0..4)
    rewards: Any                    # [batch, 1] (Joint PnL & microstructure reward)
    next_global_states: Any         # [batch, global_state_dim]
    next_alpha_obs: Any             # [batch, alpha_obs_dim]
    next_exec_obs: Any              # [batch, exec_obs_dim]
    dones: Any                      # [batch, 1] (Boolean / float 0.0 or 1.0)


class COMATrainer:
    """
    COMA Multi-Agent Trainer implementing Centralized Training with Decentralized Execution.
    """

    def __init__(
        self,
        alpha_actor: DecentralizedAlphaActor,
        exec_actor: DecentralizedExecutionActor,
        joint_critic: CentralizedJointCritic,
        gamma: float = 0.99,
        lr_actor: float = 3e-4,
        lr_critic: float = 1e-3,
        entropy_coef_alpha: float = 0.005,
        entropy_coef_exec: float = 0.01,
        max_grad_norm: float = 0.5,
        target_update_interval: int = 150,
        tau: float = 0.01
    ):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required for COMATrainer.")

        self.alpha_actor = alpha_actor
        self.exec_actor = exec_actor
        self.joint_critic = joint_critic

        self.gamma = gamma
        self.entropy_coef_alpha = entropy_coef_alpha
        self.entropy_coef_exec = entropy_coef_exec
        self.max_grad_norm = max_grad_norm
        self.target_update_interval = target_update_interval
        self.tau = tau
        self.train_step = 0

        # Create target critic
        self.target_joint_critic = CentralizedJointCritic(
            global_state_dim=joint_critic.exec_critic.global_state_dim,
            alpha_action_dim=joint_critic.exec_critic.alpha_action_dim,
            num_exec_actions=joint_critic.exec_critic.num_exec_actions,
            hidden_dim=256
        )
        self.target_joint_critic.load_state_dict(self.joint_critic.state_dict())

        # Optimizers
        self.alpha_optimizer = torch.optim.Adam(self.alpha_actor.parameters(), lr=lr_actor)
        self.exec_optimizer = torch.optim.Adam(self.exec_actor.parameters(), lr=lr_actor)
        self.critic_optimizer = torch.optim.Adam(self.joint_critic.parameters(), lr=lr_critic)

    def _soft_update_targets(self):
        """Polyak averaging target update."""
        for target_p, p in zip(self.target_joint_critic.parameters(), self.joint_critic.parameters()):
            target_p.data.copy_(self.tau * p.data + (1.0 - self.tau) * target_p.data)

    def compute_coma_advantages(
        self,
        batch: MARLTransitionBatch
    ) -> Tuple[Any, Any]:
        """
        Computes counterfactual advantages for both actors.
        
        For Execution Actor (Discrete):
          b_exec(s, a_alpha) = sum_{a'} pi(a' | o_exec) * Q_exec(s, a_alpha, a')
          A_exec = Q_exec(s, a_alpha, a_exec) - b_exec
          
        For Alpha Actor (Continuous):
          b_alpha(s) = V(s)
          A_alpha = Q_alpha(s, a_exec_onehot, a_alpha) - V(s)
        """
        with torch.no_grad():
            # 1. Execution Agent Counterfactual Baseline
            exec_probs = self.exec_actor.get_action_probs(batch.exec_obs) # [batch, 5]
            q_exec_all = self.joint_critic.exec_critic(batch.global_states, batch.alpha_actions) # [batch, 5]

            # Selected Q-value: Q(s, a_alpha, a_exec)
            q_exec_chosen = q_exec_all.gather(1, batch.exec_actions) # [batch, 1]

            # Counterfactual expectation under current policy:
            baseline_exec = (exec_probs * q_exec_all).sum(dim=-1, keepdim=True) # [batch, 1]
            advantage_exec = q_exec_chosen - baseline_exec

            # 2. Alpha Agent Baseline
            exec_onehot = F.one_hot(batch.exec_actions.squeeze(-1), num_classes=5).float()
            q_alpha = self.joint_critic.alpha_critic(batch.global_states, exec_onehot, batch.alpha_actions)
            v_state = self.joint_critic.get_state_value(batch.global_states)
            advantage_alpha = q_alpha - v_state

        return advantage_alpha, advantage_exec

    def train_step_batch(self, batch: MARLTransitionBatch) -> Dict[str, float]:
        """Runs a complete training step on the given transition batch."""
        if not HAS_TORCH:
            raise RuntimeError("PyTorch is required.")

        exec_onehot = F.one_hot(batch.exec_actions.squeeze(-1), num_classes=5).float()

        # =====================================================================
        # 1. CRITIC LOSS & TD UPDATE
        # =====================================================================
        # Current Q-values
        q_alpha, q_exec_all = self.joint_critic(
            batch.global_states, (batch.alpha_actions, exec_onehot)
        )
        q_exec_chosen = q_exec_all.gather(1, batch.exec_actions)
        v_current = self.joint_critic.get_state_value(batch.global_states)

        # Target Q-values using Target Critic & next state actions
        with torch.no_grad():
            next_alpha_act, _ = self.alpha_actor.act(batch.next_alpha_obs, deterministic=True)
            next_exec_probs = self.exec_actor.get_action_probs(batch.next_exec_obs)
            next_q_exec_all = self.target_joint_critic.exec_critic(
                batch.next_global_states, next_alpha_act
            )
            # Expected Q under next policy
            next_v_exec = (next_exec_probs * next_q_exec_all).sum(dim=-1, keepdim=True)
            target_q = batch.rewards + (1.0 - batch.dones) * self.gamma * next_v_exec

        loss_q_exec = F.mse_loss(q_exec_chosen, target_q)
        loss_q_alpha = F.mse_loss(q_alpha, target_q)
        loss_v = F.mse_loss(v_current, target_q)
        critic_loss = loss_q_exec + loss_q_alpha + 0.5 * loss_v

        self.critic_optimizer.zero_grad()
        critic_loss.backward()
        nn.utils.clip_grad_norm_(self.joint_critic.parameters(), self.max_grad_norm)
        self.critic_optimizer.step()

        # =====================================================================
        # 2. COMA ADVANTAGE ESTIMATION
        # =====================================================================
        adv_alpha, adv_exec = self.compute_coma_advantages(batch)

        # Standardize advantages for gradient stability
        adv_alpha = (adv_alpha - adv_alpha.mean()) / (adv_alpha.std() + 1e-8)
        adv_exec = (adv_exec - adv_exec.mean()) / (adv_exec.std() + 1e-8)

        # =====================================================================
        # 3. ACTOR 2 (EXECUTION) UPDATE
        # =====================================================================
        exec_logits = self.exec_actor(batch.exec_obs)
        exec_probs = F.softmax(exec_logits, dim=-1)
        exec_log_probs = torch.log(exec_probs + 1e-10)
        chosen_exec_log_prob = exec_log_probs.gather(1, batch.exec_actions)

        exec_entropy = -(exec_probs * exec_log_probs).sum(dim=-1).mean()
        exec_actor_loss = -(chosen_exec_log_prob * adv_exec).mean() - (self.entropy_coef_exec * exec_entropy)

        self.exec_optimizer.zero_grad()
        exec_actor_loss.backward()
        nn.utils.clip_grad_norm_(self.exec_actor.parameters(), self.max_grad_norm)
        self.exec_optimizer.step()

        # =====================================================================
        # 4. ACTOR 1 (ALPHA) UPDATE
        # =====================================================================
        alpha_dist = self.alpha_actor.get_distribution(batch.alpha_obs)
        # Pre-tanh action inversion approximation for exact density
        clamped_act = torch.clamp(batch.alpha_actions, -0.9999, 0.9999)
        pre_tanh = 0.5 * torch.log((1.0 + clamped_act) / (1.0 - clamped_act))
        alpha_log_prob = alpha_dist.log_prob(pre_tanh) - torch.log(1.0 - clamped_act.pow(2) + 1e-6)
        alpha_log_prob = alpha_log_prob.sum(dim=-1, keepdim=True)

        alpha_entropy = alpha_dist.entropy().sum(dim=-1).mean()
        alpha_actor_loss = -(alpha_log_prob * adv_alpha).mean() - (self.entropy_coef_alpha * alpha_entropy)

        self.alpha_optimizer.zero_grad()
        alpha_actor_loss.backward()
        nn.utils.clip_grad_norm_(self.alpha_actor.parameters(), self.max_grad_norm)
        self.alpha_optimizer.step()

        # =====================================================================
        # 5. TARGET NETWORK SYNC
        # =====================================================================
        self.train_step += 1
        self._soft_update_targets()
        if self.train_step % self.target_update_interval == 0:
            self.target_joint_critic.load_state_dict(self.joint_critic.state_dict())

        return {
            "critic_loss": float(critic_loss.item()),
            "loss_q_exec": float(loss_q_exec.item()),
            "loss_q_alpha": float(loss_q_alpha.item()),
            "exec_actor_loss": float(exec_actor_loss.item()),
            "alpha_actor_loss": float(alpha_actor_loss.item()),
            "exec_entropy": float(exec_entropy.item()),
            "alpha_entropy": float(alpha_entropy.item()),
            "adv_exec_mean": float(adv_exec.mean().item()),
            "adv_alpha_mean": float(adv_alpha.mean().item())
        }
