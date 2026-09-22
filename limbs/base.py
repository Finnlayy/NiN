"""Limb-Basislaufzeit (Protokoll 1.2).

Ein *Limb* ist ein ausfuehrender Arm: Er liest genau einen Intent, fuehrt ihn
strikt aus und gibt genau ein Result zurueck. Er kennt keine Konversation,
keine anderen Intents und keinen Chat-Kontext -- alles, was er weiss, steht im
Intent.

**Timer-Pflicht (seit 1.1, erweitert in 1.2):** Der Orchestrator schaerft den Timer, bevor
der Limb startet. Der Limb ueberwacht dieselbe Deadline und liefert bei Ablauf
einen klaren Statusbericht (``status="timeout"`` + ``status_report``), statt
stum zu sterben:

* ``soft_expires_at``  -> der Handler wird abgebrochen, der Bericht wird gebaut
* ``expires_at``       -> spaeteste Abgabe; danach killt der Orchestrator hart

Aufrufvertrag (fuer jeden Limb identisch):

    python3 limbs/<name>_limb.py --intent <pfad-zum-intent.json> [--out <pfad>]
    cat intent.json | python3 limbs/<name>_limb.py --stdin

* **stdout** enthaelt ausschliesslich das Result als JSON.
* **stderr** ist fuer menschliche Diagnose frei verfuegbar.
* Exit-Code 0 = Result wurde erzeugt (auch bei status="failed"/"timeout").
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
for _entry in (str(Path(__file__).resolve().parent), str(_REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from core.config import NeuConfig  # noqa: E402
from core.policy import Policy  # noqa: E402
from core.protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    Artifact,
    ErrorCode,
    Intent,
    Operations,
    ProtocolError,
    Result,
    StatusReport,
    TimerReport,
    format_timestamp,
    new_id,
    parse_timestamp,
    sha256_bytes,
    sha256_file,
    utc_now,
    utc_now_iso,
)

EXIT_OK = 0
EXIT_CRASH = 70

#: Reserve fuer das Schreiben des Statusberichts vor der harten Deadline.
REPORT_RESERVE_S = 0.35


class LimbError(Exception):
    """Fachlicher Ausfuehrungsfehler eines Limbs (wird zu status="failed")."""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        self.code = code
        self.message = message
        self.hint = hint
        super().__init__(f"[{code}] {message}")


class DeadlineExceeded(Exception):
    """Wird vom Watchdog geworfen, wenn der Handler die Deadline ueberzieht."""


@dataclass
class LimbContext:
    """Alles, was ein Handler zur Ausfuehrung braucht -- inklusive Safety und Uhr."""

    intent: Intent
    config: NeuConfig
    policy: Policy
    attempt: int = 1
    sandbox_root: Path = field(default_factory=lambda: Path("workspace"))
    artifacts: list[Artifact] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    done: list[str] = field(default_factory=list)
    remaining: list[str] = field(default_factory=list)
    deadline_hit: threading.Event = field(default_factory=threading.Event)

    # ----------------------------------------------------------------- Uhr
    @property
    def armed(self) -> bool:
        return self.intent.timer.armed

    def expires_at(self) -> datetime | None:
        """Harte Deadline; ``None`` im Unlimited-Modus (Zeit wird nur getrackt)."""
        return parse_timestamp(self.intent.timer.expires_at, "$.timer.expires_at") if self.intent.timer.expires_at else None

    def soft_expires_at(self) -> datetime | None:
        """Soft-Deadline fuer den eigenen Statusbericht; ``None`` = unbegrenzt."""
        return parse_timestamp(self.intent.timer.soft_expires_at, "$.timer.soft_expires_at") if self.intent.timer.soft_expires_at else None

    def remaining_s(self) -> float | None:
        expires = self.expires_at()
        if expires is None:
            return None
        return (expires - utc_now()).total_seconds()

    def soft_remaining_s(self) -> float | None:
        soft = self.soft_expires_at()
        if soft is None:
            return None
        return (soft - utc_now()).total_seconds()

    def expired(self) -> bool:
        remaining = self.remaining_s()
        return remaining is not None and remaining <= 0

    def checkpoint(self, label: str) -> None:
        """Haken hinter einen erledigten Teilschritt -- fuellt den Statusbericht."""
        self.done.append(label)
        if self.expired():
            self.deadline_hit.set()
            raise DeadlineExceeded(f"Timer abgelaufen nach Teilschritt '{label}'.")

    def plan(self, *steps: str) -> None:
        """Meldet die geplanten Teilschritte, damit 'remaining' nie leer ist."""
        self.remaining.extend(step for step in steps if step)

    def finish_step(self, label: str) -> None:
        self.remaining = [step for step in self.remaining if step != label]
        self.done.append(label)

    def note(self, message: str) -> None:
        self.notes.append(message)

    # ------------------------------------------------------------- Pfade
    def resolve(self, raw_path: str, *, where: str = "$.task.params.path", must_exist: bool = False) -> Path:
        """Laufzeit-Sandbox-Pruefung. Immer statt eigener Pfadlogik benutzen."""
        return self.policy.resolve_path(raw_path, self.intent, where=where, must_exist=must_exist)

    def rel(self, path: Path) -> str:
        return self.config.relative(path)

    # --------------------------------------------------------- Dateiarbeit
    def backup(self, path: Path) -> str | None:
        """Sichert eine bestehende Datei nach runtime/backups/ und liefert den Relativpfad."""
        if not path.is_file():
            return None
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        safe_name = self.rel(path).replace("/", ">").replace(os.sep, ">")
        target = self.config.backup_dir / f"{stamp}__{safe_name}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        return self.rel(target)

    def write_atomic(self, path: Path, content: str, *, encoding: str = "utf-8") -> None:
        """Schreibt ueber temporaere Datei + os.replace (keine halben Dateien)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - delete=False ist Absicht: os.replace braucht die Datei
            "w",
            encoding=encoding,
            delete=False,
            dir=str(path.parent),
            prefix=f".{path.name}.",
            suffix=".neu-tmp",
        )
        try:
            with handle:
                handle.write(content)
            os.replace(handle.name, path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise

    def record(self, path: Path, action: str, *, backup_path: str = "") -> Artifact:
        """Dokumentiert eine Dateioperation als Artefakt (inkl. Hash-Nachweis)."""
        size = path.stat().st_size if path.exists() else 0
        digest = sha256_file(path) if path.is_file() else ""
        artifact = Artifact(path=self.rel(path), action=action, bytes=size, sha256=digest, backup_path=backup_path)
        self.artifacts.append(artifact)
        return artifact


Handler = Callable[[Mapping[str, Any], LimbContext], Mapping[str, Any]]


class LimbBase:
    """Basisklasse: Intent entgegennehmen, Handler ausfuehren, Result bauen."""

    name: str = "base"
    version: str = "0.0.0"
    description: str = ""

    def __init__(self, config: NeuConfig | None = None, operations: Operations | None = None, policy: Policy | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.operations = operations or Operations.load(self.config.protocol_dir / "operations.json")
        self.policy = policy or Policy(self.config, self.operations)

    # ---------------------------------------------------- von Limbs zu liefern
    def handlers(self) -> dict[str, Handler]:
        raise NotImplementedError

    # ------------------------------------------------------------------- Lauf
    def execute(self, intent: Intent, *, attempt: int | None = None) -> Result:
        # ``attempt`` ist der historische Name fuer die Job-Iteration.
        """Fuehrt einen Intent aus und liefert garantiert ein gueltiges Result."""
        started = time.time()
        started_at = utc_now_iso()
        attempt_no = int(attempt if attempt is not None else intent.iteration)
        handlers = self.handlers()

        context = LimbContext(
            intent=intent,
            config=self.config,
            policy=self.policy,
            attempt=attempt_no,
            sandbox_root=self._safe_sandbox(intent),
        )

        def build(
            status: str,
            output: Mapping[str, Any],
            *,
            error: Mapping[str, str] | None,
            artifacts=(),
            report: StatusReport | None = None,
            notes: list[str] | None = None,
            confidence: float = 1.0,
            self_reported: bool = True,
        ) -> Result:
            now = utc_now()
            overrun = 0
            remaining_ms: int | None = None
            if intent.timer.expires_at:
                expires = parse_timestamp(intent.timer.expires_at, "$.timer.expires_at")
                delta_ms = int((expires - now).total_seconds() * 1000)
                remaining_ms = delta_ms
                overrun = max(0, -delta_ms)
            elif not intent.timer.unlimited:
                remaining_ms = 0  # Deadline-Modus ohne geschaerfte Frist (Sonderfall)
            payload = {
                "protocol": "neu/result",
                "version": PROTOCOL_VERSION,
                "result_id": new_id("res"),
                "intent_id": intent.intent_id,
                "trace_id": intent.trace_id,
                "job_id": intent.job_id,
                "iteration": intent.iteration,
                "status": status,
                "operation": intent.operation,
                "limb": {"name": self.name, "version": self.version, "pid": os.getpid()},
                "started_at": started_at,
                "finished_at": format_timestamp(now),
                "duration_ms": max(0, int((time.time() - started) * 1000)),
                "output": dict(output),
                "artifacts": [a.to_dict() for a in artifacts],
                "status_report": report.to_dict() if report else None,
                "timer": TimerReport(
                    mode=intent.timer.mode,
                    t0=intent.timer.t0,
                    armed_at=intent.timer.armed_at,
                    expires_at=intent.timer.expires_at,
                    reported_at=format_timestamp(now),
                    # Im Unlimited-Modus ist elapsed_s der eigentliche Nachweis:
                    # Die Zeit wurde getrackt, nicht begrenzt (remaining_ms=null).
                    elapsed_s=intent.timer.elapsed(now=now),
                    remaining_ms=remaining_ms,
                    overrun_ms=overrun,
                    self_reported=self_reported,
                ).to_dict(),
                "diagnostics": {"stdout": "", "stderr": "", "exit_code": None},
                "error": dict(error) if error else None,
                "self_report": {"confidence": confidence, "notes": " | ".join(notes or [])[:8000]},
            }
            # Selbstpruefung: Ein Limb liefert niemals ein protokollwidriges Result.
            return Result.from_dict(payload, intent=intent)

        # 1) Adressierung + Operation
        if intent.target_limb != self.name:
            return build(
                "rejected",
                {},
                error={
                    "code": ErrorCode.TARGET_NOT_FOUND,
                    "message": f"Intent ist an '{intent.target_limb}' adressiert, dieser Limb heisst '{self.name}'.",
                    "hint": "limbs/registry.json pruefen.",
                },
                self_reported=False,
            )
        if intent.operation not in handlers:
            return build(
                "rejected",
                {"supported": sorted(handlers)},
                error={
                    "code": ErrorCode.UNSUPPORTED_OP,
                    "message": f"'{intent.operation}' wird von Limb '{self.name}' nicht implementiert.",
                    "hint": f"Unterstuetzt: {', '.join(sorted(handlers))}",
                },
                self_reported=False,
            )

        # 2) Sandbox/Rechte zur Laufzeit erneut pruefen (Pre-Flight kann ueberholt sein).
        #    Budgetfragen prueft ausschliesslich der Orchestrator -- sonst Drift.
        decision = self.policy.check_runtime(intent)
        if not decision.allowed:
            return build(
                "rejected",
                {"policy": decision.to_dict()},
                error={"code": decision.code, "message": decision.reason, "hint": "Intent-Anpassung durch den Core noetig."},
                self_reported=False,
            )

        # 3) Ausfuehrung unter Timer-Aufsicht
        box: dict[str, Any] = {}

        def worker() -> None:
            try:
                box["output"] = handlers[intent.operation](intent.task.params, context) or {}
            except BaseException as exc:
                box["error"] = exc

        thread = threading.Thread(target=worker, name=f"{self.name}-{intent.operation}", daemon=True)
        thread.start()

        wait_s = self._wait_budget(intent)
        thread.join(wait_s)

        if thread.is_alive() and intent.timer.unlimited:
            # Unlimited: kein Aufgabenlimit verletzt -- das Safety-Netz hat nur den
            # Prozess beendet. Kein inhaltliches Scheitern, aber eine Entscheidung.
            net = intent.timer.safety_net_s
            net_report = StatusReport(
                state="blocked",
                explanation=(
                    f"Safety-Netz ausgeloesst: Der Handler fuer '{intent.operation}' lief laenger als "
                    f"{net}s (t_unlimited={intent.timer.elapsed():.3f}s ab t0={intent.timer.t0}). "
                    f"Es bestand kein Zeitlimit fuer die Aufgabe; der Abbruch dient der Prozess-Hygiene. "
                    f"Erledigt bis zum Abbruch: {len(context.done)} Schritt(e)."
                ),
                done=tuple(context.done) or ("Handler lief noch; nichts abgeschlossen meldbar.",),
                remaining=tuple(context.remaining)
                or ("Auftrag laeuft laenger als ein Prozessfenster: in Teilauftraege zerlegen oder safety_net_s anheben.",),
                blockers=(
                    {
                        "code": ErrorCode.SAFETY_NET,
                        "message": f"Safety-Netz bei {net}s; t_unlimited={intent.timer.elapsed():.3f}s.",
                        "hint": "Menschliche Entscheidung: Zerlegung oder Konfigurationsanpassung (safety_net_s).",
                    },
                ),
                suggested_next="An Core eskalieren: Auftrag zerlegen oder safety_net_s bewusst anheben.",
            )
            context.note("safety-net: prozess-hygiene, kein aufgabenlimit")
            return build(
                "failed",
                {"handler_alive": True, "done_steps": list(context.done), "elapsed_s": intent.timer.elapsed(), "timer_mode": "unlimited"},
                error={
                    "code": ErrorCode.SAFETY_NET,
                    "message": net_report.explanation,
                    "hint": net_report.suggested_next,
                },
                artifacts=context.artifacts,
                report=net_report,
                notes=context.notes,
                confidence=0.3,
            )

        if thread.is_alive():
            soft_report = StatusReport(
                state="timeout",
                explanation=(
                    f"Timer abgelaufen: Der Handler fuer '{intent.operation}' war nach "
                    f"{intent.timer.deadline_s}s (soft {intent.timer.soft_deadline_s}s) nicht fertig. "
                    f"Erledigt bis zum Abbruch: {len(context.done)} Schritt(e)."
                ),
                done=tuple(context.done) or ("Timer vor Anbeginn vom Orchestrator geschaerft.",),
                remaining=tuple(context.remaining)
                or (f"Auftrag '{intent.task.title or intent.operation}' ist in einem Durchgang nicht abschliessbar.",),
                blockers=(
                    {
                        "code": ErrorCode.TIMEOUT,
                        "message": f"Zeitbudget von {intent.timer.deadline_s}s ueberschritten.",
                        "hint": "Umfang verkleinern oder deadline_s anheben.",
                    },
                ),
                suggested_next="Zweiter Durchgang mit verkleinertem Umfang (siehe Restliste).",
            )
            context.note("timeout: statusbericht durch limb")
            return build(
                "timeout",
                {"handler_alive": True, "done_steps": list(context.done)},
                error={"code": ErrorCode.TIMEOUT, "message": soft_report.explanation, "hint": soft_report.suggested_next},
                artifacts=context.artifacts,
                report=soft_report,
                notes=context.notes,
                confidence=0.2,
            )

        exc = box.get("error")
        if isinstance(exc, ProtocolError):
            return build("rejected", {}, error={"code": exc.code, "message": exc.message, "hint": "Intent-Korrektur noetig."}, artifacts=context.artifacts, notes=context.notes)
        if isinstance(exc, DeadlineExceeded):
            deadline_report = StatusReport(
                state="timeout",
                explanation=str(exc),
                done=tuple(context.done),
                remaining=tuple(context.remaining) or ("Restauftrag offen.",),
                blockers=({"code": ErrorCode.TIMEOUT, "message": str(exc), "hint": "Checkpoint-Liste verkleinern."},),
                suggested_next="Naechster Durchgang setzt am letzten Checkpoint an.",
            )
            return build("timeout", {}, error={"code": ErrorCode.TIMEOUT, "message": str(exc), "hint": ""}, artifacts=context.artifacts, report=deadline_report, notes=context.notes, confidence=0.3)
        if isinstance(exc, LimbError):
            blocked_report = StatusReport(
                state="blocked",
                explanation=f"{exc.code}: {exc.message}",
                done=tuple(context.done),
                remaining=tuple(context.remaining) or ("Auftrag wegen Blocker nicht ausgefuehrt.",),
                blockers=({"code": exc.code, "message": exc.message, "hint": exc.hint},),
                suggested_next=exc.hint or "Auftrag korrigieren und erneut zustellen.",
            )
            return build(
                "failed",
                {},
                error={"code": exc.code, "message": exc.message, "hint": exc.hint},
                artifacts=context.artifacts,
                report=blocked_report,
                notes=context.notes,
                confidence=0.4,
            )
        if isinstance(exc, FileNotFoundError):
            return build(
                "failed",
                {},
                error={"code": ErrorCode.PATH_NOT_FOUND, "message": str(exc), "hint": "Pfad im Intent pruefen."},
                artifacts=context.artifacts,
                notes=context.notes,
                confidence=0.3,
            )
        if exc is not None:
            return build(
                "failed",
                {"exception": type(exc).__name__},
                error={"code": ErrorCode.INTERNAL, "message": f"{type(exc).__name__}: {exc}"[:16000], "hint": "Stacktrace steht in stderr."},
                artifacts=context.artifacts,
                notes=context.notes,
                confidence=0.1,
            )

        output = box.get("output") or {}
        if not isinstance(output, Mapping):
            output = {"value": output}
        output = dict(output)
        status = str(output.pop("__status__", "success"))
        confidence = float(output.pop("__confidence__", 1.0))
        notes = list(output.pop("__notes__", []))
        report_data = output.pop("__status_report__", None)
        # Der Handler darf einen Bericht liefern -- muss aber nicht.
        report: StatusReport | None = StatusReport.from_dict(report_data) if isinstance(report_data, Mapping) else None
        if status in {"timeout", "partial"} and report is None:
            report = StatusReport(
                state=status,
                explanation=output.pop("__explanation__", "") or "Teilerfolg durch den Handler gemeldet.",
                done=tuple(context.done),
                remaining=tuple(context.remaining),
                suggested_next=str(output.pop("__suggested_next__", "")),
            )
        return build(
            status,
            output,
            error=None
            if status in {"success", "partial", "timeout"}
            else {"code": ErrorCode.INTERNAL, "message": "Handler meldete Misserfolg ohne Fehlercode.", "hint": ""},
            artifacts=context.artifacts,
            report=report,
            notes=context.notes + notes,
            confidence=confidence,
        )

    # ------------------------------------------------------------------ Uhr
    def _wait_budget(self, intent: Intent) -> float | None:
        """Wie lange auf den Handler gewartet wird, bevor der Bericht gebaut wird.

        Deadline-Modus: Soft-Deadline minus Reserve fuer den Statusbericht.
        Unlimited-Modus: Es gibt kein Aufgabenlimit -- gewartet wird auf das
        Safety-Netz (Prozess-Hygiene). Ist keins gesetzt, wartet der Limb, bis
        der Handler fertig ist (``None``).
        """
        if intent.timer.unlimited:
            net = intent.timer.hard_timeout_s()
            return None if net is None else max(0.05, net - REPORT_RESERVE_S)
        soft = intent.timer.soft_remaining_s()
        hard = intent.timer.remaining_s()
        if soft is None and hard is None:
            return None  # kein Timer geschaerft (z. B. direkter Testaufruf)
        if soft is None:
            soft = (hard or 0.0) * 0.8
        budget = min(soft, (hard if hard is not None else soft) - REPORT_RESERVE_S)
        return max(0.05, budget)

    def _safe_sandbox(self, intent: Intent) -> Path:
        try:
            return self.policy.sandbox_root(intent)
        except ProtocolError:
            return self.config.workspace_dir

    # -------------------------------------------------------------------- CLI
    def main(self, argv: list[str] | None = None) -> int:
        parser = argparse.ArgumentParser(prog=f"limbs/{self.name}", description=self.description or f"NEU-Limb '{self.name}'")
        source = parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--intent", type=Path, help="Pfad zur Intent-JSON-Datei")
        source.add_argument("--stdin", action="store_true", help="Intent von stdin lesen")
        parser.add_argument("--out", type=Path, help="Result zusaetzlich in diese Datei schreiben")
        parser.add_argument("--repo-root", type=Path, default=None, help="Repository-Wurzel (Default: uebergeordnetes Verzeichnis)")
        parser.add_argument("--profile", choices=("dev", "scale"), default=None, help="Wirksames Skalierungsprofil (vom Orchestrator durchgereicht)")
        parser.add_argument("--iteration", type=int, default=None, help="Durchgang (Default: iteration aus dem Intent)")
        parser.add_argument("--attempt", type=int, default=None, help="Alias fuer --iteration (abgekuendigt)")
        parser.add_argument("--pretty", action="store_true", help="Result eingerueckt ausgeben (nur fuer Menschen)")
        args = parser.parse_args(argv)

        intent: Intent | None = None
        try:
            overrides: dict[str, Any] = {}
            if args.repo_root:
                overrides["repo_root"] = args.repo_root
            if args.profile:
                from core.config import SCALE_PROFILES

                overrides["mode"] = args.profile
                overrides["limits"] = dict(SCALE_PROFILES[args.profile])
            if overrides:
                self.config = NeuConfig.load(**overrides)
                self.operations = Operations.load(self.config.protocol_dir / "operations.json")
                self.policy = Policy(self.config, self.operations)
            self.config.ensure_dirs()

            raw = sys.stdin.read() if args.stdin else Path(args.intent).read_text(encoding="utf-8")
            intent = Intent.from_json(raw, operations=self.operations)
        except ProtocolError as exc:
            print(json.dumps(_synthetic_error(self, exc.code, exc.message), ensure_ascii=False), flush=True)
            return EXIT_OK
        except Exception as exc:
            print(f"[{self.name}] Intent konnte nicht geladen werden: {exc}", file=sys.stderr)
            print(json.dumps(_synthetic_error(self, ErrorCode.SCHEMA_INVALID, str(exc)), ensure_ascii=False), flush=True)
            return EXIT_OK

        print(
            f"[{self.name}] intent={intent.intent_id} job={intent.job_id} iter={intent.iteration} "
            f"op={intent.operation} mode={intent.timer.mode} expires={intent.timer.expires_at}",
            file=sys.stderr,
        )
        result = self.execute(intent, attempt=args.iteration if args.iteration is not None else args.attempt)
        payload = result.to_json(indent=2 if args.pretty else None)

        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(payload + "\n", encoding="utf-8")
        print(payload, flush=True)
        return EXIT_OK


def _synthetic_error(limb: LimbBase, code: str, message: str) -> dict[str, Any]:
    """Not-Result, falls schon das Lesen des Intents scheitert."""
    now = utc_now_iso()
    return {
        "protocol": "neu/result",
        "version": PROTOCOL_VERSION,
        "result_id": new_id("res"),
        "intent_id": "int_unknown_000000",
        "trace_id": "int_unknown_000000",
        "job_id": "",
        "iteration": 1,
        "status": "rejected",
        "operation": "unknown",
        "limb": {"name": limb.name, "version": limb.version, "pid": os.getpid()},
        "started_at": now,
        "finished_at": now,
        "duration_ms": 0,
        "output": {},
        "artifacts": [],
        "status_report": None,
        "timer": {
            "mode": "deadline",
            "t0": None,
            "armed_at": None,
            "expires_at": None,
            "reported_at": now,
            "elapsed_s": None,
            "remaining_ms": None,
            "overrun_ms": 0,
            "self_reported": False,
        },
        "diagnostics": {"stdout": "", "stderr": "", "exit_code": None},
        "error": {"code": code, "message": message[:16000], "hint": f"Intent entspricht nicht Protokoll {PROTOCOL_VERSION}."},
        "self_report": {"confidence": 0.0, "notes": "Intent-Eingang fehlerhaft"},
    }


def sha256_of(data: bytes | str) -> str:
    return sha256_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
