"""Agent-Slots (Protokoll 1.2).

Das Skalierungsprofil begrenzt, wie viele Agenten (Limb-Prozesse) gleichzeitig
laufen duerfen. Im Dev-Modus ist das exakt **einer**: ``max_agents=1``.

Implementiert als Datei-Locks unter ``runtime/locks/`` -- dadurch sichtbar,
nachvollziehbar und crash-tolerant (verwaiste Locks werden anhand von PID und
Ablaufzeit zurueckgeholt).
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from core.config import NeuConfig
from core.protocol import format_timestamp, parse_timestamp, utc_now

#: Slot-Arten. Aufgaben-Slots (``job``) begrenzen Auftraege des Kerns;
#: ``scheduled``-Slots begrenzen Kontroll-Jobs, die ein zeitgesteuerter Trigger
#: erzeugt. Getrennte Kontingente, damit eine laufende Beobachtung ihre eigenen
#: periodischen Kontrollen nicht blockiert (und umgekehrt).
KIND_JOB = "job"
KIND_SCHEDULED = "scheduled"
VALID_SLOT_KINDS = (KIND_JOB, KIND_SCHEDULED)


@dataclass(frozen=True)
class AgentSlot:
    index: int
    path: Path
    job_id: str
    pid: int
    acquired_at: str
    expires_at: str
    kind: str = KIND_JOB

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "path": str(self.path),
            "job_id": self.job_id,
            "pid": self.pid,
            "acquired_at": self.acquired_at,
            "expires_at": self.expires_at,
            "kind": self.kind,
        }


class NoSlotAvailable(RuntimeError):
    """Alle Agent-Slots einer Art sind belegt (Dev-Modus: genau einer)."""

    def __init__(self, message: str, busy: tuple[dict[str, object], ...] = (), kind: str = KIND_JOB) -> None:
        self.busy = busy
        self.kind = kind
        super().__init__(message)


class AgentPool:
    def __init__(self, config: NeuConfig | None = None) -> None:
        self.config = config or NeuConfig.load()
        self.config.ensure_dirs()

    @property
    def capacity(self) -> int:
        return self.capacity_for(KIND_JOB)

    def capacity_for(self, kind: str = KIND_JOB) -> int:
        """Kontingent einer Slot-Art (mindestens 1, damit nichts festklemmt)."""
        if kind == KIND_SCHEDULED:
            return max(1, self.config.limits.max_scheduled_jobs)
        return max(1, self.config.limits.max_agents)

    def lock_path(self, index: int, kind: str = KIND_JOB) -> Path:
        prefix = "scheduled" if kind == KIND_SCHEDULED else "agent"
        return self.config.locks_dir / f"{prefix}-{index}.lock"

    def busy(self, kind: str | None = None) -> list[AgentSlot]:
        """Belegte Slots; ``kind=None`` liefert alle Arten."""
        kinds = VALID_SLOT_KINDS if kind is None else (kind,)
        slots: list[AgentSlot] = []
        for slot_kind in kinds:
            slots.extend(self._busy_kind(slot_kind))
        return slots

    def _busy_kind(self, kind: str) -> list[AgentSlot]:
        slots: list[AgentSlot] = []
        for index in range(self.capacity_for(kind)):
            path = self.lock_path(index, kind)
            if not path.is_file():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            slots.append(
                AgentSlot(
                    index=index,
                    path=path,
                    job_id=str(data.get("job_id", "")),
                    pid=int(data.get("pid", 0)),
                    acquired_at=str(data.get("acquired_at", "")),
                    expires_at=str(data.get("expires_at", "")),
                    kind=str(data.get("kind", kind)),
                )
            )
        return slots

    def is_stale(self, slot: AgentSlot) -> bool:
        """Verwaist, wenn die Frist abgelaufen ist oder die PID nicht mehr lebt."""
        try:
            expires = parse_timestamp(slot.expires_at, "$.expires_at")
        except Exception:
            return True
        if utc_now() > expires:
            return True
        if slot.pid <= 0:
            return True
        try:
            os.kill(slot.pid, 0)
        except (OSError, ProcessLookupError):
            return True
        return False

    def reclaim_stale(self) -> int:
        removed = 0
        for slot in self.busy():
            if self.is_stale(slot):
                slot.path.unlink(missing_ok=True)
                removed += 1
        return removed

    def acquire(self, *, job_id: str, ttl_s: float, kind: str = KIND_JOB) -> AgentSlot:
        """Belegt einen Slot oder wirft ``NoSlotAvailable``.

        ``kind="scheduled"`` nutzt das eigene Kontroll-Kontingent
        (``limits.max_scheduled_jobs``) und kollidiert damit nicht mit dem
        Aufgaben-Slot einer laufenden Beobachtung.
        """
        if kind not in VALID_SLOT_KINDS:
            raise ValueError(f"kind muss eines von {VALID_SLOT_KINDS} sein (gefunden: {kind!r})")
        self.config.locks_dir.mkdir(parents=True, exist_ok=True)
        self.reclaim_stale()
        now = utc_now()
        for index in range(self.capacity_for(kind)):
            path = self.lock_path(index, kind)
            if path.exists():
                continue
            slot = AgentSlot(
                index=index,
                path=path,
                job_id=job_id,
                pid=os.getpid(),
                acquired_at=format_timestamp(now),
                expires_at=format_timestamp(now + _ttl(ttl_s)),
                kind=kind,
            )
            try:
                # O_CREAT|O_EXCL = atomar, auch gegen parallele Orchestratoren
                handle = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                continue
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(slot.to_dict(), stream, ensure_ascii=False, indent=2)
            return slot
        limit_name = "max_scheduled_jobs" if kind == KIND_SCHEDULED else "max_agents"
        raise NoSlotAvailable(
            f"Kein {kind}-Slot frei (mode={self.config.mode}, {limit_name}={self.capacity_for(kind)}).",
            busy=tuple(s.to_dict() for s in self.busy(kind)),
            kind=kind,
        )

    def renew(self, slot: AgentSlot, *, ttl_s: float) -> AgentSlot:
        """Verlaengert die Frist eines belegten Slots (Lebenszeichen).

        Noetig fuer ``timer.mode="unlimited"``: Es gibt keine Deadline, aus der
        sich eine TTL ableiten liesse. Der ueberwachte Ablauf meldet pro Tick,
        dass der Slot bewusst belegt bleibt -- sonst wuerde ``reclaim_stale()``
        eine langlaufende Beobachtung fuer einen Absturz halten.
        """
        if not slot.path.is_file():
            return slot
        try:
            data = json.loads(slot.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return slot
        if data.get("pid") not in (os.getpid(), None):
            return slot  # fremder Orchestrator: nicht anfassen
        renewed = AgentSlot(
            index=slot.index,
            path=slot.path,
            job_id=slot.job_id,
            pid=slot.pid,
            acquired_at=slot.acquired_at,
            expires_at=format_timestamp(utc_now() + _ttl(ttl_s)),
            kind=slot.kind,
        )
        try:
            renewed.path.write_text(json.dumps(renewed.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            return slot
        return renewed

    def release(self, slot: AgentSlot) -> None:
        try:
            data = json.loads(slot.path.read_text(encoding="utf-8")) if slot.path.is_file() else {}
        except (json.JSONDecodeError, OSError):
            data = {}
        # Nur eigene Locks loesen (PID-Schutz gegen fremde Orchestratoren)
        if data.get("pid") in (os.getpid(), None):
            slot.path.unlink(missing_ok=True)

    @contextmanager
    def slot(self, *, job_id: str, ttl_s: float, kind: str = KIND_JOB) -> Iterator[AgentSlot]:
        acquired = self.acquire(job_id=job_id, ttl_s=ttl_s, kind=kind)
        try:
            yield acquired
        finally:
            self.release(acquired)


def _ttl(value: float) -> timedelta:
    """Mindestens eine Sekunde, damit ein Lock nicht sofort als verwaist gilt."""
    return timedelta(seconds=max(1.0, float(value)))
