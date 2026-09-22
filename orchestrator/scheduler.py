"""Zeit-Tracking und zeitgesteuerte Ausloeser (Protokoll 1.2).

Zwei Fragen, ein Mechanismus:

1. **Wie lange laeuft ein Auftrag schon?** Ohne ``t_limit`` (``timer.mode =
   "unlimited"``) wird die Zeit nicht begrenzt, sondern *aufgezeichnet*: ``t0``
   ist der Nullpunkt (Job-Erstellung), ``elapsed_s`` die seitdem vergangene Zeit
   -- im Projekt ``t_unlimited`` genannt. Jeder Event traegt diesen Wert
   (``Event.clock_s``), damit Beobachtung und spaetere Log-Analyse dieselbe Uhr
   benutzen.

2. **Was soll zu bestimmten Zeiten passieren?** ``intent.schedule.triggers``
   beschreibt Ausloeser gegen genau diese Uhr::

       {"id": "kontrolle", "action": "check", "every_s": 10,
        "payload": {"operation": "sys.echo", "params": {"message": "Status?"}}}
       {"id": "schwelle", "action": "emit_event", "when": "elapsed >= 30",
        "payload": {"kind": "timer.threshold"}}

   Der Scheduler tickt (Default 0,5 s), vergleicht ``elapsed`` mit den
   Ausloesern und liefert :class:`DueAction`-Objekte. Ausgefuehrt werden sie vom
   Orchestrator (``orchestrator/runner.py``) -- der Scheduler entscheidet nur,
   *dass* etwas faellig ist, und fuehrt selbst keine Limbs aus.

Designregeln (aus den Projekt-Vorgaben abgeleitet):

* **Kein stiller Verlust.** Kann ein Ausloeser nicht ausgefuehrt werden (z. B.
  weil ``limits.max_scheduled_jobs`` belegt ist), wird das als
  ``timer.skipped``-Event dokumentiert -- nicht verschluckt.
* **Kantengesteuert.** Eine ``when``-Bedingung feuert in dem Tick, in dem sie
  wahr *wird*, nicht in jedem Tick, in dem sie wahr ist. Ein Intervall
  (``every_s``) feuert dagegen wiederholt; kombiniert mit ``when`` zaehlt das
  Intervall erst ab Eintritt der Bedingung.
* **Zustand ist persistent.** ``runtime/schedules/<job_id>.json`` -- ein
  Neustart des Orchestrators setzt die Uhr nicht zurueck (``t0`` bleibt) und
  vergisst keine bereits erfolgten Feuerungen.
* **Safety-Netz ist Hygiene, kein Aufgabenlimit.** Es beendet hoechstens einen
  Prozess und meldet ``E_SAFETY_NET``; die Entscheidung liegt beim Menschen.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from core.atomic import atomic_write_bytes
from core.config import NeuConfig
from core.protocol import (
    ErrorCode,
    Intent,
    ProtocolError,
    Schedule,
    Trigger,
    format_timestamp,
    parse_timestamp,
    timestamp_epoch_s,
    utc_now,
)

__all__ = [
    "ACTION_CHECK",
    "ACTION_EMIT",
    "ACTION_ESCALATE",
    "ACTION_FINISH",
    "ACTION_LOG",
    "DueAction",
    "ScheduleState",
    "Scheduler",
    "TriggerState",
    "evaluate_condition",
    "parse_condition",
]

ACTION_EMIT = "emit_event"
ACTION_CHECK = "check"
ACTION_ESCALATE = "escalate"
ACTION_FINISH = "finish_job"
ACTION_LOG = "log"

#: Wie viele Feuerungen pro Job maximal im Zustand mitgeschrieben werden.
HISTORY_LIMIT = 200

#: Operator-Syntax als Menge: ``op not in _COMPARISONS`` laeuft pro Tick und wird
#: hier nur noch als Mengentest benoetigt (ein Tupel waere eine Linearsuche).
_COMPARISONS = frozenset(("<=", ">=", "==", "!=", "<", ">"))

#: Dieselbe Grammatik wie ``core.protocol._CONDITION_RE`` (Schema + Parser).
_CONDITION_TOKEN_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(\d+(?:\.\d+)?)")


# =============================================================================
# Bedingungen ("elapsed >= 30")
# =============================================================================
#: Vorkompilierte Bedingungen: roher ``when``-Text -> ``(Operator, Schwellwert)``.
#:
#: Derselbe Text wird **pro Tick und pro Ausloeser** ausgewertet (bei 8 Triggern
#: und ``tick_s=0,05`` sind das 160 Parses pro Sekunde und Job), obwohl das
#: Ergebnis mit dem Stellen des Auftrags feststeht. Der Parser selbst ist der
#: teure Teil: ``str.strip`` + ``re.fullmatch`` + ``float()`` + Operator-
#: Mitgliedschaftstest kosten ~0,76 µs -- der eigentliche Vergleich ~0,08 µs.
#: Der Cache ist **gebunden** (Leeren bei Vollstand), damit ein Logger oder eine
#: endlose Folge handschriftlicher Bedingungen keinen Speicherballast erzeugt.
#: Fehler werden bewusst *nicht* gecacht: die Meldung muss den rohen Text nennen
#: koennen, und ein ungueltiger Zustand soll weiterhin jeden Tick laut verwerfen.
_CONDITION_CACHE_MAX = 512
_CONDITION_CACHE: dict[str, tuple[str, float]] = {}


def parse_condition(when: str) -> tuple[str, float]:
    """Zerlegt ``"elapsed <op> <sekunden>"`` in Operator und Schwellwert.

    Der Operator muss aus dem Protokoll stammen (``<=``, ``>=``, ``==``, ``!=``,
    ``<``, ``>``). Groesser-/Kleiner-Vergleiche sind exakt, ``==``/``!=`` werden
    mit der Trigger-Toleranz ausgewertet (Zeitscheiben sind nie exakt).

    Gleiche Eingabe ergibt immer dasselbe Resultat -- deshalb darf der Wert
    gecacht werden (schnellster Pfad = ein einziger Dict-Treffer).
    """
    cached = _CONDITION_CACHE.get(when)
    if cached is not None:
        return cached
    compiled = _compile_condition(when)
    if len(_CONDITION_CACHE) >= _CONDITION_CACHE_MAX:
        _CONDITION_CACHE.clear()
    _CONDITION_CACHE[when] = compiled
    return compiled


def _compile_condition(when: str) -> tuple[str, float]:
    """Einmalige Analyse einer Bedingung (der Teil, den ``parse_condition`` cacht)."""
    text = (when or "").strip()
    if not text:
        raise ProtocolError(ErrorCode.TRIGGER_INVALID, "when darf nicht leer sein", "$.schedule.triggers[].when")
    # Ein Tokenizer statt Zeichenketten-Ersetzung: "elapsed<5" (ohne Leerzeichen)
    # ist laut Schema gueltig und muss auch hier erkannt werden. Die Grammatik ist
    # dieselbe wie core.protocol._CONDITION_RE -- beide pruefen dieselbe Sprache.
    matched = _CONDITION_TOKEN_RE.fullmatch(text)
    if matched is None:
        raise ProtocolError(
            ErrorCode.TRIGGER_INVALID,
            f"Bedingung '{when}' hat die Form 'elapsed <op> <sekunden>' mit op in {', '.join(_COMPARISONS)}",
            "$.schedule.triggers[].when",
        )
    subject, op, raw_value = matched.group(1), matched.group(2), matched.group(3)
    if subject != "elapsed":
        raise ProtocolError(
            ErrorCode.TRIGGER_INVALID,
            f"Einzig zulaessige Uhr-Groesse in when ist 'elapsed' (gefunden: '{subject}')",
            "$.schedule.triggers[].when",
        )
    if op not in _COMPARISONS:
        raise ProtocolError(
            ErrorCode.TRIGGER_INVALID,
            f"Unbekannter Vergleich '{op}'; zulaessig: {', '.join(_COMPARISONS)}",
            "$.schedule.triggers[].when",
        )
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ProtocolError(
            ErrorCode.TRIGGER_INVALID,
            f"Schwellwert '{raw_value}' ist keine Zahl",
            "$.schedule.triggers[].when",
        ) from exc
    return op, value


def evaluate_condition(when: str, elapsed: float, *, tolerance_s: float = 0.25) -> bool:
    """Wertet eine Bedingung gegen ``t_unlimited`` aus.

    Ordnungvergleiche (``<``, ``<=``, ``>``, ``>=``) sind **exakt**: "elapsed >=
    30" darf nicht bei 29,8 s feuern -- der Schwellwert kommt vom Auftraggeber
    und ist keine Naeherung. Die Toleranz gilt nur fuer Gleichheit (``==``,
    ``!=``), denn Ticks sind diskret: Ohne Fenster wuerde ``elapsed == 30`` in
    der Praxis fast nie getroffen. Verspaetung ist erlaubt und wird im Event
    dokumentiert (``elapsed_s`` zeigt die echte Uhrzeit der Feuerung).
    """
    op, value = parse_condition(when)
    if op == "<=":
        return elapsed <= value
    if op == ">=":
        return elapsed >= value
    if op == "==":
        return abs(elapsed - value) <= tolerance_s
    if op == "!=":
        return abs(elapsed - value) > tolerance_s
    if op == "<":
        return elapsed < value
    return elapsed > value  # ">"


# =============================================================================
# Zustand
# =============================================================================
@dataclass
class TriggerState:
    """Buchhaltung eines einzelnen Ausloesers (was feuerte wann, was kommt)."""

    trigger_id: str
    action: str = ACTION_EMIT
    fires: int = 0
    condition_met: bool = False
    gate_at: float | None = None          # elapsed, ab dem ein Intervall zaehlt
    next_interval_at: float | None = None  # naechste Intervall-Feuerung (elapsed)
    pending_marks: list[float] = field(default_factory=list)
    finished: bool = False
    last_fired_elapsed: float | None = None
    skipped: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "trigger_id": self.trigger_id,
            "action": self.action,
            "fires": self.fires,
            "condition_met": self.condition_met,
            "gate_at": self.gate_at,
            "next_interval_at": self.next_interval_at,
            "pending_marks": list(self.pending_marks),
            "finished": self.finished,
            "last_fired_elapsed": self.last_fired_elapsed,
            "skipped": self.skipped,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TriggerState:
        body = dict(data)
        marks = body.get("pending_marks", []) or []
        return cls(
            trigger_id=str(body.get("trigger_id", "")),
            action=str(body.get("action", ACTION_EMIT)),
            fires=int(body.get("fires", 0) or 0),
            condition_met=bool(body.get("condition_met", False)),
            gate_at=None if body.get("gate_at") is None else float(body["gate_at"]),
            next_interval_at=None if body.get("next_interval_at") is None else float(body["next_interval_at"]),
            pending_marks=[float(m) for m in marks],
            finished=bool(body.get("finished", False)),
            last_fired_elapsed=None if body.get("last_fired_elapsed") is None else float(body["last_fired_elapsed"]),
            skipped=int(body.get("skipped", 0) or 0),
        )


@dataclass
class DueAction:
    """Eine faellige Aktion -- vom Orchestrator auszufuehren, nicht vom Scheduler."""

    job_id: str
    trigger: Trigger
    action: str
    elapsed_s: float
    reason: str
    payload: dict[str, Any] = field(default_factory=dict)
    catch_up: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "trigger_id": self.trigger.id,
            "action": self.action,
            "elapsed_s": self.elapsed_s,
            "reason": self.reason,
            "payload": dict(self.payload),
            "catch_up": self.catch_up,
        }


@dataclass
class ScheduleState:
    """Persistierter Zustand aller Ausloeser eines Jobs."""

    job_id: str
    t0: str
    tick_s: float = 0.5
    safety_net_s: float | None = None
    timer_mode: str = "unlimited"
    triggers: tuple[Trigger, ...] = ()
    states: dict[str, TriggerState] = field(default_factory=dict)
    fires_total: int = 0
    skipped_total: int = 0
    needs_human: bool = False
    finish_requested: bool = False
    safety_net_fired: bool = False
    last_tick: str = ""
    last_tick_elapsed: float = 0.0
    history: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    # Fragment-Puffer fuer die Persistenz: pro Historieneintrag genau ein
    # ``json.dumps`` statt eines pro Speichervorgang. ``compare=False``, damit die
    # Ableitung nie Zustandsverleich oder ``repr`` verunziert.
    hist_frags: list[str] = field(default_factory=list, compare=False, repr=False)
    hist_appends: int = field(default=0, compare=False, repr=False)
    hist_built: int = field(default=-1, compare=False, repr=False)
    hist_tail: int = field(default=0, compare=False, repr=False)
    hist_head: int = field(default=0, compare=False, repr=False)

    # -- Uhr -----------------------------------------------------------------
    def elapsed_s(self, *, now: datetime | None = None) -> float:
        """``t_unlimited``: Sekunden seit ``t0``.

        Schnellpfad ohne vorgegebenes ``now``: ``t0`` ist nach dem Schaerfen
        unveraenderlich, also wird der Anker nicht pro Tick neu geparst, sondern
        aus dem memoisierten Epoche-Wert gelesen (``timestamp_epoch_s``). Der
        Pfad mit explizitem ``now`` (Tests, ``tick(now=...)``) bleibt unveraendert.
        """
        if now is not None:
            origin = parse_timestamp(self.t0, "$.schedule.t0")
            return round(max(0.0, (now - origin).total_seconds()), 3)
        return round(max(0.0, time.time() - timestamp_epoch_s(self.t0, "$.schedule.t0")), 3)

    def state_for(self, trigger: Trigger) -> TriggerState:
        found = self.states.get(trigger.id)
        if found is None:
            found = TriggerState(
                trigger_id=trigger.id,
                action=trigger.action,
                pending_marks=list(trigger.at_s),
            )
            self.states[trigger.id] = found
        return found

    def active_triggers(self) -> tuple[Trigger, ...]:
        return tuple(t for t in self.triggers if not self.state_for(t).finished)

    # -- Persistenz-Text -----------------------------------------------------
    def record_history_fragment(self, entry: Mapping[str, Any]) -> None:
        """Holt das JSON-Fragment eines frischen Historieneintrags nach.

        Muss synchron zu ``history`` gepflegt werden (gleiche Kuerzung), sonst gilt
        der Puffer beim naechsten ``persist_text`` als veraltet und wird komplett neu
        gebaut -- Sicherheitsnetz, kein Fehlerpfad.
        """
        self.hist_frags.append(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
        if len(self.hist_frags) > HISTORY_LIMIT:
            del self.hist_frags[: len(self.hist_frags) - HISTORY_LIMIT]
        self.hist_appends += 1
        self.hist_built = self.hist_appends
        self.hist_tail = id(self.history[-1]) if self.history else 0
        self.hist_head = id(self.history[0]) if self.history else 0

    def persist_text(self) -> str:
        """Der Dateiinhalt: dasselbe Dokument wie ``to_dict()``, nur billiger.

        Die Historie ist der einzige grosse Teil des Zustands (bis zu
        ``HISTORY_LIMIT`` Eintraege) und sie waechst nur am Ende -- also wird jeder
        Eintrag genau einmal encodiert (in ``_record``) und hier nur noch
        aneinanderguegt. Bei voller Historie ersetzt das ein ``json.dumps`` ueber
        33 KB (gemessen 306 µs) durch einen Join (~15 µs inklusive Rumpf).

        Der Puffer gilt als frisch, wenn Anhaehlzahl, Laenge und die Objekte an Kopf
        und Ende noch dieselben sind -- das ist dervertrag, den ``_record`` haelt
        (Eintraege werden nach dem Anhaengen nicht mehr angefasst). Ein Eingriff in
        die *Mitte* der Liste gilt deshalb als unveraendert; er existiert nirgends.

        Die Schluesselreihenfolge in der Datei aendert sich dabei (``history`` steht
        zuletzt); gelesen wird ausschliesslich ueber ``json.loads``, das keine
        Reihenfolge kennt. Geprueft wird trotzdem die Identitaet:
        ``json.loads(persist_text()) == to_dict()``.
        """
        body = self.to_dict()
        history = body.pop("history")
        frags = self.hist_frags
        tail_mark = id(history[-1]) if history else 0
        head_mark = id(history[0]) if history else 0
        if (
            self.hist_built != self.hist_appends
            or len(frags) != len(history)
            or (tail_mark, head_mark) != (self.hist_tail, self.hist_head)
        ):
            frags = [json.dumps(entry, ensure_ascii=False, separators=(",", ":")) for entry in history]
            self.hist_frags = frags
            self.hist_built = self.hist_appends
            self.hist_tail = tail_mark
            self.hist_head = head_mark
        rumpf = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        return rumpf[:-1] + ',"history":[' + ",".join(frags) + "]}"

    # -- Serialisierung ------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "t0": self.t0,
            "tick_s": self.tick_s,
            "safety_net_s": self.safety_net_s,
            "timer_mode": self.timer_mode,
            "triggers": [t.to_dict() for t in self.triggers],
            "states": {key: value.to_dict() for key, value in self.states.items()},
            "fires_total": self.fires_total,
            "skipped_total": self.skipped_total,
            "needs_human": self.needs_human,
            "finish_requested": self.finish_requested,
            "safety_net_fired": self.safety_net_fired,
            "last_tick": self.last_tick,
            "last_tick_elapsed": self.last_tick_elapsed,
            "history": list(self.history[-HISTORY_LIMIT:]),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ScheduleState:
        body = dict(data)
        triggers = tuple(Trigger.from_dict(item) for item in body.get("triggers", []) or [])
        raw_states = body.get("states", {}) or {}
        states = {str(key): TriggerState.from_dict(value) for key, value in raw_states.items()}
        raw_safety = body.get("safety_net_s")
        return cls(
            job_id=str(body.get("job_id", "")),
            t0=str(body.get("t0", "")),
            tick_s=float(body.get("tick_s", 0.5) or 0.5),
            safety_net_s=None if raw_safety is None else float(raw_safety),
            timer_mode=str(body.get("timer_mode", "unlimited")),
            triggers=triggers,
            states=states,
            fires_total=int(body.get("fires_total", 0) or 0),
            skipped_total=int(body.get("skipped_total", 0) or 0),
            needs_human=bool(body.get("needs_human", False)),
            finish_requested=bool(body.get("finish_requested", False)),
            safety_net_fired=bool(body.get("safety_net_fired", False)),
            last_tick=str(body.get("last_tick", "")),
            last_tick_elapsed=float(body.get("last_tick_elapsed", 0.0) or 0.0),
            history=list(body.get("history", []) or []),
            created_at=str(body.get("created_at", "")),
            updated_at=str(body.get("updated_at", "")),
        )

    @classmethod
    def from_intent(cls, intent: Intent, *, t0: str = "") -> ScheduleState:
        """Uebernimmt Uhr und Ausloeser aus einem Intent.

        ``t0`` faellt auf ``timer.t0`` (falls schon geschaerft) oder auf die
        Jetzzeit zurueck -- die Uhr beginnt mit dem Auftrag, nicht mit dem Tick.
        """
        origin = t0 or intent.timer.t0 or format_timestamp(utc_now())
        now = format_timestamp(utc_now())
        state = cls(
            job_id=intent.job.job_id,
            t0=origin,
            tick_s=intent.schedule.tick_s,
            safety_net_s=intent.timer.safety_net_s,
            timer_mode=intent.timer.mode,
            triggers=intent.schedule.triggers,
            created_at=now,
            updated_at=now,
        )
        for trigger in intent.schedule.triggers:
            state.state_for(trigger)
        return state


# =============================================================================
# Scheduler
# =============================================================================
class Scheduler:
    """Wertet Trigger gegen die Job-Uhr aus und liefert faellige Aktionen.

    Der Scheduler fuehrt nichts aus: Er erzeugt :class:`DueAction`-Eintraege und
    Events. Ausfuehren tut der Orchestrator -- so bleibt die Verantwortung
    (Budgets, Policy, Limb-Auswahl) an einer Stelle.
    """

    def __init__(self, config: NeuConfig, *, bus: Any = None) -> None:
        self.config = config
        self.bus = bus
        self.config.schedules_dir.mkdir(parents=True, exist_ok=True)

    # -- Persistenz ----------------------------------------------------------
    def path_for(self, job_id: str) -> Path:
        return self.config.schedules_dir / f"{job_id}.json"

    def attach(self, intent: Intent, *, t0: str = "", force: bool = False) -> ScheduleState | None:
        """Legt den Trigger-Zustand fuer einen Intent an (idempotent).

        Ohne Trigger und ohne ``force`` entsteht kein Zustand -- ein Auftrag mit
        Deadline und ohne Ausloeser braucht keinen Scheduler.
        """
        schedule: Schedule = intent.schedule
        if not schedule.triggers and not force:
            return None
        existing = self.load(intent.job.job_id)
        if existing is not None and tuple(t.id for t in existing.triggers) == tuple(t.id for t in schedule.triggers):
            return existing
        state = ScheduleState.from_intent(intent, t0=t0)
        if existing is not None:
            # Bestehende Feuerungen uebernehmen, damit ein Re-Attach keine
            # Ausloeser doppelt feuern laesst (z. B. nach Absturz/Neustart).
            for trigger_id, previous in existing.states.items():
                if trigger_id in state.states:
                    state.states[trigger_id].fires = previous.fires
                    state.states[trigger_id].finished = previous.finished
                    state.states[trigger_id].condition_met = previous.condition_met
                    state.states[trigger_id].gate_at = previous.gate_at
                    state.states[trigger_id].next_interval_at = previous.next_interval_at
                    state.states[trigger_id].skipped = previous.skipped
            state.fires_total = existing.fires_total
            state.skipped_total = existing.skipped_total
            state.needs_human = existing.needs_human
            state.t0 = existing.t0  # die Uhr laeuft weiter, sie beginnt nicht neu
        self.save(state)
        self._emit(
            "schedule.attached",
            {
                "timer_mode": state.timer_mode,
                "t0": state.t0,
                "tick_s": state.tick_s,
                "safety_net_s": state.safety_net_s,
                "triggers": [t.id for t in state.triggers],
            },
            job_id=state.job_id,
            clock_s=state.elapsed_s(),
        )
        return state

    def load(self, job_id: str) -> ScheduleState | None:
        path = self.path_for(job_id)
        if not path.is_file():
            return None
        try:
            return ScheduleState.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, ProtocolError, ValueError, TypeError):
            return None

    def save(self, state: ScheduleState) -> Path:
        state.updated_at = format_timestamp(utc_now())
        path = self.path_for(state.job_id)
        # Optimierung (Bolt, Nr.2; Fragment-Cache, Nr.3): kompakte Separators statt
        # indent=2 und -- neu -- die Historie wird nicht pro Feuerung komplett neu
        # encodiert. Die Datei bleibt reiner Maschinenzustand, gelesen ueber
        # ``json.loads`` (load()/from_dict); die menschliche Sicht ist ``schedule show``.
        try:
            atomic_write_bytes(path, (state.persist_text() + "\n").encode("utf-8"), dir_mode=False)
        except FileNotFoundError:
            # Verzeichnis wurde nach dem attach() entfernt (aufraumen, Neustart):
            # einmal anlegen und wiederholen -- statt pro Speicherzugriff zu pruefen.
            atomic_write_bytes(path, (state.persist_text() + "\n").encode("utf-8"), dir_mode=True)
        return path

    def detach(self, job_id: str) -> bool:
        """Entfernt den Zustand (Auftrag abgeschlossen)."""
        path = self.path_for(job_id)
        if path.is_file():
            path.unlink()
            return True
        return False

    def states(self) -> list[ScheduleState]:
        if not self.config.schedules_dir.is_dir():
            return []
        found: list[ScheduleState] = []
        for path in sorted(self.config.schedules_dir.glob("*.json")):
            state = self.load(path.stem)
            if state is not None:
                found.append(state)
        return found

    # -- Auswertung ----------------------------------------------------------
    def tick(self, state: ScheduleState, *, now: datetime | None = None) -> list[DueAction]:
        """Ein Scheduler-Tick: vergleicht ``t_unlimited`` mit allen Ausloesern."""
        moment = now or utc_now()
        elapsed = state.elapsed_s(now=moment)
        state.last_tick = format_timestamp(moment)
        state.last_tick_elapsed = elapsed

        due: list[DueAction] = []
        # Optimierung (Bolt): Persistenz nur bei durabler Aenderung. Ein leerer
        # Tick (nichts faellig, kein Kantenwechsel) laesst den Zustand auf
        # Platte unveraendert -- ein bedingungsloses ``save()`` wuerde ihn
        # trotzdem jedes Mal komplett neu serialisieren und atomar schreiben
        # (Historie waechst auf bis zu ~70 KB bei 200 Feuerungen). Bei
        # tick_s=0,5 s mit einem every_s=2 s-Trigger sind 3 von 4 Ticks leer,
        # tragen aber die volle Schreiblast: gemessen ~1,06 ms/Tick allein
        # fuer ``tick()``, davon >95 % Serialisierung + I/O. ``last_tick``/
        # ``last_tick_elapsed`` sind reine Metriken und werden nach einem
        # Neustart aus ``t0`` rekonstruiert -- ein Absturz zwischen zwei
        # leeren Ticks verliert nichts.
        changed = False
        safety_at = state.safety_net_s
        if safety_at and safety_at > 0 and elapsed >= safety_at and not state.safety_net_fired:
            state.safety_net_fired = True
            state.needs_human = True
            changed = True
            self._record(state, "timer.safety_net", "", ACTION_ESCALATE, elapsed,
                         f"Safety-Netz bei {safety_at}s erreicht (t_unlimited={elapsed}s)")

        for trigger in state.triggers:
            trigger_state = state.state_for(trigger)
            if trigger_state.finished:
                continue
            was_met = trigger_state.condition_met
            fired = self._evaluate(trigger, trigger_state, elapsed)
            if fired:
                changed = True  # Feuerung, Marke verbraucht oder Kante falsch->wahr
            elif was_met and not trigger_state.condition_met:
                changed = True  # Kante wahr->falsch (z. B. "elapsed < 30")
            for reason, catch_up in fired:
                if trigger.max_fires and trigger_state.fires >= trigger.max_fires:
                    trigger_state.finished = True
                    break
                trigger_state.fires += 1
                trigger_state.last_fired_elapsed = elapsed
                state.fires_total += 1
                if trigger.once or (trigger.max_fires and trigger_state.fires >= trigger.max_fires):
                    trigger_state.finished = True
                action = DueAction(
                    job_id=state.job_id,
                    trigger=trigger,
                    action=trigger.action,
                    elapsed_s=elapsed,
                    reason=reason,
                    payload=dict(trigger.payload),
                    catch_up=catch_up,
                )
                due.append(action)
                kind = {
                    ACTION_EMIT: str(trigger.payload.get("kind") or "timer.trigger"),
                    ACTION_LOG: "timer.log",
                    ACTION_ESCALATE: "timer.escalation",
                    ACTION_FINISH: "timer.finished",
                    ACTION_CHECK: "timer.trigger",
                }.get(trigger.action, "timer.trigger")
                if trigger.action == ACTION_ESCALATE:
                    state.needs_human = True
                if trigger.action == ACTION_FINISH:
                    state.finish_requested = True
                self._record(state, kind, trigger.id, trigger.action, elapsed, reason, payload=trigger.payload)

        # Nur bei tatsaechlicher Zustandsaenderung persistieren (siehe oben):
        # der haeufigste Fall -- ein Tick ohne faellige Aktion -- wird dadurch
        # vom Platten-I/O entkoppelt, ohne die Crash-Garantie anzutasten
        # (Feuerungen/Fahnen werden immer genau dann geschrieben, wenn sie
        # entstehen).
        if changed:
            self.save(state)
        return due

    def tick_all(self, *, now: datetime | None = None) -> list[DueAction]:
        """Tickt alle bekannten Auftraege (fuer ``loop --watch``)."""
        due: list[DueAction] = []
        for state in self.states():
            due.extend(self.tick(state, now=now))
        return due

    def _evaluate(self, trigger: Trigger, state: TriggerState, elapsed: float) -> list[tuple[str, int]]:
        """Liefert ``[(Begruendung, Aufholzahl), ...]`` fuer einen Trigger."""
        fired: list[tuple[str, int]] = []

        # 1) Bedingung: kantengesteuert (feuert beim Uebergang falsch -> wahr).
        if trigger.when:
            is_true = evaluate_condition(trigger.when, elapsed, tolerance_s=trigger.tolerance_s)
            if is_true and not state.condition_met:
                state.condition_met = True
                if state.gate_at is None:
                    state.gate_at = elapsed
                fired.append((f"when '{trigger.when}' wurde wahr bei t_unlimited={elapsed}s", 0))
            elif not is_true:
                # Bedingung kann wieder falsch werden (z. B. "elapsed < 30"):
                # Kante zuruecksetzen, damit ein spaeterer Uebergang erneut feuert.
                state.condition_met = False

        # Ohne when gilt die Bedingung als dauerhaft erfuellt.
        gated = state.condition_met or not trigger.when

        # 2) Intervall: "pruefe alle N Sekunden" (mit when erst ab Bedingungseintritt).
        if trigger.every_s and gated:
            if state.next_interval_at is None:
                # ``or 0.0``: gate_at und condition_met werden gemeinsam gesetzt
                # und persistiert -- fehlt der Bezug dennoch (z. B. handeditierter
                # Zustand), zaehlt das Intervall ab Auftragsbeginn statt zu crashen.
                origin = (state.gate_at or 0.0) if trigger.when else 0.0
                state.next_interval_at = origin + trigger.every_s
            due_at = state.next_interval_at
            catch_up = 0
            while elapsed >= due_at:
                catch_up += 1
                due_at = (due_at or 0.0) + trigger.every_s
                state.next_interval_at = due_at
            if catch_up:
                base = (state.gate_at or 0.0) if trigger.when else 0.0
                late = round(elapsed - (state.next_interval_at - trigger.every_s), 3)
                fired.append((
                    f"Intervall every_s={trigger.every_s}s faellig "
                    f"(t_unlimited={elapsed}s, Bezug {base}s, Verzoegerung {late}s)"
                    + (f"; {catch_up - 1} verpasste(r) Tick(s) aufgeholt" if catch_up > 1 else ""),
                    catch_up - 1,
                ))

        # 3) Diskrete Zeitmarken: alle Marken der Liste werden abgearbeitet.
        if state.pending_marks:
            reached = [mark for mark in list(state.pending_marks) if elapsed >= mark]
            for mark in reached:
                state.pending_marks.remove(mark)
                fired.append((f"Zeitmarke at_s={mark}s erreicht (t_unlimited={elapsed}s)", 0))

        # 4) Eine reine at_s-Liste ist abgearbeitet, sobald keine Marke offen ist.
        if not trigger.when and not trigger.every_s and not state.pending_marks and fired:
            state.finished = True

        return fired

    # -- Berichte ------------------------------------------------------------
    def next_due_in_s(self, state: ScheduleState) -> float | None:
        """Wann (in Sekunden ab jetzt) der naechste Ausloeser faellig ist."""
        now = utc_now()
        elapsed = state.elapsed_s(now=now)
        upcoming: list[float] = []
        for trigger in state.triggers:
            trigger_state = state.state_for(trigger)
            if trigger_state.finished:
                continue
            gated = trigger_state.condition_met or not trigger.when
            if trigger.every_s and gated:
                base = trigger_state.next_interval_at
                if base is None:
                    base = (trigger_state.gate_at or 0.0) + trigger.every_s
                upcoming.append(max(0.0, base - elapsed))
            upcoming.extend(max(0.0, mark - elapsed) for mark in trigger_state.pending_marks)
        if state.safety_net_s and not state.safety_net_fired:
            upcoming.append(max(0.0, state.safety_net_s - elapsed))
        return round(min(upcoming), 3) if upcoming else None

    def report(self, job_id: str) -> dict[str, Any]:
        """Zustandsbericht fuer CLI/Status -- inkl. ``t_unlimited``."""
        state = self.load(job_id)
        if state is None:
            return {"job_id": job_id, "scheduled": False}
        elapsed = state.elapsed_s()
        return {
            "job_id": job_id,
            "scheduled": True,
            "timer_mode": state.timer_mode,
            "t0": state.t0,
            "t_unlimited_s": elapsed,
            "tick_s": state.tick_s,
            "safety_net_s": state.safety_net_s,
            "safety_net_fired": state.safety_net_fired,
            "fires_total": state.fires_total,
            "skipped_total": state.skipped_total,
            "needs_human": state.needs_human,
            "finish_requested": state.finish_requested,
            "next_due_in_s": self.next_due_in_s(state),
            "triggers": [
                {
                    "id": trigger.id,
                    "action": trigger.action,
                    "when": trigger.when,
                    "every_s": trigger.every_s,
                    "at_s": list(trigger.at_s),
                    "once": trigger.once,
                    "max_fires": trigger.max_fires,
                    "fires": state.state_for(trigger).fires,
                    "finished": state.state_for(trigger).finished,
                    "skipped": state.state_for(trigger).skipped,
                    "condition_met": state.state_for(trigger).condition_met,
                    "last_fired_elapsed": state.state_for(trigger).last_fired_elapsed,
                }
                for trigger in state.triggers
            ],
            "last_ticks": list(state.history[-10:]),
        }

    def mark_skipped(self, job_id: str, trigger_id: str, reason: str, *, elapsed_s: float | None = None) -> None:
        """Dokumentiert eine *nicht* ausgefuehrte Feuerung (kein stiller Verlust)."""
        state = self.load(job_id)
        if state is None:
            return
        trigger_state = state.states.get(trigger_id)
        if trigger_state is not None:
            trigger_state.skipped += 1
        state.skipped_total += 1
        clock = state.elapsed_s() if elapsed_s is None else elapsed_s
        self._record(state, "timer.skipped", trigger_id, "skipped", clock, reason)
        self.save(state)

    # -- Intern --------------------------------------------------------------
    def _record(
        self,
        state: ScheduleState,
        kind: str,
        trigger_id: str,
        action: str,
        elapsed: float,
        reason: str,
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        entry = {
            "at": format_timestamp(utc_now()),
            "kind": kind,
            "trigger_id": trigger_id,
            "action": action,
            "elapsed_s": elapsed,
            "reason": reason,
        }
        if payload:
            entry["payload"] = {key: value for key, value in payload.items() if key != "params"}
        state.history.append(entry)
        state.history = state.history[-HISTORY_LIMIT:]
        state.record_history_fragment(entry)  # Persistenz encodiert jeden Eintrag genau einmal
        self._emit(
            kind,
            {
                "trigger_id": trigger_id,
                "action": action,
                "reason": reason,
                "t0": state.t0,
                **({"payload": entry["payload"]} if "payload" in entry else {}),
            },
            job_id=state.job_id,
            clock_s=elapsed,
        )

    def _emit(self, kind: str, payload: Mapping[str, Any], *, job_id: str = "", clock_s: float | None = None) -> None:
        if self.bus is None:
            return
        try:
            self.bus.emit(kind, payload, job_id=job_id, clock_s=clock_s)
        except Exception as exc:
            import sys

            sys.stderr.write(f"[scheduler] Event '{kind}' konnte nicht geschrieben werden: {exc}\n")


def _as_trigger(item: Any) -> Trigger | None:
    """Rohdaten in einen Trigger uebersetzen; Unsinn ergibt ``None``.

    ``describe_schedule`` ist eine Anzeige-Hilfe und bekommt mitunter rohe
    CLI-/Event-Daten. Ein einzelner ungueltiger Eintrag darf die Beschreibung
    der uebrigen nicht verhindern -- die eigentliche Validierung bleibt Aufgabe
    von ``Trigger.from_dict`` beim Bauen des Intents (fail-fast).
    """
    if isinstance(item, Trigger):
        return item
    if isinstance(item, Mapping):
        try:
            return Trigger.from_dict(item)
        except (ProtocolError, TypeError, ValueError):
            return None
    return None


def describe_schedule(schedule: Schedule | Iterable[Any] | Mapping[str, Any] | None) -> str:
    """Menschenlesbare Einzeiler fuer CLI-Ausgaben.

    Nimmt bewusst auch Rohdaten (``dict``/``list[dict]``) an: Die Beschreibung
    wird schon gezeigt, bevor der Kernel daraus ein ``Schedule``-Objekt gebaut
    hat -- z. B. im ``job.created``-Event.
    """
    triggers: Sequence[Trigger] = ()
    if isinstance(schedule, Schedule):
        triggers = schedule.triggers
    elif isinstance(schedule, Mapping):
        raw = schedule.get("triggers", []) or []
        triggers = tuple(found for found in (_as_trigger(item) for item in raw) if found is not None)
    elif schedule:
        triggers = tuple(found for found in (_as_trigger(item) for item in schedule) if found is not None)
    if not triggers:
        return "keine zeitgesteuerten Ausloeser"
    parts: list[str] = []
    for trigger in triggers:
        when = []
        if trigger.when:
            when.append(trigger.when)
        if trigger.every_s:
            when.append(f"alle {trigger.every_s}s")
        if trigger.at_s:
            when.append("bei " + ", ".join(f"{mark}s" for mark in trigger.at_s))
        repeat = "einmalig" if trigger.once else (f"max. {trigger.max_fires}x" if trigger.max_fires else "wiederholend")
        parts.append(f"{trigger.id}: {' und '.join(when)} -> {trigger.action} ({repeat})")
    return "; ".join(parts)
