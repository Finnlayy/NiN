"""NEU-Testsuite (Phase 1).

Reines ``unittest`` (Stdlib), damit sie ohne Installation laeuft::

    python3 -m unittest discover -s tests -v
    python3 -m pytest tests -v          # funktioniert ebenfalls (pytest-kompatibel)

Die Orchestrator-Tests starten **echte** Limb-Subprozesse mit **echten** Timern.
Es wird nichts gemockt: Was hier gruener Haken ist, war wirklich erfolgreich.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
