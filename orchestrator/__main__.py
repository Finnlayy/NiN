"""Modul-Einstieg: ``python3 -m orchestrator <kommando>``."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
