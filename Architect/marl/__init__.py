"""
NiN Multi-Agent Reinforcement Learning (MARL) Framework.

Components:
- Interfaces: BaseLocalActor, BaseCentralizedCritic, BaseExecutionEngine, ExecutionAction, PreTradeDecision
- Actors: DecentralizedAlphaActor, DecentralizedExecutionActor
- Critic: CentralizedJointCritic, CentralizedAlphaCritic, CentralizedExecutionCritic
- COMA Engine: COMATrainer, MARLTransitionBatch
- Environment: PessimisticFillModel, VectorizedRolloutCollector, MarketTick, FillReport
- State Fabric: StateBus, InMemoryStateBusEngine
- Guard: AtomicExecutionGuard, RoutedOrder
- ONNX Pipeline: export_actors_to_onnx
"""

from Architect.marl.interfaces import (
    BaseLocalActor,
    BaseCentralizedCritic,
    BaseExecutionEngine,
    ExecutionAction,
    PreTradeDecision,
    PortfolioState,
)
from Architect.marl.actors import (
    DecentralizedAlphaActor,
    DecentralizedExecutionActor,
)
from Architect.marl.critic import (
    CentralizedJointCritic,
    CentralizedAlphaCritic,
    CentralizedExecutionCritic,
)
from Architect.marl.coma import (
    COMATrainer,
    MARLTransitionBatch,
)
from Architect.marl.environment import (
    PessimisticFillModel,
    VectorizedRolloutCollector,
    MarketTick,
    FillReport,
)
from Architect.marl.state_bus import (
    StateBus,
    InMemoryStateBusEngine,
)
from Architect.marl.guard import (
    AtomicExecutionGuard,
    RoutedOrder,
)
from Architect.marl.export_onnx import (
    export_actors_to_onnx,
)
from Architect.marl.fincad_processor import (
    FinCADLogitsProcessor,
    DebiasingVerdict,
)
from Architect.marl.meta_breaker import (
    MetaCircuitBreaker,
    BreakerDomain,
    BreakerStatus,
    MetaHaltVerdict,
)

__all__ = [
    "BaseLocalActor",
    "BaseCentralizedCritic",
    "BaseExecutionEngine",
    "ExecutionAction",
    "PreTradeDecision",
    "PortfolioState",
    "DecentralizedAlphaActor",
    "DecentralizedExecutionActor",
    "CentralizedJointCritic",
    "CentralizedAlphaCritic",
    "CentralizedExecutionCritic",
    "COMATrainer",
    "MARLTransitionBatch",
    "PessimisticFillModel",
    "VectorizedRolloutCollector",
    "MarketTick",
    "FillReport",
    "StateBus",
    "InMemoryStateBusEngine",
    "AtomicExecutionGuard",
    "RoutedOrder",
    "export_actors_to_onnx",
    "FinCADLogitsProcessor",
    "DebiasingVerdict",
    "MetaCircuitBreaker",
    "BreakerDomain",
    "BreakerStatus",
    "MetaHaltVerdict",
]
