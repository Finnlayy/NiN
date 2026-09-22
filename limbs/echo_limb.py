"""Echo-Limb (Phase 1) -- Protokoll-Testdouble und Konformanz-Harness.

Beweist, dass die Pipeline Intent -> Orchestrator -> Limb -> Result funktioniert,
Der Bootstrap-Limb (Phase 2) uebernimmt echte Dateioperationen; dieser Limb
implementiert ausschliesslich ``sys.*``-Operationen und schreibt niemals Dateien.

``sys.simulate`` erzwingt gezielt die Fehlpfade (fail / timeout / partial /
crash), damit die Autodidaktik-Schleife des Orchestrators *echt* getestet werden
kann -- ohne Mocks, mit realen Subprozessen und realen Timern.

Aufruf: ``python3 limbs/echo_limb.py --intent runtime/inbox/echo/<id>.json``
"""

from __future__ import annotations

import os
import platform
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

# Zwei Aufrufwege, ein Modul:
#   * Skript  -- so startet der Orchestrator Limbs (``python3 limbs/echo_limb.py``),
#                dann ist ``__package__`` leer und ``base`` liegt auf sys.path.
#   * Paket   -- Tests und Tooling importieren ``limbs.echo_limb``.
# Relative Importe (``..core``) sind hier **unmoeglich**: ``limbs`` ist bereits
# ein Top-Level-Paket, ``from ..core import ...`` wirft ImportError. Deshalb wird
# in beiden Faellen absolut importiert -- mit dem Repo-Root auf sys.path.
_REPO_ROOT = Path(__file__).resolve().parent.parent
for _entry in (str(Path(__file__).resolve().parent), str(_REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

if __package__ in (None, ""):  # direkter Skriptaufruf durch den Orchestrator
    from base import LimbBase, LimbContext, LimbError  # type: ignore[import-not-found]
else:  # Import als Paket (Tests, Tooling)
    from limbs.base import LimbBase, LimbContext, LimbError

from core.protocol import PROTOCOL_VERSION, ErrorCode  # noqa: E402

VALID_MODES = ("fail", "timeout", "partial", "crash", "success")


class EchoLimb(LimbBase):
    name = "echo"
    version = "1.0.0"
    description = "Protokoll-Konformanz-Limb: sys.ping / sys.echo / sys.noop / sys.simulate"

    def handlers(self) -> dict[str, Callable[[Mapping[str, Any], LimbContext], Mapping[str, Any]]]:
        return {
            "sys.ping": self._ping,
            "sys.echo": self._echo,
            "sys.noop": self._noop,
            "sys.simulate": self._simulate,
        }

    # ---------------------------------------------------------------- Handler
    def _ping(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        return {
            "limb": self.name,
            "version": self.version,
            "operations": sorted(self.handlers()),
            "python": platform.python_version(),
            "sandbox_root": ctx.rel(ctx.sandbox_root),
            "protocol": PROTOCOL_VERSION,
            "timer_armed": ctx.armed,
            "deadline": ctx.intent.timer.expires_at,
        }

    def _echo(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        message = params.get("message")
        if not isinstance(message, str) or not message:
            raise LimbError(
                ErrorCode.SCHEMA_INVALID,
                "params.message fehlt oder ist kein nicht-leerer String.",
                hint='Beispiel: {"message": "hallo"}',
            )
        if len(message) > 8192:
            raise LimbError(ErrorCode.SCHEMA_INVALID, "params.message ist laenger als 8192 Zeichen.")
        ctx.plan("Nachricht entgegennehmen", "Nachricht unveraendert zurueckgeben")
        ctx.checkpoint("Nachricht entgegengenommen")
        ctx.finish_step("Nachricht unveraendert zurueckgeben")
        return {"echo": message, "length": len(message), "attempt": ctx.attempt}

    def _noop(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        return {"noop": True, "params_received": dict(params), "attempt": ctx.attempt}

    def _simulate(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        """Erzwingt einen definierten Ausgang -- fuer echte Tests der Fehlpfade."""
        mode = str(params.get("mode", "success"))
        if mode not in VALID_MODES:
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.mode muss eines von {VALID_MODES} sein.", hint=f"gefunden: {mode!r}")
        message = str(params.get("message", f"simulierter {mode}-Fall"))
        seconds = float(params.get("seconds", 30.0))

        if mode == "success":
            ctx.plan("Simulation ausfuehren")
            ctx.finish_step("Simulation ausfuehren")
            return {"simulated": mode, "message": message}

        if mode == "crash":
            # Provokation: kein JSON auf stdout, harter Abgang -> E_LIMB_CRASH
            sys.stderr.write(f"[echo] simulierter Absturz: {message}\n")
            sys.stderr.flush()
            print("DAS IST KEIN JSON -- provokerter Protokollverstoss", flush=True)
            os._exit(3)

        if mode == "timeout":
            ctx.plan(f"{seconds}s warten", "Ergebnis melden")
            ctx.checkpoint("Warten begonnen")
            deadline = time.time() + seconds
            while time.time() < deadline:
                # Kleine Scheiben, damit der Watchdog sauber zuschlagen kann
                time.sleep(min(0.05, max(0.0, deadline - time.time())))
            ctx.finish_step(f"{seconds}s warten")
            return {"simulated": mode, "message": message}

        if mode == "partial":
            ctx.plan("Teil A", "Teil B")
            ctx.finish_step("Teil A")
            return {
                "__status__": "partial",
                "simulated": mode,
                "message": message,
                "__status_report__": {
                    "state": "partial",
                    "explanation": f"Teil A erledigt, Teil B offen ({message}).",
                    "done": ["Teil A"],
                    "remaining": ["Teil B"],
                    "blockers": [],
                    "suggested_next": "Zweiter Durchgang uebernimmt ausschliesslich Teil B.",
                },
            }

        # mode == "fail"
        code = str(params.get("code", ErrorCode.INTERNAL))
        raise LimbError(code, message, hint=str(params.get("hint", "Auftrag pruefen.")))


if __name__ == "__main__":
    sys.exit(EchoLimb().main())
