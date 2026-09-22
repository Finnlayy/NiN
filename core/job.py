"""Job-Lebenszyklus und Iterationszaehlung (Protokoll 1.2).

Grundregel des Users, hier maschinell durchgesetzt:

    Ein Job ist **wirklich failed**, wenn nach einem Versagen *keine*
    Massnahme mehr ergriffen wird, um das Problem zu loesen.
    Geht das System nach einem Fehlschlag in den autodidaktischen Modus
    (2. Durchgang mit neu entworfenem Auftrag), ist der Job **nicht** failed,
    sondern ``iterating``.

Iterationen zaehlen pro **Job** (``job_id``), nicht pro Agenten- oder
Limb-Aufruf. Maximum: ``core.config.ABSOLUTE_MAX_ITERATIONS`` (= 2), im
Dev-Modus 1.

Zustaende::

    open -> running -> resolved                 (Ziel erreicht)
                    -> iterating -> resolved    (Autodidaktik: 2. Durchgang)
                                 -> failed      (keine Massnahme mehr / Budget leer)
                                 -> escalated   (Mensch noetig)
"""

from __future__ import annotations

import builtins
import json
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from .atomic import atomic_write_bytes
from .config import ABSOLUTE_MAX_ITERATIONS, NeuConfig
from .protocol import format_timestamp, new_id, parse_timestamp, utc_now

#: Job-Arten: vom Kern/User beauftragt ("job") oder vom Scheduler getriggert
#: ("scheduled"). Getriggerte Kontrollen verbrauchen kein Iterations-Budget des
#: beobachteten Jobs -- sie sind eigene Jobs mit eigener Spur.
JOB_KIND_TASK = "job"
JOB_KIND_SCHEDULED = "scheduled"
VALID_JOB_KINDS = (JOB_KIND_TASK, JOB_KIND_SCHEDULED)

JOB_OPEN = "open"
JOB_RUNNING = "running"
JOB_ITERATING = "iterating"
JOB_RESOLVED = "resolved"
JOB_ESCALATED = "escalated"
JOB_FAILED = "failed"

ACTIVE_STATES = (JOB_OPEN, JOB_RUNNING, JOB_ITERATING)
TERMINAL_STATES = (JOB_RESOLVED, JOB_ESCALATED, JOB_FAILED)

#: Warum ein Job endgueltig gescheitert ist.
FAILURE_NO_MEASURE = "no_measure_available"
FAILURE_STALE = "stale_reclaimed"
FAILURE_INTERNAL = "internal_error"
FAILURE_BUDGET_EXHAUSTED = "budget_exhausted"
FAILURE_ESCALATION = "escalation_required"
FAILURE_ABORTED = "aborted_by_policy"


@dataclass(frozen=True)
class IterationEntry:
    """Ein Durchgang eines Jobs -- der Pruefstein fuer die Autodidaktik."""

    iteration: int
    intent_id: str
    operation: str
    limb: str
    status: str
    verdict: str
    error_code: str = ""
    duration_ms: int = 0
    timer_expired: bool = False
    self_reported: bool = False
    archive: str = ""
    measure: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "iteration": self.iteration,
            "intent_id": self.intent_id,
            "operation": self.operation,
            "limb": self.limb,
            "status": self.status,
            "verdict": self.verdict,
            "error_code": self.error_code,
            "duration_ms": self.duration_ms,
            "timer_expired": self.timer_expired,
            "self_reported": self.self_reported,
            "archive": self.archive,
            "measure": self.measure,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> IterationEntry:
        return cls(
            iteration=int(data.get("iteration", 1)),
            intent_id=str(data.get("intent_id", "")),
            operation=str(data.get("operation", "")),
            limb=str(data.get("limb", "")),
            status=str(data.get("status", "")),
            verdict=str(data.get("verdict", "")),
            error_code=str(data.get("error_code", "")),
            duration_ms=int(data.get("duration_ms", 0)),
            timer_expired=bool(data.get("timer_expired", False)),
            self_reported=bool(data.get("self_reported", False)),
            archive=str(data.get("archive", "")),
            measure=str(data.get("measure", "")),
        )


