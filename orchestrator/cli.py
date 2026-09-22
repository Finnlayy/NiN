"""Kommandozeilen- und I/O-Schnittstelle des Orchestrators (Protokoll 1.2).

Der KI-Kern (und der Mensch) steuert das System ueber diese CLI:

    python3 -m orchestrator spec                 # Protokoll + Operationen + Timer-Semantik
    python3 -m orchestrator status               # Profil, Limits, Queues, Jobs, Agent-Slots
    python3 -m orchestrator job run --goal ... --op sys.echo --params '{"message":"hi"}'
    python3 -m orchestrator job show <job_id>    # Historie inkl. Statusberichten
    python3 -m orchestrator dispatch --intent runtime/inbox/echo/<id>.json
    python3 -m orchestrator intent --op sys.ping --limb echo --print
    python3 -m orchestrator validate --intent <datei> --schema
    python3 -m orchestrator loop --once          # Inbox abarbeiten
    python3 -m orchestrator scale --profile scale --approved-by human

Zeit-Tracking und zeitgesteuerte Ausloeser (Protokoll 1.2)::

    # Zeit wird getrackt statt begrenzt; Kontrolle alle 5s; Ende bei 30s
    python3 -m orchestrator job run --goal "Beobachten" --op sys.simulate \
        --params '{"mode":"timeout","seconds":60}' --unlimited --tick 0.2 \
        --trigger "id=kontrolle;action=check;every=5;op=sys.ping" \
        --trigger "id=ende;action=finish_job;when=elapsed >= 30"

    python3 -m orchestrator watch --goal ... --op ... --unlimited --trigger ...
    python3 -m orchestrator watch --job <job_id> --for 60   # nur Scheduler
    python3 -m orchestrator schedule show <job_id>          # Zustand + t_unlimited
    python3 -m orchestrator schedule list

Trigger-Syntax (``--trigger``, mehrfach): entweder JSON (``{"id":...}``),
``@datei.json`` oder ``schluessel=wert``-Paare mit ``;`` getrennt::

    id=kontrolle;action=check;every=10;op=sys.ping;params={"message":"Status?"}
    id=schwelle;action=emit_event;when=elapsed >= 30;kind=timer.threshold
    id=marke;action=log;at=5,15,30;message=Zwischenstand
    id=ende;action=finish_job;when=elapsed >= 120

Schluessel: ``id``, ``action``, ``when``, ``every`` (=every_s), ``at`` (=at_s,
Kommaliste), ``clock``, ``tolerance``, ``max-fires``, ``once`` sowie fuer die
Aktion ``op``, ``params``, ``checks``, ``limb``, ``goal``, ``title``, ``kind``,
``message``.

Konvention: **stdout** traegt das Ergebnis (Menschen oder ``--json``),
**stderr** traegt die Events des Event-Bus (JSON-Zeilen). Damit bleibt alles
pipe-faehig: ``python3 -m orchestrator job run ... --json | jq .status``.

Exit-Codes: 0 = Erfolg, 1 = Protokoll-/Validierungsfehler, 2 = Job nicht
aufgeloest (failed/escalated), 3 = Nutzungsfehler (falsche Flags, unbekanntes
Kommando). "Nichts gefunden" ist **kein** Nutzungsfehler: Wer einen Job ohne
Zeitplan abfragt oder idempotent aufraeumt, bekommt Exit 0 mit einer Antwort,
die den Befund nennt -- sonst lesen Skripte einen Tippfehler in eine Anfrage
hinein, die korrekt gestellt war.
"""

from __future__ import annotations

import argparse
import atexit
import json
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, NoReturn

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from core.config import ABSOLUTE_MAX_ITERATIONS, SCALE_PROFILES, NeuConfig  # noqa: E402
from core.job import JOB_KIND_SCHEDULED, JOB_RESOLVED, JobStore, summarize  # noqa: E402
from core.protocol import (  # noqa: E402
    PROTOCOL_INTENT,
    PROTOCOL_RESULT,
    PROTOCOL_VERSION,
    ErrorCode,
    Intent,
    Operations,
    ProtocolError,
    Result,
)
from core.schemacheck import validate as schema_validate  # noqa: E402 - sys.path-Bootstrap oben ist Absicht

from .events import build_event_bus  # noqa: E402
from .locks import KIND_SCHEDULED  # noqa: E402
from .runner import Attempt, JobOutcome, Orchestrator  # noqa: E402
from .scheduler import Scheduler, describe_schedule  # noqa: E402
from .transport import COMPACT_MIN_STALE_ENTRIES, COMPACT_OLDER_THAN_DAYS, FileTransport  # noqa: E402

EXIT_OK = 0
EXIT_PROTOCOL = 1
EXIT_JOB_FAILED = 2
EXIT_USAGE = 3


# --------------------------------------------------------------------------- #
# Ausgabe-Helfer
# --------------------------------------------------------------------------- #
def _say(text: str = "") -> None:
    print(text)


def _kv(key: str, value: Any, indent: int = 0) -> None:
    print(f"{' ' * indent}{key:<22} {value}")


def _rule(char: str = "-", width: int = 78) -> None:
    print(char * width)


