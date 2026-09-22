"""NEU-Sicherheits- und Rechte-Policy (Phase 1).

Die Policy ist die einzige Instanz, die entscheidet, ob ein Intent ausgefuehrt
werden darf und auf welche Pfade ein Limb zugreifen kann. Sie wird *zweifach*
wirksam:

1. **Pre-Flight** im Orchestrator (:meth:`Policy.check`) -- bevor ein Limb
   ueberhaupt gestartet wird.
2. **Laufzeit** im Limb (:meth:`Policy.resolve_path`) -- jede einzelne
   Dateioperation wird erneut geprueft. Damit kann auch ein kompromittierter
   oder fehlerhafter Limb nicht aus der Sandbox ausbrechen.

Grundhaltung: *deny by default*. Erlaubt ist nur, was Intent + Konfiguration
explizit freigeben.
"""

from __future__ import annotations

import fnmatch
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .config import NeuConfig
from .protocol import ErrorCode, Intent, Operations, ProtocolError

#: Operationen, die schreiben (relevant fuer Backup-Pflicht und Elevation).
WRITE_OPERATIONS = frozenset(
    {
        "fs.write_file",
        "fs.patch",
        "fs.append_file",
        "fs.delete",
        "fs.mkdir",
        "fs.move",
    }
)

#: Operationen, die Code ausfuehren.
EXEC_OPERATIONS = frozenset({"shell.exec", "test.run"})


@dataclass(frozen=True)
class PolicyDecision:
    """Ergebnis der Pre-Flight-Pruefung."""

    allowed: bool
    code: str = ""
    reason: str = ""
    sandbox_root: str = ""
    resolved_targets: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "code": self.code,
            "reason": self.reason,
            "sandbox_root": self.sandbox_root,
            "resolved_targets": list(self.resolved_targets),
            "warnings": list(self.warnings),
        }