@dataclass(frozen=True)
class JobRecord:
    """Persistenter Zustand eines Jobs."""

    job_id: str
    goal: str
    status: str = JOB_OPEN
    created_at: str = ""
    updated_at: str = ""
    iteration: int = 0
    max_iterations: int = 1
    mode: str = "dev"
    deadline_s: float | None = 60.0
    timer_mode: str = "deadline"
    kind: str = JOB_KIND_TASK
    parent_job_id: str = ""
    trigger_id: str = ""
    limbs_used: tuple[str, ...] = ()
    operations_used: tuple[str, ...] = ()
    measures_taken: int = 0
    history: tuple[IterationEntry, ...] = ()
    failure_kind: str = ""
    outcome: dict[str, Any] = field(default_factory=dict)

    # ------------------------------------------------------------ Eigenschaften
    @property
    def t0(self) -> str:
        """Referenzpunkt der Job-Uhr (``t_unlimited`` zaehlt ab hier)."""
        return self.created_at

    @property
    def unlimited(self) -> bool:
        return self.timer_mode == "unlimited"

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_STATES

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATES

    @property
    def really_failed(self) -> bool:
        """True nur, wenn nach dem Versagen *keine* Massnahme moeglich war.

        User-Regel: Ein Job, nach dessen Versagen das System in den
        autodidaktischen Modus geht (oder zumindest eine Massnahme identifiziert
        und am Budget scheitert), ist nicht "wirklich failed".
        """
        return self.status == JOB_FAILED and self.failure_kind == FAILURE_NO_MEASURE

    @property
    def iterations_left(self) -> int:
        return max(0, self.max_iterations - max(self.iteration, 0))

    def next_iteration(self) -> int:
        return max(1, self.iteration + (0 if self.iteration == 0 else 1))

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "goal": self.goal,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "iteration": self.iteration,
            "max_iterations": self.max_iterations,
            "mode": self.mode,
            "deadline_s": self.deadline_s,
            "timer_mode": self.timer_mode,
            # Abgeleitet, aber absichtlich serialisiert: Wer den Ledger liest,
            # soll dieselbe Uhr sehen wie Intent und Result -- t0 als Anker und
            # t_unlimited als laufende Sekundenzahl seit t0. from_dict() liest
            # beide nicht zurueck (sie werden berechnet), sie sind reine Auskunft.
            "t0": self.t0,
            "unlimited": self.unlimited,
            "t_unlimited_s": elapsed_s(self),
            "kind": self.kind,
            "parent_job_id": self.parent_job_id,
            "trigger_id": self.trigger_id,
            "limbs_used": list(self.limbs_used),
            "operations_used": list(self.operations_used),
            "measures_taken": self.measures_taken,
            "failure_kind": self.failure_kind,
            "outcome": dict(self.outcome),
            "history": [entry.to_dict() for entry in self.history],
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> JobRecord:
        return cls(
            job_id=str(data.get("job_id", "")),
            goal=str(data.get("goal", "")),
            status=str(data.get("status", JOB_OPEN)),
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
            iteration=int(data.get("iteration", 0)),
            max_iterations=int(data.get("max_iterations", 1)),
            mode=str(data.get("mode", "dev")),
            deadline_s=None if data.get("deadline_s") is None else float(data.get("deadline_s", 60.0)),
            timer_mode=str(data.get("timer_mode", "deadline")),
            kind=str(data.get("kind", JOB_KIND_TASK)),
            parent_job_id=str(data.get("parent_job_id", "")),
            trigger_id=str(data.get("trigger_id", "")),
            limbs_used=tuple(str(x) for x in data.get("limbs_used", ())),
            operations_used=tuple(str(x) for x in data.get("operations_used", ())),
            measures_taken=int(data.get("measures_taken", 0)),
            failure_kind=str(data.get("failure_kind", "")),
            outcome=dict(data.get("outcome", {})),
            history=tuple(IterationEntry.from_dict(h) for h in data.get("history", ())),
        )


