"""Event-Bus des Orchestrators (Phase 1).

Jeder Zustandsubergang (Intent angenommen, Policy entschieden, Limb gestartet,
Result erfasst, Verdict gefaellt, archiviert) wird als strukturiertes Event
emittiert. Sinks entscheiden, wohin die Ereignisse fliessen.

Phase 1 liefert bewusst **nur** die Konsole als Sink. Die persistente
``runtime/system.log`` wird in Phase 3 rekursiv vom Bootstrap-Limb selbst
ergaenzt (Ouroboros-Test) -- deshalb ist hier eine klar markierte Andockstelle:

    NEU-PHASE-3-ANCHOR -> build_event_bus()
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, TextIO


class EventSink(Protocol):
    """Ein Sink nimmt fertig serialisierte Event-Datensaetze entgegen.

   Pflicht ist ``write(record)``. Sink, die den *Text* des Events brauchen,
    koennen ausserdem ``write_prepared(record, line)`` implementieren und
    ``wants_prepared_line = True`` setzen: dann serialisiert der Bus den
    Datensatz **genau einmal** und teilt dieselbe Zeile mit allen Sinks
    (Zero-Duplikat-Fanout, siehe ``.nio/nexus.md``, Triad 2 / Cycle 1).

    Der ``record`` ist im Besitz des Buses und wird allen Sinks identisch
    uebergeben -- ein Sink darf ihn **nicht** veraendern (Kopie anlegen, wenn er
    weitergereicht oder aufbewahrt wird). Das war schon vor dem Fast-Path so.
    """

    name: str

    def write(self, record: Mapping[str, Any]) -> None:  # pragma: no cover - Protokoll
        ...


#: Obergrenze fuer den Literal-Cache. Bewusst **gebunden**: Zustand, der mit
#: jedem Event waechst, waere ein Leck (siehe Philosophienote "State Should Be
#: Bounded"). Bei Ueberlaufen wird geleert statt unbegrenzt zuwachsen.
_LITERAL_CACHE_MAX = 4096
_LITERAL_CACHE: dict[str, str] = {}


def _json_str(text: str) -> str:
    """``json.dumps(text)`` mit Cache -- fuer die sich wiederholenden Envelope-Felder.

    Ein einzelner ``json.dumps``-Aufruf kostet in CPython ~0,29 µs, unabhaengig
    davon wie kurz der String ist (die halbe Million Aufrufe in ``scripts/``
    zeigen: der Fixpreis pro Aufruf ist der Grund, nicht die Datenmenge). Die
    Envelope-Felder (``kind``, ``job_id``, ``trace_id``, ``intent_id``, ``limb``)
    wiederholen sich *pro Tick* nahezu unveraendert, einmal pro Sekunde bei
    ``timer.tick``. Der Cache liefert also praktisch immer einen Treffer und
    garantiert identische Escapes, weil das Literal selbst mit ``json.dumps``
    erzeugt wurde.
    """
    cached = _LITERAL_CACHE.get(text)
    if cached is None:
        cached = json.dumps(text, ensure_ascii=False)
        if len(_LITERAL_CACHE) >= _LITERAL_CACHE_MAX:
            _LITERAL_CACHE.clear()
        _LITERAL_CACHE[text] = cached
    return cached


def _json_number(value: float | None) -> str:
    """Zahl als JSON-Literal -- identisch zu ``json.dumps`` (auch fuer NaN/Inf).

    ``repr(float)`` liefert CPython-konform dasselbe wie der JSON-Encoder fuer
    endliche Werte (kuerzeste Rundfahrt-Darstellung) und ist ein Tick billiger.
    Nicht endliche Werte delegieren, weil JSON dafuer ``NaN``/``Infinity``
    schreibt und ``repr`` klein schreibt.
    """
    if value is None:
        return "null"
    if isinstance(value, float):
        return repr(value) if math.isfinite(value) else json.dumps(value)
    return str(value)


def render_record(record: Mapping[str, Any]) -> str:
    """Serialisiert einen Event-Datensatz kompakt (kanonische Form fuer alle Sinks)."""
    return json.dumps(dict(record), ensure_ascii=False, separators=(",", ":"))


def _render_line(
    seq: int,
    timestamp: str,
    kind: str,
    job_id: str,
    trace_id: str,
    intent_id: str,
    limb: str,
    clock: float | None,
    payload: Mapping[str, Any] | None,
) -> str:
    """Baut die JSON-Zeile eines Events ohne das Record-Dict zu serialisieren.

    Schluessel und Reihenfolge sind exakt die von ``Event.to_dict()`` -- nur die
    feste Huuelle wird concateniert und ``json.dumps`` laeuft einmal ueber das
    (kleine) Payload statt ueber den ganzen Datensatz. Das spart auf dem
    Hot Path ~2 µs pro Event (Messung im Journal).
    """
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload else "{}"
    return (
        '{"seq":'
        + str(seq)
        + ',"timestamp":"'
        + timestamp  # vom Formatter erzeugt: nur Ziffern, '-', ':', 'T', 'Z'
        + '","kind":'
        + _json_str(kind)
        + ',"job_id":'
        + _json_str(job_id)
        + ',"trace_id":'
        + _json_str(trace_id)
        + ',"intent_id":'
        + _json_str(intent_id)
        + ',"limb":'
        + _json_str(limb)
        + ',"clock_s":'
        + _json_number(clock)
        + ',"payload":'
        + body
        + "}"
    )


_FAST_TIME_STATE: dict[str, Any] = {"sec": -1, "base": ""}


def _iso_ms_z_fast() -> str:
    """ISO-8601 MS-Zeitstempel in der Form ``...T..:..:..mmmZ`` -- ohne ``datetime``.

    Der Event-Bus erzeugt fuer *jedes* Event einen Zeitstempel. ``datetime.now(UTC)``
    plus ``.replace('+00:00', 'Z')`` kostet ~1 µs pro Aufruf, obwohl es nur eine
    formatierte Sekunde + Millisekunde ist. Diese Variante cacht den Sekunden-Basisteil
    und berechnet nur die Millisekunden neu -- identisches Ausgabeformat, keine
    Semantik-Aenderung.
    """
    now = time.time()
    sec = int(now)
    ms = int((now - sec) * 1000)
    state = _FAST_TIME_STATE
    if sec != state["sec"]:
        state["sec"] = sec
        state["base"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(sec))
    return f"{state['base']}.{ms:03d}Z"


#: Bekannte Event-Arten (Namensschema: ``bereich.ereignis``). Der Bus validiert
#: bewusst nicht -- ein Log-Sink darf nie der Grund fuer Datenverlust sein --
#: aber Tests, Doku und die CLI ziehen diese Liste heran. Die ``timer.*``-Kinds
#: ab ``timer.armed`` gehoeren zu Protokoll 1.2 (Zeit-Tracking + Trigger).
VALID_EVENT_KINDS: tuple[str, ...] = (
    "job.created",
    "job.finished",
    "job.aborted",
    "job.measure",
    "job.diagnosed",
    "job.iteration.started",
    "job.iteration.planned",
    "job.scheduled",       # 1.2: durch einen check-Trigger erzeugter Kontroll-Job
    "jobs.reclaimed",
    "intent.accepted",
    "intent.rejected",
    "inbox.rejected",
    "policy.decided",
    "agent.lock.acquired",
    "agent.lock.released",
    "limb.spawned",
    "loop.tick",
    "loop.supervised",     # 1.2: Bilanz eines ueberwachten (asynchronen) Laufs
    "result.recorded",
    "result.verdict",
    "transport.archived",
    # --- Zeit-Tracking & zeitgesteuerte Ausloeser (Protokoll 1.2) ---
    "timer.armed",         # Uhr gestartet: deadline oder unlimited (t0 gesetzt)
    "timer.expired",       # Deadline-Modus: Zeitbudget abgelaufen
    "timer.tick",          # Scheduler-Tick, traegt t_unlimited (clock_s)
    "timer.trigger",       # Ausloeser hat gefeuert
    "timer.skipped",       # Ausloeser uebersprungen (Limit belegt) -- kein stiller Verlust
    "timer.safety_net",    # Safety-Netz hat einen Prozess beendet (Hygiene, kein Aufgabenlimit)
    "timer.log",           # Freitext-Log eines log-Triggers
    "timer.escalation",    # escalate-Trigger: Entscheidung durch Mensch/Core noetig
    "timer.finished",      # finish_job-Trigger: Auftrag gilt als abgeschlossen
    "schedule.attached",   # 1.2: Trigger-Zustand fuer einen Auftrag angelegt
    "schedule.detached",   # 1.2: Trigger-Zustand nach Abschluss entfernt
    "limb.terminated",     # 1.2: Limb wurde durch Zeitplan oder Safety-Netz gestoppt
)


@dataclass(frozen=True, slots=True)
class Event:
    """Ein Ereignis auf dem Bus.

    ``clock_s`` ist ``t_unlimited``: Sekunden seit ``t0`` (Job-Erstellung). Es
    wird bei jedem Event mitgeschrieben, damit zeitgesteuerte Ausloeser und die
    spaetere Log-Analyse (Phase 3) exakt dieselbe Uhr referenzieren. ``None``
    bedeutet: kein Job-Kontext (z. B. reine Konfigurationsausgabe).

    ``slots=True`` ist kein Tempomacher (gemessen neutral, 3.06 -> 3.08 µs pro
    ``emit``), sondern Speicher: ein Sammler behaelt jedes Event eines Laufs, und
    200 000 Events kosten so 39.7 MB statt 48.9 MB (-18.8 %).
    """

    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
    seq: int = 0
    timestamp: str = ""
    job_id: str = ""
    trace_id: str = ""
    intent_id: str = ""
    limb: str = ""
    clock_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "timestamp": self.timestamp,
            "kind": self.kind,
            "job_id": self.job_id,
            "trace_id": self.trace_id,
            "intent_id": self.intent_id,
            "limb": self.limb,
            "clock_s": self.clock_s,
            "payload": dict(self.payload),
        }


class ConsoleSink:
    """Schreibt Events als JSON-Zeilen auf einen Textstrom (Default: stderr).

    stderr statt stdout, damit stdout fuer das jeweilige Ergebnis reserviert
    bleibt (Pipe-Sicherheit: ``... | jq``).
    """

    name = "console"

    def __init__(self, stream: TextIO | None = None, quiet: bool = False) -> None:
        self.stream = stream or sys.stderr
        self.quiet = quiet

    @property
    def wants_prepared_line(self) -> bool:
        """Im Quiet-Modus verwirft der Sink die Zeile -- der Bus serialisiert dann gar nicht."""
        return not self.quiet

    def write(self, record: Mapping[str, Any]) -> None:
        if self.quiet:
            return
        self._emit_line(render_record(record))

    def write_prepared(self, record: Mapping[str, Any], line: str) -> None:
        """Fast-Path: der Bus hat die Zeile schon serialisiert -- nicht nochmal tun."""
        self._emit_line(line)

    def _emit_line(self, line: str) -> None:
        try:
            self.stream.write(line)
            self.stream.write("\n")
            self.stream.flush()
        except (ValueError, OSError):  # Ein Log-Sink darf die Pipeline nie toeten
            pass


class CollectingSink:
    """Sammelt Events im Speicher -- fuer Tests und fuer die CLI-Zusammenfassung."""

    name = "collector"

    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def write(self, record: Mapping[str, Any]) -> None:
        self.records.append(dict(record))

    def kinds(self) -> list[str]:
        return [str(r.get("kind")) for r in self.records]


class EventBus:
    """Nummeriert, zeitstempelt und verteilt Ereignisse an alle Sinks.

    Fanout-Semantik (Triad 2 / Cycle 1): der Bus baut den Datensatz **einmal**
    und serialisiert ihn **einmal**. Sinks mit ``wants_prepared_line`` erhalten
    die fertige JSON-Zeile ueber ``write_prepared(record, line)`` -- bei drei
    Text-Sinks fiel vorher die Serialisierung dreimal an, jetzt genau einmal.
    Ist kein Text-Sink abonniert (nur Sammler/Ring), wird gar nicht
    serialisiert: der Bus laeuft dann rein im Dict-Pfad.
    """

    def __init__(self, sinks: Iterable[EventSink] | None = None) -> None:
        self._sinks: list[EventSink] = list(sinks or [])
        self._seq = 0

    def subscribe(self, sink: EventSink) -> None:
        self._sinks.append(sink)

    @property
    def sinks(self) -> tuple[EventSink, ...]:
        return tuple(self._sinks)

    def emit(
        self,
        kind: str,
        payload: Mapping[str, Any] | None = None,
        *,
        job_id: str = "",
        trace_id: str = "",
        intent_id: str = "",
        limb: str = "",
        clock_s: float | None = None,
    ) -> Event:
        # Fast-Path: Der Datensatz wird genau einmal gebaut. ``datetime.now`` +
        # ``.replace('+00:00','Z')`` und die doppelte ``payload``-Kopie (einmal in
        # ``Event``, einmal in ``to_dict()``) waren die beiden teuersten Teile des
        # Hot Paths (siehe ``.nio/nexus.md``, Triad 1 / Cycle 1).
        self._seq += 1
        seq = self._seq
        payload_copy = dict(payload) if payload else {}
        clock = None if clock_s is None else round(float(clock_s), 3)
        timestamp = _iso_ms_z_fast()
        job = job_id or trace_id
        record = {
            "seq": seq,
            "timestamp": timestamp,
            "kind": kind,
            "job_id": job,
            "trace_id": trace_id,
            "intent_id": intent_id,
            "limb": limb,
            "clock_s": clock,
            "payload": payload_copy,
        }
        line: str | None = None  # wird spaetestens beim ersten Text-Sink gebaut
        for sink in self._sinks:
            try:
                if getattr(sink, "wants_prepared_line", False):
                    if line is None:
                        line = _render_line(
                            seq, timestamp, kind, job, trace_id, intent_id, limb, clock, payload_copy
                        )
                    sink.write_prepared(record, line)  # type: ignore[attr-defined]
                else:
                    sink.write(record)
            except Exception as exc:
                sys.stderr.write(f"[events] Sink '{getattr(sink, 'name', '?')} scheiterte: {exc}\n")
        # Rueckgabe bleibt der ``Event`` (oeffentliche API); Sinks erhalten bereits
        # den fertig gebauten ``record``, es wird keine zweite ``to_dict()``-Kopie
        # fuer die Zustellung benoetigt.
        return Event(
            kind=kind,
            payload=payload_copy,
            seq=seq,
            timestamp=timestamp,
            job_id=job,
            trace_id=trace_id,
            intent_id=intent_id,
            limb=limb,
            clock_s=clock,
        )


def build_event_bus(*, quiet: bool = False, collector: CollectingSink | None = None, stream: TextIO | None = None) -> EventBus:
    """Standard-Bus des Orchestrators.

    NEU-PHASE-3-ANCHOR: Hier wird der persistente File-Sink (``runtime/system.log``)
    registriert, sobald der Bootstrap-Limb ihn implementiert hat. Reihenfolge
    bleibt: erst persistent, dann Konsole -- damit kein Event verloren geht.
    """
    sinks: list[EventSink] = []
    if collector is not None:
        sinks.append(collector)
    sinks.append(ConsoleSink(stream=stream, quiet=quiet))
    return EventBus(sinks)
