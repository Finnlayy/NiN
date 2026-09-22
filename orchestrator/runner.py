"""Orchestrator-Kern (Phase 1, Protokoll 1.2).

Verantwortung:

1. **Timer vor Anbeginn schaerfen** -- jeder Auftrag bekommt ``timer.armed_at``,
   ``soft_expires_at`` und ``expires_at``, *bevor* der Limb gestartet wird.
2. **Genau ein Limb pro Durchgang** -- kein stilles Retry. Ein Durchgang ist ein
   Agentenaufruf; Iterationen zaehlen pro Job.
3. **Statusbericht erzwingen** -- laeuft der Timer ab, liefert entweder der Limb
   selbst einen Bericht (Soft-Deadline) oder der Orchestrator synthetisiert
   einen vollstaendigen ``status="timeout"``-Datensatz.
4. **Autodidaktischer Modus** -- nach einem Fehlschlag entwirft
   ``orchestrator.planner`` den Auftrag fuer den 2. Durchgang. Erst wenn keine
   Massnahme moeglich oder das Budget (max 2, Dev-Modus 1) erschoepft ist, gilt
   ein Job als wirklich ``failed``.
5. **Skalierungsgrenzen** -- Agent-Slots (``max_agents``), Limb-Vielfalt pro Job
   (``max_limbs``), parallele Jobs (``max_concurrent_jobs``).

Ablauf eines Durchgangs::

    Intent validieren -> Limb im Register aufloesen -> Policy-Pre-Flight
    -> Timer schaerfen -> Agent-Slot belegen -> Intent in runtime/inbox/<limb>/
    -> Limb als Subprozess (Timeout = deadline_s + grace_s)
    -> Result parsen/validieren (bei Crash/Timeout: synthetisieren)
    -> Verdict durch den Kernel -> archivieren

Zwei Ausfuehrungspfade (seit Protokoll 1.2):

**synchron** (``dispatch``) -- wie oben; der Aufrufer wartet auf das Result.
**ueberwacht** (``spawn_async``/``collect_async``/``_supervise``) -- fuer
Auftraege mit ``timer.mode="unlimited"`` und/oder ``schedule.triggers``. Der
Limb laeuft als Prozess, waehrend der Orchestrator tickt: zeitgesteuerte
Ausloeser feuern, ``check``-Trigger starten eigene Kontroll-Jobs
(``kind="scheduled"``, eigenes Slot-Kontingent), und das Safety-Netz wird
ueberwacht. Ohne diesen Pfad koennte eine Beobachtung niemals *waehrend* des
Laufs pruefen -- ``subprocess.run`` blockiert bis zum Timeout.
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.config import NeuConfig
from core.job import (
    FAILURE_ESCALATION,
    FAILURE_INTERNAL,
    FAILURE_NO_MEASURE,
    FAILURE_STALE,
    JOB_ESCALATED,
    JOB_FAILED,
    JOB_KIND_SCHEDULED,
    JOB_KIND_TASK,
    JOB_RESOLVED,
    IterationEntry,
    JobRecord,
    JobStore,
)
from core.job import (
    elapsed_s as job_elapsed_s,
)
from core.kernel import Kernel, Verdict, arm_timer, bind_job_clock
from core.policy import Policy, PolicyDecision
from core.protocol import (
    PROTOCOL_VERSION,
    ErrorCode,
    Intent,
    Operations,
    ProtocolError,
    Result,
    StatusReport,
    format_timestamp,
    new_id,
    utc_now,
    utc_now_iso,
)

from .events import CollectingSink, EventBus, build_event_bus
from .locks import KIND_JOB, KIND_SCHEDULED, AgentPool, AgentSlot, NoSlotAvailable
from .planner import Diagnosis, IterationPlanner
from .scheduler import ACTION_CHECK, ACTION_ESCALATE, ACTION_FINISH, DueAction, Scheduler, ScheduleState, describe_schedule
from .transport import FileTransport, read_json


@dataclass(frozen=True)
class LimbSpec:
    name: str
    entrypoint: Path
    runtime: str
    version: str
    status: str
    phase: int
    operations: tuple[str, ...]
    writes_files: bool
    description: str

    @property
    def usable(self) -> bool:
        return self.status == "active"


@dataclass(frozen=True)
class Attempt:
    """Ein Durchgang: Auftrag, Ergebnis, Bewertung, Diagnose."""

    iteration: int
    intent: Intent
    result: Result
    verdict: Verdict
    decision: PolicyDecision
    spawned: bool = False
    returncode: int | None = None
    inbox_file: Path | None = None
    archive_dir: Path | None = None
    diagnosis: Diagnosis | None = None

    @property
    def ok(self) -> bool:
        return self.result.ok and self.verdict.accepted

    def summary(self) -> dict[str, Any]:
        return {
            "iteration": self.iteration,
            "intent_id": self.intent.intent_id,
            "job_id": self.intent.job_id,
            "operation": self.intent.operation,
            "limb": self.intent.target_limb,
            "status": self.result.status,
            "verdict": self.verdict.decision,
            "reasons": list(self.verdict.reasons),
            "duration_ms": self.result.duration_ms,
            "timer": {
                "mode": self.intent.timer.mode,
                "deadline_s": self.intent.timer.deadline_s,
                "soft_deadline_s": self.intent.timer.soft_deadline_s,
                "safety_net_s": self.intent.timer.safety_net_s,
                "t0": self.intent.timer.t0,
                "elapsed_s": self.result.timer.elapsed_s,
                "armed_at": self.intent.timer.armed_at,
                "expires_at": self.intent.timer.expires_at,
                "self_reported": self.result.timer.self_reported,
                "overrun_ms": self.result.timer.overrun_ms,
                "remaining_ms": self.result.timer.remaining_ms,
            },
            "status_report": self.result.status_report.to_dict() if self.result.status_report else None,
            "artifacts": [a.to_dict() for a in self.result.artifacts],
            "error": self.result.error,
            "output": self.result.output,
            "diagnosis": self.diagnosis.to_dict() if self.diagnosis else None,
            "archive": str(self.archive_dir) if self.archive_dir else None,
            "policy": self.decision.to_dict(),
        }


@dataclass(frozen=True)
class PreparedDispatch:
    """Alles, was vor dem Start eines Limbs geklaert sein muss.

    Der Slot bleibt belegt, bis das Result eingesammelt ist -- im synchronen Pfad
    sofort nach dem Start, im ueberwachten Pfad erst beim ``collect_async``.
    """

    intent: Intent
    spec: LimbSpec
    decision: PolicyDecision
    job: JobRecord
    inbox_file: Path
    slot: AgentSlot
    slot_kind: str = KIND_JOB
    hard_timeout_s: float | None = None


@dataclass
class SpawnHandle:
    """Ein laufender Limb-Prozess im ueberwachten (asynchronen) Pfad."""

    prepared: PreparedDispatch
    process: subprocess.Popen[str]
    argv: tuple[str, ...]
    started_at: str
    started_monotonic: float
    net_deadline_monotonic: float | None = None
    parent_job_id: str = ""
    trigger_id: str = ""
    ticks: int = 0
    due_actions: int = 0

    @property
    def job_id(self) -> str:
        return self.prepared.intent.job_id

    @property
    def intent(self) -> Intent:
        return self.prepared.intent

    @property
    def pid(self) -> int:
        return self.process.pid

    @property
    def running(self) -> bool:
        return self.process.poll() is None

    def elapsed_monotonic_s(self) -> float:
        return round(time.monotonic() - self.started_monotonic, 3)


@dataclass(frozen=True)
class JobOutcome:
    """Endergebnis eines Jobs ueber alle Durchgaenge."""

    job: JobRecord
    attempts: tuple[Attempt, ...]
    status: str
    failure_kind: str = ""
    measures: int = 0
    #: Bilanz der Ueberwachung (Protokoll 1.2): Ticks, Ausloesungen, Kontroll-Jobs,
    #: ob ein Trigger den Auftrag beendet hat und wie die Uhr stand. Leer, wenn
    #: der Auftrag synchron lief. Gehoert in jede Zusammenfassung -- sonst sehen
    #: ``--json``-Nutzer nicht, *warum* ein unbegrenzter Auftrag endete.
    watch: Mapping[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == JOB_RESOLVED

    @property
    def iterations(self) -> int:
        return len(self.attempts)

    def summary(self) -> dict[str, Any]:
        return {
            "job_id": self.job.job_id,
            "goal": self.job.goal,
            "status": self.status,
            "failure_kind": self.failure_kind,
            "mode": self.job.mode,
            "iterations": self.iterations,
            "max_iterations": self.job.max_iterations,
            "measures_taken": self.measures,
            "limbs_used": list(self.job.limbs_used),
            "really_failed": self.job.really_failed,
            "timer_mode": self.job.timer_mode,
            "kind": self.job.kind,
            "t0": self.job.t0,
            "t_unlimited_s": job_elapsed_s(self.job),
            "outcome": dict(self.job.outcome),
            "attempts": [a.summary() for a in self.attempts],
            "watch": dict(self.watch),
        }


class LimbRegistry:
    """Liest limbs/registry.json und haelt die Limb-Spezifikationen vor."""

    def __init__(self, config: NeuConfig) -> None:
        self.config = config
        self._raw: dict[str, Any] = {}
        self._runtimes: dict[str, Any] = {}
        self._limbs: dict[str, LimbSpec] = {}
        self.reload()

    def reload(self) -> None:
        path = self.config.registry_path
        if not path.is_file():
            raise ProtocolError(ErrorCode.TARGET_NOT_FOUND, f"Limb-Register fehlt: {path}")
        self._raw = read_json(path)
        self._runtimes = dict(self._raw.get("runtimes", {}))
        limbs = dict(self._raw.get("limbs", {}))
        self._limbs = {}
        for name, body in limbs.items():
            entrypoint = self.config.repo_root / str(body.get("entrypoint", ""))
            self._limbs[name] = LimbSpec(
                name=name,
                entrypoint=entrypoint,
                runtime=str(body.get("runtime", "python3")),
                version=str(body.get("version", "0.0.0")),
                status=str(body.get("status", "planned")),
                phase=int(body.get("phase", 0)),
                operations=tuple(str(op) for op in body.get("operations", ())),
                writes_files=bool(body.get("writes_files", False)),
                description=str(body.get("description", "")),
            )

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._limbs))

    def get(self, name: str) -> LimbSpec | None:
        return self._limbs.get(name)

    def active(self) -> tuple[LimbSpec, ...]:
        return tuple(spec for spec in self._limbs.values() if spec.usable and spec.entrypoint.is_file())

    def argv(self, spec: LimbSpec, *, intent_file: Path, iteration: int) -> list[str]:
        """Baut die Kommandozeile fuer einen Limb. Platzhalter: {python} {entrypoint}
        {intent_file} {iteration} {repo_root}."""
        template = self._runtimes.get(spec.runtime, {}).get("argv") or [
            "{python}", "{entrypoint}", "--intent", "{intent_file}", "--iteration", "{iteration}", "--profile", "{mode}",
        ]
        substitution = {
            "python": sys.executable,
            "entrypoint": str(spec.entrypoint),
            "intent_file": str(intent_file),
            "iteration": str(iteration),
            "attempt": str(iteration),  # Alias fuer aeltere Register-Eintraege
            "repo_root": str(self.config.repo_root),
            "mode": self.config.mode,
        }
        return [str(part).format(**substitution) for part in template]

    def as_dict(self) -> dict[str, Any]:
        return {
            "registry_version": self._raw.get("version"),
            "default_limb": self._raw.get("default_limb"),
            "limbs": {
                name: {
                    "entrypoint": self.config.relative(spec.entrypoint),
                    "runtime": spec.runtime,
                    "version": spec.version,
                    "status": spec.status,
                    "phase": spec.phase,
                    "operations": list(spec.operations),
                    "writes_files": spec.writes_files,
                    "entrypoint_exists": spec.entrypoint.is_file(),
                    "description": spec.description,
                }
                for name, spec in sorted(self._limbs.items())
            },
        }


class Orchestrator:
    """Verwaltet den Nachrichtenfluss zwischen Core, Dateisystem und Limbs."""

    def __init__(
        self,
        config: NeuConfig | None = None,
        *,
        kernel: Kernel | None = None,
        transport: FileTransport | None = None,
        bus: EventBus | None = None,
        registry: LimbRegistry | None = None,
        jobs: JobStore | None = None,
        planner: IterationPlanner | None = None,
        agents: AgentPool | None = None,
        scheduler: Scheduler | None = None,
        collector: CollectingSink | None = None,
        quiet: bool = False,
    ) -> None:
        self.config = config or NeuConfig.load()
        self.config.ensure_dirs()
        self.operations = Operations.load(self.config.protocol_dir / "operations.json")
        self.kernel = kernel or Kernel(self.config, self.operations)
        self.policy: Policy = self.kernel.policy
        self.transport = transport or FileTransport(self.config)
        self.jobs = jobs or JobStore(self.config)
        self.registry = registry or LimbRegistry(self.config)
        self.planner = planner or IterationPlanner(self.kernel, self.config, self.registry)
        self.agents = agents or AgentPool(self.config)
        self.collector = collector
        self.bus = bus or build_event_bus(quiet=quiet, collector=collector)
        # Der Scheduler teilt denselben Bus: Trigger-Events landen damit in
        # derselben Spur wie Job-, Limb- und Verdict-Events.
        self.scheduler = scheduler or Scheduler(self.config, bus=self.bus)

    # =====================================================================
    # Job-Ebene: Ziel -> Durchgaenge -> Terminierung
    # =====================================================================
    def run_job(
        self,
        *,
        goal: str,
        operation: str,
        params: Mapping[str, Any] | None = None,
        limb: str = "echo",
        max_iterations: int | None = None,
        deadline_s: float | None = None,
        soft_deadline_s: float | None = None,
        grace_s: float | None = None,
        safety_net_s: float | None = None,
        on_expiry: str | None = None,
        on_failure: str = "autodidactic",
        unlimited: bool = False,
        schedule: Sequence[Mapping[str, Any]] | Mapping[str, Any] | None = None,
        tick_s: float | None = None,
        kind: str = JOB_KIND_TASK,
        parent_job_id: str = "",
        trigger_id: str = "",
        title: str = "",
        objective: str = "",
        acceptance: Sequence[str] = (),
        verification: Mapping[str, Any] | None = None,
        constraints: Mapping[str, Any] | None = None,
        elevation: Mapping[str, Any] | None = None,
        context_summary: str = "",
        auto_iterate: bool = True,
        supervise: bool | None = None,
        max_ticks: int = 0,
    ) -> JobOutcome:
        """Fuehrt einen Job vollstaendig aus -- inklusive autodidaktischem 2. Durchgang.

        Zeit-Modus (Protokoll 1.2): Ohne ``deadline_s`` (oder mit
        ``unlimited=True``) wird die Zeit **getrackt** statt begrenzt; ``schedule``
        nimmt zeitgesteuerte Ausloeser auf. Solche Auftraege laufen automatisch im
        ueberwachten (asynchronen) Pfad, damit Trigger feuern, *waehrend* der Limb
        arbeitet.
        """
        reclaimed = self.reclaim_orphans()
        if reclaimed:
            self._emit("jobs.reclaimed", {"job_ids": [r.job_id for r in reclaimed]})
        slot_kind = KIND_SCHEDULED if kind == JOB_KIND_SCHEDULED else KIND_JOB
        if slot_kind == KIND_SCHEDULED:
            active = self.jobs.active_count(kind=JOB_KIND_SCHEDULED)
            quota = self.config.limits.max_scheduled_jobs
            limit_name = "max_scheduled_jobs"
        else:
            active = self.jobs.active_count(kind=JOB_KIND_TASK)
            quota = self.config.limits.max_concurrent_jobs
            limit_name = "max_concurrent_jobs"
        if active >= quota:
            raise ProtocolError(
                ErrorCode.POLICY_DENIED,
                f"Bereits {active} aktive {kind}-Jobs; Profil '{self.config.mode}' erlaubt "
                f"{limit_name}={quota}.",
            )

        timer_mode = "unlimited" if (unlimited or (deadline_s is None and self.config.timer.unlimited)) else "deadline"
        job = self.jobs.create(
            goal,
            max_iterations=max_iterations,
            deadline_s=deadline_s,
            timer_mode=timer_mode,
            kind=kind,
            parent_job_id=parent_job_id,
            trigger_id=trigger_id,
        )
        self._emit(
            "job.created",
            {
                "goal": goal,
                "max_iterations": job.max_iterations,
                "mode": job.mode,
                "kind": job.kind,
                "timer_mode": job.timer_mode,
                "t0": job.t0,
                "deadline_s": job.deadline_s,
                "safety_net_s": safety_net_s if safety_net_s is not None else self.config.timer.safety_net_s,
                "schedule": describe_schedule(schedule),
                "parent_job_id": parent_job_id,
                "trigger_id": trigger_id,
            },
            job_id=job.job_id,
            limb=limb,
            clock_s=0.0,  # Nullpunkt: t_unlimited zaehlt ab genau diesem Event
        )

        try:
            intent = self._compose_job_intent(
                job=job,
                goal=goal,
                operation=operation,
                params=params,
                limb=limb,
                max_iterations=max_iterations,
                on_failure=on_failure,
                on_expiry=on_expiry,
                deadline_s=deadline_s if deadline_s is not None else job.deadline_s,
                soft_deadline_s=soft_deadline_s,
                grace_s=grace_s,
                safety_net_s=safety_net_s,
                unlimited=unlimited,
                schedule=schedule,
                tick_s=tick_s,
                title=title,
                objective=objective,
                acceptance=acceptance,
                verification=verification,
                constraints=constraints,
                elevation=elevation,
                context_summary=context_summary,
            )
        except Exception as exc:
            # Fail-safe: Bricht der Aufbau ab, waere der Job eine aktive Waise und
            # wuerde im Dev-Modus (max_concurrent_jobs=1) die ganze Pipeline
            # blockieren. Also eskalieren und denselben Fehler weiterreichen.
            self.jobs.finish(
                job.job_id,
                JOB_ESCALATED,
                failure_kind=FAILURE_INTERNAL,
                outcome={"reason": f"Intent-Aufbau fehlgeschlagen: {type(exc).__name__}: {exc}", "iterations": 0},
            )
            self._emit("job.aborted", {"reason": f"{type(exc).__name__}: {exc}", "phase": "compose_intent"}, job_id=job.job_id)
            raise
        # Eine Uhr pro Auftrag: t0 ist die Job-Erstellung, nicht die Schaerfung.
        intent = bind_job_clock(intent, job.created_at)
        if supervise is None:
            supervise = bool(intent.schedule.triggers) or intent.timer.unlimited
        return self._execute_job(
            job.job_id,
            intent,
            auto_iterate=auto_iterate,
            slot_kind=slot_kind,
            supervise=supervise,
            max_ticks=max_ticks,
        )

    def continue_job(
        self,
        job_id: str,
        intent: Intent,
        *,
        auto_iterate: bool = True,
        slot_kind: str = KIND_JOB,
        supervise: bool | None = None,
        max_ticks: int = 0,
    ) -> JobOutcome:
        """Setzt einen bestehenden Job mit einem vom Core entworfenen Intent fort."""
        return self._execute_job(
            job_id,
            intent,
            auto_iterate=auto_iterate,
            slot_kind=slot_kind,
            supervise=supervise,
            max_ticks=max_ticks,
        )

    def _compose_job_intent(self, **kwargs: Any) -> Intent:
        """Baut den Intent eines Jobs -- duenne Huelse, damit run_job lesbar bleibt.

        ``job_id``/``iteration``/``max_iterations`` kommen aus dem Job-Ledger: Das
        Ledger ist die Wahrheit ueber das Budget (bereits gedeckelt), nicht der
        Aufrufparameter.
        """
        job = kwargs.pop("job")
        kwargs.pop("max_iterations", None)
        return self.kernel.build_intent(job_id=job.job_id, iteration=1, max_iterations=job.max_iterations, **kwargs)

    def reclaim_orphans(self) -> list[JobRecord]:
        """Aktive Jobs ohne lebenden Agent-Slot sind Waisen (abgestuerzter Lauf).

        Sie werden eskaliert statt die Pipeline zu blockieren -- im Dev-Modus mit
        ``max_concurrent_jobs=1`` waere sonst jeder Absturz ein Stillstand.
        """
        live = {slot.job_id for slot in self.agents.busy() if not self.agents.is_stale(slot)}
        orphans: list[JobRecord] = []
        for record in self.jobs.list(limit=1000, active_only=True):
            if record.job_id in live:
                continue
            if not self.jobs.is_stale(record):
                continue
            orphans.append(
                self.jobs.finish(
                    record.job_id,
                    JOB_ESCALATED,
                    failure_kind=FAILURE_STALE,
                    outcome={
                        "reason": "Job war aktiv, hielt aber keinen Agent-Slot mehr und wurde "
                        f"seit {record.updated_at} nicht aktualisiert.",
                        "iterations": record.iteration,
                    },
                )
            )
        return orphans

    def _execute_job(
        self,
        job_id: str,
        intent: Intent,
        *,
        auto_iterate: bool,
        slot_kind: str = KIND_JOB,
        supervise: bool | None = None,
        max_ticks: int = 0,
    ) -> JobOutcome:
        try:
            return self._execute_job_loop(
                job_id,
                intent,
                auto_iterate=auto_iterate,
                slot_kind=slot_kind,
                supervise=supervise,
                max_ticks=max_ticks,
            )
        except Exception as exc:
            record = self.jobs.get(job_id)
            if record is not None and record.is_active:
                self.jobs.finish(
                    job_id,
                    JOB_ESCALATED,
                    failure_kind=FAILURE_INTERNAL,
                    outcome={"reason": f"{type(exc).__name__}: {exc}", "iterations": record.iteration},
                )
            self._emit("job.aborted", {"error": f"{type(exc).__name__}: {exc}"}, job_id=job_id)
            raise

    def _execute_job_loop(
        self,
        job_id: str,
        intent: Intent,
        *,
        auto_iterate: bool,
        slot_kind: str = KIND_JOB,
        supervise: bool | None = None,
        max_ticks: int = 0,
    ) -> JobOutcome:
        attempts: list[Attempt] = []
        current = intent
        job = self.jobs.require(job_id)
        watch: dict[str, Any] = {}
        watch_summary: dict[str, Any] = {}  # bleibt ueber alle Durchgaenge erhalten

        while True:
            job = self.jobs.begin_iteration(job_id, operation=current.operation, limb=current.target_limb)
            self._emit(
                "job.iteration.started",
                {"iteration": job.iteration, "max_iterations": job.max_iterations, "operation": current.operation, "limb": current.target_limb},
                current,
                job_id=job_id,
            )

            # Ueberwacht wird, was eine Uhr trackt oder Ausloeser hat --
            # ausdruecklich erzwungen oder verboten werden kann es per Parameter.
            wants_supervision = bool(current.schedule.triggers) or current.timer.unlimited
            use_supervision = wants_supervision if supervise is None else bool(supervise)
            if use_supervision:
                handle = self.spawn_async(current, job=job, slot_kind=slot_kind)
                if isinstance(handle, Attempt):
                    attempt = handle  # vor dem Start abgelehnt
                else:
                    attempt, watch = self._supervise(handle, job_id=job_id, max_ticks=max_ticks)
                    watch_summary = dict(watch)
                    self._emit(
                        "loop.supervised",
                        {
                            "ticks": watch.get("ticks", 0),
                            "due_actions": watch.get("due_actions", 0),
                            "scheduled_jobs": watch.get("scheduled_jobs", []),
                            "finish_requested": watch.get("finish_requested", False),
                            "needs_human": watch.get("needs_human", False),
                            "t_unlimited_s": watch.get("t_unlimited_s", 0.0),
                        },
                        current,
                        job_id=job_id,
                        clock_s=watch.get("t_unlimited_s", 0.0),
                    )
            else:
                attempt = self.dispatch(current, job=job, slot_kind=slot_kind)
            attempts.append(attempt)

            job = self.jobs.record_iteration(
                job_id,
                IterationEntry(
                    iteration=attempt.iteration,
                    intent_id=attempt.intent.intent_id,
                    operation=attempt.intent.operation,
                    limb=attempt.intent.target_limb,
                    status=attempt.result.status,
                    verdict=attempt.verdict.decision,
                    error_code=attempt.result.error_code,
                    duration_ms=attempt.result.duration_ms,
                    timer_expired=attempt.verdict.timer_expired,
                    self_reported=attempt.result.timer.self_reported,
                    archive=self.config.relative(attempt.archive_dir) if attempt.archive_dir else "",
                    measure="",
                ),
            )

            # ---- Entscheidung des Zeitplans (Protokoll 1.2) ----
            # Ein finish_job-/escalate-Trigger beendet den Auftrag planmaessig.
            # Massgeblich ist dann der Zeitplan, nicht das (teilweise) Limb-Ergebnis:
            # Der Durchgang bleibt als Beweis in der Historie, aber der Job-Status
            # folgt der Entscheidung, die der Auftraggeber ueber die Uhr getroffen hat.
            if watch.get("finish_requested") or watch.get("needs_human"):
                by_trigger = watch.get("finish_requested")
                status = JOB_RESOLVED if by_trigger else JOB_ESCALATED
                kind = "" if by_trigger else FAILURE_ESCALATION
                outcome = {
                    "decided_by": "schedule",
                    "trigger_decision": "finish_job" if by_trigger else "escalate",
                    "t_unlimited_s": watch.get("t_unlimited_s"),
                    "ticks": watch.get("ticks"),
                    "due_actions": watch.get("due_actions"),
                    "scheduled_jobs": watch.get("scheduled_jobs", []),
                    "limb_status": attempt.result.status,
                    "limb_verdict": attempt.verdict.decision,
                    "intent_id": attempt.intent.intent_id,
                    "iteration": attempt.iteration,
                }
                job = self.jobs.finish(job_id, status, failure_kind=kind, outcome=outcome)
                self._emit(
                    "job.finished",
                    {"status": status, "decided_by": "schedule", "iterations": len(attempts), **{k: outcome[k] for k in ("t_unlimited_s", "ticks", "due_actions")}},
                    attempt.intent,
                    job_id=job_id,
                    clock_s=watch.get("t_unlimited_s"),
                )
                if self.scheduler.detach(job_id):
                    self._emit("schedule.detached", {"job_id": job_id}, attempt.intent, job_id=job_id)
                return JobOutcome(
                    job=job, attempts=tuple(attempts), status=status, failure_kind=kind,
                    measures=job.measures_taken, watch=watch_summary,
                )

            if attempt.ok:
                job = self.jobs.finish(
                    job_id,
                    JOB_RESOLVED,
                    outcome={
                        "intent_id": attempt.intent.intent_id,
                        "iteration": attempt.iteration,
                        "artifacts": [a.to_dict() for a in attempt.result.artifacts],
                        "duration_ms": sum(a.result.duration_ms for a in attempts),
                    },
                )
                self._emit(
                    "job.finished",
                    {
                        "status": JOB_RESOLVED,
                        "iterations": len(attempts),
                        "t_unlimited_s": attempt.result.timer.elapsed_s,
                        "ticks": watch.get("ticks", 0),
                        "due_actions": watch.get("due_actions", 0),
                        "scheduled_jobs": watch.get("scheduled_jobs", []),
                    },
                    attempt.intent,
                    job_id=job_id,
                    clock_s=attempt.result.timer.elapsed_s,
                )
                if watch:
                    self.scheduler.detach(job_id)
                return JobOutcome(
                    job=job, attempts=tuple(attempts), status=JOB_RESOLVED,
                    measures=job.measures_taken, watch=watch_summary,
                )

            diagnosis = self.planner.diagnose(attempt.intent, attempt.result, attempt.verdict)
            measure_available = self.planner.measure_available(diagnosis)
            has_budget, budget_reason = self.planner.budget_available(attempt.intent)
            can_plan, reason = self.planner.can_plan(attempt.intent, attempt.result, attempt.verdict, diagnosis=diagnosis)
            self._emit(
                "job.diagnosed",
                {
                    "diagnosis": diagnosis.to_dict(),
                    "measure_available": measure_available,
                    "budget_available": has_budget,
                    "budget_reason": budget_reason,
                    "can_iterate": can_plan,
                    "reason": reason,
                },
                attempt.intent,
                job_id=job_id,
            )

            if can_plan and auto_iterate and attempt.intent.job.on_failure == "autodidactic":
                # Massnahme ergriffen -> der Job ist per Definition NICHT failed.
                job = self.jobs.register_measure(job_id, diagnosis.measure)
                self._emit("job.measure", {"measure": diagnosis.measure[:600], "count": job.measures_taken}, attempt.intent, job_id=job_id)
                current = self.planner.compose(attempt.intent, attempt.result, attempt.verdict, diagnosis=diagnosis)
                self._emit(
                    "job.iteration.planned",
                    {"next_intent_id": current.intent_id, "iteration": current.iteration, "operation": current.operation},
                    current,
                    job_id=job_id,
                )
                continue

            if diagnosis.escalate:
                status, kind = JOB_ESCALATED, FAILURE_ESCALATION
                outcome = {"reason": diagnosis.escalation_reason or reason, "diagnosis": diagnosis.to_dict()}
            elif can_plan and not auto_iterate:
                status, kind = JOB_ESCALATED, FAILURE_ESCALATION
                outcome = {"reason": "auto_iterate=false: Massnahme identifiziert, aber nicht ausgefuehrt.", "measure": diagnosis.measure}
            else:
                status, kind = self.jobs.decide_after_failure(job_id, measure_available=measure_available, iteration=attempt.iteration)
                outcome = {
                    "reason": reason,
                    "measure_available": measure_available,
                    "budget_available": has_budget,
                    "identified_measure": diagnosis.measure,
                    "diagnosis": diagnosis.to_dict(),
                    "measures_taken": job.measures_taken,
                }

            if watch:
                outcome = {
                    **outcome,
                    "t_unlimited_s": watch.get("t_unlimited_s"),
                    "ticks": watch.get("ticks"),
                    "due_actions": watch.get("due_actions"),
                    "scheduled_jobs": watch.get("scheduled_jobs", []),
                }
            job = self.jobs.finish(job_id, status, failure_kind=kind, outcome=outcome)
            self._emit(
                "job.finished",
                {
                    "status": status,
                    "failure_kind": kind,
                    "iterations": len(attempts),
                    "measures_taken": job.measures_taken,
                    "t_unlimited_s": watch.get("t_unlimited_s", attempt.result.timer.elapsed_s),
                    "ticks": watch.get("ticks", 0),
                },
                attempt.intent,
                job_id=job_id,
                clock_s=attempt.result.timer.elapsed_s,
            )
            if watch:
                self.scheduler.detach(job_id)
            return JobOutcome(
                job=job, attempts=tuple(attempts), status=status, failure_kind=kind,
                measures=job.measures_taken, watch=watch_summary,
            )

    # =====================================================================
    # Durchgangs-Ebene: ein Intent -> ein Result
    # =====================================================================
    def dispatch(self, intent: Intent, *, job: JobRecord | None = None, slot_kind: str = KIND_JOB) -> Attempt:
        """Ein einzelner Durchgang (synchron). Kein Retry -- Retries sind Job-Iterationen."""
        prepared = self._prepare_dispatch(intent, job=job, slot_kind=slot_kind)
        if isinstance(prepared, Attempt):
            return prepared  # vor dem Start abgelehnt: kein Limb, keine Uhr, kein Budgetverbrauch
        try:
            result, spawned, returncode = self._spawn(prepared.spec, prepared.intent, inbox_file=prepared.inbox_file)
        finally:
            self._release_slot(prepared)
        return self._finalize_attempt(prepared, result, spawned=spawned, returncode=returncode)

    def _prepare_dispatch(self, intent: Intent, *, job: JobRecord | None = None, slot_kind: str = KIND_JOB) -> PreparedDispatch | Attempt:
        """Klaert alles vor dem Limb-Start: Job, Register, Policy, Timer, Slot, Inbox.

        Liefert entweder ein ``PreparedDispatch`` (Slot ist belegt, Intent liegt in
        der Inbox) oder -- bei Ablehnung -- direkt ein fertiges ``Attempt``, ohne
        dass ein Prozess gestartet wurde.
        """
        job_record = job or self.jobs.get(intent.job_id)
        if job_record is None:
            # Ein aus dem Intent nachgetragener Job erbt dessen Zeit-Modus:
            # unlimited bleibt unlimited (sonst entstünden zwei Wahrheiten
            # ueber denselben Auftrag -- Ledger sagt 60s, Intent sagt unlimited).
            job_record = self.jobs.create(
                intent.job.goal or intent.operation,
                max_iterations=intent.job.max_iterations,
                deadline_s=intent.timer.deadline_s,
                timer_mode=intent.timer.mode,
                kind=JOB_KIND_SCHEDULED if slot_kind == KIND_SCHEDULED else JOB_KIND_TASK,
                job_id=intent.job_id,
            )
            job_record = self.jobs.begin_iteration(job_record.job_id, operation=intent.operation, limb=intent.target_limb)

        # Eine Uhr pro Auftrag -- und zwar ab dem **ersten** Event: Wer spaeter
        # korreliert (Phase 3), soll nicht raten muessen, welcher Event vor der
        # Schaerfung entstand.
        intent = bind_job_clock(intent, job_record.created_at)

        self._emit(
            "intent.accepted",
            {
                "operation": intent.operation,
                "limb": intent.target_limb,
                "iteration": intent.iteration,
                "elevation": intent.elevation.level,
                "timer_mode": intent.timer.mode,
                "deadline_s": intent.timer.deadline_s,
                "safety_net_s": intent.timer.safety_net_s,
                "slot_kind": slot_kind,
            },
            intent,
            job_id=intent.job_id,
        )

        spec = self.registry.get(intent.target_limb)
        if spec is None:
            return self._short_circuit(intent, ErrorCode.TARGET_NOT_FOUND, f"Limb '{intent.target_limb}' ist nicht in limbs/registry.json registriert.", hint=f"Bekannte Limbs: {', '.join(self.registry.names())}")
        if not spec.usable:
            return self._short_circuit(intent, ErrorCode.TARGET_NOT_FOUND, f"Limb '{intent.target_limb}' hat Status '{spec.status}' und darf nicht gestartet werden.", hint="Status in limbs/registry.json auf 'active' setzen, sobald der Limb implementiert ist.")
        if not spec.entrypoint.is_file():
            return self._short_circuit(intent, ErrorCode.TARGET_NOT_FOUND, f"Entrypoint fehlt: {self.config.relative(spec.entrypoint)}", hint="Register und Dateisystem stimmen nicht ueberein.")

        decision = self.policy.check(intent, job=job_record)
        self._emit("policy.decided", decision.to_dict(), intent, job_id=intent.job_id)
        if not decision.allowed:
            return self._short_circuit(intent, decision.code, decision.reason, decision=decision, hint="Intent anpassen (Rechte, Pfade, Operation, Budget).")

        # ---- Timer VOR Anbeginn schaerfen (Uhr ist bereits auf den Job gebunden) ----
        armed_intent = arm_timer(intent, config=self.config)
        hard_timeout = armed_intent.timer.hard_timeout_s()
        self._emit(
            "timer.armed",
            {
                "mode": armed_intent.timer.mode,
                "t0": armed_intent.timer.t0,
                "armed_at": armed_intent.timer.armed_at,
                "soft_expires_at": armed_intent.timer.soft_expires_at,
                "expires_at": armed_intent.timer.expires_at,
                "deadline_s": armed_intent.timer.deadline_s,
                "soft_deadline_s": armed_intent.timer.soft_deadline_s,
                "grace_s": armed_intent.timer.grace_s,
                "safety_net_s": armed_intent.timer.safety_net_s,
                "hard_timeout_s": hard_timeout,
                "triggers": [t.id for t in armed_intent.schedule.triggers],
            },
            armed_intent,
            job_id=armed_intent.job_id,
        )

        # ---- Agent-Slot (Dev-Modus: genau einer pro Art) ----
        # Unlimited hat keine Deadline, aus der sich eine TTL ableiten liesse:
        # Dann gilt das Safety-Netz, und der ueberwachte Ablauf verlaengert die
        # Frist pro Tick (AgentPool.renew + JobStore.heartbeat).
        ttl = hard_timeout + 5.0 if hard_timeout else max(60.0, self.config.timer.tick_s * 24)
        try:
            slot = self.agents.acquire(job_id=armed_intent.job_id, ttl_s=ttl, kind=slot_kind)
        except NoSlotAvailable as exc:
            return self._short_circuit(
                armed_intent,
                ErrorCode.POLICY_DENIED,
                str(exc),
                hint=f"Profil anheben (orchestrator scale --profile scale --approved-by human) oder warten. Belegt: {json.dumps(exc.busy, ensure_ascii=False)}",
            )
        self._emit("agent.lock.acquired", slot.to_dict(), armed_intent, job_id=armed_intent.job_id)

        inbox_file = self.transport.submit(armed_intent, iteration=armed_intent.iteration)
        return PreparedDispatch(
            intent=armed_intent,
            spec=spec,
            decision=decision,
            job=job_record,
            inbox_file=inbox_file,
            slot=slot,
            slot_kind=slot_kind,
            hard_timeout_s=hard_timeout,
        )

    def _release_slot(self, prepared: PreparedDispatch) -> None:
        self.agents.release(prepared.slot)
        self._emit("agent.lock.released", {"index": prepared.slot.index, "kind": prepared.slot.kind}, prepared.intent, job_id=prepared.intent.job_id)

    def _finalize_attempt(self, prepared: PreparedDispatch, result: Result, *, spawned: bool, returncode: int | None) -> Attempt:
        """Result einsammeln, bewerten, archivieren -- fuer beide Pfade identisch."""
        armed_intent = prepared.intent
        spec = prepared.spec
        self._emit(
            "result.recorded",
            {
                "status": result.status,
                "iteration": result.iteration,
                "duration_ms": result.duration_ms,
                "timer_mode": result.timer.mode,
                "elapsed_s": result.timer.elapsed_s,
                "artifacts": [a.to_dict() for a in result.artifacts],
                "status_report": result.status_report.to_dict() if result.status_report else None,
                "error": result.error,
            },
            armed_intent,
            job_id=armed_intent.job_id,
            limb=spec.name,
        )

        verdict = self.kernel.evaluate(armed_intent, result)
        self._emit("result.verdict", {"decision": verdict.decision, "reasons": list(verdict.reasons), "next_action": verdict.next_action}, armed_intent, job_id=armed_intent.job_id, limb=spec.name)

        archive_dir = self.transport.archive(armed_intent, result, {"verdict": verdict.to_dict(), "iteration": armed_intent.iteration})
        self._emit("transport.archived", {"dir": self.config.relative(archive_dir)}, armed_intent, job_id=armed_intent.job_id, limb=spec.name)

        # Die Inbox-Datei ist zugestellt und archiviert -> weg damit, sonst wuerde
        # `loop --once` denselben Durchgang erneut ausfuehren.
        self.transport.consume(prepared.inbox_file)

        diagnosis = None if verdict.accepted else self.planner.diagnose(armed_intent, result, verdict)

        return Attempt(
            iteration=armed_intent.iteration,
            intent=armed_intent,
            result=result,
            verdict=verdict,
            decision=prepared.decision,
            spawned=spawned,
            returncode=returncode,
            inbox_file=prepared.inbox_file,
            archive_dir=archive_dir,
            diagnosis=diagnosis,
        )

    def dispatch_raw(self, raw: str | bytes | Mapping[str, Any]) -> Attempt:
        if isinstance(raw, Mapping):
            intent = Intent.from_dict(dict(raw), operations=self.operations)
        else:
            intent = Intent.from_json(raw, operations=self.operations)
        return self.dispatch(intent)

    def dispatch_file(self, path: Path | str) -> Attempt:
        file_path = Path(path)
        if not file_path.is_file():
            raise ProtocolError(ErrorCode.PATH_NOT_FOUND, f"Intent-Datei nicht gefunden: {file_path}")
        return self.dispatch_raw(file_path.read_text(encoding="utf-8"))

    def run_inbox_once(self, *, consume: bool = True) -> list[Attempt]:
        """Abarbeitungs-Modus: alle offenen Intents der Inboxen dispatchen."""
        attempts: list[Attempt] = []
        for pending in self.transport.drain_inbox():
            try:
                attempt = self.dispatch_file(pending)
            except ProtocolError as exc:
                self._emit("inbox.rejected", {"file": str(pending), "code": exc.code, "message": exc.message})
                continue
            attempts.append(attempt)
            if consume:
                self.transport.consume(pending)
        self._emit("loop.tick", {"processed": len(attempts)})
        return attempts

    # =====================================================================
    # Intern
    # =====================================================================
    def _spawn(self, spec: LimbSpec, intent: Intent, *, inbox_file: Path) -> tuple[Result, bool, int | None]:
        argv = self.registry.argv(spec, intent_file=inbox_file, iteration=intent.iteration)
        env = {**os.environ, "NEU_ROOT": str(self.config.repo_root), "PYTHONIOENCODING": "utf-8"}
        started_at = utc_now_iso()
        hard_timeout = intent.timer.hard_timeout_s()
        self._emit("limb.spawned", {"argv": argv, "hard_timeout_s": hard_timeout}, intent, job_id=intent.job_id, limb=spec.name)

        try:
            completed = subprocess.run(
                argv,
                cwd=str(self.config.repo_root),
                env=env,
                capture_output=True,
                text=True,
                timeout=hard_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _decode(exc.stdout)
            stderr = _decode(exc.stderr)
            if intent.timer.unlimited:
                # Kein Aufgabenlimit verletzt: Das Safety-Netz hat den Prozess
                # beendet (Hygiene). Eskalation statt 2. Durchgang.
                result = self._safety_net_result(intent, started_at, stdout=stdout, stderr=stderr, exit_code=None, hard_kill=True)
                self._emit(
                    "timer.safety_net",
                    {"hard_kill": True, "after_s": hard_timeout, "elapsed_s": intent.timer.elapsed(), "t0": intent.timer.t0},
                    intent,
                    job_id=intent.job_id,
                    limb=spec.name,
                    clock_s=intent.timer.elapsed(),
                )
            else:
                result = self._timeout_result(intent, started_at, stdout=stdout, stderr=stderr, hard_kill=True)
                self._emit("timer.expired", {"hard_kill": True, "after_s": hard_timeout}, intent, job_id=intent.job_id, limb=spec.name)
            return result, True, None
        except (OSError, ValueError) as exc:
            result = self._synthetic(
                intent,
                "failed",
                ErrorCode.LIMB_CRASH,
                f"Limb konnte nicht gestartet werden: {exc}",
                hint="Entrypoint und Laufzeitumgebung pruefen.",
                started_at=started_at,
            )
            return result, False, None

        return self._parse_child_output(
            intent,
            stdout=completed.stdout,
            stderr=completed.stderr,
            returncode=completed.returncode,
            started_at=started_at,
        )

    def _parse_child_output(
        self,
        intent: Intent,
        *,
        stdout: str,
        stderr: str,
        returncode: int | None,
        started_at: str,
    ) -> tuple[Result, bool, int | None]:
        """Macht aus Limb-Ausgabe ein protokollkonformes Result.

        Geteilt von synchronem und ueberwachtem Pfad, damit beide exakt dieselbe
        Auswertung nutzen (kein Drift zwischen ``dispatch`` und ``collect_async``).
        """
        parsed = _extract_json_object(stdout)
        if parsed is None:
            overrun = _overrun_ms(intent)
            if overrun > 0:
                # Limb wurde vermutlich von der eigenen Uhr gestoppt, lieferte aber nichts
                self._emit("timer.expired", {"hard_kill": False, "overrun_ms": overrun}, intent, job_id=intent.job_id, limb=intent.target_limb)
                return self._timeout_result(intent, started_at, stdout=stdout, stderr=stderr, hard_kill=False, exit_code=returncode), True, returncode
            result = self._synthetic(
                intent,
                "failed",
                ErrorCode.LIMB_CRASH,
                f"Limb lieferte kein gueltiges Result auf stdout (exit={returncode}).",
                hint="Ein Limb darf auf stdout nur genau ein JSON-Objekt schreiben; Logs gehoeren nach stderr.",
                started_at=started_at,
                stdout=stdout,
                stderr=stderr,
                exit_code=returncode,
            )
            return result, True, returncode

        try:
            result = Result.from_dict(parsed, intent=intent)
        except ProtocolError as exc:
            return (
                self._synthetic(
                    intent,
                    "rejected",
                    exc.code,
                    f"Result des Limbs verletzt das Protokoll: {exc.message}",
                    hint=f"Pfad {exc.path}",
                    started_at=started_at,
                    stdout=stdout,
                    stderr=stderr,
                    exit_code=returncode,
                ),
                True,
                returncode,
            )

        if returncode != 0 and result.status == "success":
            result = Result.from_dict(
                {
                    **result.to_dict(),
                    "status": "failed",
                    "error": {
                        "code": ErrorCode.LIMB_CRASH,
                        "message": f"Limb meldete Erfolg, beendete sich aber mit Exit-Code {returncode}.",
                        "hint": "stderr pruefen.",
                    },
                    "diagnostics": {**result.to_dict()["diagnostics"], "exit_code": returncode},
                },
                intent=intent,
            )
        return result, True, returncode

    def _timeout_result(self, intent: Intent, started_at: str, *, stdout: str, stderr: str, hard_kill: bool, exit_code: int | None = None) -> Result:
        """Statusbericht bei Timer-Ablauf -- vom Orchestrator erzwungen."""
        now = utc_now()
        expires = intent.timer.expires_at
        overrun = _overrun_ms(intent, now=now)
        explanation = (
            f"Timer abgelaufen: Budget {intent.timer.deadline_s}s (soft {intent.timer.soft_deadline_s}s) war ausgeschöpft, "
            f"als der Orchestrator den Durchgang {'hart abbrach' if hard_kill else 'als ueberzogen erkannte'}. "
            f"Der Limb hat in diesem Durchgang {'keinen' if hard_kill else 'keinen vollstaendigen'} Abschlussbericht geliefert."
        )
        report = StatusReport(
            state="timeout",
            explanation=explanation,
            done=("Timer wurde vor Anbeginn geschaerft und ueberwacht.",),
            remaining=(
                f"Auftrag '{intent.task.title or intent.operation}' ist in einem Durchgang nicht abschliessbar.",
                "Offener Umfang muss im naechsten Durchgang verkleinert werden.",
            ),
            blockers=(
                {
                    "code": ErrorCode.TIMEOUT,
                    "message": f"Zeitbudget {intent.timer.deadline_s}s ueberschritten (Ueberzug {overrun} ms).",
                    "hint": "deadline_s anheben oder Auftrag in kleinere, pruefbare Schritte teilen.",
                },
            ),
            suggested_next="Zweiter Durchgang mit verkleinertem Umfang und angepasstem Timer.",
        )
        payload = {
            "protocol": "neu/result",
            "version": PROTOCOL_VERSION,
            "result_id": new_id("res"),
            "intent_id": intent.intent_id,
            "trace_id": intent.trace_id,
            "job_id": intent.job_id,
            "iteration": intent.iteration,
            "status": "timeout",
            "operation": intent.operation,
            "limb": {"name": intent.target_limb, "version": "0.0.0", "pid": 0},
            "started_at": started_at,
            "finished_at": format_timestamp(now),
            "duration_ms": max(0, int((now - _parse_or_now(intent.timer.armed_at)).total_seconds() * 1000)),
            "output": {"synthesized_by": "orchestrator", "hard_kill": hard_kill},
            "artifacts": [],
            "status_report": report.to_dict(),
            "timer": {
                "armed_at": intent.timer.armed_at,
                "expires_at": expires,
                "reported_at": format_timestamp(now),
                "remaining_ms": -overrun,
                "overrun_ms": overrun,
                "self_reported": False,
            },
            "diagnostics": {"stdout": stdout[-65536:], "stderr": stderr[-65536:], "exit_code": exit_code},
            "error": {
                "code": ErrorCode.TIMEOUT,
                "message": explanation,
                "hint": "Autodidaktischer Modus entwirft den zweiten Durchgang.",
            },
            "self_report": {"confidence": 0.0, "notes": "Vom Orchestrator erzwungener Statusbericht nach Timer-Ablauf."},
        }
        return Result.from_dict(payload, intent=intent)

    def _safety_net_result(
        self,
        intent: Intent,
        started_at: str,
        *,
        stdout: str,
        stderr: str,
        exit_code: int | None,
        hard_kill: bool,
    ) -> Result:
        """Statusbericht, wenn das Safety-Netz einen Prozess beendet.

        Wichtig fuer die Semantik: Das ist **kein** abgelaufenes Aufgabenlimit
        (``E_TIMEOUT``), sondern Prozess-Hygiene (``E_SAFETY_NET``). Der Auftrag
        hatte keins -- deshalb wird eskaliert (zerlegen oder ``safety_net_s``
        bewusst anheben), statt einen 2. Durchgang zu starten, der dieselbe Uhr
        erneut ueberlaufen wuerde.
        """
        now = utc_now()
        elapsed = intent.timer.elapsed()
        net = intent.timer.safety_net_s
        explanation = (
            f"Safety-Netz ausgeloesst: Der Limb-Prozess lief laenger als {net}s und wurde vom Orchestrator "
            f"{'hart beendet' if hard_kill else 'als ueberlaeufig erkannt'} (t_unlimited={elapsed}s, t0={intent.timer.t0}). "
            "Es bestand kein Zeitlimit fuer die Aufgabe; der Abbruch dient der Prozess-Hygiene (Zombie-Schutz)."
        )
        report = StatusReport(
            state="blocked",
            explanation=explanation,
            done=("Timer im Unlimited-Modus geschaerft: Zeit wurde getrackt, nicht begrenzt.",
                  "Safety-Netz ueberwacht und ausgeloesst."),
            remaining=(
                f"Auftrag '{intent.task.title or intent.operation}' laeuft laenger als ein Prozessfenster.",
                "Zerlegung in Teilauftraege oder bewusste Anhebung von safety_net_s (menschenpflichtige Konfiguration).",
            ),
            blockers=(
                {
                    "code": ErrorCode.SAFETY_NET,
                    "message": f"Safety-Netz bei {net}s; t_unlimited={elapsed}s.",
                    "hint": "Eskalieren: Auftrag zerlegen oder safety_net_s anheben.",
                },
            ),
            suggested_next="An Core/Mensch eskalieren -- kein zweiter Durchgang mit derselben Uhr.",
        )
        payload = {
            "protocol": "neu/result",
            "version": PROTOCOL_VERSION,
            "result_id": new_id("res"),
            "intent_id": intent.intent_id,
            "trace_id": intent.trace_id,
            "job_id": intent.job_id,
            "iteration": intent.iteration,
            "status": "failed",
            "operation": intent.operation,
            "limb": {"name": intent.target_limb, "version": "0.0.0", "pid": 0},
            "started_at": started_at,
            "finished_at": format_timestamp(now),
            "duration_ms": max(0, int((now - _parse_or_now(intent.timer.armed_at)).total_seconds() * 1000)),
            "output": {"synthesized_by": "orchestrator", "safety_net": True, "hard_kill": hard_kill, "elapsed_s": elapsed},
            "artifacts": [],
            "status_report": report.to_dict(),
            "timer": {
                "mode": intent.timer.mode,
                "t0": intent.timer.t0,
                "armed_at": intent.timer.armed_at,
                "expires_at": None,
                "reported_at": format_timestamp(now),
                "elapsed_s": elapsed,
                "remaining_ms": None,
                "overrun_ms": 0,
                "self_reported": False,
            },
            "diagnostics": {"stdout": stdout[-65536:], "stderr": stderr[-65536:], "exit_code": exit_code},
            "error": {
                "code": ErrorCode.SAFETY_NET,
                "message": explanation,
                "hint": report.suggested_next,
            },
            "self_report": {"confidence": 0.0, "notes": "Vom Orchestrator synthetisiert: Safety-Netz (Prozess-Hygiene), kein Aufgabenlimit."},
        }
        return Result.from_dict(payload, intent=intent)

    # =====================================================================
    # Ueberwachter (asynchroner) Pfad -- Protokoll 1.2
    # =====================================================================
    def spawn_async(
        self,
        intent: Intent,
        *,
        job: JobRecord | None = None,
        slot_kind: str = KIND_JOB,
        parent_job_id: str = "",
        trigger_id: str = "",
    ) -> SpawnHandle | Attempt:
        """Startet einen Limb, ohne auf ihn zu warten.

        Noetig fuer ``timer.mode="unlimited"`` und fuer ``schedule.triggers``:
        Der Orchestrator muss ticken koennen, *waehrend* der Limb laeuft.
        Liefert bei Ablehnung (Register, Policy, Slot) ein fertiges ``Attempt``.
        """
        prepared = self._prepare_dispatch(intent, job=job, slot_kind=slot_kind)
        if isinstance(prepared, Attempt):
            return prepared

        argv = self.registry.argv(prepared.spec, intent_file=prepared.inbox_file, iteration=prepared.intent.iteration)
        env = {**os.environ, "NEU_ROOT": str(self.config.repo_root), "PYTHONIOENCODING": "utf-8"}
        started_at = utc_now_iso()
        net = prepared.intent.timer.hard_timeout_s()
        try:
            process = subprocess.Popen(
                argv,
                cwd=str(self.config.repo_root),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except (OSError, ValueError) as exc:
            self._release_slot(prepared)
            result = self._synthetic(
                prepared.intent,
                "failed",
                ErrorCode.LIMB_CRASH,
                f"Limb konnte nicht gestartet werden: {exc}",
                hint="Entrypoint und Laufzeitumgebung pruefen.",
                started_at=started_at,
            )
            return self._finalize_attempt(prepared, result, spawned=False, returncode=None)

        handle = SpawnHandle(
            prepared=prepared,
            process=process,
            argv=tuple(argv),
            started_at=started_at,
            started_monotonic=time.monotonic(),
            net_deadline_monotonic=None if net is None else time.monotonic() + net,
            parent_job_id=parent_job_id,
            trigger_id=trigger_id,
        )
        self._emit(
            "limb.spawned",
            {
                "argv": list(argv),
                "pid": process.pid,
                "async": True,
                "timer_mode": prepared.intent.timer.mode,
                "hard_timeout_s": net,
                "triggers": [t.id for t in prepared.intent.schedule.triggers],
            },
            prepared.intent,
            job_id=prepared.intent.job_id,
            limb=prepared.spec.name,
        )
        return handle

    def collect_async(self, handle: SpawnHandle) -> Attempt | None:
        """Erntet einen gestarteten Limb; ``None`` = laeuft noch.

        Ueberwacht dabei das Safety-Netz: Haengt der Prozess laenger als
        ``safety_net_s``, wird er beendet und der Bericht synthetisiert
        (``E_SAFETY_NET``) -- auch dann, wenn der Limb selbst nichts mehr meldet.
        """
        returncode = handle.process.poll()
        if returncode is None:
            if handle.net_deadline_monotonic is not None and time.monotonic() >= handle.net_deadline_monotonic:
                stdout, stderr, code = self._terminate_child(handle, reason="safety_net")
                result = self._safety_net_result(
                    handle.intent,
                    handle.started_at,
                    stdout=stdout,
                    stderr=stderr,
                    exit_code=code,
                    hard_kill=True,
                )
                self._emit(
                    "timer.safety_net",
                    {"hard_kill": True, "elapsed_s": handle.intent.timer.elapsed(), "ticks": handle.ticks},
                    handle.intent,
                    job_id=handle.job_id,
                    limb=handle.prepared.spec.name,
                    clock_s=handle.intent.timer.elapsed(),
                )
                self._release_slot(handle.prepared)
                return self._finalize_attempt(handle.prepared, result, spawned=True, returncode=code)
            return None

        stdout = handle.process.stdout.read() if handle.process.stdout else ""
        stderr = handle.process.stderr.read() if handle.process.stderr else ""
        self._close_child_streams(handle)  # fd-Hygiene: watch-Schleifen laufen stundenlang
        result, spawned, code = self._parse_child_output(
            handle.intent,
            stdout=stdout,
            stderr=stderr,
            returncode=returncode,
            started_at=handle.started_at,
        )
        self._release_slot(handle.prepared)
        return self._finalize_attempt(handle.prepared, result, spawned=spawned, returncode=code)

    @staticmethod
    def _close_child_streams(handle: SpawnHandle) -> None:
        """Kind-Kanaele schliessen, sobald ihr Inhalt gelesen wurde.

        Ohne diesen Schritt haengt jeder geerntete Versuch einen Dateideskriptor
        an -- in einer unbegrenzt laufenden ``watch``-Schleife (Protokoll 1.2)
        genau der falsche Ort fuer ein Leck. ``communicate()`` schliesst seine
        Kanaele selbst, der normale Ernte-Pfad nicht.
        """
        for stream in (handle.process.stdout, handle.process.stderr, handle.process.stdin):
            with contextlib.suppress(Exception):
                if stream is not None:
                    stream.close()

    def _terminate_child(self, handle: SpawnHandle, *, reason: str) -> tuple[str, str, int | None]:
        """Beendet einen Limb-Prozess geordnet: SIGTERM, Nachfrist, SIGKILL."""
        grace = max(1.0, handle.intent.timer.grace_s)
        # Prozess kann bereits weg sein (Race) -- dann ist SIGTERM ueberfluessig.
        with contextlib.suppress(OSError, ValueError):
            handle.process.send_signal(signal.SIGTERM)
        try:
            stdout, stderr = handle.process.communicate(timeout=grace)
        except subprocess.TimeoutExpired:
            handle.process.kill()
            stdout, stderr = handle.process.communicate()
        self._emit(
            "limb.terminated",
            {"reason": reason, "pid": handle.pid, "returncode": handle.process.returncode, "elapsed_s": handle.intent.timer.elapsed()},
            handle.intent,
            job_id=handle.job_id,
            limb=handle.prepared.spec.name,
            clock_s=handle.intent.timer.elapsed(),
        )
        return _decode(stdout), _decode(stderr), handle.process.returncode

    def _supervise(self, handle: SpawnHandle, *, job_id: str, max_ticks: int = 0) -> tuple[Attempt, dict[str, Any]]:
        """Betreut einen laufenden Limb: tickt, feuert Trigger, erntet das Result.

        Der beobachtete Auftrag behaelt dabei sein Iterations-Budget --
        Kontrollen laufen als eigene Jobs (``kind="scheduled"``) mit eigenem
        Slot-Kontingent und verbrauchen es nicht.
        """
        state = self.scheduler.attach(
            handle.intent,
            t0=handle.prepared.job.created_at,
            force=handle.intent.timer.unlimited,
        )
        summary: dict[str, Any] = {
            "ticks": 0,
            "due_actions": 0,
            "scheduled_jobs": [],
            "finish_requested": False,
            "needs_human": False,
            "t_unlimited_s": 0.0,
            "state": None,
        }
        tick_s = max(0.01, handle.intent.schedule.tick_s)
        renew_s = max(30.0, tick_s * 12)
        tick_event_every = max(1, round(1.0 / tick_s))  # ~1 Tick-Event pro Sekunde

        try:
            return self._supervise_loop(handle, job_id=job_id, state=state, summary=summary, max_ticks=max_ticks,
                                        tick_s=tick_s, renew_s=renew_s, tick_event_every=tick_event_every)
        except BaseException as exc:
            # Kein verwaister Prozess, kein belegter Slot: Bricht die Ueberwachung
            # ab (auch durch KeyboardInterrupt), wird der Limb geordnet beendet.
            if handle.running:
                # Aufraeumen darf den urspruenglichen Fehler nicht ueberdecken.
                with contextlib.suppress(Exception):
                    self._terminate_child(handle, reason=f"supervise_aborted:{type(exc).__name__}")
            self._release_slot(handle.prepared)
            raise

    def _supervise_loop(
        self,
        handle: SpawnHandle,
        *,
        job_id: str,
        state: ScheduleState | None,
        summary: dict[str, Any],
        max_ticks: int,
        tick_s: float,
        renew_s: float,
        tick_event_every: int,
    ) -> tuple[Attempt, dict[str, Any]]:
        """Die Tick-Schleife selbst -- getrennt, damit die Aufraeum-Garantie haelt."""
        while True:
            attempt = self.collect_async(handle)
            if attempt is not None:
                summary["t_unlimited_s"] = attempt.result.timer.elapsed_s
                summary["state"] = self.scheduler.report(job_id) if state else None
                return attempt, summary

            summary["ticks"] += 1
            handle.ticks += 1

            # Lebenszeichen: Slot-Frist und Job-Heartbeat erneuern, damit eine
            # langlaufende Beobachtung nicht als Waise eskaliert wird.  Beide
            # Fristen (Slot-TTL ``renew_s`` >= 30 s, Stale-Schwelle
            # ``tick_s * 12 + 25`` >= 30 s) sind ein Vielfaches der Tick-Dauer;
            # ein Plattenzugriff pro Tick ist reine Write-Amplifikation
            # (Bolt: gemessen ~0,6 ms/Tick fuer renew + heartbeat, ca. 36 % der
            # Tick-Kosten). Renewal alle ``renew_s / 5`` Sekunden haelt die
            # Frist immer mindestens ~4/5 * ``renew_s`` in der Zukunft (plus
            # PID-Liveness-Check als zweite Sicherung) -- bei tick_s = 0,5 s
            # faellt der Write auf 1 pro 12 Ticks (~92 % weniger).
            lifecycle_every = max(1, int((renew_s / 5.0) / tick_s))
            clock = state.elapsed_s() if state is not None else handle.intent.timer.elapsed()
            if summary["ticks"] % lifecycle_every == 0:
                self.agents.renew(handle.prepared.slot, ttl_s=renew_s)
                self.jobs.heartbeat(job_id, note=f"tick={summary['ticks']} t_unlimited={clock}s")

            fired_this_tick = 0
            started_this_tick = 0
            if state is not None:
                for action in self.scheduler.tick(state):
                    fired_this_tick += 1
                    summary["due_actions"] += 1
                    handle.due_actions += 1
                    outcome = self.execute_due_action(
                        action,
                        parent_job_id=job_id,
                        limb=handle.intent.target_limb,
                        started_this_tick=started_this_tick,
                    )
                    for scheduled in outcome.get("scheduled_jobs", []):
                        summary["scheduled_jobs"].append(scheduled)
                        if scheduled.get("status") != "skipped":
                            started_this_tick += 1
                    if outcome.get("finish_requested"):
                        summary["finish_requested"] = True
                    if outcome.get("needs_human"):
                        summary["needs_human"] = True

            # Zeit-Tracking ist der Zweck des Unlimited-Modus, aber ein Event pro
            # Tick wuerde bei 0,5 s und einer Stunde Laufzeit 7200 Zeilen schreiben.
            # Deshalb: erster Tick, jeder Tick mit Feuerung und sonst ~1/s. Der
            # vollstaendige Verlauf bleibt persistiert (runtime/schedules/*.json).
            if summary["ticks"] == 1 or fired_this_tick or summary["ticks"] % tick_event_every == 0:
                self._emit(
                    "timer.tick",
                    {
                        "tick": summary["ticks"],
                        "t0": state.t0 if state else handle.intent.timer.t0,
                        "tick_s": tick_s,
                        "fired": fired_this_tick,
                        "active_triggers": [t.id for t in state.active_triggers()] if state else [],
                    },
                    handle.intent,
                    job_id=job_id,
                    clock_s=clock,
                )

            if summary["finish_requested"] or summary["needs_human"]:
                reason = "finish_job" if summary["finish_requested"] else "escalate"
                stdout, stderr, code = self._terminate_child(handle, reason=reason)
                result = self._scheduled_stop_result(handle, reason=reason, stdout=stdout, stderr=stderr, exit_code=code, elapsed_s=state.elapsed_s() if state else 0.0)
                self._release_slot(handle.prepared)
                attempt = self._finalize_attempt(handle.prepared, result, spawned=True, returncode=code)
                summary["t_unlimited_s"] = attempt.result.timer.elapsed_s
                summary["state"] = self.scheduler.report(job_id) if state else None
                return attempt, summary

            if max_ticks and summary["ticks"] >= max_ticks:
                stdout, stderr, code = self._terminate_child(handle, reason="max_ticks")
                result = self._scheduled_stop_result(handle, reason="max_ticks", stdout=stdout, stderr=stderr, exit_code=code, elapsed_s=state.elapsed_s() if state else 0.0)
                self._release_slot(handle.prepared)
                attempt = self._finalize_attempt(handle.prepared, result, spawned=True, returncode=code)
                summary["t_unlimited_s"] = attempt.result.timer.elapsed_s
                summary["state"] = self.scheduler.report(job_id) if state else None
                return attempt, summary

            time.sleep(tick_s)

    def _scheduled_stop_result(
        self,
        handle: SpawnHandle,
        *,
        reason: str,
        stdout: str,
        stderr: str,
        exit_code: int | None,
        elapsed_s: float,
    ) -> Result:
        """Ehrlicher Bericht, wenn der Zeitplan den Limb planmaessig stoppt.

        ``status="partial"`` (nicht ``success``): Der Beobachtungsauftrag ist
        erfuellt, aber der Limb hat seine Arbeit nicht selbst abgeschlossen.
        Erfunden wird hier nichts -- die Entscheidung liegt beim Job-Ablauf, der
        ``finish_job``/``escalate`` als solche verbucht.
        """
        now = utc_now()
        reason_text = {
            "finish_job": "Ein finish_job-Trigger hat den Auftrag planmaessig beendet.",
            "escalate": "Ein escalate-Trigger verlangt eine Entscheidung; die Beobachtung wurde gestoppt.",
            "max_ticks": "Das Tick-Limit der Ueberwachung war erreicht.",
        }.get(reason, reason)
        report = StatusReport(
            state="partial",
            explanation=f"{reason_text} t_unlimited={elapsed_s}s (t0={handle.intent.timer.t0}).",
            done=("Zeit wurde getrackt (unlimited) und der Zeitplan wurde ausgewertet.",),
            remaining=("Limb-Arbeit wurde durch den Zeitplan beendet, nicht durch den Limb selbst.",),
            blockers=(),
            suggested_next="Ergebnis der Kontroll-Jobs pruefen; ggf. Auftrag neu aufsetzen.",
        )
        payload = {
            "protocol": "neu/result",
            "version": PROTOCOL_VERSION,
            "result_id": new_id("res"),
            "intent_id": handle.intent.intent_id,
            "trace_id": handle.intent.trace_id,
            "job_id": handle.intent.job_id,
            "iteration": handle.intent.iteration,
            "status": "partial",
            "operation": handle.intent.operation,
            "limb": {"name": handle.intent.target_limb, "version": "0.0.0", "pid": handle.pid},
            "started_at": handle.started_at,
            "finished_at": format_timestamp(now),
            "duration_ms": max(0, int((now - _parse_or_now(handle.intent.timer.armed_at)).total_seconds() * 1000)),
            "output": {"synthesized_by": "orchestrator", "stop_reason": reason, "elapsed_s": elapsed_s, "ticks": handle.ticks},
            "artifacts": [],
            "status_report": report.to_dict(),
            "timer": {
                "mode": handle.intent.timer.mode,
                "t0": handle.intent.timer.t0,
                "armed_at": handle.intent.timer.armed_at,
                "expires_at": None,
                "reported_at": format_timestamp(now),
                "elapsed_s": elapsed_s,
                "remaining_ms": None,
                "overrun_ms": 0,
                "self_reported": False,
            },
            "diagnostics": {"stdout": stdout[-65536:], "stderr": stderr[-65536:], "exit_code": exit_code},
            "error": None,
            "self_report": {"confidence": 0.4, "notes": "Planmaessiger Stopp durch den Zeitplan (Protokoll 1.2)."},
        }
        return Result.from_dict(payload, intent=handle.intent)

    def execute_due_action(
        self,
        action: DueAction,
        *,
        parent_job_id: str,
        limb: str = "echo",
        started_this_tick: int = 0,
    ) -> dict[str, Any]:
        """Fuehrt eine faellige Aktion aus. ``emit_event``/``log`` sind schon Events."""
        outcome: dict[str, Any] = {"action": action.action, "trigger_id": action.trigger.id}

        if action.action == ACTION_CHECK:
            entries = action.payload.get("checks")
            if isinstance(entries, list) and entries:
                entry_list = [dict(e) for e in entries]
            else:
                entry_list = [{"operation": action.payload.get("operation"), "params": action.payload.get("params", {})}]
            results = []
            for index, entry in enumerate(entry_list):
                results.append(
                    self._dispatch_scheduled(
                        entry,
                        trigger_id=action.trigger.id,
                        parent_job_id=parent_job_id,
                        elapsed_s=action.elapsed_s,
                        index=index,
                        limb=str(action.payload.get("limb") or limb),
                        title=str(action.payload.get("title") or f"Kontrolle {action.trigger.id}"),
                        goal=str(action.payload.get("goal") or f"Zeitgesteuerte Kontrolle '{action.trigger.id}' bei t_unlimited={action.elapsed_s}s"),
                        started_this_tick=started_this_tick + index,
                    )
                )
            outcome["scheduled_jobs"] = results
            outcome["scheduled_job"] = results[0] if results else None
            return outcome

        if action.action == ACTION_FINISH:
            outcome["finish_requested"] = True
            return outcome

        if action.action == ACTION_ESCALATE:
            outcome["needs_human"] = True
            return outcome

        return outcome

    def _dispatch_scheduled(
        self,
        entry: Mapping[str, Any],
        *,
        trigger_id: str,
        parent_job_id: str,
        elapsed_s: float,
        index: int,
        limb: str,
        title: str,
        goal: str,
        started_this_tick: int = 0,
    ) -> dict[str, Any]:
        """Ein Kontroll-Job: eigene Spur, eigenes Kontingent, kein Eltern-Budget.

        Eine Kontrolle ist eine **Stichprobe**, kein Projekt: ein Durchgang,
        keine Autodidaktik, kurzes Deadline-Budget. Scheitert sie, wird das
        dokumentiert (``timer.skipped``/Event) -- sie darf den beobachteten
        Auftrag weder aufbrauchen noch still verschwinden.
        """
        operation = str(entry.get("operation") or "")
        raw_params = entry.get("params")
        params: Mapping[str, Any] = raw_params if isinstance(raw_params, Mapping) else {}
        entry_limb = str(entry.get("limb") or limb)
        entry_goal = str(entry.get("goal") or goal)

        # Kontingent = laufende Kontroll-Jobs **plus** die in diesem Tick bereits
        # gestarteten. Ohne den zweiten Term waere die Grenze unerreichbar: Die
        # Ausfuehrung ist synchron, also ist der Slot nach jeder Kontrolle sofort
        # wieder frei -- und zwei Ausloeser im selben Tick wuerden still
        # nacheinander laufen, statt das Kontingent zu respektieren.
        active = self.jobs.active_count(kind=JOB_KIND_SCHEDULED) + started_this_tick
        if active >= self.config.limits.max_scheduled_jobs:
            reason = (
                f"Kontroll-Job fuer Trigger '{trigger_id}' ({operation}) nicht gestartet: "
                f"max_scheduled_jobs={self.config.limits.max_scheduled_jobs} (mode={self.config.mode}) belegt "
                f"(aktiv={self.jobs.active_count(kind=JOB_KIND_SCHEDULED)}, in diesem Tick gestartet={started_this_tick})."
            )
            self.scheduler.mark_skipped(parent_job_id, trigger_id, reason, elapsed_s=elapsed_s)
            self._emit("timer.skipped", {"trigger_id": trigger_id, "operation": operation, "reason": reason}, job_id=parent_job_id, clock_s=elapsed_s)
            return {
                "status": "skipped",
                "operation": operation,
                "reason": reason,
                "trigger_id": trigger_id,
                "kind": JOB_KIND_SCHEDULED,
                "parent_job_id": parent_job_id,
            }

        record = self.jobs.create(
            entry_goal,
            max_iterations=1,
            timer_mode="deadline",
            kind=JOB_KIND_SCHEDULED,
            parent_job_id=parent_job_id,
            trigger_id=trigger_id,
        )
        try:
            intent = self.kernel.build_intent(
                operation=operation,
                params=dict(params),
                limb=entry_limb,
                job_id=record.job_id,
                goal=entry_goal,
                iteration=1,
                max_iterations=1,
                on_failure="return_to_core",
                on_expiry="escalate",
                title=f"{title} [{index + 1}]" if index else title,
                objective=f"Zeitgesteuerte Kontrolle bei t_unlimited={elapsed_s}s (Auftrag {parent_job_id}).",
                context_summary=f"Erzeugt von Trigger '{trigger_id}' des Auftrags {parent_job_id}.",
            )
        except ProtocolError as exc:
            self.jobs.finish(record.job_id, JOB_ESCALATED, failure_kind=FAILURE_ESCALATION, outcome={"reason": f"{exc.code}: {exc.message}"})
            self._emit("job.scheduled", {"status": "rejected", "trigger_id": trigger_id, "reason": f"{exc.code}: {exc.message}"}, job_id=parent_job_id, clock_s=elapsed_s)
            return {
                "status": "rejected",
                "operation": operation,
                "job_id": record.job_id,
                "reason": f"{exc.code}: {exc.message}",
                "trigger_id": trigger_id,
                "kind": JOB_KIND_SCHEDULED,
                "parent_job_id": parent_job_id,
            }

        self.jobs.begin_iteration(record.job_id, operation=intent.operation, limb=intent.target_limb)
        self._emit(
            "job.scheduled",
            {
                "scheduled_job_id": record.job_id,
                "parent_job_id": parent_job_id,
                "trigger_id": trigger_id,
                "operation": intent.operation,
                "limb": intent.target_limb,
                "elapsed_s": elapsed_s,
            },
            intent,
            job_id=parent_job_id,
            clock_s=elapsed_s,
        )

        attempt = self.dispatch(intent, job=record, slot_kind=KIND_SCHEDULED)
        status = JOB_RESOLVED if attempt.ok else JOB_FAILED
        failure_kind = "" if attempt.ok else FAILURE_NO_MEASURE
        self.jobs.record_iteration(
            record.job_id,
            IterationEntry(
                iteration=attempt.iteration,
                intent_id=attempt.intent.intent_id,
                operation=attempt.intent.operation,
                limb=attempt.intent.target_limb,
                status=attempt.result.status,
                verdict=attempt.verdict.decision,
                error_code=attempt.result.error_code,
                duration_ms=attempt.result.duration_ms,
                timer_expired=attempt.verdict.timer_expired,
                self_reported=attempt.result.timer.self_reported,
                archive=self.config.relative(attempt.archive_dir) if attempt.archive_dir else "",
                measure="",
            ),
        )
        self.jobs.finish(
            record.job_id,
            status,
            failure_kind=failure_kind,
            outcome={
                "trigger_id": trigger_id,
                "parent_job_id": parent_job_id,
                "elapsed_s": elapsed_s,
                "status": attempt.result.status,
                "verdict": attempt.verdict.decision,
                "error": attempt.result.error,
                "output": attempt.result.output,
            },
        )
        return {
            "status": status,
            "operation": attempt.intent.operation,
            "job_id": record.job_id,
            "result_status": attempt.result.status,
            "verdict": attempt.verdict.decision,
            "elapsed_s": elapsed_s,
            "output": attempt.result.output,
            "error": attempt.result.error,
            # Rueckverfolgbarkeit: Welcher Ausloeser hat welchen Kontroll-Job
            # erzeugt, und zu welchem Auftrag gehoert er? Ohne diese Angaben sind
            # Kontroll-Jobs in einer Bilanz anonyme Eintraege.
            "trigger_id": trigger_id,
            "kind": JOB_KIND_SCHEDULED,
            "parent_job_id": parent_job_id,
        }

    def _short_circuit(self, intent: Intent, code: str, message: str, *, hint: str = "", decision: PolicyDecision | None = None) -> Attempt:
        """Erzeugt ein abgelehntes Result, ohne einen Limb zu starten."""
        result = self._synthetic(intent, "rejected", code, message, hint=hint)
        policy_decision = decision or PolicyDecision(allowed=False, code=code, reason=message)
        verdict = self.kernel.evaluate(intent, result)
        self._emit("intent.rejected", {"code": code, "message": message, "verdict": verdict.decision}, intent, job_id=intent.job_id, limb=intent.target_limb)
        archive_dir = self.transport.archive(intent, result, {"verdict": verdict.to_dict(), "rejected_before_spawn": True})
        diagnosis = self.planner.diagnose(intent, result, verdict)
        return Attempt(
            iteration=intent.iteration,
            intent=intent,
            result=result,
            verdict=verdict,
            decision=policy_decision,
            spawned=False,
            archive_dir=archive_dir,
            diagnosis=diagnosis,
        )

    def _synthetic(
        self,
        intent: Intent,
        status: str,
        code: str,
        message: str,
        *,
        hint: str = "",
        started_at: str | None = None,
        stdout: str = "",
        stderr: str = "",
        exit_code: int | None = None,
        report: StatusReport | None = None,
    ) -> Result:
        """Vom Orchestrator erzeugtes Result -- immer protokollkonform."""
        now = utc_now_iso()
        payload: dict[str, Any] = {
            "protocol": "neu/result",
            "version": PROTOCOL_VERSION,
            "result_id": new_id("res"),
            "intent_id": intent.intent_id,
            "trace_id": intent.trace_id,
            "job_id": intent.job_id,
            "iteration": intent.iteration,
            "status": status,
            "operation": intent.operation,
            "limb": {"name": intent.target_limb, "version": "0.0.0", "pid": 0},
            "started_at": started_at or now,
            "finished_at": now,
            "duration_ms": 0,
            "output": {"synthesized_by": "orchestrator"},
            "artifacts": [],
            "timer": {
                "armed_at": intent.timer.armed_at,
                "expires_at": intent.timer.expires_at,
                "reported_at": now,
                # unlimited: kein Budget -> null statt erfundener 0
                "remaining_ms": (
                    None
                    if intent.timer.unlimited
                    else (int((intent.timer.remaining_s() or 0.0) * 1000) if intent.timer.armed else 0)
                ),
                "overrun_ms": 0,
                "self_reported": False,
            },
            "diagnostics": {"stdout": stdout[-65536:], "stderr": stderr[-65536:], "exit_code": exit_code},
            "error": {"code": code, "message": message[:16000], "hint": hint[:4000]},
            "self_report": {"confidence": 0.0, "notes": "Vom Orchestrator synthetisiert (kein Limb-Erfolg)."},
        }
        if report is not None:
            payload["status_report"] = report.to_dict()
        if status == "partial" and report is None:
            payload["status_report"] = StatusReport(state="partial", explanation=message[:4000], remaining=("Teilauftrag offen.",)).to_dict()
        return Result.from_dict(payload, intent=intent)

    def _emit(
        self,
        kind: str,
        payload: Mapping[str, Any] | None = None,
        intent: Intent | None = None,
        *,
        job_id: str = "",
        limb: str = "",
        clock_s: float | None = None,
    ) -> None:
        """Event mit Job-Kontext -- inkl. ``clock_s`` (= ``t_unlimited``).

        Ohne expliziten Wert wird die Uhr aus dem geschaerften Intent abgeleitet,
        damit jeder Event eines Auftrags dieselbe Zeitachse traegt. Das ist die
        Grundlage fuer Phase 3: Ein Log-Sink kann spaeter allein aus den Events
        rekonstruieren, was wann (seit Auftragserteilung) geschah.
        """
        if clock_s is None and intent is not None and intent.timer.t0:
            clock_s = intent.timer.elapsed()
        self.bus.emit(
            kind,
            payload or {},
            job_id=job_id or (intent.job_id if intent else ""),
            trace_id=intent.trace_id if intent else "",
            intent_id=intent.intent_id if intent else "",
            limb=limb or (intent.target_limb if intent else ""),
            clock_s=clock_s,
        )


def _decode(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _parse_or_now(value: str | None):
    from core.protocol import parse_timestamp

    if not value:
        return utc_now()
    try:
        return parse_timestamp(value, "$.timer.armed_at")
    except ProtocolError:
        return utc_now()


def _overrun_ms(intent: Intent, *, now=None) -> int:
    """Millisekunden ueber der harten Deadline (0 = noch im Budget)."""
    if not intent.timer.expires_at:
        return 0
    moment = now or utc_now()
    deadline = _parse_or_now(intent.timer.expires_at)
    delta = (moment - deadline).total_seconds() * 1000
    return int(max(0, delta))


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Findet das Result-JSON-Objekt im stdout eines Limbs.

    Toleriert versehentliche Zusaetze, nimmt aber immer das *letzte* vollstaendige
    Objekt mit ``protocol == "neu/result"`` -- das ist per Vertrag das Result.
    """
    if not text or not text.strip():
        return None
    stripped = text.strip()
    try:
        data = json.loads(stripped)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    candidates: list[dict[str, Any]] = []
    index = 0
    while index < len(text):
        start = text.find("{", index)
        if start == -1:
            break
        try:
            obj, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            index = start + 1
            continue
        if isinstance(obj, dict):
            candidates.append(obj)
        index = start + max(1, end)
    for candidate in reversed(candidates):
        if candidate.get("protocol") == "neu/result":
            return candidate
    return candidates[-1] if candidates else None