def _dump(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _config_from_args(args: argparse.Namespace) -> NeuConfig:
    overrides: dict[str, Any] = {}
    if getattr(args, "repo_root", None):
        overrides["repo_root"] = Path(args.repo_root)
    # Laufzeitverzeichnis ueberschreiben: erlaubt isolierte Laeufe (CI, Tests,
    # Experimente), ohne runtime/ des Repo zu beruehren.
    if getattr(args, "runtime_dir", None):
        overrides["runtime_dir"] = Path(args.runtime_dir)
    profile = getattr(args, "mode", None)
    if profile:
        if profile not in SCALE_PROFILES:
            raise SystemExit(f"[usage] Unbekanntes Profil '{profile}'. Erlaubt: {', '.join(SCALE_PROFILES)}")
        overrides["mode"] = profile
        overrides["limits"] = dict(SCALE_PROFILES[profile])
    return NeuConfig.load(**overrides)


def _orchestrator(args: argparse.Namespace) -> Orchestrator:
    config = _config_from_args(args)
    return Orchestrator(config, quiet=bool(getattr(args, "quiet", False)))


def _print_attempt(attempt: Attempt, *, json_mode: bool) -> None:
    if json_mode:
        _dump(attempt.summary())
        return
    result = attempt.result
    report = result.status_report
    _rule("=")
    _kv("Durchgang", f"{attempt.iteration}/{attempt.intent.job.max_iterations}  (Job {attempt.intent.job_id})")
    _kv("Intent", attempt.intent.intent_id)
    _kv("Operation", f"{attempt.intent.operation}  ->  Limb '{attempt.intent.target_limb}'")
    timer = attempt.intent.timer
    if timer.unlimited:
        _kv("Timer", f"mode=unlimited (Zeit wird getrackt) t0={timer.t0} safety_net={timer.safety_net_s}s "
                     f"armed_at={timer.armed_at}")
    else:
        _kv("Timer", f"mode=deadline deadline={timer.deadline_s}s soft={timer.soft_deadline_s}s "
                     f"armed_at={timer.armed_at} expires_at={timer.expires_at}")
    stop_reason = str((result.output or {}).get("stop_reason", "")) if isinstance(result.output, dict) else ""
    exit_note = f"  (durch Zeitplan gestoppt: {stop_reason})" if stop_reason else ""
    _kv("Ergebnis", f"status={result.status}  dauer={result.duration_ms} ms  exit={result.diagnostics_exit_code}{exit_note}")
    _kv("Zeit", f"t_unlimited={result.timer.elapsed_s}s  verbleibend={result.timer.remaining_ms} ms  "
                f"ueberzug={result.timer.overrun_ms} ms  self_reported={result.timer.self_reported}")
    _kv("Verdict", f"{attempt.verdict.decision}  next={attempt.verdict.next_action}")
    if result.error:
        _kv("Fehler", f"{result.error['code']}: {result.error['message'][:200]}")
        if result.error.get("hint"):
            _kv("Hinweis", result.error["hint"][:200], indent=2)
    if report:
        _kv("Statusbericht", f"state={report.state}")
        _kv("Erklaerung", report.explanation[:400], indent=2)
        if report.done:
            _kv("Erledigt", "; ".join(report.done)[:300], indent=2)
        if report.remaining:
            _kv("Offen", "; ".join(report.remaining)[:300], indent=2)
        if report.suggested_next:
            _kv("Vorschlag", report.suggested_next[:300], indent=2)
    if result.artifacts:
        _kv("Artefakte", f"{len(result.artifacts)}")
        for artifact in result.artifacts[:10]:
            print(f"  - {artifact.action:<9} {artifact.path} ({artifact.bytes} B, sha {artifact.sha256[:12]}…)")
    if attempt.diagnosis is not None:
        _kv("Diagnose", attempt.diagnosis.code)
        _kv("Ursache", attempt.diagnosis.cause[:300], indent=2)
        _kv("Massnahme", attempt.diagnosis.measure[:300], indent=2)
    if attempt.verdict.reasons:
        _kv("Begruendung", " | ".join(r[:160] for r in attempt.verdict.reasons[:4]))
    if attempt.verdict.warnings:
        _kv("Hinweise (weich)", " | ".join(w[:200] for w in attempt.verdict.warnings[:3]))
    if attempt.archive_dir:
        _kv("Archiv", str(attempt.archive_dir))
    _rule("=")


def _print_outcome(outcome: JobOutcome, *, json_mode: bool) -> None:
    if json_mode:
        _dump(outcome.summary())
        return
    for attempt in outcome.attempts:
        _print_attempt(attempt, json_mode=False)
    _rule("=")
    _kv("Job", outcome.job.job_id)
    _kv("Ziel", outcome.job.goal[:120])
    _kv("Status", outcome.status + (f" ({outcome.failure_kind})" if outcome.failure_kind else ""))
    _kv("Durchgaenge", f"{outcome.iterations}/{outcome.job.max_iterations}  (Profil {outcome.job.mode})")
    _kv("Massnahmen", outcome.job.measures_taken)
    _kv("Wirklich failed", "ja" if outcome.job.really_failed else "nein")
    watch = outcome.watch
    if watch:
        ende = "finish_job" if watch.get("finish_requested") else ("escalate" if watch.get("needs_human") else "Limb/Ernte")
        _kv(
            "Beobachtung",
            f"Ticks={watch.get('ticks', 0)}  Ausloesungen={watch.get('due_actions', 0)}  "
            f"Kontroll-Jobs={len(watch.get('scheduled_jobs') or [])}  beendet durch={ende}",
        )
    _kv("Genutzte Limbs", ", ".join(outcome.job.limbs_used) or "-")
    if outcome.job.outcome:
        _kv("Outcome", json.dumps(outcome.job.outcome, ensure_ascii=False)[:300])
    _rule("=")


# --------------------------------------------------------------------------- #
# Kommandos
# --------------------------------------------------------------------------- #
def cmd_spec(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    operations = Operations.load(config.protocol_dir / "operations.json")
    registry = config.registry_path
    payload: dict[str, Any] = {
        "protocol_version": PROTOCOL_VERSION,
        "envelopes": [PROTOCOL_INTENT, PROTOCOL_RESULT],
        "reference_implementation": "core/protocol.py",
        "schemas": ["protocol/intent.schema.json", "protocol/result.schema.json"],
        "operations": operations.as_dict(),
        "error_codes": list(ErrorCode.ALL),
        "timer_semantics": {
            "armed_by": "orchestrator (vor Anbeginn des Durchgangs)",
            "mode": "deadline (begrenzt) | unlimited (Zeit wird getrackt, nicht begrenzt)",
            "deadline_s": "hartes Budget; danach killt der Orchestrator. null => mode=unlimited",
            "soft_deadline_s": "hier muss der Limb seinen Statusbericht liefern",
            "grace_s": "Nachfrist fuer die Berichtuebermittlung",
            "on_expiry": "iterate | escalate | abort",
            "report_required_for_status": ["timeout", "partial"],
            "t0": "Referenzpunkt der Job-Uhr (Job-Erstellung); identisch in Intent, Result und Events",
            "elapsed_s": "t_unlimited = Sekunden seit t0",
            "safety_net_s": f"Prozess-Hygiene (Zombie-Schutz), kein Aufgabenlimit; Default {config.timer.safety_net_s}s",
        },
        "schedule_semantics": {
            "where": "intent.schedule.triggers[]",
            "tick_s": config.timer.tick_s,
            "conditions": "when: 'elapsed <op> <sekunden>' mit op in ==,!=,<,<=,>,>= (Toleranz nur bei ==/!=)",
            "kinds": {
                "when": "kantengesteuert: feuert einmal, wenn die Bedingung wahr wird",
                "every_s": "Intervall: 'pruefe alle N Sekunden'; mit when erst ab Bedingungseintritt",
                "at_s": "feste Zeitmarken seit t0 (Liste, mit Catch-up nach verpassten Ticks)",
            },
            "actions": ["emit_event", "check", "escalate", "finish_job", "log"],
            "check": (
                "startet eigene Kontroll-Jobs (kind='scheduled', Kontingent "
                f"max_scheduled_jobs={config.limits.max_scheduled_jobs}); sie verbrauchen kein Iterationsbudget des Auftrags"
            ),
            "finish_job": "beendet den Auftrag planmaessig -> Kernel-Wertung accept (mit Hinweis 'durch Zeitplan gestoppt')",
            "escalate": "verlangt eine Entscheidung -> Auftrag wird eskaliert (needs_human)",
            "persistence": "runtime/schedules/<job_id>.json; t0 und Feuerungen ueberstehen einen Neustart",
        },
        "iteration_semantics": {
            "counted_per": "job (nicht pro Agentenaufruf)",
            "absolute_max": ABSOLUTE_MAX_ITERATIONS,
            "profile": config.mode,
            "limits": config.limits.to_dict(),
            "failure_rule": "failed nur, wenn nach dem Versagen keine Massnahme mehr ergriffen werden kann",
        },
    }
    if args.json:
        _dump(payload)
        return EXIT_OK

    _rule("=")
    _say(f"NEU-Protokoll {PROTOCOL_VERSION}   ({PROTOCOL_INTENT}, {PROTOCOL_RESULT})")
    _say(f"Referenz: core/protocol.py   Schemas: protocol/*.schema.json   Register: {config.relative(registry)}")
    _rule("=")
    _say()
    _say("Intent-Envelope (Pflichtfelder)")
    for key in ("protocol", "version", "intent_id", "created_at", "source{role,node_id}", "target{limb}", "job{job_id,goal,iteration,max_iterations}", "task{operation,params}"):
        _say(f"  - {key}")
    _say("Intent-Envelope (optional)")
    for key in (
        "trace_id",
        "parent_intent_id",
        "idempotency_key",
        "timer{mode,deadline_s,soft_deadline_s,grace_s,on_expiry,t0,safety_net_s,armed_at,soft_expires_at,expires_at}",
        "schedule{tick_s,triggers[]{id,action,when,every_s,at_s,clock,tolerance_s,max_fires,once,payload}}",
        "task{title,objective,acceptance,verification}",
        "constraints",
        "elevation",
        "context",
    ):
        _say(f"  - {key}")
    _say()
    _say("Result-Envelope")
    for key in ("protocol", "version", "result_id", "intent_id", "job_id", "iteration", "status", "operation", "limb{name,version,pid}", "started_at", "finished_at", "duration_ms"):
        _say(f"  - {key}")
    for key in (
        "output",
        "artifacts[]",
        "status_report{state,explanation,done,remaining,blockers,suggested_next}",
        "timer{mode,t0,elapsed_s,armed_at,expires_at,reported_at,remaining_ms,overrun_ms,self_reported}",
        "diagnostics{stdout,stderr,exit_code}",
        "error{code,message,hint}",
        "self_report{confidence,notes}",
    ):
        _say(f"  - {key}")
    _say("  status-Werte: success | partial | failed | rejected | timeout")
    _say()
    _say(f"Operationen ({len(operations.names())})")
    _say(f"  {'OPERATION':<20}{'PHASE':<7}{'RISK':<13}{'ELEVATION':<13}{'LIMBS':<14}PFAD-PARAMS")
    for name in operations.names():
        spec = operations.spec(name)
        _say(
            f"  {name:<20}{spec.phase:<7}{spec.risk:<13}{spec.requires_elevation:<13}"
            f"{(','.join(spec.implemented_by) or '-'):<14}{','.join(spec.path_params) or '-'}"
        )
    _say()
    _say("Fehlercodes")
    _say("  " + ", ".join(ErrorCode.ALL))
    _say()
    _say("Timer-Semantik")
    _say("  * Der Orchestrator schaerft timer.armed_at/soft_expires_at/expires_at VOR dem Start des Limbs.")
    _say("  * Soft-Deadline: Der Limb liefert selbst einen status_report (self_reported=true).")
    _say("  * Harte Deadline (+grace_s): Der Orchestrator bricht ab und synthetisiert status='timeout'.")
    _say("  * Nach Ablauf folgt der autodidaktische 2. Durchgang -- der Orchestrator entwirft den Auftrag.")
    _say()
    _say("Zeit-Tracking (1.2): unlimited statt Deadline")
    _say("  * Ohne deadline_s (oder mit --unlimited) gilt timer.mode='unlimited': Zeit wird GETRACKT, nicht begrenzt.")
    _say("  * t0 = Job-Erstellung, elapsed_s = t_unlimited; Intent, Result und jeder Event tragen dieselbe Uhr.")
    _say(f"  * safety_net_s (Default {config.timer.safety_net_s}s) ist Prozess-Hygiene, kein Aufgabenlimit:")
    _say("    Eingriff -> E_SAFETY_NET -> Eskalation (kein 2. Durchgang, die Schwelle ist Menschenentscheid).")
    _say("  * remaining_ms ist im unlimited-Modus null -- es gibt kein Budget, also wird keines erfunden.")
    _say()
    _say("Zeitgesteuerte Ausloeser (1.2): intent.schedule.triggers[]")
    _say("  * when='elapsed >= 30'        kantengesteuert, feuert einmal bei Eintritt")
    _say(f"  * every_s=N                   Intervall ('pruefe alle N Sekunden'), Tick {config.timer.tick_s}s")
    _say("  * at_s=[5,15,30]              feste Zeitmarken seit t0 (mit Catch-up)")
    _say("  * Aktionen: emit_event | check | escalate | finish_job | log")
    _say(f"  * check startet Kontroll-Jobs (kind='scheduled', Kontingent max_scheduled_jobs="
         f"{config.limits.max_scheduled_jobs}) -- eigenes Budget, keine Iteration des Auftrags.")
    _say("  * finish_job beendet planmaessig (Verdict accept), escalate verlangt einen Menschen.")
    _say("  * Zustand: runtime/schedules/<job_id>.json; t0/Feuerungen ueberstehen einen Neustart.")
    _say()
    _say("Iterations-Semantik")
    _say(f"  * Zaehlung pro Job, absolut max {ABSOLUTE_MAX_ITERATIONS}; Profil '{config.mode}': {config.limits.to_dict()}")
    _say("  * failed nur, wenn keine Massnahme mehr ergriffen werden kann; sonst iterating/escalated.")
    return EXIT_OK


def cmd_status(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    config.ensure_dirs()
    transport = FileTransport(config)
    jobs = JobStore(config)
    orch = Orchestrator(config, quiet=True)
    queue = transport.state()
    log_exists = config.system_log_path.is_file()
    payload = {
        "repo_root": str(config.repo_root),
        "config_source": str(config.source_file) if config.source_file else "(eingebaute Defaults)",
        # Wo liegt was? Ohne diese Pfade koennen Skriptequeues, Jobs und
        # Zeitplaene nicht finden -- und Isolation (--runtime-dir) ist nicht
        # ueberpruefbar.
        "runtime_dir": str(config.runtime_dir),
        "workspace_dir": str(config.workspace_dir),
        "protocol_dir": str(config.protocol_dir),
        "jobs_dir": str(config.jobs_dir),
        "schedules_dir": str(config.schedules_dir),
        "mode": config.mode,
        "limits": config.limits.to_dict(),
        "timer_defaults": config.timer.to_dict(),
        "flags": {
            "allow_shell_ops": config.allow_shell_ops,
            "allow_test_ops": config.allow_test_ops,
            "allow_repo_write": config.allow_repo_write,
        },
        "runtime": {
            "inbox": queue.inbox,
            "outbox": queue.outbox,
            "archived_jobs": queue.archived,
            "backups": queue.backups,
            "system_log": {"path": config.relative(config.system_log_path), "exists": log_exists, "note": "wird in Phase 3 rekursiv vom Bootstrap-Limb ergaenzt"},
        },
        "agents": {
            "capacity": orch.agents.capacity,
            "scheduled_capacity": orch.agents.capacity_for(KIND_SCHEDULED),
            "busy": [s.to_dict() for s in orch.agents.busy()],
        },
        "limbs": orch.registry.as_dict(),
        "jobs": {
            "active": jobs.active_count(),
            "active_scheduled": jobs.active_count(kind=JOB_KIND_SCHEDULED),
            "recent": [j.to_dict() for j in jobs.list(limit=5)],
        },
        "schedules": [orch.scheduler.report(state.job_id) for state in orch.scheduler.states()],
        "operations": list(orch.operations.names()),
    }
    if args.json:
        _dump(payload)
        return EXIT_OK

    _rule("=")
    _say("NEU-Orchestrator -- Status")
    _rule("=")
    _kv("Repo-Root", config.repo_root)
    _kv("Konfiguration", config.source_file or "(eingebaute Defaults)")
    _kv("Profil", f"{config.mode}  ->  {config.limits.to_dict()}")
    _kv("Timer-Defaults", config.timer.to_dict())
    _kv("Flags", f"shell={config.allow_shell_ops} tests={config.allow_test_ops} repo_write={config.allow_repo_write}")
    _kv("Queues", f"inbox={queue.inbox} outbox={queue.outbox} archiv={queue.archived} backups={queue.backups}")
    _kv("system.log", f"{config.relative(config.system_log_path)} {'(vorhanden)' if log_exists else '(fehlt -- Phase 3 Auftrag)'}")
    _kv("Agent-Slots", f"capacity={orch.agents.capacity} busy={len(orch.agents.busy())} "
                       f"(Kontroll-Slots: {orch.agents.capacity_for(KIND_SCHEDULED)})")
    _kv("Jobs", f"aktiv={jobs.active_count()} kontroll-jobs={jobs.active_count(kind=JOB_KIND_SCHEDULED)}")
    for state in orch.scheduler.states():
        _kv("Zeitplan", f"{state.job_id} t_unlimited={state.elapsed_s()}s "
                        f"ausloeser={len(state.triggers)} (aktiv {len(state.active_triggers())}) "
                        f"feuerungen={state.fires_total} | {describe_schedule(state.triggers)}")
    _say()
    _say("Limbs")
    for name, spec in orch.registry.as_dict()["limbs"].items():
        marker = "aktiv " if spec["status"] == "active" and spec["entrypoint_exists"] else "inaktiv"
        _say(f"  [{marker}] {name:<10} v{spec['version']:<7} phase {spec['phase']}  ops: {', '.join(spec['operations']) or '-'}")
        if spec["status"] != "active":
            _say(f"              status='{spec['status']}' -- {spec['description'][:90]}")
    _say()
    _say("Letzte Jobs")
    recent = jobs.list(limit=5)
    if not recent:
        _say("  (noch keine)")
    for record in recent:
        _say(f"  {summarize(record)}")
    _rule("=")
    return EXIT_OK


def cmd_job_run(args: argparse.Namespace) -> int:
    orch = _orchestrator(args)
    params = _load_params(args.params, args.param)
    try:
        outcome = orch.run_job(
            goal=args.goal,
            operation=args.op,
            params=params,
            limb=args.limb,
            max_iterations=args.max_iterations,
            **_time_kwargs(args),
            title=args.title or "",
            objective=args.objective or "",
            acceptance=tuple(args.accept or ()),
            constraints=_constraints(args),
            elevation=_elevation(args),
            context_summary=args.context or "",
            auto_iterate=not args.no_auto_iterate,
        )
    except ProtocolError as exc:
        _dump({"ok": False, "error": exc.to_dict()}) if args.json else _say(f"[protokoll] {exc}")
        return EXIT_PROTOCOL
    _print_outcome(outcome, json_mode=args.json)
    return EXIT_OK if outcome.status == JOB_RESOLVED else EXIT_JOB_FAILED


def cmd_job_list(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    jobs = JobStore(config)
    records = jobs.list(limit=args.limit, active_only=args.active)
    if args.json:
        _dump([r.to_dict() for r in records])
        return EXIT_OK
    if not records:
        _say("(keine Jobs in runtime/jobs/)")
        return EXIT_OK
    for record in records:
        _say(summarize(record))
    return EXIT_OK


def cmd_job_show(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    jobs = JobStore(config)
    record = jobs.get(args.job_id)
    if record is None:
        _say(f"[fehler] Job '{args.job_id}' nicht gefunden.")
        return EXIT_USAGE
    history = jobs.read_history(args.job_id)
    if args.json:
        _dump({"job": record.to_dict(), "history": history})
        return EXIT_OK
    _rule("=")
    _kv("Job", record.job_id)
    _kv("Ziel", record.goal)
    _kv("Status", record.status + (f" ({record.failure_kind})" if record.failure_kind else ""))
    _kv("Profil", f"{record.mode}  limits={config.limits.to_dict()}")
    _kv("Durchgaenge", f"{record.iteration}/{record.max_iterations}")
    _kv("Massnahmen", record.measures_taken)
    _kv("Wirklich failed", "ja" if record.really_failed else "nein")
    _kv("Limbs", ", ".join(record.limbs_used) or "-")
    _kv("Operationen", ", ".join(record.operations_used) or "-")
    _say()
    _say("Durchgaenge")
    for entry in record.history:
        _say(f"  D{entry.iteration}: {entry.operation} @ {entry.limb} -> {entry.status}/{entry.verdict} "
             f"({entry.duration_ms} ms){' TIMER-ABLUF' if entry.timer_expired else ''}"
             f"{' self-report' if entry.self_reported else ''}{f' err={entry.error_code}' if entry.error_code else ''}")
        if entry.measure:
            _say(f"        Massnahme: {entry.measure[:140]}")
    _say()
    _say("Historie (runtime/jobs/*.history.jsonl)")
    for event in history[-12:]:
        _say(f"  {event.get('at', '?')}  {event.get('event', '?')}  {json.dumps({k: v for k, v in event.items() if k not in {'event', 'at', 'history', 'outcome'}}, ensure_ascii=False)[:180]}")
    _rule("=")
    return EXIT_OK


def cmd_job_reclaim(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    orch = Orchestrator(config, quiet=True)
    jobs = orch.jobs
    reclaimed = orch.reclaim_orphans() + jobs.reclaim_stale()
    if args.json:
        _dump({"reclaimed": [r.to_dict() for r in reclaimed], "active": jobs.active_count()})
        return EXIT_OK
    if not reclaimed:
        _say("[ok] Keine verwaisten Jobs. Aktiv: " + str(jobs.active_count()))
        return EXIT_OK
    _say(f"[ok] {len(reclaimed)} verwaiste(r) Job(s) eskaliert:")
    for record in reclaimed:
        _say("  " + summarize(record))
    return EXIT_OK


def cmd_dispatch(args: argparse.Namespace) -> int:
    orch = _orchestrator(args)
    raw = sys.stdin.read() if args.intent == Path("-") or str(args.intent) == "-" else Path(args.intent).read_text(encoding="utf-8")
    try:
        attempt = orch.dispatch_raw(raw)
    except ProtocolError as exc:
        if args.json:
            _dump({"ok": False, "error": exc.to_dict()})
        else:
            _say(f"[protokoll] {exc}")
        return EXIT_PROTOCOL
    _print_attempt(attempt, json_mode=args.json)
    return EXIT_OK if attempt.ok else EXIT_JOB_FAILED


def cmd_intent(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    from core.kernel import Kernel

    kernel = Kernel(config)
    params = _load_params(args.params, args.param)
    try:
        time_kwargs = _time_kwargs(args)
        time_kwargs.pop("max_ticks", None)  # build_intent kennt kein Tick-Limit
        intent = kernel.build_intent(
            operation=args.op,
            params=params,
            limb=args.limb,
            goal=args.goal or args.title or args.op,
            iteration=args.iteration,
            max_iterations=args.max_iterations,
            **time_kwargs,
            title=args.title or "",
            objective=args.objective or "",
            acceptance=tuple(args.accept or ()),
            verification={"type": args.verify_type, "command": args.verify_command} if args.verify_type and args.verify_type != "none" else None,
            constraints=_constraints(args),
            elevation=_elevation(args),
            context_summary=args.context or "",
        )
    except ProtocolError as exc:
        if args.json:
            _dump({"ok": False, "error": exc.to_dict()})
        else:
            _say(f"[protokoll] {exc}")
        return EXIT_PROTOCOL

    if args.dispatch:
        orch = Orchestrator(config, quiet=bool(args.quiet))
        attempt = orch.dispatch(intent)
        _print_attempt(attempt, json_mode=args.json)
        return EXIT_OK if attempt.ok else EXIT_JOB_FAILED

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(intent.to_json() + "\n", encoding="utf-8")
        if not args.json:
            _say(f"[ok] Intent geschrieben: {args.out}")
    if args.json:
        _dump(json.loads(intent.to_json()))
    else:
        _say(intent.to_json())
    return EXIT_OK


def cmd_validate(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    operations = Operations.load(config.protocol_dir / "operations.json")
    problems: list[dict[str, Any]] = []
    intent: Intent | None = None

    if args.intent:
        try:
            intent = Intent.from_file(args.intent, operations=operations)
        except ProtocolError as exc:
            problems.append({"file": str(args.intent), **exc.to_dict()})
    if args.result:
        try:
            Result.from_file(args.result, intent=intent)
        except ProtocolError as exc:
            problems.append({"file": str(args.result), **exc.to_dict()})
    if not args.intent and not args.result:
        _say("[usage] --intent und/oder --result angeben")
        return EXIT_USAGE

    # --- Optionale Pruefung gegen die normativen JSON-Schemas ---
    # Der Parser ist die Referenzimplementierung, aber die Schemas sind der
    # Vertrag fuer Editoren, CI und fremdsprachige Limbs. Beides muss dieselbe
    # Antwort geben -- sonst existieren zwei Wahrheiten ueber das Protokoll.
    schema_notes: list[dict[str, Any]] = []
    if getattr(args, "schema", False):
        for label, path, schema_name in (
            ("intent", args.intent, "intent.schema.json"),
            ("result", args.result, "result.schema.json"),
        ):
            if not path:
                continue
            schema = json.loads((config.protocol_dir / schema_name).read_text(encoding="utf-8"))
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            errors = schema_validate(data, schema)
            for error in errors:
                schema_notes.append({"file": str(path), "kind": label, "schema": schema_name, "error": error})

    ok = not problems and not schema_notes
    if args.json:
        _dump({"ok": ok, "protocol": PROTOCOL_VERSION, "problems": problems, "schema_violations": schema_notes,
               "schema_checked": bool(getattr(args, "schema", False))})
    else:
        _say(f"[{'ok' if ok else 'FEHLER'}] Protokoll {PROTOCOL_VERSION}"
             + (" (Parser + JSON-Schema)" if getattr(args, "schema", False) else " (Parser)"))
        for problem in problems:
            _say(f"  {problem['file']}: [{problem['code']}] {problem['path']}: {problem['message']}")
        for note in schema_notes:
            _say(f"  {note['file']}: [schema] {note['error']}")
        if intent is not None and not problems:
            clock = (f"mode={intent.timer.mode} t0={intent.timer.t0} elapsed_s={intent.timer.elapsed_s}"
                     if intent.timer.unlimited else f"deadline={intent.timer.deadline_s}s")
            _say(f"  intent {intent.intent_id} op={intent.operation} limb={intent.target_limb} "
                 f"job={intent.job_id} iter={intent.iteration}/{intent.job.max_iterations} {clock}")
            _say(f"  zeitplan: {describe_schedule(intent.schedule)}")
    return EXIT_OK if ok else EXIT_PROTOCOL


def cmd_archive(args: argparse.Namespace) -> int:
    """Archiv-/Ledger-Hygiene: Statistik anzeigen oder veraltete Eintraege kompaktieren."""
    config = _config_from_args(args)
    transport = FileTransport(config)

    if getattr(args, "archive_cmd", None) == "stats":
        stats = transport.archive_stats()
        if args.json:
            _dump(stats)
        else:
            _say("Archiv-Statistik:")
            if stats["days"]:
                for day in sorted(stats["days"]):
                    info = stats["days"][day]
                    _say(f"  {day}: {info['entries']} Eintraege, {info['bytes']} Bytes")
            else:
                _say("  (leer)")
            if stats["compacted"]:
                for day, info in stats["compacted"].items():
                    note = "Index ja" if info.get("indexed") else "Index fehlt (Scan)"
                    digest = f" digest={info['digest']}" if info.get("digest") else ""
                    _say(f"  kompaktiert {day}: {info['records']} Records, {info['bytes']} Bytes"
                         f" ({note}, {info.get('index_bytes', 0)} Bytes Index{digest}, Quelle: {info.get('source')})")
            stale = stats.get("stale_entries", 0)
            _say(f"  gesamt: {stats['total_entries']} Eintraege, {stats['total_bytes']} Bytes"
                 f" | veraltet (> {COMPACT_OLDER_THAN_DAYS} Tage): {stale}"
                 f" | Auto-Kompaktierung ab {COMPACT_MIN_STALE_ENTRIES}")
        return EXIT_OK

    summary = transport.compact_archive(
        older_than_days=getattr(args, "older_than_days", None),
        keep_recent=getattr(args, "keep_recent", 0),
    )
    violations = transport.verify_archive()
    if args.json:
        _dump({"ok": not violations, "summary": summary, "integrity_violations": violations})
    else:
        if violations:
            _say(f"[FEHLER] Integritaetsverletzungen: {len(violations)}")
            for issue in violations[:10]:
                _say(f"  {issue}")
            return EXIT_PROTOCOL
        _say(f"[ok] Ledger kompaktiert: {summary['pruned_dirs']} Eintraege, "
             f"{summary['bytes_freed']} Bytes freigegeben, {summary['snapshot_bytes']} Bytes im Snapshot")
        for day in sorted(summary["days"]):
            info = summary["days"][day]
            _say(f"  {day}: {info['compacted']} Eintraege -> {info['snapshot_records']} Snapshot-Records"
                 f" (+ {info.get('index_entries', 0)} Index-Offsets, {info.get('index_bytes', 0)} Bytes)")
    return EXIT_OK


def cmd_archive_lookup(args: argparse.Namespace) -> int:
    """Einzelnen Durchgang aus dem Ledger holen -- Snapshot *oder* Verzeichnis."""
    config = _config_from_args(args)
    transport = FileTransport(config)
    found = transport.lookup_archived(args.intent_id)
    if args.json:
        _dump({"ok": found is not None, "intent_id": args.intent_id, "entry": found})
    else:
        if found is None:
            _say(f"[archiv] kein Eintrag fuer '{args.intent_id}' (runtime/archive/)")
            return EXIT_PROTOCOL
        state = "kompaktiert (Snapshot)" if found["compacted"] else f"expandiert ({found.get('path')})"
        _say(f"  {found['intent_id']}  tag={found['day']}  {state}")
        record = found.get("record") or {}
        files = record.get("files") if found["compacted"] else None
        if isinstance(files, Mapping):
            for name in sorted(files):
                _say(f"    {name}: {json.dumps(files[name], ensure_ascii=False)[:120]}")
        else:
            for name in ("intent", "result", "verdict"):
                body = found.get(name)
                if body is not None:
                    _say(f"    {name}: {json.dumps(body, ensure_ascii=False)[:120]}")
    return EXIT_OK if found is not None else EXIT_PROTOCOL


def cmd_archive_verify(args: argparse.Namespace) -> int:
    """Integritaet der kompaktierten Schnappschuese pruefen (Digest-Schnellpfad)."""
    config = _config_from_args(args)
    transport = FileTransport(config)
    violations = transport.verify_archive(force=bool(getattr(args, "deep", False)))
    if args.json:
        _dump({"ok": not violations, "mode": "deep" if args.deep else "digest", "violations": violations})
    else:
        mode = "tief (jeden Eintrag re-hashen)" if args.deep else "Digest-Schnellpfad"
        if violations:
            _say(f"[FEHLER] {len(violations)} Verletzung(en), Pruefung: {mode}")
            for issue in violations[:20]:
                _say(f"  {issue}")
            return EXIT_PROTOCOL
        _say(f"[ok] Archive intakt (Pruefung: {mode})")
    return EXIT_OK



def _attach_uds_sink(bus: Any, args: argparse.Namespace) -> Any:
    """Haengt den opt-in UDS-Broadcast an den Bus (Nexus Triad 2, Focus A).

    Ohne ``--uds`` aendert sich nichts am Standardpfad (Konsole/Sammler/Datei).
    Mit ``--uds`` und nicht erreichbarem Empfaenger laeuft der Lauf trotzdem
    durch: der Sink zaehlt Drops und degradiert statt zu raise'en.
    """
    path = getattr(args, "uds", None)
    if not path:
        return None
    from .uds import UDSBroadcastSink

    sink = UDSBroadcastSink(Path(path), batch_bytes=int(getattr(args, "uds_batch", 0) or 0))
    bus.subscribe(sink)
    atexit.register(sink.close)  # Batch-Freigabe beim CLI-Exit, ohne Rueckgabe-Pfad zu verbauen
    return sink


def cmd_bus_tail(args: argparse.Namespace) -> int:
    """Mitlesen: Events vom UDS-Broadcast holen (Gegenseite von ``watch --uds``).

    Der Bus bleibt der Producer; dieses Kommando ist ein reiner Konsument --
    es schreibt nichts zurueck und aendert keinen Job-Zustand.
    """
    config = _config_from_args(args)
    from .uds import UDSBroadcastServer

    socket_path = Path(args.socket) if args.socket else config.runtime_dir / "bus.sock"
    limit = int(args.limit or 0)
    idle_s = max(0.05, float(args.idle if args.idle is not None else 5.0))
    seen = 0
    try:
        # Der Konsument *besitzt* das Socket: er bindet es (und raeumt einen stale
        # Inode eines abgestuerzten Laufs weg) und der Producer connectet dagegen.
        # Damit ist die Startreihenfolge egal -- `bus tail` zuerst starten ist der
        # vorgesehene Weg, ein laufender `watch --uds` findet den Empfaenger spaeter.
        with UDSBroadcastServer(socket_path) as server:
            if not args.json:
                _say(f"[bus tail] {socket_path} (wartet bis {idle_s}s Leerlauf"
                     f"{', limit=' + str(limit) if limit else ''})")
            while True:
                records = server.records(timeout_s=idle_s)
                if not records:
                    break
                for record in records:
                    if args.json:
                        # JSON Lines (eine Zeile pro Event) -- wie der Event-Strom
                        # auf stderr, damit `| jq -c` und `| wc -l` funktionieren.
                        print(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                    else:
                        clock = record.get("clock_s")
                        _say(f"  #{record.get('seq', '?'):>4} {record.get('timestamp', '')} "
                             f"{record.get('kind', '?'):<22} t_unlimited={clock if clock is not None else '-'}")
                    seen += 1
                    if limit and seen >= limit:
                        print(f"[bus tail] {seen} Events empfangen", file=sys.stderr)
                        return EXIT_OK
    except OSError as exc:
        _say(f"[bus tail] Socket nicht nutzbar: {exc}")
        return EXIT_PROTOCOL
    print(f"[bus tail] {seen} Events empfangen (Leerlauf {idle_s}s)", file=sys.stderr)
    return EXIT_OK


class WatchSink:
    """Menschenlesbare Live-Ansicht der Zeit-Ereignisse (``watch``).

    stdout bleibt fuer das Ergebnis reserviert; die Live-Zeilen gehen nach
    stderr, genau wie die JSON-Events des Busses. Damit bleibt ``--json`` pipe-faehig.
    """

    name = "watch"

    INTERESTING = (
        "schedule.attached",
        "schedule.detached",
        "timer.armed",
        "timer.tick",
        "timer.trigger",
        "timer.skipped",
        "timer.safety_net",
        "timer.log",
        "timer.escalation",
        "timer.finished",
        "job.scheduled",
        "limb.spawned",
        "limb.terminated",
        "result.verdict",
        "job.finished",
    )

    def __init__(self, stream: Any = None, show_ticks: bool = True) -> None:
        self.stream = stream or sys.stderr
        self.show_ticks = show_ticks
        self.lines = 0

    def write(self, record: Mapping[str, Any]) -> None:
        kind = str(record.get("kind", ""))
        if kind not in self.INTERESTING:
            return
        if kind == "timer.tick" and not self.show_ticks:
            return
        payload = dict(record.get("payload") or {})
        clock = record.get("clock_s")
        clock_text = f"{clock:>9.3f}s" if isinstance(clock, (int, float)) else "         -"
        detail = payload.get("reason") or payload.get("trigger_id") or payload.get("status") or ""
        extra = ""
        if kind == "job.scheduled":
            extra = f" -> {payload.get('operation', '')} ({payload.get('scheduled_job_id', '')})"
        elif kind == "timer.tick":
            extra = f" tick={payload.get('tick')} aktiv={','.join(payload.get('active_triggers') or ()) or '-'}"
        elif kind == "result.verdict":
            extra = f" entscheidung={payload.get('decision')}"
        elif kind == "job.finished":
            extra = f" status={payload.get('status')}"
        elif kind == "timer.armed":
            extra = f" mode={payload.get('mode')} deadline={payload.get('deadline_s')} safety_net={payload.get('safety_net_s')}"
        job = str(record.get("job_id", ""))
        job_text = f" {job[-6:]}" if job else ""
        line = f"[{clock_text}] {kind:<19}{job_text} {str(detail)[:56]}{extra}"
        try:
            self.stream.write(line + "\n")
            self.stream.flush()
            self.lines += 1
        except (OSError, ValueError):
            pass


def cmd_watch(args: argparse.Namespace) -> int:
    """Lebt-Ansicht: Auftrag mit Zeit-Tracking und/oder Triggern ueberwachen.

    Zwei Betriebsarten:

    * ohne ``--job``: startet einen Auftrag (wie ``job run``), zeigt aber jeden
      Tick, jede Feuerung und jeden Kontroll-Job live.
    * mit ``--job <id>``: **nur Scheduler** -- tickt den bestehenden Zeitplan
      dieses Auftrags und fuehrt faellige Aktionen aus, ohne einen Limb fuer den
      Auftrag selbst zu starten (z. B. nach einem Neustart).
    """
    config = _config_from_args(args)
    config.ensure_dirs()
    collector = None
    sink = WatchSink(show_ticks=not args.no_ticks)
    bus = build_event_bus(quiet=True, collector=collector)
    bus.subscribe(sink)
    _attach_uds_sink(bus, args)  # opt-in Broadcast-Zweig; Standardpfad bleibt unangetastet
    orch = Orchestrator(config, bus=bus, quiet=True)

    if args.job:
        state = orch.scheduler.load(args.job)
        if state is None:
            if args.json:
                _dump({"ok": False, "error": {"code": ErrorCode.PATH_NOT_FOUND,
                                              "message": f"kein Zeitplan fuer Job '{args.job}'"}})
            else:
                _say(f"[usage] fuer Job '{args.job}' liegt kein Zeitplan unter runtime/schedules/ vor")
            return EXIT_USAGE
        if not args.json:
            _say(f"[watch] nur Scheduler: {args.job} | t0={state.t0} | t_unlimited={state.elapsed_s()}s | "
                 f"tick={state.tick_s}s | {describe_schedule(state.triggers)}")
        limit_s = float(args.for_s) if args.for_s else 0.0
        started = time.monotonic()
        ticks = 0
        while True:
            ticks += 1
            actions = orch.scheduler.tick(state)
            started_this_tick = 0
            for action in actions:
                # Nicht ``outcome`` nennen: Weiter unten haelt dieselbe Funktion
                # ein ``JobOutcome`` -- zwei Bedeutungen in einem Namen fuehren
                # zu Typverwirrung (mypy) und beim Lesen.
                action_outcome = orch.execute_due_action(
                    action, parent_job_id=state.job_id, limb=args.limb, started_this_tick=started_this_tick
                )
                started_this_tick += sum(
                    1 for item in action_outcome.get("scheduled_jobs", []) if item.get("status") != "skipped"
                )
            refreshed = orch.scheduler.load(state.job_id) or state
            if refreshed.finish_requested or refreshed.needs_human:
                if not args.json:
                    _say(f"[watch] Zeitplan beendet die Ueberwachung "
                         f"(finish={refreshed.finish_requested} escalate={refreshed.needs_human})")
                break
            if args.max_ticks and ticks >= args.max_ticks:
                if not args.json:
                    _say(f"[watch] max-ticks={args.max_ticks} erreicht")
                break
            if limit_s and (time.monotonic() - started) >= limit_s:
                if not args.json:
                    _say(f"[watch] --for {limit_s}s erreicht (t_unlimited={refreshed.elapsed_s()}s)")
                break
            if not refreshed.active_triggers():
                if not args.json:
                    _say("[watch] alle Ausloeser sind abgearbeitet")
                break
            time.sleep(max(0.01, state.tick_s))
        report = orch.scheduler.report(args.job)
        if args.json:
            _dump({"ok": True, "ticks": ticks, "report": report})
        else:
            _print_schedule_report(report)
        return EXIT_OK

    if not args.op:
        if args.json:
            _dump({"ok": False, "error": {"code": ErrorCode.SCHEMA_INVALID, "message": "watch braucht --op/--goal oder --job"}})
        else:
            _say("[usage] watch braucht --op/--goal (neuer Auftrag) oder --job <id> (nur Scheduler)")
        return EXIT_USAGE

    params = _load_params(args.params, args.param)
    time_kwargs = _time_kwargs(args)
    if args.for_s and not time_kwargs.get("max_ticks"):
        tick = time_kwargs.get("tick_s") or config.timer.tick_s
        time_kwargs["max_ticks"] = max(1, int(float(args.for_s) / max(0.01, tick)))
    try:
        outcome = orch.run_job(
            goal=args.goal or args.title or args.op,
            operation=args.op,
            params=params,
            limb=args.limb,
            max_iterations=args.max_iterations,
            **time_kwargs,
            title=args.title or "",
            objective=args.objective or "",
            acceptance=tuple(args.accept or ()),
            constraints=_constraints(args),
            elevation=_elevation(args),
            context_summary=args.context or "",
            auto_iterate=not args.no_auto_iterate,
        )
    except ProtocolError as exc:
        _dump({"ok": False, "error": exc.to_dict()}) if args.json else _say(f"[protokoll] {exc}")
        return EXIT_PROTOCOL
    except ValueError as exc:  # Trigger-Angabe ungueltig
        _say(f"[usage] {exc}")
        return EXIT_USAGE
    if args.json:
        _dump(outcome.summary())
    else:
        _print_outcome(outcome, json_mode=False)
    return EXIT_OK if outcome.status == JOB_RESOLVED else EXIT_JOB_FAILED


def _print_schedule_report(report: Mapping[str, Any]) -> None:
    _rule("-")
    if not report.get("scheduled"):
        _say(f"  Job {report.get('job_id')}: kein Zeitplan hinterlegt")
        return
    _kv("Job", report["job_id"])
    _kv("Zeit-Modus", report["timer_mode"])
    _kv("t0", report["t0"])
    _kv("t_unlimited", f"{report['t_unlimited_s']}s")
    _kv("Tick", f"{report['tick_s']}s")
    _kv("Safety-Netz", f"{report['safety_net_s']}s" if report["safety_net_s"] else "(keins -- wirklich unbegrenzt)")
    _kv("Feuerungen", f"{report['fires_total']} gesamt | uebersprungen: {report['skipped_total']}")
    _kv("Entscheidung offen", f"needs_human={report['needs_human']} finish_requested={report['finish_requested']}")
    _kv("Naechste Faelligkeit", f"in {report['next_due_in_s']}s" if report["next_due_in_s"] is not None else "(keine)")
    _say("  Ausloeser:")
    for trigger in report["triggers"]:
        source = []
        if trigger["when"]:
            source.append(trigger["when"])
        if trigger["every_s"]:
            source.append(f"alle {trigger['every_s']}s")
        if trigger["at_s"]:
            source.append("bei " + ", ".join(f"{m}s" for m in trigger["at_s"]))
        status = "abgearbeitet" if trigger["finished"] else "aktiv"
        _say(f"    {trigger['id']:<14} {trigger['action']:<11} {' und '.join(source):<28} "
             f"feuert={trigger['fires']} uebersprungen={trigger['skipped']} [{status}]")
    _say("  Letzte Ereignisse:")
    for entry in report["last_ticks"]:
        _say(f"    {entry.get('elapsed_s')}s  {entry.get('kind'):<18} {entry.get('trigger_id') or '-':<12} {str(entry.get('reason'))[:60]}")
    _rule("-")


def cmd_schedule_show(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    config.ensure_dirs()
    scheduler = Scheduler(config)
    report = scheduler.report(args.job_id)

    # Zwei verschiedene Befunde, zwei verschiedene Codes:
    #   * die Job-Referenz bezeichnet nichts  -> Nutzungsfehler (Exit 3)
    #   * der Job existiert, hat aber keinen Zeitplan -> gueltige Antwort (Exit 0)
    if not report.get("scheduled") and JobStore(config).get(args.job_id) is None:
        if args.json:
            _dump({"ok": False, "job_id": args.job_id, "scheduled": False,
                   "error": {"code": ErrorCode.TARGET_NOT_FOUND, "message": f"Job '{args.job_id}' nicht gefunden"}})
        else:
            _say(f"[usage] Job '{args.job_id}' nicht gefunden (runtime/jobs/)")
        return EXIT_USAGE

    if args.json:
        _dump(report)
        return EXIT_OK
    if not report.get("scheduled"):
        _say(f"[info] kein Zeitplan fuer Job '{args.job_id}' (abgeschlossen oder nie ueberwacht)")
        return EXIT_OK
    _print_schedule_report(report)
    return EXIT_OK


def cmd_schedule_list(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    config.ensure_dirs()
    scheduler = Scheduler(config)
    states = scheduler.states()
    if args.json:
        _dump([scheduler.report(state.job_id) for state in states])
        return EXIT_OK
    if not states:
        _say("(keine Zeitplaene in runtime/schedules/)")
        return EXIT_OK
    for state in states:
        active = len(state.active_triggers())
        _say(f"{state.job_id}  t_unlimited={state.elapsed_s():>9.3f}s  tick={state.tick_s}s  "
             f"ausloeser={len(state.triggers)} (aktiv {active})  feuerungen={state.fires_total}  "
             f"uebersprungen={state.skipped_total}  needs_human={state.needs_human}")
    return EXIT_OK


def cmd_schedule_clear(args: argparse.Namespace) -> int:
    config = _config_from_args(args)
    config.ensure_dirs()
    scheduler = Scheduler(config)
    removed = scheduler.detach(args.job_id)
    if args.json:
        _dump({"ok": True, "removed": removed, "job_id": args.job_id})
    else:
        _say(f"[ok] Zeitplan fuer {args.job_id} "
             f"{'entfernt' if removed else 'war nicht vorhanden (Aufraeumen ist idempotent)'}")
    # Idempotent: Zweimal aufraeumen ist kein Bedienfehler.
    return EXIT_OK


def cmd_loop(args: argparse.Namespace) -> int:
    orch = _orchestrator(args)
    if args.watch:
        _say("[usage] --watch (Dauerbetrieb) folgt in Phase 4; aktuell ist --once verfuegbar.")
        return EXIT_USAGE
    attempts = orch.run_inbox_once()
    if args.json:
        _dump({"processed": len(attempts), "attempts": [a.summary() for a in attempts]})
        return EXIT_OK
    _say(f"[loop] {len(attempts)} Intent(s) abgearbeitet")
    for attempt in attempts:
        _say(f"  - {attempt.intent.intent_id} {attempt.intent.operation} -> {attempt.result.status}/{attempt.verdict.decision}")
    return EXIT_OK


def cmd_scale(args: argparse.Namespace) -> int:
    """Skalierungsprofil dauerhaft setzen -- nur mit menschlicher Freigabe."""
    config = _config_from_args(args)
    if args.profile not in SCALE_PROFILES:
        _say(f"[usage] Profil muss eines von {', '.join(SCALE_PROFILES)} sein.")
        return EXIT_USAGE
    if args.approved_by != "human":
        _say(
            "[abgelehnt] neu.config.json steht unter dem Constitution Guard (human_only_globs).\n"
            "            Ein Limb oder der Core darf sich seine Rechte nicht selbst erweitern.\n"
            "            Freigabe durch den User: --approved-by human"
        )
        return EXIT_JOB_FAILED
    path = config.repo_root / "neu.config.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    profile = dict(SCALE_PROFILES[args.profile])
    updated = {**current, "mode": args.profile, "limits": profile}
    backup = FileTransport(config).backup_file(path, reason=f"scale -> {args.profile} (approved_by=human)")
    path.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    payload = {"ok": True, "profile": args.profile, "limits": profile, "config": config.relative(path), "backup": config.relative(backup) if backup else None}
    if args.json:
        _dump(payload)
    else:
        _say(f"[ok] Profil '{args.profile}' gesetzt: {profile}")
        _say(f"     Datei: {config.relative(path)}" + (f"  Backup: {config.relative(backup)}" if backup else ""))
    return EXIT_OK


# --------------------------------------------------------------------------- #
# Parameter-Helfer
# --------------------------------------------------------------------------- #
def _load_params(raw: str | None, pairs: Sequence[str] | None) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if raw:
        text = Path(raw[1:]).read_text(encoding="utf-8") if raw.startswith("@") else raw
        try:
            loaded = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"[usage] --params ist kein gueltiges JSON: {exc}") from exc
        if not isinstance(loaded, dict):
            raise SystemExit("[usage] --params muss ein JSON-Objekt sein")
        params.update(loaded)
    for pair in pairs or ():
        if "=" not in pair:
            raise SystemExit(f"[usage] --param erwartet schluessel=wert (gefunden: {pair!r})")
        key, value = pair.split("=", 1)
        params[key.strip()] = _coerce_scalar(value)
    return params


def _coerce_scalar(value: str) -> Any:
    lowered = value.strip().lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "none"}:
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    if value.startswith(("[", "{")):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _constraints(args: argparse.Namespace) -> dict[str, Any]:
    constraints: dict[str, Any] = {}
    if getattr(args, "sandbox", None):
        constraints["sandbox_root"] = args.sandbox
    if getattr(args, "allow_shell", False):
        constraints["allow_shell"] = True
    if getattr(args, "allow_network", False):
        constraints["allow_network"] = True
    if getattr(args, "dry_run", False):
        constraints["dry_run"] = True
    if getattr(args, "no_backup", False):
        constraints["backup"] = False
    if getattr(args, "max_output_bytes", None):
        constraints["max_output_bytes"] = args.max_output_bytes
    return constraints


def _elevation(args: argparse.Namespace) -> dict[str, Any] | None:
    level = getattr(args, "elevate", None)
    if not level or level == "none":
        return None
    return {
        "level": level,
        "reason": args.reason or "",
        "approved_by": args.approved_by or "core",
        "requested_paths": tuple(args.path or ()),
    }


TRIGGER_KEY_ALIASES = {
    "id": "id",
    "action": "action",
    "when": "when",
    "every": "every_s",
    "every_s": "every_s",
    "at": "at_s",
    "at_s": "at_s",
    "clock": "clock",
    "tolerance": "tolerance_s",
    "tolerance_s": "tolerance_s",
    "max-fires": "max_fires",
    "max_fires": "max_fires",
    "once": "once",
}

#: Schluessel, die in ``payload`` wandern (Aktion-spezifisch).
TRIGGER_PAYLOAD_KEYS = {
    "op": "operation",
    "operation": "operation",
    "params": "params",
    "checks": "checks",
    "limb": "limb",
    "goal": "goal",
    "title": "title",
    "kind": "kind",
    "message": "message",
    "reason": "reason",
}


def _split_trigger_spec(spec: str) -> list[str]:
    """Teilt ``a=1;b={...}`` an Semikola -- aber nicht innerhalb von JSON."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    quote = ""
    for char in spec:
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            current.append(char)
            continue
        if char in "{[":
            depth += 1
        elif char in "}]":
            depth = max(0, depth - 1)
        if char == ";" and depth == 0:
            parts.append("".join(current).strip())
            current = []
            continue
        current.append(char)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return [part for part in parts if part]


def _coerce_trigger_value(key: str, raw: str) -> Any:
    """Wandelt Trigger-Werte in die protokollgerechten Typen."""
    text = raw.strip()
    if key == "at_s":
        return [float(item) for item in text.replace(" ", "").split(",") if item]
    if key in {"params", "checks"}:
        return json.loads(text)
    if key in {"every_s", "tolerance_s"}:
        return float(text)
    if key == "max_fires":
        return int(text)
    if key == "once":
        lowered = text.lower()
        if lowered in {"true", "1", "yes", "ja"}:
            return True
        if lowered in {"false", "0", "no", "nein"}:
            return False
        raise ValueError(f"once erwartet true/false (gefunden: {text!r})")
    return text


def _parse_trigger_spec(spec: str) -> dict[str, Any]:
    """Uebersetzt eine CLI-Trigger-Angabe in ein protokollgerechtes Dict.

    Drei Formen: JSON-Objekt, ``@datei.json`` oder ``schluessel=wert;...``.
    Die Pruefung gegen das Protokoll geschieht danach durch den Parser
    (``core.protocol.Trigger``) und die Policy -- die CLI erfindet keine eigenen
    Regeln, sie uebersetzt nur.
    """
    text = spec.strip()
    if text.startswith("@"):
        text = Path(text[1:]).read_text(encoding="utf-8").strip()
    if text.startswith("{"):
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("Trigger-JSON muss ein Objekt sein")
        return data

    trigger: dict[str, Any] = {}
    payload: dict[str, Any] = {}
    for part in _split_trigger_spec(text):
        if "=" not in part:
            raise ValueError(f"Trigger-Angabe '{part}' hat kein '=' (erwartet schluessel=wert)")
        key, _, raw_value = part.partition("=")
        key = key.strip().lower()
        if key in TRIGGER_KEY_ALIASES:
            trigger[TRIGGER_KEY_ALIASES[key]] = _coerce_trigger_value(TRIGGER_KEY_ALIASES[key], raw_value)
        elif key in TRIGGER_PAYLOAD_KEYS:
            payload[TRIGGER_PAYLOAD_KEYS[key]] = _coerce_trigger_value(TRIGGER_PAYLOAD_KEYS[key], raw_value)
        else:
            known = ", ".join(sorted({*TRIGGER_KEY_ALIASES, *TRIGGER_PAYLOAD_KEYS}))
            raise ValueError(f"unbekannter Trigger-Schluessel '{key}' (bekannt: {known})")
    if payload:
        trigger["payload"] = payload
    return trigger


def _triggers_from_args(args: argparse.Namespace) -> list[dict[str, Any]]:
    raw = list(getattr(args, "trigger", []) or [])
    return [_parse_trigger_spec(item) for item in raw]


def _time_kwargs(args: argparse.Namespace) -> dict[str, Any]:
    """Gemeinsame Zeit-Parameter fuer run_job/build_intent aus den CLI-Schaltern."""
    kwargs: dict[str, Any] = {
        "deadline_s": args.deadline,
        "soft_deadline_s": args.soft_deadline,
        "grace_s": args.grace,
        "safety_net_s": args.safety_net,
        "on_expiry": args.on_expiry,
        "on_failure": args.on_failure,
        "unlimited": bool(args.unlimited),
        "tick_s": args.tick,
        "max_ticks": args.max_ticks,
    }
    triggers = _triggers_from_args(args)
    if triggers:
        kwargs["schedule"] = triggers
    return kwargs


def _add_timer_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--deadline", type=float, default=None, help="hartes Zeitbudget des Durchgangs in Sekunden")
    parser.add_argument("--soft-deadline", type=float, default=None, help="weiche Marke fuer den Statusbericht des Limbs")
    parser.add_argument("--grace", type=float, default=None, help="Nachfrist zwischen Soft-Report und hartem Kill")
    parser.add_argument("--on-expiry", choices=("iterate", "escalate", "abort", "none"), default=None,
                        help="Reaktion bei Timer-Ablauf (Default: iterate; unlimited erzwingt none)")
    parser.add_argument("--on-failure", choices=("autodidactic", "return_to_core", "abort"), default="autodidactic", help="Reaktion bei Fehlschlag (Default: autodidactic)")
    # --- Protokoll 1.2: Zeit tracken statt begrenzen + zeitgesteuerte Trigger ---
    parser.add_argument("--unlimited", action="store_true",
                        help="kein Zeitlimit: Zeit wird getrackt (t_unlimited) und kann Ausloeser speisen")
    parser.add_argument("--safety-net", type=float, default=None, dest="safety_net",
                        help="Safety-Netz in Sekunden (Prozess-Hygiene, kein Aufgabenlimit; Default aus neu.config.json)")
    parser.add_argument("--tick", type=float, default=None, help="Tick-Intervall des Schedulers in Sekunden (Default 0.5)")
    parser.add_argument("--trigger", action="append", default=[],
                        help="zeitgesteuerter Ausloeser: 'id=..;action=..;every=10;op=sys.ping' oder JSON oder @datei (mehrfach)")
    parser.add_argument("--max-ticks", type=int, default=0, dest="max_ticks",
                        help="Ueberwachung nach so vielen Ticks beenden (0 = unbegrenzt)")


def _add_task_flags(parser: argparse.ArgumentParser, *, op_required: bool = True) -> None:
    parser.add_argument("--op", required=op_required, default=None, help="Operation gemaess protocol/operations.json")
    parser.add_argument("--limb", default="echo", help="Ziel-Limb (Default: echo)")
    parser.add_argument("--params", default=None, help="Parameter als JSON-Objekt oder @datei.json")
    parser.add_argument("--param", action="append", default=[], help="Einzelparameter schluessel=wert (mehrfach)")
    parser.add_argument("--title", default=None, help="Kurztitel des Auftrags")
    parser.add_argument("--objective", default=None, help="Zielbeschreibung fuer den Limb")
    parser.add_argument("--accept", action="append", default=[], help="Acceptance-Kriterium (mehrfach)")
    parser.add_argument("--context", default=None, help="Kontextzusammenfassung fuer den Limb")
    parser.add_argument("--sandbox", default=None, help="Sandbox-Wurzel (Default: workspace)")
    parser.add_argument("--allow-shell", action="store_true", help="constraints.allow_shell=true")
    parser.add_argument("--allow-network", action="store_true", help="constraints.allow_network=true")
    parser.add_argument("--dry-run", action="store_true", help="Limb soll nichts schreiben")
    parser.add_argument("--no-backup", action="store_true", help="Backups deaktivieren")
    parser.add_argument("--max-output-bytes", type=int, default=None, help="Groessenlimit fuer Ausgaben")
    parser.add_argument("--elevate", choices=("none", "workspace", "repo_write"), default=None, help="Rechteanhebung")
    parser.add_argument("--reason", default=None, help="Begruendung der Rechteanhebung (>= 20 Zeichen)")
    parser.add_argument("--approved-by", default=None, help="core | human")
    parser.add_argument("--path", action="append", default=[], help="Deklarierter Zielpfad fuer elevation.requested_paths (mehrfach)")


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #
class _NeuArgumentParser(argparse.ArgumentParser):
    """Nutzungsfehler beenden mit Exit-Code 3 -- nicht mit argparse' Default 2.

    Im CLI-Vertrag ist Code 2 fuer "Job nicht aufgeloest" reserviert. Ein
    Tippfehler in einem Flag darf fuer Skripte nicht wie ein gescheiterter
    Auftrag aussehen, sonst wird aus einem Bedienfehler eine Eskalation.
    """

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: Fehler: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = _NeuArgumentParser(
        prog="python3 -m orchestrator",
        description=f"NEU-Orchestrator: steuert Jobs, Timer, Zeitplaene und Limbs (Protokoll {PROTOCOL_VERSION}).",
    )
    parser.add_argument("--repo-root", default=None, help="Repository-Wurzel (Default: dieses Repo)")
    parser.add_argument("--runtime-dir", default=None, dest="runtime_dir",
                        help="Laufzeitverzeichnis (Queues, Jobs, Zeitplaene) -- absolut oder relativ zur Repo-Wurzel")
    parser.add_argument("--mode", choices=tuple(SCALE_PROFILES), default=None, help="Profil fuer diesen Aufruf ueberschreiben (dev=1/1/1/1)")
    parser.add_argument("--json", action="store_true", help="Maschinenlesbare Ausgabe auf stdout")
    parser.add_argument("--quiet", action="store_true", help="Event-Ausgabe auf stderr unterdruecken")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=_NeuArgumentParser)

    p_spec = sub.add_parser("spec", help="Protokoll, Operationen, Timer- und Iterations-Semantik anzeigen")
    p_spec.set_defaults(func=cmd_spec)

    p_status = sub.add_parser("status", help="Konfiguration, Queues, Jobs, Limbs, Agent-Slots")
    p_status.set_defaults(func=cmd_status)

    p_job = sub.add_parser("job", help="Job-Lebenszyklus (run/list/show)")
    job_sub = p_job.add_subparsers(dest="job_command", required=True, parser_class=_NeuArgumentParser)

    p_run = job_sub.add_parser("run", help="Ziel als Job ausfuehren (inkl. Timer + autodidaktischem 2. Durchgang)")
    p_run.add_argument("--goal", required=True, help="Ziel des Jobs (ueber alle Durchgaenge stabil)")
    p_run.add_argument("--max-iterations", type=int, default=None, help=f"Durchgaenge (max {ABSOLUTE_MAX_ITERATIONS}, gedeckelt durch das Profil)")
    p_run.add_argument("--no-auto-iterate", action="store_true", help="Autodidaktik deaktivieren (nur ein Durchgang)")
    _add_task_flags(p_run)
    _add_timer_flags(p_run)
    p_run.set_defaults(func=cmd_job_run)

    p_list = job_sub.add_parser("list", help="Jobs auflisten")
    p_list.add_argument("--limit", type=int, default=25)
    p_list.add_argument("--active", action="store_true", help="nur aktive Jobs")
    p_list.set_defaults(func=cmd_job_list)

    p_show = job_sub.add_parser("show", help="Job inkl. Historie und Statusberichten anzeigen")
    p_show.add_argument("job_id")
    p_show.set_defaults(func=cmd_job_show)

    p_reclaim = job_sub.add_parser("reclaim", help="Verwaiste (abgestuerzte) Jobs eskalieren und freigeben")
    p_reclaim.set_defaults(func=cmd_job_reclaim)

    p_dispatch = sub.add_parser("dispatch", help="Einzelnen Intent zustellen (ein Durchgang, keine Autodidaktik)")
    p_dispatch.add_argument("--intent", required=True, type=Path, help="Intent-Datei oder '-' fuer stdin")
    p_dispatch.set_defaults(func=cmd_dispatch)

    p_intent = sub.add_parser("intent", help="Intent erzeugen, validieren und optional zustellen")
    _add_task_flags(p_intent)
    _add_timer_flags(p_intent)
    p_intent.add_argument("--goal", default=None, help="Job-Ziel")
    p_intent.add_argument("--iteration", type=int, default=1, help="Durchgang (1..max_iterations)")
    p_intent.add_argument("--max-iterations", type=int, default=None, help="Iterations-Budget des Jobs")
    p_intent.add_argument("--verify-type", choices=("none", "file_exists", "hash", "unittest", "pytest", "shell"), default=None)
    p_intent.add_argument("--verify-command", default=None)
    p_intent.add_argument("--out", default=None, help="Intent zusaetzlich in diese Datei schreiben")
    p_intent.add_argument("--print", dest="print_only", action="store_true", default=True, help="Intent nur ausgeben (Default)")
    p_intent.add_argument("--dispatch", action="store_true", help="Intent sofort zustellen (ein Durchgang)")
    p_intent.set_defaults(func=cmd_intent)

    p_validate = sub.add_parser("validate", help=f"Intent-/Result-Datei gegen Protokoll {PROTOCOL_VERSION} pruefen")
    p_validate.add_argument("--intent", type=Path, default=None)
    p_validate.add_argument("--result", type=Path, default=None)
    p_validate.add_argument("--schema", action="store_true",
                            help="zusaetzlich gegen die normativen protocol/*.schema.json pruefen (Stdlib-Pruefer)")
    p_validate.set_defaults(func=cmd_validate)

    # --- Protokoll 1.2: Zeit-Tracking live + zeitgesteuerte Ausloeser ---
    p_watch = sub.add_parser(
        "watch",
        help="Auftrag mit Zeit-Tracking/Triggern live ueberwachen (oder mit --job nur den Scheduler ticken)",
    )
    _add_task_flags(p_watch, op_required=False)
    _add_timer_flags(p_watch)
    p_watch.add_argument("--goal", default=None, help="Ziel des Auftrags")
    p_watch.add_argument("--max-iterations", type=int, default=None, dest="max_iterations")
    p_watch.add_argument("--no-auto-iterate", action="store_true", dest="no_auto_iterate")
    p_watch.add_argument("--job", default=None, help="bestehender Job: nur dessen Zeitplan ticken (kein Limb-Start)")
    p_watch.add_argument("--for", dest="for_s", type=float, default=None, help="Wandzeit-Limit in Sekunden")
    p_watch.add_argument("--no-ticks", action="store_true", dest="no_ticks", help="timer.tick-Zeilen unterdruecken")
    p_watch.add_argument("--uds", default=None, metavar="PATH",
                         help="Event-Strom zusaetzlich per Unix-Domain-Socket broadcasten (opt-in, sub-ms; "
                              "Datei-/Konsolepfad bleibt unveraendert)")
    p_watch.add_argument("--uds-batch", type=int, default=0, dest="uds_batch", metavar="BYTES",
                         help="Broadcast-Zeilen bis N Bytes bündeln (1 Syscall fuer viele Events; 0 = sofort senden)")
    p_watch.set_defaults(func=cmd_watch)

    p_bus = sub.add_parser("bus", help="Event-Bus-Broadcast (Unix-Domain-Socket) mitlesen")
    bus_sub = p_bus.add_subparsers(dest="bus_cmd", required=True, parser_class=_NeuArgumentParser)
    p_bus_tail = bus_sub.add_parser("tail", help="Events vom Broadcast-Socket holen (read-only Konsument)")
    p_bus_tail.add_argument("--socket", default=None, help="Pfad des Broadcast-Sockets (Default: runtime/bus.sock)")
    p_bus_tail.add_argument("--limit", type=int, default=0, help="nach N Events aufhoeren (0 = bis Leerlauf)")
    # Die Leerlauf-Schwelle muss die Producer-Startzeit uebersteigen: der tail
    # bindet das Socket und wartet; ein `watch`-Prozess braucht ~1-2 s bis zum
    # ersten Event (Interpreter + Config + Limb-Spawn). 2 s fuhrten dazu, dass der
    # tail abbrach, *bevor* der erste Event eintraf.
    p_bus_tail.add_argument("--idle", type=float, default=5.0,
                            help="Leerlauf-Sekunden bis zum Abbruch (Default 5.0; groesser als die Producer-Startzeit waehlen)")
    p_bus_tail.add_argument("--json", action="store_true", help="JSON Lines statt Menschentext auf stdout")
    p_bus_tail.set_defaults(func=cmd_bus_tail)

    p_schedule = sub.add_parser("schedule", help="Zeitgesteuerte Ausloeser: Zustand, Bericht, Aufraeumen")
    sched_sub = p_schedule.add_subparsers(dest="schedule_cmd", required=True, parser_class=_NeuArgumentParser)
    p_sched_show = sched_sub.add_parser("show", help="Zustand eines Zeitplans inkl. t_unlimited und Historie")
    p_sched_show.add_argument("job_id")
    p_sched_show.set_defaults(func=cmd_schedule_show)
    p_sched_list = sched_sub.add_parser("list", help="Alle hinterlegten Zeitplaene (runtime/schedules/)")
    p_sched_list.set_defaults(func=cmd_schedule_list)
    p_sched_clear = sched_sub.add_parser("clear", help="Zeitplan eines Jobs entfernen")
    p_sched_clear.add_argument("job_id")
    p_sched_clear.set_defaults(func=cmd_schedule_clear)

    p_archive = sub.add_parser("archive", help="Archiv-/Ledger-Hygiene: Statistik und Kompaktierung")
    archive_sub = p_archive.add_subparsers(dest="archive_cmd", required=True, parser_class=_NeuArgumentParser)
    p_arch_stats = archive_sub.add_parser("stats", help="Archiv-Groesse und Eintraege anzeigen")
    p_arch_stats.set_defaults(func=cmd_archive)
    p_arch_compact = archive_sub.add_parser("compact", help="Veraltete Eintraege in Snapshot-Dateien kompaktieren und pruenen")
    p_arch_compact.add_argument("--older-than-days", type=int, default=30,
                                help="nur Eintraege aelter als N Tage kompaktieren (Default 30)")
    p_arch_compact.add_argument("--keep-recent", type=int, default=7,
                                help="die neuesten N Eintraege pro Tag als Verzeichnis belassen (Default 7)")
    p_arch_compact.set_defaults(func=cmd_archive)
    p_arch_lookup = archive_sub.add_parser("lookup", help="Einzelnen Durchgang im Ledger suchen (kompaktiert oder expandiert)")
    p_arch_lookup.add_argument("intent_id")
    p_arch_lookup.set_defaults(func=cmd_archive_lookup)
    p_arch_verify = archive_sub.add_parser("verify", help="Integritaet der Schnappschuese pruefen (SHA-256)")
    p_arch_verify.add_argument("--deep", action="store_true", help="jeden Eintrag re-hashen statt nur den Tages-Digest zu pruefen")
    p_arch_verify.set_defaults(func=cmd_archive_verify)

    p_loop = sub.add_parser("loop", help="Inbox abarbeiten")
    p_loop.add_argument("--once", action="store_true", default=True, help="Ein Durchlauf (Default)")
    p_loop.add_argument("--watch", action="store_true", help="Dauerbetrieb (ab Phase 4)")
    p_loop.set_defaults(func=cmd_loop)

    p_scale = sub.add_parser("scale", help="Skalierungsprofil dauerhaft setzen (Constitution Guard: nur mit --approved-by human)")
    p_scale.add_argument("--profile", required=True, choices=tuple(SCALE_PROFILES))
    p_scale.add_argument("--approved-by", default="core", choices=("core", "human"))
    p_scale.set_defaults(func=cmd_scale)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ProtocolError as exc:
        if getattr(args, "json", False):
            _dump({"ok": False, "error": exc.to_dict()})
        else:
            _say(f"[protokoll] {exc}")
        return EXIT_PROTOCOL
    except SystemExit:
        raise
    except Exception as exc:
        if getattr(args, "json", False):
            _dump({"ok": False, "error": {"code": ErrorCode.INTERNAL, "message": f"{type(exc).__name__}: {exc}"}})
        else:
            _say(f"[intern] {type(exc).__name__}: {exc}")
        return EXIT_PROTOCOL


if __name__ == "__main__":
    raise SystemExit(main())
