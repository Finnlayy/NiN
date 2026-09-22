"""Deterministischer Anteil des KI-Kerns (Phase 1, Protokoll 1.2).

Wichtig zur Rolle: Der *intelligente* Teil des KI-Kerns ist das LLM, das diese
Bibliothek benutzt. ``kernel.py`` enthaelt ausschliesslich deterministische
Funktionen, damit Entscheidungen nachvollziehbar und testbar bleiben:

* :meth:`Kernel.build_intent`  -- Auftrag eines Job-Durchgangs erzeugen
* :meth:`Kernel.evaluate`      -- Limb-Ergebnis bewerten -> Verdict
* :func:`arm_timer`            -- Timer **vor Anbeginn** schaerfen

Jeder Auftrag erhaelt einen Timer. Laeuft er ab, muss ein Statusbericht vorliegen
(das Protokoll erzwingt das, seit 1.1). Danach entscheidet nicht der Zufall, sondern die
Job-Logik: Ist eine Massnahme verfuegbar und Budget uebrig -> autodidaktischer
2. Durchgang. Sonst -> wirklich failed.

Seit Protokoll 1.2 gibt es zwei Zeit-Modi:

``deadline``   es gilt ein Zeitbudget; Ablauf erzwingt den Statusbericht.
``unlimited``  **kein** Zeitlimit -- die Zeit wird getrackt (``t0`` ab
               Job-Erstellung, ``elapsed_s`` = ``t_unlimited``) und kann als
               Ereignisquelle dienen: ``schedule.triggers`` feuern Aktionen,
               sobald ``elapsed`` eine Bedingung erfuellt oder ein Intervall
               verstreicht ("pruefe alle N Sekunden X und Y").

Das ``safety_net_s`` ist in beiden Modi reine Prozess-Hygiene (Zombie-Schutz)
und kein Aufgabenlimit; sein Eingriff meldet ``E_SAFETY_NET`` und wird vom Kern
eskaliert statt iteriert -- ein Neustart wuerde dieselbe Uhr erneut ueberlaufen.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .config import ABSOLUTE_MAX_ITERATIONS, DEFAULT_DEADLINE_S, NeuConfig
from .policy import Policy
from .protocol import (
    Constraints,
    Elevation,
    ErrorCode,
    Intent,
    Job,
    Operations,
    ProtocolError,
    Result,
    Schedule,
    Timer,
    Verification,
    new_id,
    sha256_file,
    utc_now_iso,
)

__all__ = ["ACCEPT", "NEEDS_CORRECTION", "REJECT", "Kernel", "Verdict", "arm_timer", "artifact_reference", "bind_job_clock", "remaining_budget"]

ACCEPT = "accept"
NEEDS_CORRECTION = "needs_correction"
REJECT = "reject"

#: Ab dieser Selbsteinschaetzung wird ein "success" trotzdem hinterfragt.
MIN_CONFIDENCE = 0.5

NEXT_READ_ARTIFACTS = "read_artifacts_and_continue"
NEXT_ITERATE = "iterate_autodidactic"
NEXT_ESCALATE = "escalate_to_human"
NEXT_REPLAN = "core_replan"


@dataclass(frozen=True)
class Verdict:
    """Bewertung eines Limb-Ergebnisses durch den Kern.

    ``reasons``   harte Mängel -> Entscheidung wird gekippt
    ``warnings``  weiche Hinweise -> Entscheidung bleibt, Mensch prüft
    """

    decision: str
    reasons: tuple[str, ...] = ()
    next_action: str = ""
    checks: dict[str, Any] = field(default_factory=dict)
    timer_expired: bool = False
    warnings: tuple[str, ...] = ()

    @property
    def accepted(self) -> bool:
        return self.decision == ACCEPT

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "reasons": list(self.reasons),
            "warnings": list(self.warnings),
            "next_action": self.next_action,
            "timer_expired": self.timer_expired,
            "checks": dict(self.checks),
        }


def bind_job_clock(intent: Intent, t0: str) -> Intent:
    """Bindet die Intent-Uhr an die Job-Uhr (``t0`` = Job-Erstellung).

    Ohne diesen Schritt gaebe es zwei Nullpunkte: ``JobRecord.created_at`` (wann
    der Auftrag entstand) und ``timer.armed_at`` (wann der Durchgang geschaerft
    wurde). ``t_unlimited`` waere dann je nach Lesestelle eine andere Zahl --
    genau die Art Drift, die Phase 3 (Log-Analyse) unbrauchbar macht. Regel:
    **Ein Auftrag, eine Uhr.** Im Deadline-Modus bleibt der Intent unveraendert,
    weil dort absolute Fristen (nicht die Job-Uhr) massgeblich sind.
    """
    if not t0 or not intent.timer.unlimited or intent.timer.t0:
        return intent
    return replace(intent, timer=replace(intent.timer, t0=t0))


def arm_timer(intent: Intent, *, now=None, config: NeuConfig | None = None) -> Intent:
    """Schaerft den Timer eines Intents **vor** der Uebergabe an den Limb.

    Der Limb sieht damit eine absolute Deadline (``timer.expires_at``) und kann
    selbst einen Statusbericht liefern, bevor der Orchestrator hart abbricht.
    """
    cfg = config or NeuConfig.load()
    timer = intent.timer
    if not timer.armed_at and not timer.unlimited:
        # Soft-Deadline niemals ueber der harten Deadline, nie unter 0.2s.
        # Im Unlimited-Modus gibt es keine Deadline zum Klemmen: Die Uhr wird
        # nur gestartet (t0), damit t_unlimited zaehlt.
        soft = min(timer.soft_deadline_s or 0.0, timer.deadline_s or 0.0)
        timer = replace(timer, soft_deadline_s=max(0.2, soft))
    armed = timer.arm(now=now)
    del cfg  # Konfiguration dient hier nur der Default-Aufloesung
    return replace(intent, timer=armed)


class Kernel:
    """Werkzeugkasten des KI-Kerns."""

    def __init__(self, config: NeuConfig | None = None, operations: Operations | None = None, policy: Policy | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.operations = operations or Operations.load(self.config.protocol_dir / "operations.json")
        self.policy = policy or Policy(self.config, self.operations)

    # ------------------------------------------------------------- Intents
    def build_intent(
        self,
        *,
        operation: str,
        params: Mapping[str, Any] | None = None,
        limb: str = "echo",
        job_id: str | None = None,
        goal: str = "",
        iteration: int = 1,
        max_iterations: int | None = None,
        on_failure: str = "autodidactic",
        on_expiry: str | None = None,
        deadline_s: float | None = None,
        soft_deadline_s: float | None = None,
        grace_s: float | None = None,
        safety_net_s: float | None = None,
        unlimited: bool = False,
        schedule: Sequence[Mapping[str, Any]] | Mapping[str, Any] | None = None,
        tick_s: float | None = None,
        title: str = "",
        objective: str = "",
        acceptance: Sequence[str] = (),
        verification: Mapping[str, Any] | None = None,
        constraints: Mapping[str, Any] | None = None,
        elevation: Mapping[str, Any] | None = None,
        context_summary: str = "",
        context_artifacts: Sequence[Mapping[str, Any]] = (),
        context_extra: Mapping[str, Any] | None = None,
        parent_intent_id: str | None = None,
        trace_id: str | None = None,
        node_id: str = "core.kernel",
    ) -> Intent:
        """Baut und validiert einen Intent -- inkl. Policy-Pre-Flight.

        Wirft ``ProtocolError``, wenn Auftrag oder Rechte nicht zulaessig sind.
        ``max_iterations`` wird auf das Konfigurationslimit gedeckelt (Dev-Modus: 1).

        **Zeit-Modus:** Wird kein ``deadline_s`` uebergeben (oder ``unlimited=True``),
        entsteht ``timer.mode="unlimited"`` -- die Zeit wird dann *getrackt* statt
        begrenzt (``t0`` = Job-Erstellung, ``elapsed_s`` = ``t_unlimited``).
        ``schedule`` nimmt zeitgesteuerte Trigger auf, die der Orchestrator gegen
        dieselbe Uhr auswertet.
        """
        from .protocol import Task  # lokaler Import gegen Zirkularitaet beim Laden

        cap = min(self.config.limits.max_iterations, ABSOLUTE_MAX_ITERATIONS)
        effective_max = max(1, min(int(max_iterations if max_iterations is not None else cap), cap))
        effective_iteration = max(1, min(int(iteration), effective_max))

        timer_defaults = self.config.timer
        wants_unlimited = bool(unlimited) or (deadline_s is None and timer_defaults.unlimited)
        if wants_unlimited:
            # Kein Limit -> die Uhr laeuft einfach mit und wird aufgezeichnet.
            timer = Timer(
                mode="unlimited",
                deadline_s=None,
                soft_deadline_s=None,
                grace_s=float(grace_s if grace_s is not None else timer_defaults.grace_s),
                on_expiry="none",
                safety_net_s=safety_net_s if safety_net_s is not None else timer_defaults.safety_net_s,
            )
        else:
            # Deadline-Modus braucht eine Zahl. Steht auch die Konfiguration auf
            # unlimited (``deadline_s=None``), gilt die Protokoll-Default -- sonst
            # wuerde ein ausdruecklich begrenzter Auftrag ohne Budget starten.
            effective_deadline = deadline_s if deadline_s is not None else (timer_defaults.deadline_s or DEFAULT_DEADLINE_S)
            timer = Timer(
                mode="deadline",
                deadline_s=float(effective_deadline),
                soft_deadline_s=float(soft_deadline_s if soft_deadline_s is not None else (timer_defaults.soft_deadline_s or 45.0)),
                grace_s=float(grace_s if grace_s is not None else timer_defaults.grace_s),
                on_expiry=on_expiry or "iterate",
                safety_net_s=safety_net_s if safety_net_s is not None else timer_defaults.safety_net_s,
            )
            if timer.soft_deadline_s and timer.deadline_s and timer.soft_deadline_s > timer.deadline_s:
                timer = replace(timer, soft_deadline_s=max(0.2, timer.deadline_s * 0.8))

        if schedule:
            schedule_obj = Schedule.from_dict(
                schedule if isinstance(schedule, Mapping) else {"triggers": list(schedule), "tick_s": tick_s or self.config.timer.tick_s}
            )
        else:
            schedule_obj = Schedule(triggers=(), tick_s=float(tick_s or self.config.timer.tick_s))

        job = Job(
            job_id=job_id or new_id("job"),
            goal=goal or title or operation,
            iteration=effective_iteration,
            max_iterations=effective_max,
            on_failure=on_failure,
        )

        task = Task(
            operation=operation,
            params=dict(params or {}),
            title=title,
            objective=objective,
            acceptance=tuple(acceptance),
            verification=Verification.from_dict(dict(verification)) if verification else None,
        )
        intent = Intent(
            intent_id=new_id("int"),
            operation=operation,
            task=task,
            target_limb=limb,
            created_at=utc_now_iso(),
            job=job,
            timer=timer,
            trace_id=trace_id or job.job_id,
            parent_intent_id=parent_intent_id,
            idempotency_key="",
            source_role="core",
            source_node=node_id,
            constraints=Constraints.from_dict(dict(constraints) if constraints else None),
            elevation=Elevation.from_dict(dict(elevation) if elevation else None),
            schedule=schedule_obj,
            context_summary=context_summary,
            context_artifacts=tuple(dict(a) for a in context_artifacts),
            context_extra=dict(context_extra or {}),
        )
        intent = replace(intent, idempotency_key=f"{job.job_id}:i{job.iteration}:{intent.intent_id}")

        # Round-Trip durch den Parser = dieselbe strenge Validierung wie am Eingang
        # des Orchestrators. Was hier durchfaellt, duerfte der Limb nie sehen.
        validated = Intent.from_dict(intent.to_dict(), operations=self.operations)
        decision = self.policy.check(validated)
        if not decision.allowed:
            raise ProtocolError(decision.code, decision.reason)
        return validated

    # ------------------------------------------------------------ Bewertung
    def evaluate(self, intent: Intent, result: Result, *, verify_hashes: bool = True) -> Verdict:
        """Bewertet ein Limb-Ergebnis gegen den Auftrag. Rein deterministisch."""
        reasons: list[str] = []
        report = result.status_report
        timer_expired = result.status == "timeout" or (report is not None and report.state == "timeout")
        checks: dict[str, Any] = {
            "intent_id_match": result.intent_id == intent.intent_id,
            "operation_match": result.operation == intent.operation,
            "limb_match": result.limb_name == intent.target_limb,
            "iteration": result.iteration,
            "timer_mode": intent.timer.mode,
            "t0": intent.timer.t0,
            "elapsed_s": result.timer.elapsed_s,
            "job_iteration_match": result.iteration == intent.iteration,
            "status": result.status,
            "artifacts": [a.to_dict() for a in result.artifacts],
            "confidence": result.confidence,
            "status_report": report.to_dict() if report else None,
            "timer": result.timer.to_dict(),
        }

        if not checks["intent_id_match"]:
            reasons.append("result.intent_id gehoert nicht zu diesem Auftrag.")
        if not checks["operation_match"]:
            reasons.append(f"Operation abgewichen: erwartet {intent.operation}, erhalten {result.operation}.")
        if not checks["limb_match"]:
            reasons.append(f"Falscher Limb geantwortet: {result.limb_name}.")
        if not checks["job_iteration_match"]:
            reasons.append(f"Iterationsnummer abgewichen: erwartet {intent.iteration}, erhalten {result.iteration}.")

        # ---------------- Safety-Net (Prozess-Hygiene, kein Aufgabenlimit) ----
        if result.error_code == ErrorCode.SAFETY_NET:
            reasons.append(
                f"Safety-Net hat den Prozess beendet ({(result.error or {}).get('message', '')[:200]}). "
                "Das ist kein inhaltliches Scheitern, braucht aber eine Entscheidung: "
                "Auftrag zerlegen oder safety_net_s anheben (Konfiguration ist menschenpflichtig)."
            )
            return Verdict(REJECT, tuple(reasons), next_action=NEXT_ESCALATE, checks=checks, timer_expired=timer_expired)

        # ---------------- abgelehnt (vor Ausfuehrung) ----------------
        if result.status == "rejected":
            code = result.error_code or "n/a"
            reasons.append(f"Auftrag abgelehnt ({code}). Rechte/Ziel muessen ueberarbeitet werden.")
            action = NEXT_ESCALATE if code in {"E_POLICY_DENIED", "E_SANDBOX_ESCAPE", "E_SHELL_BLOCKED"} else NEXT_REPLAN
            return Verdict(REJECT, tuple(reasons), next_action=action, checks=checks, timer_expired=timer_expired)

        # ---------------- Timer abgelaufen ----------------
        if result.status == "timeout":
            explanation = report.explanation if report else "(kein Statusbericht)"
            reasons.append(f"Timer abgelaufen nach {result.duration_ms} ms. Statusbericht: {explanation[:400]}")
            if report and report.remaining:
                reasons.append(f"Offen laut Limb: {'; '.join(report.remaining)[:400]}")
            if not result.timer.self_reported:
                reasons.append("Kein Selbstbericht des Limbs: Der Orchestrator hat hart abgebrochen (Report synthetisiert).")
            return Verdict(NEEDS_CORRECTION, tuple(reasons), next_action=NEXT_ITERATE, checks=checks, timer_expired=True)

        # ---------------- Fehler ----------------
        if result.status == "failed":
            error = result.error or {}
            reasons.append(f"Ausfuehrung fehlgeschlagen: {error.get('code')} -- {str(error.get('message', ''))[:400]}")
            if report and report.explanation:
                reasons.append(f"Statusbericht: {report.explanation[:400]}")
            return Verdict(NEEDS_CORRECTION, tuple(reasons), next_action=NEXT_ITERATE, checks=checks, timer_expired=timer_expired)

        # ---------------- Planmaessiger Stopp durch den Zeitplan (1.2) --------
        # Ein finish_job-/escalate-Trigger beendet einen Auftrag absichtlich. Das
        # Limb-Ergebnis ist dann "partial" (der Limb hat nicht selbst fertig
        # gemacht), aber der *Auftrag* ist erfuellt. Ohne diese Unterscheidung
        # wuerde jede planmaessig beendete Beobachtung als korrekturbeduerftig
        # gelten -- und der 2. Durchgang wuerde dieselbe Uhr erneut ablaufen lassen.
        output = result.output if isinstance(result.output, Mapping) else {}
        stop_reason = str(output.get("stop_reason", ""))
        if stop_reason and str(output.get("synthesized_by", "")) == "orchestrator":
            elapsed = result.timer.elapsed_s
            checks["stop_reason"] = stop_reason
            if stop_reason == "finish_job":
                reasons.append(f"Planmaessig beendet: finish_job-Trigger bei t_unlimited={elapsed}s.")
                return Verdict(
                    ACCEPT,
                    tuple(reasons),
                    next_action=NEXT_READ_ARTIFACTS,
                    checks=checks,
                    timer_expired=False,
                    warnings=(
                        f"Der Limb wurde durch den Zeitplan gestoppt (t_unlimited={elapsed}s), "
                        "nicht durch eigenes Fertigwerden: Ergebnis auf Vollstaendigkeit pruefen.",
                    ),
                )
            if stop_reason == "escalate":
                reasons.append(f"escalate-Trigger bei t_unlimited={elapsed}s: Entscheidung durch Mensch/Core noetig.")
                return Verdict(REJECT, tuple(reasons), next_action=NEXT_ESCALATE, checks=checks, timer_expired=False)
            reasons.append(f"Ueberwachung bei t_unlimited={elapsed}s beendet (Grund: {stop_reason}); Arbeit unvollstaendig.")
            return Verdict(NEEDS_CORRECTION, tuple(reasons), next_action=NEXT_ITERATE, checks=checks, timer_expired=False)

        # ---------------- Teilerfolg ----------------
        if result.status == "partial":
            remaining = "; ".join(report.remaining) if report else "(nicht beziffert)"
            reasons.append(f"Teilerfolg. Offen: {remaining[:400]}")
            return Verdict(NEEDS_CORRECTION, tuple(reasons), next_action=NEXT_ITERATE, checks=checks, timer_expired=timer_expired)

        # ---------------- Erfolg ----------------
        if intent.operation.startswith("fs.") and intent.operation not in {"fs.read_file", "fs.list"} and not result.artifacts:
            reasons.append("Schreiboperation ohne Artefakt-Nachweis -- Erfolg ist nicht belegt.")

        if verify_hashes:
            reasons.extend(self._verify_artifact_hashes(result))

        warnings: list[str] = []
        if intent.task.acceptance:
            covered = self._acceptance_coverage(intent, result)
            checks["acceptance_coverage"] = covered
            missing = [criterion for criterion, hit in covered.items() if not hit]
            if missing:
                verified = intent.task.verification is not None and intent.task.verification.type != "none"
                if not verified:
                    # Lexikalische Heuristik ist kein Beweis: Sie darf einen echten
                    # Erfolg nicht kippen, sondern wird dem Kern zur Prüfung vorgelegt.
                    warnings.append(
                        f"{len(missing)} Acceptance-Kriterium/Kriterien ohne maschinellen Nachweis "
                        f"(vom Kern zu lesen): {missing}"
                    )

        if result.confidence < MIN_CONFIDENCE:
            reasons.append(f"Selbsteinschaetzung {result.confidence:.2f} liegt unter {MIN_CONFIDENCE}.")

        if result.diagnostics_exit_code not in (0, None):
            reasons.append(f"Exit-Code {result.diagnostics_exit_code} trotz status=success.")

        if result.timer.overrun_ms > 0:
            warnings.append(f"Timer ueberzogen um {result.timer.overrun_ms} ms (Ergebnis liegt vor, Budget war knapp).")

        if intent.timer.unlimited and result.timer.elapsed_s is None:
            warnings.append("Unlimited-Modus ohne elapsed_s im Result: Zeit-Tracking unvollstaendig.")

        if reasons:
            return Verdict(NEEDS_CORRECTION, tuple(reasons), next_action=NEXT_ITERATE, checks=checks, timer_expired=timer_expired, warnings=tuple(warnings))
        return Verdict(
            ACCEPT,
            ("Ergebnis deckt den Auftrag.",),
            next_action=NEXT_READ_ARTIFACTS,
            checks=checks,
            timer_expired=timer_expired,
            warnings=tuple(warnings),
        )

    # ------------------------------------------------------------- Internes
    def _verify_artifact_hashes(self, result: Result) -> list[str]:
        problems: list[str] = []
        for artifact in result.artifacts:
            if artifact.action in {"deleted", "read"} or not artifact.sha256:
                continue
            path = self.config.repo_root / artifact.path
            if not path.is_file():
                problems.append(f"Artefakt fehlt auf Platte: {artifact.path}")
                continue
            actual = sha256_file(path)
            if actual != artifact.sha256:
                problems.append(f"Hash-Abweichung bei {artifact.path}: erwartet {artifact.sha256[:12]}…, gefunden {actual[:12]}…")
        return problems

    @staticmethod
    def _acceptance_coverage(intent: Intent, result: Result) -> dict[str, bool]:
        """Grobe, deterministische Heuristik: Liegt ein Beleg im Ergebnis?"""
        haystack = " ".join(
            [
                result.notes,
                str(result.output),
                " ".join(a.path for a in result.artifacts),
                (result.status_report.explanation if result.status_report else ""),
                result.diagnostics_stdout[-4000:],
            ]
        ).lower()
        coverage: dict[str, bool] = {}
        for criterion in intent.task.acceptance:
            tokens = [t for t in criterion.lower().replace(":", " ").split() if len(t) > 4]
            coverage[criterion] = bool(tokens) and any(token in haystack for token in tokens[:6])
        return coverage


def artifact_reference(path: Path | str, config: NeuConfig | None = None, role: str = "input") -> dict[str, Any]:
    """Kontext-Artefakt inkl. Hash -- damit der Limb Input-Drift bemerkt."""
    cfg = config or NeuConfig.load()
    absolute = Path(path)
    if not absolute.is_absolute():
        absolute = cfg.repo_root / absolute
    entry: dict[str, Any] = {"path": cfg.relative(absolute), "role": role}
    if absolute.is_file():
        entry["sha256"] = sha256_file(absolute)
    return entry


def remaining_budget(intent: Intent, config: NeuConfig | None = None) -> dict[str, Any]:
    """Uebersicht ueber das verbleibende Budget eines Jobs (fuer den 2. Durchgang)."""
    cfg = config or NeuConfig.load()
    cap = min(cfg.limits.max_iterations, ABSOLUTE_MAX_ITERATIONS)
    return {
        "iteration": intent.iteration,
        "max_iterations": min(intent.job.max_iterations, cap),
        "iterations_left": max(0, min(intent.job.max_iterations, cap) - intent.iteration),
        "timer_mode": intent.timer.mode,
        "deadline_s": intent.timer.deadline_s,
        "t0": intent.timer.t0,
        "elapsed_s": intent.timer.elapsed(),
        "triggers": [t.to_dict() for t in intent.schedule.triggers],
        "mode": cfg.mode,
    }
