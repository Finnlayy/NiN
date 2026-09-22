"""NEU-Konfiguration (Protokoll 1.2).

Ein einziger, deterministischer Ort fuer Pfade, Sicherheits-Policy, Timer und
Skalierungsgrenzen. Core, Orchestrator und Limbs lesen alle dieselbe
Konfiguration, damit es keine divergierenden Annahmen gibt.

Ladereihenfolge (spaeter gewinnt):
    1. eingebaute Defaults
    2. ``neu.config.json`` im Repo-Root
    3. Umgebungsvariable ``NEU_ROOT`` (nur Repo-Root)
    4. explizite Parameter ``NeuConfig.load(repo_root=..., **overrides)``

**Dev-Modus** (``mode="dev"``) deckelt alles auf 1 Iteration / 1 Agent /
1 Limb / 1 parallelen Job. Hoeher skaliert wird erst, wenn das System sich im
Dev-Modus bewaehrt hat -- und nur mit menschlicher Freigabe, weil
``neu.config.json`` unter dem Constitution Guard steht.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CONFIG_FILENAME = "neu.config.json"

#: Pfade, die ein Limb mit ``elevation.level == "repo_write"`` veraendern darf.
#: fnmatch-Semantik: ``*`` matcht auch Pfadtrenner.
DEFAULT_ALLOWED_REPO_GLOBS: tuple[str, ...] = (
    "core/*",
    "orchestrator/*",
    "limbs/*",
    "prompts/*",
    "protocol/*",
    "tests/*",
    "docs/*",
    "workspace/*",
    "README.md",
    "neu.config.json",  # schreibbar, aber human_only -> Constitution Guard
)

#: Harte Verbote. Diese Liste gewinnt immer gegen ``allowed_repo_globs``.
DEFAULT_DENIED_GLOBS: tuple[str, ...] = (
    ".git/*",
    ".github/*",
    "runtime/*",
    "node_modules/*",
    "dist/*",
    "frontend/.next/*",
    "*.bak",
    "*.log",
)

#: "Constitution Guard": Diese Dateien duerfen nur mit menschlicher Freigabe
#: (``elevation.approved_by == "human"``) veraendert werden. Ein Limb darf sich
#: seine eigenen Rechte niemals selbst erweitern koennen.
DEFAULT_HUMAN_ONLY_GLOBS: tuple[str, ...] = (
    "neu.config.json",
    "core/policy.py",
    "core/config.py",
    ".git/*",
    ".github/*",
)

DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
HARD_MAX_OUTPUT_BYTES = 67_108_864

#: Mindest-Schwellenwert für die strukturierte `defineEval`-Pipeline (ersetzt starre 85er-Schwelle durch konfigurierbare Pipeline-Parameter).
EVAL_MIN_THRESHOLD = 85.0
EVAL_DEFAULT_SAFETY_TOLERANCE = 0.1

#: Timer-Defaults (Protokoll 1.2)
DEFAULT_RUNTIME_DIR = "runtime"
DEFAULT_WORKSPACE_DIR = "workspace"
DEFAULT_PROTOCOL_DIR = "protocol"

DEFAULT_DEADLINE_S = 60.0
DEFAULT_SOFT_DEADLINE_S = 45.0
DEFAULT_GRACE_S = 5.0
HARD_DEADLINE_S = 900.0

#: Reine Prozess-Hygiene fuer den Unlimited-Modus: kein Aufgabenlimit, sondern
#: Zombie-Schutz. 0 = wirklich unbegrenzt. Eingriffe melden E_SAFETY_NET.
DEFAULT_SAFETY_NET_S = 3600.0

#: Tick-Intervall des Schedulers (Auswertung der zeitgesteuerten Trigger)
DEFAULT_TICK_S = 0.5

#: Iterations-Budget: hartes Maximum ueber alle Profile (vom User festgelegt: 2).
ABSOLUTE_MAX_ITERATIONS = 2

#: Skalierungsprofile. Dev = 1/1/1/1, scale = das erlaubte Maximum.
SCALE_PROFILES: dict[str, dict[str, Any]] = {
    "dev": {
        "max_iterations": 1,
        "max_agents": 1,
        "max_limbs": 1,
        "max_concurrent_jobs": 1,
        "max_scheduled_jobs": 1,
    },
    "scale": {
        "max_iterations": ABSOLUTE_MAX_ITERATIONS,
        "max_agents": 4,
        "max_limbs": 4,
        "max_concurrent_jobs": 2,
        "max_scheduled_jobs": 4,
    },
}

VALID_MODES = ("dev", "scale")


@dataclass(frozen=True)
class Limits:
    """Ressourcen-Deckel. Iterationen zaehlen pro **Job**, nicht pro Agentenaufruf."""

    max_iterations: int = 1
    max_agents: int = 1
    max_limbs: int = 1
    max_concurrent_jobs: int = 1
    max_scheduled_jobs: int = 1

    def to_dict(self) -> dict[str, int]:
        return {
            "max_iterations": self.max_iterations,
            "max_agents": self.max_agents,
            "max_limbs": self.max_limbs,
            "max_concurrent_jobs": self.max_concurrent_jobs,
            "max_scheduled_jobs": self.max_scheduled_jobs,
        }

    @classmethod
    def from_dict(cls, data: Any, mode: str = "dev") -> Limits:
        profile = dict(SCALE_PROFILES.get(mode, SCALE_PROFILES["dev"]))
        if isinstance(data, dict):
            profile.update({k: v for k, v in data.items() if k in profile and v is not None})
        return cls(
            max_iterations=max(1, min(int(profile["max_iterations"]), ABSOLUTE_MAX_ITERATIONS)),
            max_agents=max(1, int(profile["max_agents"])),
            max_limbs=max(1, int(profile["max_limbs"])),
            max_concurrent_jobs=max(1, int(profile["max_concurrent_jobs"])),
            max_scheduled_jobs=max(1, int(profile.get("max_scheduled_jobs", 1))),
        )


@dataclass(frozen=True)
class TimerDefaults:
    """Vorgaben fuer den Timer, der vor jedem Auftrag scharf geschaltet wird.

    ``deadline_s = None`` bedeutet: Es wird **kein** Limit vorgegeben, die Zeit
    wird getrackt (``mode="unlimited"``, Protokoll 1.2).
    """

    deadline_s: float | None = DEFAULT_DEADLINE_S
    soft_deadline_s: float | None = DEFAULT_SOFT_DEADLINE_S
    grace_s: float = DEFAULT_GRACE_S
    safety_net_s: float | None = DEFAULT_SAFETY_NET_S
    tick_s: float = DEFAULT_TICK_S

    @property
    def unlimited(self) -> bool:
        return self.deadline_s is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "deadline_s": self.deadline_s,
            "soft_deadline_s": self.soft_deadline_s,
            "grace_s": self.grace_s,
            "safety_net_s": self.safety_net_s,
            "tick_s": self.tick_s,
        }

    @classmethod
    def from_dict(cls, data: Any) -> TimerDefaults:
        body = dict(data) if isinstance(data, dict) else {}
        raw_deadline = body.get("deadline_s", DEFAULT_DEADLINE_S)
        raw_soft = body.get("soft_deadline_s", DEFAULT_SOFT_DEADLINE_S)
        grace = float(body.get("grace_s", DEFAULT_GRACE_S))
        raw_net = body.get("safety_net_s", DEFAULT_SAFETY_NET_S)
        tick = float(body.get("tick_s", DEFAULT_TICK_S))

        if raw_deadline is None:
            # Unlimited: keine Fristen, nur Tracking + optionales Safety-Net
            net = None if raw_net is None else float(raw_net)
            if net is not None and net < 1.0:
                raise ValueError("timer.safety_net_s muss >= 1.0 sein (0/null = wirklich unbegrenzt)")
            return cls(deadline_s=None, soft_deadline_s=None, grace_s=max(0.0, grace), safety_net_s=net, tick_s=max(0.05, tick))

        deadline = float(raw_deadline)
        if not 0.1 <= deadline <= HARD_DEADLINE_S:
            raise ValueError(f"timer.deadline_s muss in [0.1, {HARD_DEADLINE_S}] liegen (gefunden: {deadline})")
        soft = None if raw_soft is None else min(max(0.1, float(raw_soft)), deadline)
        net = None if raw_net is None else float(raw_net)
        return cls(deadline_s=deadline, soft_deadline_s=soft, grace_s=max(0.0, grace), safety_net_s=net, tick_s=max(0.05, tick))


@dataclass(frozen=True)
class NeuConfig:
    """Unveraenderliche Laufzeitkonfiguration des NEU-Stacks."""

    repo_root: Path
    mode: str = "dev"
    # Invariante: Nach ``__post_init__`` sind das immer echte ``Path``-Objekte
    # (relativ = unterhalb repo_root, absolut = unveraendert). Eingaben duerfen
    # trotzdem Strings oder None sein -- ``load()`` und ``__post_init__``
    # normalisieren, damit kein Aufrufer ``Path | None`` weiterschleppen muss.
    runtime_dir: Path = field(default_factory=lambda: Path(DEFAULT_RUNTIME_DIR))
    workspace_dir: Path = field(default_factory=lambda: Path(DEFAULT_WORKSPACE_DIR))
    protocol_dir: Path = field(default_factory=lambda: Path(DEFAULT_PROTOCOL_DIR))
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES
    allow_shell_ops: bool = False
    allow_test_ops: bool = False
    allow_repo_write: bool = True
    allowed_repo_globs: tuple[str, ...] = DEFAULT_ALLOWED_REPO_GLOBS
    denied_globs: tuple[str, ...] = DEFAULT_DENIED_GLOBS
    human_only_globs: tuple[str, ...] = DEFAULT_HUMAN_ONLY_GLOBS
    limits: Limits = field(default_factory=lambda: Limits.from_dict(None, "dev"))
    timer: TimerDefaults = field(default_factory=TimerDefaults)
    eval_min_threshold: float = EVAL_MIN_THRESHOLD
    eval_safety_tolerance: float = EVAL_DEFAULT_SAFETY_TOLERANCE
    source_file: Path | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        root = Path(self.repo_root).resolve()
        object.__setattr__(self, "repo_root", root)
        for key, default in (
            ("runtime_dir", DEFAULT_RUNTIME_DIR),
            ("workspace_dir", DEFAULT_WORKSPACE_DIR),
            ("protocol_dir", DEFAULT_PROTOCOL_DIR),
        ):
            raw = getattr(self, key)
            text = str(raw).strip() if raw is not None else ""
            # ``root / "/abs"`` ergibt "/abs": Ein isoliertes runtime/ ausserhalb
            # des Repos (CLI ``--runtime-dir``) bleibt damit moeglich.
            object.__setattr__(self, key, root / Path(text or default))
        if self.mode not in VALID_MODES:
            raise ValueError(f"mode muss eines von {VALID_MODES} sein (gefunden: {self.mode!r})")
        object.__setattr__(self, "limits", Limits.from_dict(self.limits.to_dict() if isinstance(self.limits, Limits) else self.limits, self.mode))

    # ---------------------------------------------------------------- Pfade
    @property
    def inbox_dir(self) -> Path:
        return Path(self.runtime_dir) / "inbox"

    @property
    def outbox_dir(self) -> Path:
        return Path(self.runtime_dir) / "outbox"

    @property
    def archive_dir(self) -> Path:
        return Path(self.runtime_dir) / "archive"

    @property
    def backup_dir(self) -> Path:
        return Path(self.runtime_dir) / "backups"

    @property
    def jobs_dir(self) -> Path:
        return Path(self.runtime_dir) / "jobs"

    @property
    def locks_dir(self) -> Path:
        return Path(self.runtime_dir) / "locks"

    @property
    def schedules_dir(self) -> Path:
        """Zustand der zeitgesteuerten Ausloeser (Protokoll 1.2).

        Eigenes Verzeichnis, damit ``runtime/jobs/job_*.json`` eindeutig Jobs
        bleiben und Trigger-Zustaende die Job-Liste nicht verwirren.
        """
        return Path(self.runtime_dir) / "schedules"

    @property
    def system_log_path(self) -> Path:
        """Ziel der Phase-3-Logging-Erweiterung (in Phase 1 noch unbeschrieben)."""
        return Path(self.runtime_dir) / "system.log"

    @property
    def registry_path(self) -> Path:
        return self.repo_root / "limbs" / "registry.json"

    @property
    def is_dev(self) -> bool:
        return self.mode == "dev"

    def ensure_dirs(self) -> tuple[Path, ...]:
        """Legt alle Laufzeitverzeichnisse an (idempotent)."""
        created: list[Path] = []
        for directory in (
            Path(self.runtime_dir),
            self.inbox_dir,
            self.outbox_dir,
            self.archive_dir,
            self.backup_dir,
            self.jobs_dir,
            self.locks_dir,
            self.schedules_dir,
            Path(self.workspace_dir),
        ):
            directory.mkdir(parents=True, exist_ok=True)
            created.append(directory)
        return tuple(created)

    def relative(self, path: Path | str) -> str:
        """Pfad relativ zum Repo-Root (lesbar in Logs/Archiv)."""
        try:
            return str(Path(path).resolve().relative_to(self.repo_root)).replace(os.sep, "/")
        except ValueError:
            return str(path)

    def relative_resolved(self, absolute: Path | str) -> str:
        """Wie ``relative``, aber fuer Pfade, die das ``resolve()`` schon hinter sich haben.

        Der doppelte Realpath-Durchlauf ist der Grund: ``relative(sandbox_root(intent))``
        lief die Kette zwei Mal -- pro Pruefung, und die Sandbox-Wurzel steht in
        jeder Policy-Antwort. Wer einen Aufloesungs-Pfad in der Hand haelt (Policy,
        Transport), geht hier lang. Ausserhalb des Repos gilt derselbe Ruckfall wie
        bei ``relative``: die Stringform des Ubergebenen, kein Raise.
        """
        try:
            return str(Path(absolute).relative_to(self.repo_root)).replace(os.sep, "/")
        except ValueError:
            return str(absolute)

    def to_dict(self) -> dict[str, Any]:
        return {
            "repo_root": str(self.repo_root),
            "mode": self.mode,
            "limits": self.limits.to_dict(),
            "timer": self.timer.to_dict(),
            "allow_shell_ops": self.allow_shell_ops,
            "allow_test_ops": self.allow_test_ops,
            "allow_repo_write": self.allow_repo_write,
            "allowed_repo_globs": list(self.allowed_repo_globs),
            "denied_globs": list(self.denied_globs),
            "human_only_globs": list(self.human_only_globs),
            "max_output_bytes": self.max_output_bytes,
            "eval_min_threshold": self.eval_min_threshold,
            "eval_safety_tolerance": self.eval_safety_tolerance,
            "source_file": str(self.source_file) if self.source_file else None,
        }

    # --------------------------------------------------------------- Laden
    @classmethod
    def load(cls, repo_root: Path | str | None = None, **overrides: Any) -> NeuConfig:
        root = Path(
            repo_root
            or os.environ.get("NEU_ROOT")
            or Path(__file__).resolve().parent.parent
        ).resolve()

        values: dict[str, Any] = {}
        config_file = root / CONFIG_FILENAME
        if config_file.is_file():
            try:
                raw = json.loads(config_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:  # Konfigurationsfehler darf nie still scheitern
                raise ValueError(f"{CONFIG_FILENAME} ist kein gueltiges JSON: {exc}") from exc
            if not isinstance(raw, dict):
                raise ValueError(f"{CONFIG_FILENAME} muss ein JSON-Objekt sein.")
            for key, value in raw.items():
                if key in {"repo_root", "$comment"}:
                    continue
                values[key] = value
            values["source_file"] = config_file

        values.update({k: v for k, v in overrides.items() if v is not None})

        # Wird das Profil explizit gewaehlt (CLI/Env/Test), ziehen dessen Limits
        # mit -- sonst wuerde die Konfigurationsdatei das Profil still aushebeln.
        if "mode" in overrides and overrides["mode"] and "limits" not in overrides:
            values["limits"] = dict(SCALE_PROFILES[str(values["mode"])])

        for key in ("allowed_repo_globs", "denied_globs", "human_only_globs"):
            if key in values:
                values[key] = _as_str_tuple(values[key], key)

        # Pfadfelder: String -> Path, leer/null -> Default der Datenklasse.
        for key in ("runtime_dir", "workspace_dir", "protocol_dir", "source_file"):
            if key not in values:
                continue
            value = values[key]
            if value is None or (isinstance(value, str) and not value.strip()):
                values.pop(key)
            elif not isinstance(value, Path):
                values[key] = Path(str(value))

        mode = str(values.get("mode", "dev"))
        if "limits" in values and not isinstance(values["limits"], Limits):
            values["limits"] = Limits.from_dict(values["limits"], mode)
        elif "limits" not in values:
            values["limits"] = Limits.from_dict(None, mode)
        if "timer" in values and not isinstance(values["timer"], TimerDefaults):
            values["timer"] = TimerDefaults.from_dict(values["timer"])

        return cls(repo_root=root, **values)


def _as_str_tuple(value: Iterable[Any], key: str) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, Iterable):
        raise ValueError(f"Konfigurationsschluessel '{key}' muss eine Liste von Strings sein.")
    items = tuple(str(v) for v in value)
    if any(not i for i in items):
        raise ValueError(f"Konfigurationsschluessel '{key}' enthaelt leere Eintraege.")
    return items