class Policy:
    """Sandbox-, Elevations- und Operations-Gating."""

    #: Wie viele verschiedene ``sandbox_root``-Angaben pro Policy instanz gemerkt
    #: werden. Der Schluessel kommt aus dem Intent (also von aussen!) -- ohne Kante
    #: waere das ein unbegrenzt wachsender Cache.
    _SANDBOX_CACHE_LIMIT = 32

    def __init__(self, config: NeuConfig | None = None, operations: Operations | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.operations = operations or Operations.load(self.config.protocol_dir / "operations.json")
        self._sandbox_roots: dict[str, tuple[Path, str]] = {}

    # ------------------------------------------------------------------ Pfade
    def sandbox_root(self, intent: Intent) -> Path:
        """Aufgeloeste Sandbox-Wurzel eines Intents.

        ``"."`` bzw. ``""`` bedeuten "das Repository selbst" -- noetig fuer
        Selbstmodifikation mit ``elevation.level='repo_write'``. Die eigentliche
        Freigabe prueft weiterhin ``allowed_repo_globs``/``denied_globs``/
        ``human_only_globs`` pro Pfad.
        """
        root_name = (intent.constraints.sandbox_root or "workspace").strip()
        if root_name in {"", ".", "./"}:
            return self.config.repo_root
        found = self._sandbox_roots.get(root_name)
        if found is not None:
            return found[0]
        candidate = self._join_safe(root_name, "$.constraints.sandbox_root")
        root = (self.config.repo_root / candidate).resolve()
        if not self._is_inside(root, self.config.repo_root):
            raise ProtocolError(ErrorCode.SANDBOX_ESCAPE, "sandbox_root verlaesst das Repository", "$.constraints.sandbox_root")
        if len(self._sandbox_roots) < self._SANDBOX_CACHE_LIMIT:
            self._sandbox_roots[root_name] = (root, self.config.relative_resolved(root))
        return root

    def sandbox_root_label(self, intent: Intent) -> str:
        """Lesbarer Name der Sandbox-Wurzel fuer Entscheidungstexte.

        Dieselbe Wurzel, dieselbe Kette -- nur einmal pro Wurzel berechnet statt
        pro Antwort (``relative(sandbox_root(...))`` war ein Realpath-Durchlauf
        zusaetzlich zu dem der Aufloesung selbst).
        """
        root_name = (intent.constraints.sandbox_root or "workspace").strip()
        cached = self._sandbox_roots.get(root_name)
        if cached is not None:
            return cached[1]
        return self.config.relative_resolved(self.sandbox_root(intent))

    def resolve_path(self, raw_path: str, intent: Intent, *, where: str = "$.task.params.path", must_exist: bool = False) -> Path:
        """Uebersetzt einen Intent-Pfad in einen sicheren, absoluten Pfad.

        Regelwerk:
        * nur Relativpfade, keine ``..``-Segmente, keine Nullbytes
        * ohne Elevation: Basis ist ``constraints.sandbox_root`` (Default
          ``workspace/``) -- alles ausserhalb wird abgewiesen
        * mit ``elevation.level == "repo_write"``: Basis ist das Repo-Root,
          der Pfad muss ``allowed_repo_globs`` treffen und darf keine
          ``denied_globs`` treffen; ``human_only_globs`` zusaetzlich nur mit
          ``approved_by == "human"``
        """
        relative = self._join_safe(raw_path, where)
        elevation = intent.elevation

        base = self.config.repo_root if elevation.level == "repo_write" else self.sandbox_root(intent)

        target = (base / relative).resolve()

        if not self._is_inside(target, self.config.repo_root):
            raise ProtocolError(ErrorCode.SANDBOX_ESCAPE, f"Ziel {raw_path!r} liegt ausserhalb des Repositories", where)

        rel = self.config.relative_resolved(target)

        if elevation.level != "repo_write" and not self._is_inside(target, base):
            raise ProtocolError(
                ErrorCode.SANDBOX_ESCAPE,
                f"Ziel {raw_path!r} verlaesst die Sandbox '{self.sandbox_root_label(intent)}'. "
                " Fuer Aenderungen am System selbst ist elevation.level='repo_write' noetig.",
                where,
            )

        if elevation.level == "repo_write":
            if self._matches_any(rel, self.config.denied_globs):
                raise ProtocolError(ErrorCode.POLICY_DENIED, f"Pfad {rel!r} ist durch denied_globs gesperrt", where)
            if not self._matches_any(rel, self.config.allowed_repo_globs):
                raise ProtocolError(
                    ErrorCode.POLICY_DENIED,
                    f"Pfad {rel!r} ist nicht durch allowed_repo_globs freigegeben",
                    where,
                )
            if self._matches_any(rel, self.config.human_only_globs) and elevation.approved_by != "human":
                raise ProtocolError(
                    ErrorCode.POLICY_DENIED,
                    f"Pfad {rel!r} unterliegt dem Constitution Guard: Freigabe nur durch 'human' "
                    f"(gefunden: approved_by={elevation.approved_by!r})",
                    where,
                )
            if rel not in set(elevation.requested_paths) and elevation.requested_paths:
                raise ProtocolError(
                    ErrorCode.POLICY_DENIED,
                    f"Pfad {rel!r} ist nicht in elevation.requested_paths deklariert",
                    where,
                )

        if must_exist and not target.exists():
            raise ProtocolError(ErrorCode.PATH_NOT_FOUND, f"Ziel existiert nicht: {rel}", where)
        return target

    # ---------------------------------------------------------- Pre-Flight
    def check_runtime(self, intent: Intent) -> PolicyDecision:
        """Laufzeit-Pruefung **im Limb**: nur Sandbox, Operation und Rechte.

        Budget- und Profilfragen gehoeren ausschliesslich dem Orchestrator --
        wuerde der Limb sie mit seiner eigenen Konfiguration nachpruefen,
        entstuenden genau die Drift-Fehler, die das Protokoll verhindern soll.
        """
        return self._check_common(intent)

    def check(self, intent: Intent, *, job: Any | None = None) -> PolicyDecision:
        """Vollstaendige Pre-Flight-Pruefung im Orchestrator.

        ``job`` ist optional ein ``core.job.JobRecord``; wird er mitgegeben,
        prueft die Policy zusaetzlich die Skalierungsgrenzen des Profils
        (Dev-Modus: 1 Iteration, 1 Agent, 1 Limb pro Job).
        """
        # ---- Iterations-Budget: zaehlt pro Job, gedeckelt durch das Profil ----
        cap = self.config.limits.max_iterations
        if intent.job.max_iterations > cap:
            return self._deny(
                ErrorCode.POLICY_DENIED,
                f"max_iterations={intent.job.max_iterations} ueberschreitet das Profil-Limit "
                f"(mode={self.config.mode}, max_iterations={cap}).",
                intent,
            )
        if intent.job.iteration > cap:
            return self._deny(
                ErrorCode.BUDGET_EXHAUSTED,
                f"Durchgang {intent.job.iteration} liegt ueber dem Iterations-Budget von {cap}.",
                intent,
            )

        # ---- Limb-Vielfalt pro Job (Dev-Modus: genau ein Limb) ----
        if job is not None:
            used = tuple(job.limbs_used or ())
            if intent.target_limb not in used and len(used) >= self.config.limits.max_limbs:
                return self._deny(
                    ErrorCode.POLICY_DENIED,
                    f"Job {job.job_id} hat bereits Limb(s) {list(used)} genutzt; das Profil "
                    f"(mode={self.config.mode}) erlaubt max_limbs={self.config.limits.max_limbs}. "
                    f"Limb '{intent.target_limb}' ist damit gesperrt.",
                    intent,
                )
            if job.is_terminal:
                return self._deny(
                    ErrorCode.POLICY_DENIED,
                    f"Job {job.job_id} ist bereits abgeschlossen (status={job.status}).",
                    intent,
                )

        # ---- Zeitgesteuerte Ausloeser (Protokoll 1.2): fail-fast ----
        # Ein Trigger darf spaeter nichts duerfen, was der Auftrag jetzt nicht
        # duerfte. Deshalb werden check-Operationen hier geprueft wie der
        # Hauptauftrag -- statt zur Laufzeit (oder nie) aufzufallen.
        denial = self._check_schedule(intent)
        if denial is not None:
            return denial

        return self._check_common(intent)

    def _check_schedule(self, intent: Intent) -> PolicyDecision | None:
        """Prueft ``intent.schedule`` -- ``None`` bedeutet: zulaessig.

        Regeln (Protokoll 1.2, siehe ``protocol/PROTOCOL.md`` §3.3):

        * ``check``-Trigger nennen Operationen. Jede wird gegen das
          Operationsregister, das Rechte-Profil (``shell``/``test``), die
          Elevation des Auftrags und die Sandbox geprueft -- mit denselben
          Massstaeben wie der Hauptauftrag.
        * Pfadparameter der Kontroll-Operationen werden *jetzt* aufgeloest: Ein
          Sandbox-Escape ueber die Zeitachse ist ein Escapes, kein spaeter Fehler.
        * Kontingente: Die Zahl der Kontroll-Ausloeser wird gegen
          ``limits.max_scheduled_jobs`` gespiegelt (Warnung, wenn sie sich
          gegenseitig ausbremsen koennen), und ein Intervall unterhalb der
          Tick-Rate kann nicht schneller feuern als getickt wird.
        """
        schedule = intent.schedule
        if not schedule.triggers:
            return None

        warnings: list[str] = []
        check_triggers = 0

        for trigger in schedule.triggers:
            where = f"$.schedule.triggers[{trigger.id}]"

            if trigger.action == "check":
                check_triggers += 1
                raw_entries: list[dict[str, Any]]
                checks = trigger.payload.get("checks")
                if isinstance(checks, list) and checks:
                    raw_entries = [dict(entry) for entry in checks]
                else:
                    raw_entries = [{"operation": trigger.payload.get("operation"), "params": trigger.payload.get("params", {})}]

                for index, entry in enumerate(raw_entries):
                    operation = str(entry.get("operation") or "")
                    entry_where = f"{where}.payload.checks[{index}]"
                    if not self.operations.known(operation):
                        return self._deny_trigger(
                            ErrorCode.UNSUPPORTED_OP,
                            f"{where}: Kontroll-Operation '{operation}' ist im Register unbekannt.",
                            intent,
                        )
                    spec = self.operations.spec(operation)

                    if spec.family in {"shell", "test"} or operation in EXEC_OPERATIONS:
                        if operation == "shell.exec" and not self.config.allow_shell_ops:
                            return self._deny_trigger(
                                ErrorCode.SHELL_BLOCKED,
                                f"{entry_where}: shell.exec ist deaktiviert (allow_shell_ops=false).",
                                intent,
                            )
                        if operation == "test.run" and not self.config.allow_test_ops:
                            return self._deny_trigger(
                                ErrorCode.POLICY_DENIED,
                                f"{entry_where}: test.run ist deaktiviert (allow_test_ops=false).",
                                intent,
                            )
                        if not intent.constraints.allow_shell:
                            return self._deny_trigger(
                                ErrorCode.SHELL_BLOCKED,
                                f"{entry_where}: Kontroll-Operation braucht constraints.allow_shell=true.",
                                intent,
                            )

                    if spec.requires_elevation != "none" and intent.elevation.level == "none":
                        return self._deny_trigger(
                            ErrorCode.POLICY_DENIED,
                            f"{entry_where}: '{operation}' erfordert elevation.level='{spec.requires_elevation}' "
                            f"(Auftrag hat '{intent.elevation.level}').",
                            intent,
                        )

                    if spec.implemented_by:
                        limb = str(trigger.payload.get("limb") or intent.target_limb)
                        if limb not in spec.implemented_by:
                            return self._deny_trigger(
                                ErrorCode.TARGET_NOT_FOUND,
                                f"{entry_where}: Limb '{limb}' implementiert '{operation}' nicht "
                                f"(erwartet: {list(spec.implemented_by)}).",
                                intent,
                            )

                    raw_params = entry.get("params")
                    params: Mapping[str, Any] = raw_params if isinstance(raw_params, Mapping) else {}
                    for param_name in spec.path_params:
                        value = params.get(param_name)
                        if value is None:
                            continue
                        try:
                            self.resolve_path(str(value), intent, where=f"{entry_where}.params.{param_name}")
                        except ProtocolError as exc:
                            return self._deny_trigger(exc.code, f"{entry_where}: {exc.message}", intent)

            if trigger.every_s is not None and trigger.every_s < schedule.tick_s:
                warnings.append(
                    f"{where}: every_s={trigger.every_s}s liegt unter der Tick-Rate "
                    f"({schedule.tick_s}s) -- der Ausloeser feuert spaetestens pro Tick."
                )

        quota = self.config.limits.max_scheduled_jobs
        if check_triggers > quota:
            warnings.append(
                f"{check_triggers} check-Trigger, aber max_scheduled_jobs={quota} "
                f"(mode={self.config.mode}): ueberzaehlige Feuerungen werden als "
                "timer.skipped dokumentiert, nicht ausgefuehrt."
            )

        if warnings:
            return PolicyDecision(
                allowed=True,
                sandbox_root=self.sandbox_root_label(intent),
                warnings=tuple(warnings),
            )
        return None

    def _deny_trigger(self, code: str, reason: str, intent: Intent) -> PolicyDecision:
        """Ablehnung eines Ausloesers: ``E_TRIGGER_INVALID`` mit Ursachencode im Text.

        Der Auftrag ist nicht "irgendwie unerlaubt", sondern sein Zeitplan ist es --
        das muss im Code sichtbar bleiben, damit der Kern den Trigger korrigiert
        und nicht den ganzen Auftrag verwirft.
        """
        return PolicyDecision(
            allowed=False,
            code=ErrorCode.TRIGGER_INVALID,
            reason=f"{reason} (Ursache: {code})",
            sandbox_root=self.sandbox_root_label(intent),
        )

    def _check_common(self, intent: Intent, *, warnings: list[str] | None = None) -> PolicyDecision:
        """Sandbox-, Operations- und Rechte-Gating (Orchestrator *und* Limb)."""
        warnings = list(warnings or [])

        if not self.operations.known(intent.operation):
            return self._deny(
                ErrorCode.UNSUPPORTED_OP,
                f"Operation '{intent.operation}' ist im Register protocol/operations.json unbekannt.",
                intent,
            )

        spec = self.operations.spec(intent.operation)

        if spec.family in {"shell", "test"} or intent.operation in EXEC_OPERATIONS:
            if intent.operation == "shell.exec" and not self.config.allow_shell_ops:
                return self._deny(
                    ErrorCode.SHELL_BLOCKED,
                    "shell.exec ist in neu.config.json deaktiviert (allow_shell_ops=false).",
                    intent,
                )
            if intent.operation == "test.run" and not self.config.allow_test_ops:
                return self._deny(
                    ErrorCode.POLICY_DENIED,
                    "test.run ist in neu.config.json deaktiviert (allow_test_ops=false).",
                    intent,
                )
            if not intent.constraints.allow_shell:
                return self._deny(
                    ErrorCode.SHELL_BLOCKED,
                    "constraints.allow_shell muss fuer Ausfuehr-Operationen true sein.",
                    intent,
                )

        if intent.constraints.allow_network:
            warnings.append("allow_network=true ist in Phase 1 noch ohne Wirkung (kein Netz-Limb).")

        if intent.elevation.level == "repo_write" and not self.config.allow_repo_write:
            return self._deny(
                ErrorCode.POLICY_DENIED,
                "Selbstmodifikation ist deaktiviert (allow_repo_write=false in neu.config.json).",
                intent,
            )

        if spec.requires_elevation != "none" and intent.elevation.level == "none":
            return self._deny(
                ErrorCode.POLICY_DENIED,
                f"Operation '{intent.operation}' erfordert elevation.level='{spec.requires_elevation}'.",
                intent,
            )

        if intent.operation in WRITE_OPERATIONS and not intent.constraints.backup:
            warnings.append("backup=false: Schreiboperation ohne Ruecksicherung -- nur fuer Wegwerf-Artefakte nutzen.")

        if intent.constraints.dry_run:
            warnings.append("dry_run=true: Der Limb meldet das geplante Ergebnis, schreibt aber nicht.")

        # Pfadparameter auflösen -> fängt Sandbox-Escapes vor dem Start ab
        resolved: list[str] = []
        for param_name in spec.path_params:
            value = intent.task.params.get(param_name)
            if value is None:
                continue
            try:
                target = self.resolve_path(str(value), intent, where=f"$.task.params.{param_name}")
            except ProtocolError as exc:
                return self._deny(exc.code, exc.message, intent)
            resolved.append(self.config.relative_resolved(target))

        if spec.implemented_by and intent.target_limb not in spec.implemented_by:
            return self._deny(
                ErrorCode.TARGET_NOT_FOUND,
                f"Limb '{intent.target_limb}' implementiert '{intent.operation}' nicht "
                f"(erwartet: {list(spec.implemented_by)}).",
                intent,
            )

        return PolicyDecision(
            allowed=True,
            sandbox_root=self.sandbox_root_label(intent),
            resolved_targets=tuple(resolved),
            warnings=tuple(warnings),
        )

    # ------------------------------------------------------------- Internes
    def _deny(self, code: str, reason: str, intent: Intent) -> PolicyDecision:
        return PolicyDecision(allowed=False, code=code, reason=reason, sandbox_root=self.sandbox_root_label(intent))

    def _join_safe(self, raw_path: str, where: str) -> PurePosixPath:
        text = str(raw_path).strip()
        if not text:
            raise ProtocolError(ErrorCode.SCHEMA_INVALID, "leerer Pfad", where)
        if "\x00" in text:
            raise ProtocolError(ErrorCode.SANDBOX_ESCAPE, "Nullbytes im Pfad", where)
        if text.startswith("/") or (len(text) > 1 and text[1] == ":"):
            raise ProtocolError(ErrorCode.SANDBOX_ESCAPE, f"absoluter Pfad verboten: {text!r}", where)
        parts = PurePosixPath(text).parts
        if any(part == ".." for part in parts):
            raise ProtocolError(ErrorCode.SANDBOX_ESCAPE, f"'..' im Pfad verboten: {text!r}", where)
        cleaned = tuple(part for part in parts if part not in {"", "."})
        if not cleaned:
            raise ProtocolError(ErrorCode.SCHEMA_INVALID, f"Pfad reduziert sich auf Nichts: {text!r}", where)
        return PurePosixPath(*cleaned)

    @staticmethod
    def _is_inside(target: Path, root: Path) -> bool:
        try:
            target.relative_to(root)
            return True
        except ValueError:
            return False

    @staticmethod
    def _matches_any(relative_path: str, patterns: Iterable[str]) -> bool:
        norm = relative_path.replace("\\", "/")
        return any(fnmatch.fnmatch(norm, pattern) for pattern in patterns)


def summarize_paths(paths: Sequence[str]) -> str:
    return ", ".join(paths) if paths else "(keine)"
