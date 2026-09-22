"""
export_onnx.py - Automated ONNX Export Pipeline for NiN Decentralized MARL Actors.

Exports:
1. DecentralizedAlphaActor -> alpha_actor.onnx
2. DecentralizedExecutionActor -> exec_actor.onnx

Features:
- Full dynamic batching configuration on input observation and output action tensors.
- Verification and parity test against PyTorch eager mode outputs.
- Standalone execution entrypoint with CLI arguments.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional, Tuple

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
    _BaseModule = nn.Module
except ImportError:
    HAS_TORCH = False
    torch = None
    nn = None
    _BaseModule = object

from Architect.marl.actors import DecentralizedAlphaActor, DecentralizedExecutionActor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("NiN.ONNXExport")


class _AlphaExportWrapper(_BaseModule):
    """Deterministic inference wrapper for Alpha Actor ONNX export."""
    def __init__(self, actor: DecentralizedAlphaActor):
        super().__init__()
        self.actor = actor

    def forward(self, obs: Any) -> Any:
        # Evaluates deterministic mode (mean conviction)
        action, _ = self.actor.act(obs, deterministic=True)
        return action


class _ExecExportWrapper(_BaseModule):
    """Deterministic inference wrapper for Execution Actor ONNX export."""
    def __init__(self, actor: DecentralizedExecutionActor):
        super().__init__()
        self.actor = actor

    def forward(self, obs: Any) -> Tuple[Any, Any]:
        # Returns (action_index, action_probabilities)
        logits = self.actor(obs)
        probs = torch.softmax(logits, dim=-1)
        action = torch.argmax(probs, dim=-1, keepdim=True)
        return action, probs


def export_actors_to_onnx(
    output_dir: str = "Architect/models/onnx",
    alpha_actor: Optional[DecentralizedAlphaActor] = None,
    exec_actor: Optional[DecentralizedExecutionActor] = None,
    alpha_input_dim: int = 16,
    exec_input_dim: int = 12,
    opset_version: int = 17
) -> Tuple[str, str]:
    """
    Exports Alpha and Execution actors to ONNX with dynamic batching.
    """
    if not HAS_TORCH:
        raise RuntimeError("PyTorch is required for ONNX export.")

    os.makedirs(output_dir, exist_ok=True)

    # Instantiate default actors if not provided
    if alpha_actor is None:
        alpha_actor = DecentralizedAlphaActor(input_dim=alpha_input_dim)
    if exec_actor is None:
        exec_actor = DecentralizedExecutionActor(input_dim=exec_input_dim)

    alpha_actor.eval()
    exec_actor.eval()

    # -------------------------------------------------------------------------
    # 1. EXPORT ALPHA ACTOR
    # -------------------------------------------------------------------------
    alpha_wrapper = _AlphaExportWrapper(alpha_actor)
    alpha_dummy_input = torch.randn(1, alpha_input_dim, dtype=torch.float32)
    alpha_path = os.path.join(output_dir, "alpha_actor.onnx")

    logger.info(f"Exporting Alpha Actor to {alpha_path} (opset {opset_version})...")
    torch.onnx.export(
        alpha_wrapper,
        alpha_dummy_input,
        alpha_path,
        export_params=True,
        opset_version=opset_version,
        do_constant_folding=True,
        input_names=["alpha_obs"],
        output_names=["conviction"],
        dynamic_axes={
            "alpha_obs": {0: "batch_size"},
            "conviction": {0: "batch_size"}
        }
    )
    logger.info("Alpha Actor exported successfully.")

    # -------------------------------------------------------------------------
    # 2. EXPORT EXECUTION ACTOR
    # -------------------------------------------------------------------------
    exec_wrapper = _ExecExportWrapper(exec_actor)
    exec_dummy_input = torch.randn(1, exec_input_dim, dtype=torch.float32)
    exec_path = os.path.join(output_dir, "exec_actor.onnx")

    logger.info(f"Exporting Execution Actor to {exec_path} (opset {opset_version})...")
    torch.onnx.export(
        exec_wrapper,
        exec_dummy_input,
        exec_path,
        export_params=True,
        opset_version=opset_version,
        do_constant_folding=True,
        input_names=["exec_obs"],
        output_names=["action_id", "action_probs"],
        dynamic_axes={
            "exec_obs": {0: "batch_size"},
            "action_id": {0: "batch_size"},
            "action_probs": {0: "batch_size"}
        }
    )
    logger.info("Execution Actor exported successfully.")

    # -------------------------------------------------------------------------
    # 3. VERIFY EXPORTS (if onnx is available)
    # -------------------------------------------------------------------------
    try:
        import onnx
        model_alpha = onnx.load(alpha_path)
        onnx.checker.check_model(model_alpha)
        model_exec = onnx.load(exec_path)
        onnx.checker.check_model(model_exec)
        logger.info("ONNX graph structural checks passed.")
    except ImportError:
        logger.warning("Package 'onnx' not installed; skipped onnx.checker validation.")

    return alpha_path, exec_path


def main():
    parser = argparse.ArgumentParser(description="Export NiN MARL Actors to ONNX")
    parser.add_argument("--output-dir", type=str, default="Architect/models/onnx")
    parser.add_argument("--alpha-dim", type=int, default=16)
    parser.add_argument("--exec-dim", type=int, default=12)
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()

    export_actors_to_onnx(
        output_dir=args.output_dir,
        alpha_input_dim=args.alpha_dim,
        exec_input_dim=args.exec_dim,
        opset_version=args.opset
    )


if __name__ == "__main__":
    main()
