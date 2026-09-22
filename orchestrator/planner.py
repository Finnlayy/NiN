"""Autodidaktischer Re-Planer (Protokoll 1.2).

Wenn ein Durchgang scheitert oder der Timer ablaeuft, entwirft **der
Orchestrator** den Auftrag fuer den zweiten Durchgang -- einen "optimalen
Prompt", der aus dem echten Fehlschlag gelernt hat:

    Diagnose (Fehlercode + Statusbericht + stderr) -> Massnahme -> neuer Intent

Der neue Intent ist kein blindes Retry:

* anderes ``intent_id``, gleicher ``job_id``, ``iteration + 1``
* ``parent_intent_id`` verweist auf den Fehlversuch
* Kontext enthaelt die vollstaendige Fehleranalyse und eine
  ``forbidden_repeats``-Liste, damit exakt dieselbe Aktion nicht wiederholt wird
* Parameter, Rechte, Timer und Acceptance-Kriterien werden *zielfuehrend*
  nachgeschaerft (siehe DIAGNOSEN)
* alles bleibt deterministisch nachvollziehbar -- der KI-Kern (LLM) darf den
  Entwurf ueberschreiben, muss dann aber seine Fassung als Intent einspeisen

Grenzen: Kein Plan ohne Massnahme, kein Plan ohne Budget. Ist beides nicht
gegeben, meldet :meth:`IterationPlanner.can_plan` ``False`` und der Job wird
wirklich failed (bzw. eskaliert).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.config import ABSOLUTE_MAX_ITERATIONS, DEFAULT_DEADLINE_S, NeuConfig
from core.kernel import Kernel, Verdict
from core.protocol import ErrorCode, Intent, Operations, ProtocolError, Result, sha256_text

#: Massnahmen, die ohne Menschen nicht moeglich sind.
ESCALATION_CODES = frozenset({ErrorCode.SANDBOX_ESCAPE, ErrorCode.SHELL_BLOCKED})
HUMAN_GUARD_HINT = "Constitution Guard"


@dataclass(frozen=True)
class Diagnosis:
    """Was war die Ursache, und welche Massnahme folgt daraus?"""

    code: str
    cause: str
    measure: str
    escalate: bool = False
    escalation_reason: str = ""
    operation_override: str | None = None
    limb_override: str | None = None
    param_patch: Mapping[str, Any] = field(default_factory=dict)
    constraint_patch: Mapping[str, Any] = field(default_factory=dict)
    elevation_patch: Mapping[str, Any] | None = None
    timer_patch: Mapping[str, float] = field(default_factory=dict)
    extra_acceptance: tuple[str, ...] = ()
    forbidden_repeats: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "cause": self.cause,
            "measure": self.measure,
            "escalate": self.escalate,
            "escalation_reason": self.escalation_reason,
            "operation_override": self.operation_override,
            "limb_override": self.limb_override,
            "param_patch": dict(self.param_patch),
            "constraint_patch": dict(self.constraint_patch),
            "elevation_patch": dict(self.elevation_patch) if self.elevation_patch else None,
            "timer_patch": dict(self.timer_patch),
            "extra_acceptance": list(self.extra_acceptance),
            "forbidden_repeats": list(self.forbidden_repeats),
        }


class IterationPlanner:
    """Entwirft den zweiten Durchgang eines Jobs."""

    def __init__(self, kernel: Kernel | None = None, config: NeuConfig | None = None, registry: Any | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.kernel = kernel or Kernel(self.config)
        self.operations: Operations = self.kernel.operations
        self.registry = registry

    # ------------------------------------------------------------- Diagnose
    def diagnose(self, intent: Intent, result: Result, verdict: Verdict) -> Diagnosis:
        code = result.error_code or ("E_TIMEOUT" if result.status == "timeout" else ErrorCode.INTERNAL)
        report = result.status_report
        message = str((result.error or {}).get("message", ""))
        hint = str((result.error or {}).get("hint", ""))
        stderr_tail = result.diagnostics_stderr[-1500:]
        params = dict(intent.task.params)
        repeat_guard = (sha256_text(json.dumps({"op": intent.operation, "params": params}, sort_keys=True, ensure_ascii=False))[:16],)

        # ---------------- Safety-Netz (Protokoll 1.2): Mensch, kein 2. Durchgang ----------------
        if code == ErrorCode.SAFETY_NET:
            elapsed = result.timer.elapsed_s
            return Diagnosis(
                code=code,
                cause=(
                    f"Safety-Netz {intent.timer.safety_net_s}s hat bei t_unlimited={elapsed}s eingegriffen. "
                    f"Der Auftrag lief im Unlimited-Modus, wurde aber nicht selbst beendet; "
                    f"kein Ausloeser hat rechtzeitig abgeschlossen. Statusbericht: "
                    f"{(report.explanation[:400] if report else '') or 'nicht geliefert'}"
                ),
                measure=(
                    "Kein automatischer 2. Durchgang: Unlimited heisst 'Zeit tracken', nicht 'ewig laufen'. "
                    "Menschliche Entscheidung noetig -- entweder den Auftrag zerlegen, einen Ausloeser "
                    "(finish_job/check) mit realistischer Schwelle setzen oder safety_net_s bewusst anheben."
                ),
                escalate=True,
                escalation_reason="Safety-Netz im Unlimited-Modus ausgeloest -- Schwelle ist Menschenentscheid.",
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Zeitplan fehlerhaft: Kern repariert, Limb ist unschuldig ----------------
        if code == ErrorCode.TRIGGER_INVALID:
            return Diagnosis(
                code=code,
                cause=f"Zeitplan-Ausloeser abgelehnt: {message[:400]}",
                measure=(
                    "Auftrag neu komponieren: Ausloeser-Bedingung an die Grammatik anpassen "
                    "(z. B. 'elapsed >= 30'), Operation des check-Ausloesers auf einen registrierten "
                    "Limb legen, Rechte/Sandbox-Einstellungen des Zeitplans pruefen."
                ),
                escalate=False,
                timer_patch={},
                forbidden_repeats=repeat_guard,
                extra_acceptance=("Ausloeser-Bedingung entspricht der Trigger-Grammatik.",),
            )

        # ---------------- Zeitablauf: Budget + Umfang ----------------
        if result.status == "timeout" or code in {ErrorCode.TIMEOUT, ErrorCode.DEADLINE_EXCEEDED}:
            budget = (
                f"safety_net={intent.timer.safety_net_s}s (unlimited)"
                if intent.timer.unlimited
                else f"Budget {intent.timer.deadline_s}s"
            )
            cause = (
                f"Timer abgelaufen nach {result.duration_ms} ms ({budget}, "
                f"Soft-Report {'ja' if result.timer.self_reported else 'nein'})."
            )
            if report and report.explanation:
                cause += f" Statusbericht des Limbs: {report.explanation[:600]}"
            scaled = self._scaled_timer(intent)
            return Diagnosis(
                code=code,
                cause=cause,
                measure=(
                    "Umfang des Auftrags verkleinern und Timer auf das verbleibende Job-Budget anheben. "
                    "Konkret: nur ein einziges, pruefbares Teilergebnis anstreben; lange Warte-/Batch-Arbeit "
                    "in mehrere Durchgaenge teilen."
                ),
                param_patch=self._shrink_params(params, intent.operation),
                constraint_patch={"backup": True},
                timer_patch=scaled,
                extra_acceptance=(
                    "Der Durchgang endet vor der Soft-Deadline mit einem status_report (state, done, remaining).",
                    "Es wird hoechstens ein Teilschritt ausgefuehrt, dafuer vollstaendig.",
                ),
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Suchtext nicht gefunden ----------------
        if code == ErrorCode.PATCH_NO_MATCH:
            return Diagnosis(
                code=code,
                cause=f"fs.patch fand den Suchtext nicht: {message[:400]}",
                measure=(
                    "Erst den Ist-Zustand lesen (fs.read_file), dann die Datei komplett schreiben "
                    "(fs.write_file, mode=overwrite) statt eines blinden Suchen/Ersetzen-Eingriffs."
                ),
                operation_override="fs.read_file",
                param_patch={"path": params.get("path", ""), "max_bytes": 262_144},
                extra_acceptance=("Der Ist-Inhalt der Datei liegt als Nachweis im Result vor.",),
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Sandbox / Rechte ----------------
        if code == ErrorCode.SANDBOX_ESCAPE:
            target = self._first_path_param(intent)
            return Diagnosis(
                code=code,
                cause=f"Zielpfad liegt ausserhalb der Sandbox: {message[:400]}",
                measure=(
                    "Selbstmodifikation korrekt beantragen: elevation.level='repo_write' mit Begruendung, "
                    "approved_by='core' und explizit deklarierten requested_paths."
                ),
                elevation_patch={
                    "level": "repo_write",
                    "reason": (
                        "Korrekturdurchgang: Der Auftrag verlangt eine Aenderung am System selbst "
                        f"(Ziel: {target}). Begruendung aus Fehlschlag {intent.intent_id}: {message[:200]}"
                    )[:2000],
                    "approved_by": "core",
                    "requested_paths": (target,) if target else (),
                },
                constraint_patch={"sandbox_root": ".", "backup": True},
                extra_acceptance=("Vor dem Schreiben liegt ein Backup unter runtime/backups/ (Artefakt-Nachweis).",),
                forbidden_repeats=repeat_guard,
            )

        if code == ErrorCode.POLICY_DENIED:
            profile_markers = ("Profil-Limit", "Iterations-Budget", "max_iterations", "max_limbs", "max_agents", "max_concurrent_jobs")
            if any(marker in message for marker in profile_markers):
                return Diagnosis(
                    code=code,
                    cause=f"Skalierungsgrenze des Profils verletzt: {message[:400]}",
                    measure=(
                        "Keine automatische Massnahme: Das Profil begrenzt Iterationen/Limbs/Agenten. "
                        "Hochskalieren darf nur der User (orchestrator scale --profile scale --approved-by human)."
                    ),
                    escalate=True,
                    escalation_reason="Skalierungsgrenze -- Profilaenderung ist menschenpflichtig (Constitution Guard).",
                    forbidden_repeats=repeat_guard,
                )
            if HUMAN_GUARD_HINT in message or "Constitution Guard" in message or "approved_by" in hint:
                return Diagnosis(
                    code=code,
                    cause=f"Rechte verweigert: {message[:400]}",
                    measure="Keine automatische Massnahme moeglich: Die Policy verlangt menschliche Freigabe.",
                    escalate=True,
                    escalation_reason="Constitution Guard / human_only_globs -- nur der User darf diese Rechte erweitern.",
                    forbidden_repeats=repeat_guard,
                )
            return Diagnosis(
                code=code,
                cause=f"Rechte verweigert: {message[:400]}",
                measure="Auftrag auf einen erlaubten Pfad/Operation zurueckziehen und ohne Rechteanhebung ausfuehren.",
                constraint_patch={"sandbox_root": "workspace"},
                param_patch=self._retarget_into_sandbox(params),
                forbidden_repeats=repeat_guard,
            )

        # ---------------- falsche Operation / falscher Limb ----------------
        if code in {ErrorCode.UNSUPPORTED_OP, ErrorCode.TARGET_NOT_FOUND}:
            alternative_op, alternative_limb = self._find_capable(intent.operation, intent.target_limb)
            if alternative_op is None:
                return Diagnosis(
                    code=code,
                    cause=f"{message[:400]}",
                    measure="Kein aktiver Limb implementiert die benoetigte Operation.",
                    escalate=True,
                    escalation_reason="Fehlende Faehigkeit: Es muss erst ein Limb gebaut werden (Phase 2+).",
                    forbidden_repeats=repeat_guard,
                )
            return Diagnosis(
                code=code,
                cause=f"{message[:400]}",
                measure=f"Operation/Limb korrigieren auf '{alternative_op}' bei Limb '{alternative_limb or intent.target_limb}'.",
                operation_override=alternative_op,
                limb_override=alternative_limb,
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Protokollfehler im Auftrag ----------------
        if code == ErrorCode.SCHEMA_INVALID:
            return Diagnosis(
                code=code,
                cause=f"Auftrag oder Antwort verletzt das Protokoll: {message[:400]} (Pfad: {hint[:200]})",
                measure="Parameter strikt gemaess protocol/operations.json neu setzen (Typen und Pflichtfelder beachten).",
                param_patch=self._coerce_params(intent.operation, params),
                extra_acceptance=("Alle Pflichtparameter entsprechen dem Operations-Register.",),
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Dateizustand ----------------
        if code == ErrorCode.PATH_NOT_FOUND:
            return Diagnosis(
                code=code,
                cause=f"Ziel existiert nicht: {message[:400]}",
                measure="Anlegen statt veraendern: mode='create' (inkl. Elternverzeichnis) bzw. Pfad korrigieren.",
                param_patch={**params, "mode": "create"},
                extra_acceptance=("Die Datei existiert nach dem Durchgang und ist als Artefakt belegt.",),
                forbidden_repeats=repeat_guard,
            )

        if code == ErrorCode.ALREADY_EXISTS:
            return Diagnosis(
                code=code,
                cause=f"Ziel existiert bereits: {message[:400]}",
                measure="Ueberschreiben mit Backup und Hash-Vorbedingung statt create.",
                param_patch={**params, "mode": "overwrite"},
                constraint_patch={"backup": True},
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Limb-Crash ----------------
        if code == ErrorCode.LIMB_CRASH:
            return Diagnosis(
                code=code,
                cause=f"Limb lieferte kein protokollkonformes Result: {message[:400]}",
                measure=(
                    "Umfang halbieren und erneut ausfuehren; der Limb schreibt ausschliesslich ein "
                    "JSON-Objekt auf stdout, alles andere nach stderr."
                ),
                param_patch=self._shrink_params(params, intent.operation),
                timer_patch=self._scaled_timer(intent, factor=1.25),
                extra_acceptance=("stdout enthaelt genau ein JSON-Objekt mit protocol='neu/result'.",),
                forbidden_repeats=repeat_guard,
            )

        if code == ErrorCode.IO:
            return Diagnosis(
                code=code,
                cause=f"Dateisystemfehler: {message[:400]}",
                measure="Mit aktiviertem Backup und verifiziertem Zielpfad erneut schreiben.",
                constraint_patch={"backup": True},
                forbidden_repeats=repeat_guard,
            )

        # ---------------- Teilerfolg ----------------
        if result.status == "partial":
            remaining = list(report.remaining) if report else []
            return Diagnosis(
                code=code or "E_PARTIAL",
                cause=f"Teilerfolg: {message[:300] or (report.explanation[:300] if report else '')}",
                measure="Nur die offenen Punkte als eigener Mikro-Auftrag nachziehen.",
                param_patch=self._partial_followup(params, remaining),
                extra_acceptance=tuple(f"Offener Punkt erledigt: {item}" for item in remaining[:5]) or ("Restumfang erledigt.",),
                forbidden_repeats=repeat_guard,
            )

        # ---------------- unspezifisch ----------------
        return Diagnosis(
            code=code,
            cause=f"Unspezifischer Fehlschlag: {message[:400] or 'keine Fehlermeldung'}",
            measure=(
                "Umfang verkleinern, Diagnose aus stderr wiederholen"
                + (f" (stderr: {stderr_tail[-300:]})" if stderr_tail else "")
                + "."
            ),
            param_patch=self._shrink_params(params, intent.operation),
            timer_patch=self._scaled_timer(intent, factor=1.5),
            extra_acceptance=("Der Statusbericht nennt done/remaining explizit.",),
            forbidden_repeats=repeat_guard,
        )

    # ------------------------------------------------------------- Planung
    @staticmethod
    def measure_available(diagnosis: Diagnosis) -> bool:
        """Gibt es ueberhaupt eine Massnahme? (False = Eskalation zum Menschen.)"""
        return not diagnosis.escalate

    def budget_available(self, intent: Intent) -> tuple[bool, str]:
        """Ist noch ein Durchgang im Budget? Zaehlung pro Job, nie pro Agentenaufruf."""
        cap = min(self.config.limits.max_iterations, ABSOLUTE_MAX_ITERATIONS)
        limit = min(intent.job.max_iterations, cap)
        if intent.job.iteration >= limit:
            return False, f"Iterations-Budget erschoepft ({intent.job.iteration}/{limit}, Profil {self.config.mode})."
        return True, f"Durchgang {intent.job.iteration + 1} von {limit} moeglich."

    def can_plan(self, intent: Intent, result: Result, verdict: Verdict, *, diagnosis: Diagnosis | None = None) -> tuple[bool, str]:
        """Liefert (moeglich, begruendung). Massnahme UND Budget muessen gegeben sein."""
        diag = diagnosis or self.diagnose(intent, result, verdict)

        if intent.job.on_failure == "abort":
            return False, "job.on_failure='abort' -- der Core will keine Automatik."
        if verdict.decision == "accept":
            return False, "Ergebnis wurde akzeptiert; kein Korrekturdurchgang noetig."
        if not self.measure_available(diag):
            return False, f"Eskalation noetig: {diag.escalation_reason or diag.cause}"
        has_budget, budget_reason = self.budget_available(intent)
        if not has_budget:
            return False, f"{budget_reason} Massnahme waere: {diag.measure[:200]}"
        return True, diag.measure

    def compose(self, intent: Intent, result: Result, verdict: Verdict, *, diagnosis: Diagnosis | None = None, node_id: str = "orchestrator.planner") -> Intent:
        """Baut den Intent fuer den naechsten Durchgang -- den "optimalen Prompt"."""
        diag = diagnosis or self.diagnose(intent, result, verdict)
        allowed, reason = self.can_plan(intent, result, verdict, diagnosis=diag)
        if not allowed:
            raise ProtocolError(ErrorCode.BUDGET_EXHAUSTED, f"Kein Korrekturdurchgang moeglich: {reason}")

        report = result.status_report
        params = {**dict(intent.task.params), **dict(diag.param_patch)}
        params = {k: v for k, v in params.items() if v is not None}
        operation = diag.operation_override or intent.operation
        limb = diag.limb_override or intent.target_limb

        constraints = {**intent.constraints.to_dict(), **dict(diag.constraint_patch)}
        elevation = dict(diag.elevation_patch) if diag.elevation_patch else intent.elevation.to_dict()

        timer_patch = dict(diag.timer_patch)
        unlimited = intent.timer.unlimited
        if unlimited:
            # Kein Budget -> nichts zu skalieren. Der Korrekturdurchgang bleibt im
            # Tracking-Modus und erbt t0 des Jobs (eine Uhr pro Auftrag).
            deadline: float | None = None
            soft: float | None = None
        else:
            # Der Zweig ist per Definition nicht unlimited; fehlt trotzdem eine
            # Zahl (unvollstaendig geschaerfter Timer), gilt die Protokoll-Default.
            current = intent.timer.deadline_s if intent.timer.deadline_s is not None else DEFAULT_DEADLINE_S
            deadline = float(timer_patch.get("deadline_s", current))
            soft_default = intent.timer.soft_deadline_s if intent.timer.soft_deadline_s is not None else deadline
            soft = float(timer_patch.get("soft_deadline_s", min(soft_default, deadline)))
        grace = float(timer_patch.get("grace_s", intent.timer.grace_s))

        briefing = self._briefing(intent, result, verdict, diag)
        acceptance = tuple(dict.fromkeys((*intent.task.acceptance, *diag.extra_acceptance)))

        return self.kernel.build_intent(
            operation=operation,
            params=params,
            limb=limb,
            job_id=intent.job_id,
            goal=intent.job.goal,
            iteration=intent.job.iteration + 1,
            max_iterations=intent.job.max_iterations,
            on_failure=intent.job.on_failure,
            on_expiry=intent.timer.on_expiry,
            deadline_s=deadline,
            soft_deadline_s=soft,
            grace_s=grace,
            unlimited=unlimited,
            safety_net_s=intent.timer.safety_net_s,
            # Zeitplan mitnehmen: Der Korrekturdurchgang setzt dieselbe Uhr und
            # denselben Zustand fort (attach() erhalt bereits erfolgte Feuerungen),
            # statt Ausloeser von vorn zu zaehlen.
            schedule=[trigger.to_dict() for trigger in intent.schedule.triggers] or None,
            tick_s=intent.schedule.tick_s,
            title=f"Korrektur D{intent.job.iteration + 1}: {intent.task.title or operation}"[:250],
            objective=(
                f"Ziel (unveraendert): {intent.job.goal or intent.task.objective}\n"
                f"Durchgang {intent.job.iteration + 1} von {intent.job.max_iterations}. "
                f"Der vorherige Versuch ({intent.intent_id}) ist gescheitert: {diag.cause[:600]}\n"
                f"Massnahme dieses Durchgangs: {diag.measure[:900]}\n"
                f"Verboten: exakt dieselbe Aktion zu wiederholen "
                f"(Fingerabdruck {', '.join(diag.forbidden_repeats) or 'n/a'}).\n"
                f"Liefere in jedem Fall einen status_report mit done/remaining, auch bei Abbruch."
            )[:8000],
            acceptance=acceptance,
            verification=intent.task.verification.to_dict() if intent.task.verification else None,
            constraints=constraints,
            elevation=elevation,
            context_summary=briefing[:16000],
            context_artifacts=intent.context_artifacts,
            context_extra={
                **intent.context_extra,
                "autodidactic": True,
                "corrects": intent.intent_id,
                "diagnosis": diag.to_dict(),
                "previous": {
                    "intent_id": intent.intent_id,
                    "operation": intent.operation,
                    "params": dict(intent.task.params),
                    "status": result.status,
                    "error": result.error,
                    "status_report": report.to_dict() if report else None,
                    "duration_ms": result.duration_ms,
                    "verdict": verdict.decision,
                    "reasons": list(verdict.reasons)[:10],
                },
                "forbidden_repeats": list(diag.forbidden_repeats),
            },
            parent_intent_id=intent.intent_id,
            trace_id=intent.trace_id,
            node_id=node_id,
        )

    # ------------------------------------------------------------- Internes
    def _briefing(self, intent: Intent, result: Result, verdict: Verdict, diag: Diagnosis) -> str:
        report = result.status_report
        lines = [
            f"FEHLSCHLAGS-BRIEFING fuer Durchgang {intent.job.iteration + 1} (Job {intent.job_id})",
            f"Ziel: {intent.job.goal or intent.task.objective or intent.operation}",
            f"Vorheriger Auftrag: {intent.intent_id} op={intent.operation} limb={intent.target_limb}",
            f"Ergebnis: status={result.status} code={diag.code} dauer={result.duration_ms}ms",
            f"Ursache: {diag.cause}",
            f"Massnahme: {diag.measure}",
            (
                f"Timer: mode=unlimited t0={intent.timer.t0} t_unlimited={result.timer.elapsed_s}s "
                f"safety_net={intent.timer.safety_net_s}s self_reported={result.timer.self_reported}"
                if intent.timer.unlimited
                else f"Timer: deadline={intent.timer.deadline_s}s soft={intent.timer.soft_deadline_s}s "
                     f"self_reported={result.timer.self_reported} overrun={result.timer.overrun_ms}ms"
            ),
        ]
        if report:
            lines.append(f"Statusbericht: state={report.state} erklaerung={report.explanation[:400]}")
            if report.done:
                lines.append(f"Erledigt: {'; '.join(report.done)[:400]}")
            if report.remaining:
                lines.append(f"Offen: {'; '.join(report.remaining)[:400]}")
            if report.blockers:
                lines.append(f"Blocker: {json.dumps(list(report.blockers)[:3], ensure_ascii=False)[:400]}")
            if report.suggested_next:
                lines.append(f"Vorschlag des Limbs: {report.suggested_next[:300]}")
        if verdict.reasons:
            lines.append(f"Kern-Bewertung: {'; '.join(verdict.reasons)[:600]}")
        if result.diagnostics_stderr.strip():
            lines.append(f"stderr (Auszug): {result.diagnostics_stderr.strip()[-600:]}")
        return "\n".join(lines)

    def _scaled_timer(self, intent: Intent, *, factor: float = 1.5) -> dict[str, float]:
        """Mehr Zeit fuer den Korrekturdurchgang -- aber nie ueber dem harten Limit.

        Im Unlimited-Modus (Protokoll 1.2) gibt es **kein** Budget zu skalieren:
        Die Zeit wird getrackt, nicht begrenzt. Dann bleibt der Patch leer, und
        ``compose`` uebernimmt Modus, Safety-Netz und Zeitplan unveraendert.
        """
        if intent.timer.unlimited or intent.timer.deadline_s is None:
            return {}

        from core.config import HARD_DEADLINE_S

        deadline = min(HARD_DEADLINE_S, round(intent.timer.deadline_s * factor, 3))
        return {
            "deadline_s": deadline,
            "soft_deadline_s": max(0.2, round(deadline * 0.75, 3)),
            "grace_s": intent.timer.grace_s,
        }

    @staticmethod
    def _shrink_params(params: Mapping[str, Any], operation: str) -> dict[str, Any]:
        """Umfang verkleinern: Wartezeiten halbieren, Inhalte kuerzen, Batches begrenzen."""
        patched = dict(params)
        if "seconds" in patched and isinstance(patched["seconds"], (int, float)):
            patched["seconds"] = max(0.05, round(float(patched["seconds"]) / 2.0, 3))
        if "timeout_s" in patched and isinstance(patched["timeout_s"], (int, float)):
            patched["timeout_s"] = max(1.0, round(float(patched["timeout_s"]) / 2.0, 3))
        if "max_entries" in patched and isinstance(patched["max_entries"], int):
            patched["max_entries"] = max(10, patched["max_entries"] // 2)
        if "max_bytes" in patched and isinstance(patched["max_bytes"], int):
            patched["max_bytes"] = max(4096, patched["max_bytes"] // 2)
        if isinstance(patched.get("content"), str) and len(patched["content"]) > 20_000:
            patched["content"] = patched["content"][:20_000]
        if isinstance(patched.get("patches"), list) and len(patched["patches"]) > 3:
            patched["patches"] = patched["patches"][:3]
        if operation == "sys.sleep":
            patched.setdefault("report_state", "timeout")
        return patched

    @staticmethod
    def _retarget_into_sandbox(params: Mapping[str, Any]) -> dict[str, Any]:
        patched = dict(params)
        path = str(patched.get("path", ""))
        if path:
            patched["path"] = f"workspace/{Path(path).name}" if "/" not in path.strip("/") else path
        return patched

    @staticmethod
    def _partial_followup(params: Mapping[str, Any], remaining: Sequence[str]) -> dict[str, Any]:
        patched = dict(params)
        if remaining:
            patched["remaining_focus"] = list(remaining)[:5]
        return patched

    def _coerce_params(self, operation: str, params: Mapping[str, Any]) -> dict[str, Any]:
        patched = dict(params)
        if not self.operations.known(operation):
            return patched
        spec = self.operations.spec(operation)
        for key, declaration in spec.params.items():
            text = str(declaration)
            if key not in patched:
                continue
            if text.startswith("int") and isinstance(patched[key], str) and patched[key].lstrip("-").isdigit():
                patched[key] = int(patched[key])
            if text.startswith("number") and isinstance(patched[key], str):
                with contextlib.suppress(ValueError):
                    patched[key] = float(patched[key])
            if text.startswith("bool") and isinstance(patched[key], str):
                patched[key] = patched[key].lower() in {"true", "1", "yes", "ja"}
        return patched

    def _first_path_param(self, intent: Intent) -> str:
        if not self.operations.known(intent.operation):
            return ""
        for name in self.operations.spec(intent.operation).path_params:
            value = intent.task.params.get(name)
            if isinstance(value, str) and value:
                return value
        return str(intent.task.params.get("path", "") or "")

    def _find_capable(self, operation: str, current_limb: str) -> tuple[str | None, str | None]:
        """Sucht eine ausfuehrbare Alternative innerhalb der Profil-Grenzen."""
        if self.operations.known(operation):
            spec = self.operations.spec(operation)
            if not spec.implemented_by or current_limb in spec.implemented_by:
                return operation, None
            if self.registry is not None:
                for candidate in spec.implemented_by:
                    limb_spec = self.registry.get(candidate)
                    if limb_spec is not None and limb_spec.usable:
                        if self.config.limits.max_limbs <= 1:
                            return None, None  # Dev-Modus: Limb-Wechsel verboten
                        return operation, candidate
            return None, None
        return None, None
