"""NEU-Orchestrator (Protokoll 1.2).

Oeffentliche Schnittstelle::

    from orchestrator import Orchestrator, JobOutcome, IterationPlanner

Importrichtung: orchestrator -> core (niemals umgekehrt).
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from .events import CollectingSink, ConsoleSink, EventBus, build_event_bus  # noqa: E402
from .locks import AgentPool, AgentSlot, NoSlotAvailable  # noqa: E402
from .planner import Diagnosis, IterationPlanner  # noqa: E402
from .runner import Attempt, JobOutcome, LimbRegistry, Orchestrator  # noqa: E402
from .transport import FileTransport, QueueState, read_json, write_json_atomic  # noqa: E402

__all__ = [
    "AgentPool",
    "AgentSlot",
    "Attempt",
    "CollectingSink",
    "ConsoleSink",
    "Diagnosis",
    "EventBus",
    "FileTransport",
    "IterationPlanner",
    "JobOutcome",
    "LimbRegistry",
    "NoSlotAvailable",
    "Orchestrator",
    "QueueState",
    "build_event_bus",
    "read_json",
    "write_json_atomic",
]