class JobStore:
    """Legt Jobs unter ``runtime/jobs/`` ab (JSON + JSONL-Historie)."""

    def __init__(self, config: NeuConfig | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.config.ensure_dirs()

    # ------------------------------------------------------------------ Pfade
    def path(self, job_id: str) -> Path:
        return self.config.jobs_dir / f"{job_id}.json"

    def history_path(self, job_id: str) -> Path:
        return self.config.jobs_dir / f"{job_id}.history.jsonl"

    # ---------------------------------------------------------------- Anlegen
    def create(
        self,
        goal: str,
        *,
        max_iterations: int | None = None,
        deadline_s: float | None = None,
        timer_mode: str = "deadline",
        kind: str = JOB_KIND_TASK,
        parent_job_id: str = "",
        trigger_id: str = "",
        job_id: str | None = None,
    ) -> JobRecord:
        """Legt einen Job an. ``created_at`` ist damit der Nullpunkt der Job-Uhr.

        ``deadline_s=None`` (bzw. ``timer_mode="unlimited"``) bedeutet: Die Zeit
        wird getrackt, nicht begrenzt.
        """
        cap = self.config.limits.max_iterations
        requested = int(max_iterations if max_iterations is not None else cap)
        effective = max(1, min(requested, cap, ABSOLUTE_MAX_ITERATIONS))
        now = format_timestamp(utc_now())
        # Eindeutige Aufloesung (Protokoll 1.2): deadline_s=None bedeutet
        # "kein Limit" -- entweder weil der Modus unlimited ist oder weil die
        # Konfiguration kein Default-Limit vorgibt (TimerDefaults.unlimited).
        resolved_deadline: float | None
        if timer_mode == "unlimited":
            resolved_deadline = None
        elif deadline_s is not None:
            resolved_deadline = float(deadline_s)
        elif self.config.timer.unlimited:
            resolved_deadline = None
        else:
            resolved_deadline = self.config.timer.deadline_s
        if kind not in VALID_JOB_KINDS:
            raise ValueError(f"kind muss eines von {VALID_JOB_KINDS} sein (gefunden: {kind!r})")
        record = JobRecord(
            job_id=job_id or new_id("job"),
            goal=goal.strip()[:4000],
            status=JOB_OPEN,
            created_at=now,
            updated_at=now,
            iteration=0,
            max_iterations=effective,
            mode=self.config.mode,
            deadline_s=resolved_deadline,
            timer_mode="unlimited" if resolved_deadline is None else "deadline",
            kind=kind,
            parent_job_id=parent_job_id,
            trigger_id=trigger_id,
        )
        self.save(record)
        self._append_history(record.job_id, {"event": "job.created", "at": now, **record.to_dict()})
        return record

    def get(self, job_id: str) -> JobRecord | None:
        path = self.path(job_id)
        if not path.is_file():
            return None
        return JobRecord.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def require(self, job_id: str) -> JobRecord:
        record = self.get(job_id)
        if record is None:
            raise KeyError(f"Job '{job_id}' existiert nicht (runtime/jobs/).")
        return record

    def save(self, record: JobRecord) -> JobRecord:
        stamped = replace(record, updated_at=format_timestamp(utc_now()))
        path = self.path(stamped.job_id)
        # Kompakt statt indent=2: die Datei ist reiner Maschinenzustand (gelesen wird
        # ueber ``load``/json, die menschliche Sicht ist ``neu job show``).indent=2
        # indent=2 kostet bei vollem Attempt-Verlauf gemessen das 4,8-Fache der
        # Serialisierung und 34 % mehr Bytes -- pro Heartbeat und pro Uebergang.
        atomic_write_bytes(path, (json.dumps(stamped.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        return stamped

    def list(self, *, limit: int = 25, active_only: bool = False, kind: str | None = None) -> list[JobRecord]:
        if not self.config.jobs_dir.is_dir():
            return []
        records: list[JobRecord] = []
        for path in sorted(self.config.jobs_dir.glob("job_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                record = JobRecord.from_dict(json.loads(path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                continue
            if active_only and not record.is_active:
                continue
            if kind is not None and record.kind != kind:
                continue
            records.append(record)
            if len(records) >= limit:
                break
        return records

    def stale_after_s(self, record: JobRecord) -> float:
        """Ab wann ein aktiver Job als verwaist gilt (Prozessabsturz).

        Deadline-Modus: Timer plus Puffer -- knapp, damit ein Absturz die
        Pipeline nicht blockiert.
        Unlimited-Modus: Es gibt keinen Timer, also zaehlt nur der Heartbeat des
        Schedulers (``updated_at``).
        """
        if record.unlimited or record.deadline_s is None:
            return max(30.0, self.config.timer.tick_s * 12 + 25.0)
        return max(30.0, record.deadline_s + 25.0)

    def is_stale(self, record: JobRecord, *, now: datetime | None = None) -> bool:
        if not record.is_active or not record.updated_at:
            return False
        try:
            updated = parse_timestamp(record.updated_at, "$.updated_at")
        except Exception:
            return True
        moment = now or utc_now()
        return (moment - updated).total_seconds() > self.stale_after_s(record)

    # ``builtins.list`` statt ``list``: Die Klasse hat eine Methode namens
    # ``list``, die im Klassen-Scope das Builtin beschattet -- Annotationen
    # wuerden sonst die Methode als Typ lesen (mypy: valid-type).
    def active_jobs(self, *, kind: str | None = None) -> builtins.list[JobRecord]:
        """Aktive Jobs ohne verwaiste (abgestuerzte) Eintraege."""
        return [record for record in self.list(limit=1000, active_only=True, kind=kind) if not self.is_stale(record)]

    def stale_jobs(self) -> builtins.list[JobRecord]:
        return [record for record in self.list(limit=1000, active_only=True) if self.is_stale(record)]

    def active_count(self, *, kind: str = JOB_KIND_TASK) -> int:
        """Zaehlt aktive Jobs einer Art.

        Getriggerte Kontroll-Jobs (``kind="scheduled"``) werden getrennt gezaehlt,
        damit eine periodische Kontrolle nicht das Aufgaben-Budget blockiert.
        """
        return len(self.active_jobs(kind=kind))

    def reclaim_stale(self) -> builtins.list[JobRecord]:
        """Verwaiste Jobs eskalieren statt sie ewig als 'aktiv' zu zaehlen."""
        reclaimed: list[JobRecord] = []
        for record in self.stale_jobs():
            updated = self.finish(
                record.job_id,
                JOB_ESCALATED,
                failure_kind=FAILURE_STALE,
                outcome={
                    "reason": "Job blieb ohne Abschluss im Zustand "
                    f"'{record.status}' (letzte Aktualisierung {record.updated_at}). "
                    "Vermutlich abgestuerzter Orchestrator-Prozess.",
                    "iterations": record.iteration,
                },
            )
            self._append_history(record.job_id, {"event": "job.reclaimed", "at": updated.updated_at})
            reclaimed.append(updated)
        return reclaimed

    # ------------------------------------------------------------- Fortschritt
    def heartbeat(self, job_id: str, *, note: str = "") -> JobRecord | None:
        """Aktualisiert ``updated_at`` eines aktiven Jobs.

        Lebenszeichen fuer die Waisen-Erkennung: Im Unlimited-Modus gibt es
        keinen Timer, an dem man Fortschritt ablesen koennte -- also meldet der
        Scheduler pro Tick, dass der Auftrag noch betreut wird. Ohne Heartbeat
        wuerde ``is_stale()`` eine langlaufende Beobachtung fuer einen Absturz
        halten und sie eskalieren.
        """
        record = self.get(job_id)
        if record is None or not record.is_active:
            return record
        outcome = dict(record.outcome)
        if note:
            outcome["heartbeat"] = note[:400]
        return self.save(replace(record, updated_at=format_timestamp(utc_now()), outcome=outcome))

    def begin_iteration(self, job_id: str, *, operation: str, limb: str) -> JobRecord:
        """Markiert den Start eines Durchgangs (Iteration zaehlt hier hoch)."""
        record = self.require(job_id)
        iteration = record.iteration + 1
        limbs = tuple(dict.fromkeys((*record.limbs_used, limb)))
        operations = tuple(dict.fromkeys((*record.operations_used, operation)))
        updated = replace(
            record,
            iteration=iteration,
            status=JOB_ITERATING if iteration > 1 else JOB_RUNNING,
            limbs_used=limbs,
            operations_used=operations,
        )
        saved = self.save(updated)
        self._append_history(job_id, {"event": "iteration.started", "iteration": iteration, "operation": operation, "limb": limb, "at": saved.updated_at})
        return saved

    def record_iteration(self, job_id: str, entry: IterationEntry) -> JobRecord:
        record = self.require(job_id)
        updated = replace(record, history=(*record.history, entry))
        saved = self.save(updated)
        self._append_history(job_id, {"event": "iteration.finished", **entry.to_dict(), "at": saved.updated_at})
        return saved

    def register_measure(self, job_id: str, measure: str) -> JobRecord:
        """Zaehlt eine ergriffene Massnahme -- der Job gilt damit nicht als failed."""
        record = self.require(job_id)
        updated = replace(record, measures_taken=record.measures_taken + 1, status=JOB_ITERATING)
        saved = self.save(updated)
        self._append_history(job_id, {"event": "measure.registered", "measure": measure, "count": saved.measures_taken, "at": saved.updated_at})
        return saved

    def finish(self, job_id: str, status: str, *, failure_kind: str = "", outcome: Mapping[str, Any] | None = None) -> JobRecord:
        if status not in TERMINAL_STATES:
            raise ValueError(f"finish() erwartet einen Terminalzustand, erhalten: {status!r}")
        record = self.require(job_id)
        updated = replace(record, status=status, failure_kind=failure_kind, outcome=dict(outcome or {}))
        saved = self.save(updated)
        self._append_history(job_id, {"event": "job.finished", "status": status, "failure_kind": failure_kind, "at": saved.updated_at})
        return saved

    def decide_after_failure(self, job_id: str, *, measure_available: bool, iteration: int) -> tuple[str, str]:
        """Kernregel: failed nur ohne Massnahme. Liefert (status, failure_kind).

        ``measure_available``  es existiert eine Loesungsidee (unabhaengig vom Budget)
        ``budget_left``        reicht das Iterations-Budget noch fuer einen Durchgang
        """
        record = self.require(job_id)
        budget_left = record.max_iterations - iteration
        if measure_available and budget_left > 0:
            return JOB_ITERATING, ""
        if measure_available:
            # Massnahme bekannt, aber kein Budget -> terminal, jedoch NICHT hilflos.
            return JOB_FAILED, FAILURE_BUDGET_EXHAUSTED
        return JOB_FAILED, FAILURE_NO_MEASURE

    # ------------------------------------------------------------------ Intern
    def _append_history(self, job_id: str, entry: Mapping[str, Any]) -> None:
        path = self.history_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(dict(entry), ensure_ascii=False) + "\n")

    def read_history(self, job_id: str) -> builtins.list[dict[str, Any]]:
        path = self.history_path(job_id)
        if not path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries


def elapsed_s(record: JobRecord, *, now: datetime | None = None) -> float:
    """``t_unlimited``: Sekunden seit Job-Erstellung."""
    if not record.created_at:
        return 0.0
    moment = now or utc_now()
    return round(max(0.0, (moment - parse_timestamp(record.created_at, "$.created_at")).total_seconds()), 3)


def summarize(record: JobRecord, *, now: datetime | None = None) -> str:
    """Einzeiler fuer CLI/Logs."""
    last = record.history[-1] if record.history else None
    tail = f" | letzter Durchgang: {last.status}/{last.verdict}" if last else ""
    clock = "t_unlimited" if record.unlimited else f"limit={record.deadline_s}s"
    kind = "" if record.kind == JOB_KIND_TASK else f" kind={record.kind}"
    return (
        f"{record.job_id} [{record.status}] '{record.goal[:60]}' "
        f"iter={record.iteration}/{record.max_iterations} massnahmen={record.measures_taken} "
        f"{clock} elapsed={elapsed_s(record, now=now)}s{kind}"
        f"{f' failure={record.failure_kind}' if record.failure_kind else ''}{tail}"
    )
