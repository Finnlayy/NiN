"""Zeitgesteuerte Ausloeser (Protokoll 1.2): Semantik, Zustand, CLI.

Die Trigger-Semantik wird mit einer **virtuellen Uhr** geprueft
(``Scheduler.tick(state, now=...)``): kein ``sleep``, keine Flakyness, und
Grenzfaelle (verpasste Ticks, Kanten, Aufholen) werden ueberhaupt erst testbar.

Die CLI-Tests am Ende starten dagegen **echte** Kontroll-Jobs mit echtem
Echo-Limb-Subprozess -- ein ``check``-Trigger, der nur im Speicher feuert, waere
kein Beweis.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import timedelta
from pathlib import Path

from core.config import NeuConfig
from core.job import JOB_KIND_SCHEDULED, JobStore
from core.kernel import Kernel
from core.protocol import ErrorCode, Operations, ProtocolError, Trigger, format_timestamp, parse_timestamp, utc_now
from orchestrator.cli import _parse_trigger_spec, _split_trigger_spec
from orchestrator.cli import main as cli_main
from orchestrator.events import CollectingSink, build_event_bus
from orchestrator.scheduler import (
    ACTION_CHECK,
    ACTION_FINISH,
    Scheduler,
    ScheduleState,
    TriggerState,
    describe_schedule,
    evaluate_condition,
    parse_condition,
)

from . import REPO_ROOT

TICK = 0.05


class SchedulerTestCase(unittest.TestCase):
    """Isoliertes runtime/ + virtuelle Uhr."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-sched-")
        tmp = Path(self._tmp.name)
        self.config = NeuConfig.load(
            REPO_ROOT,
            mode="dev",
            limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1, "max_scheduled_jobs": 1},
            runtime_dir=tmp / "runtime",
            workspace_dir=tmp / "workspace",
        )
        self.config.ensure_dirs()
        self.collector = CollectingSink()
        self.bus = build_event_bus(quiet=True, collector=self.collector)
        self.scheduler = Scheduler(self.config, bus=self.bus)
        self.kernel = Kernel(self.config, Operations.load(self.config.protocol_dir / "operations.json"))
        self.jobs = JobStore(self.config)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # ------------------------------------------------------------- Helfer
    def build_state(self, triggers: list[dict], *, t0: str = "", tick_s: float = TICK) -> ScheduleState:
        intent = self.kernel.build_intent(
            operation="sys.echo",
            params={"message": "Beobachtung"},
            limb="echo",
            goal="Zeit tracken statt begrenzen",
            unlimited=True,
            tick_s=tick_s,
            schedule=triggers,
        )
        record = self.jobs.create(intent.job.goal, timer_mode="unlimited", job_id=intent.job.job_id)
        state = self.scheduler.attach(intent, t0=t0 or record.created_at, force=True)
        assert state is not None
        return state

    def at(self, state: ScheduleState, seconds: float):
        """Tick zu einem definierten Zeitpunkt der virtuellen Uhr."""
        moment = parse_timestamp(state.t0, "$.t0") + timedelta(seconds=seconds)
        return self.scheduler.tick(state, now=moment)

    def kinds(self) -> list[str]:
        return [str(record.get("kind")) for record in self.collector.records]


class TestBedingungen(SchedulerTestCase):
    def test_grammatik_wird_zerlegt(self):
        for text, expected in (
            ("elapsed >= 30", (">=", 30.0)),
            ("elapsed<5", ("<", 5.0)),
            ("elapsed == 10.5", ("==", 10.5)),
            ("elapsed != 0.25", ("!=", 0.25)),
            ("elapsed <= 1", ("<=", 1.0)),
            ("elapsed > 0", (">", 0.0)),
        ):
            with self.subTest(bedingung=text):
                self.assertEqual(parse_condition(text), expected)

    def test_unzulaessige_grammatik(self):
        for bad in ("", "elapsed ~ 5", "runtime >= 5", "elapsed >=", "5 >= elapsed", "elapsed >= abc"):
            with self.subTest(bedingung=bad):
                with self.assertRaises(ProtocolError) as ctx:
                    parse_condition(bad)
                self.assertEqual(ctx.exception.code, ErrorCode.TRIGGER_INVALID)

    def test_ordnungsvergleiche_sind_exakt(self):
        """>= darf nicht vor dem Schwellwert feuern -- der Wert kommt vom Auftraggeber."""
        self.assertFalse(evaluate_condition("elapsed >= 30", 29.8))
        self.assertTrue(evaluate_condition("elapsed >= 30", 30.0))
        self.assertTrue(evaluate_condition("elapsed >= 30", 30.4))
        self.assertFalse(evaluate_condition("elapsed < 5", 5.0))
        self.assertTrue(evaluate_condition("elapsed < 5", 4.999))

    def test_gleichheit_braucht_toleranz(self):
        self.assertTrue(evaluate_condition("elapsed == 10", 10.1))
        self.assertFalse(evaluate_condition("elapsed == 10", 10.4))
        self.assertTrue(evaluate_condition("elapsed == 10", 10.4, tolerance_s=0.5))
        self.assertFalse(evaluate_condition("elapsed != 10", 10.05))
        self.assertTrue(evaluate_condition("elapsed != 10", 11.0))


class TestTriggerSemantik(SchedulerTestCase):
    def test_when_kante_feuert_einmal(self):
        state = self.build_state([{"id": "schwelle", "action": "emit_event", "when": "elapsed >= 5"}])
        self.assertEqual(self.at(state, 4.9), [], "vor dem Schwellwert darf nichts feuern")
        due = self.at(state, 5.1)
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0].trigger.id, "schwelle")
        self.assertGreaterEqual(due[0].elapsed_s, 5.0)
        self.assertEqual(self.at(state, 5.5), [], "eine once-Kante feuert nicht erneut")
        self.assertEqual(self.scheduler.report(state.job_id)["triggers"][0]["finished"], True)

    def test_when_ohne_once_kann_wieder_feuern(self):
        state = self.build_state([{"id": "band", "action": "log", "when": "elapsed != 3", "once": False}])
        first = self.at(state, 1.0)
        self.assertEqual(len(first), 1)
        self.assertEqual(self.at(state, 3.0), [], "in der Toleranzband-Bedingung ist sie falsch")
        second = self.at(state, 5.0)
        self.assertEqual(len(second), 1, "nach false -> true muss die Kante erneut feuern")

    def test_intervall_zaehlt_ab_null(self):
        state = self.build_state([{"id": "kontrolle", "action": "emit_event", "every_s": 1.0}])
        fires: list[float] = []
        for moment in (0.4, 0.9, 1.0, 1.4, 2.0, 2.5, 3.1):
            for action in self.at(state, moment):
                fires.append(action.elapsed_s)
        self.assertEqual(len(fires), 3, fires)
        self.assertEqual(self.scheduler.report(state.job_id)["triggers"][0]["finished"], False)

    def test_verpasste_ticks_werden_nachgeholt(self):
        """Ein langsamer Tick darf Intervalle nicht verschlucken -- er dokumentiert sie."""
        state = self.build_state([{"id": "kontrolle", "action": "emit_event", "every_s": 1.0}])
        due = self.at(state, 3.4)
        self.assertEqual(len(due), 1, "pro Tick feuert ein Trigger hoechstens einmal")
        self.assertEqual(due[0].catch_up, 2, "zwei verpasste Intervalle muessen dokumentiert sein")
        self.assertIn("aufgeholt", due[0].reason)

    def test_intervall_startet_erst_nach_bedingung(self):
        state = self.build_state([{"id": "wache", "action": "emit_event", "when": "elapsed >= 2", "every_s": 1.0, "once": False}])
        self.assertEqual(self.at(state, 1.0), [], "vor Bedingungseintritt kein Intervall")
        edge = self.at(state, 2.1)
        self.assertEqual(len(edge), 1, edge)
        self.assertTrue(edge[0].reason.startswith("when"), edge[0].reason)
        following = self.at(state, 3.2)
        self.assertEqual(len(following), 1)
        self.assertIn("Bezug 2.1", following[0].reason)

    def test_zeitmarken_werden_abgearbeitet(self):
        state = self.build_state([{"id": "marken", "action": "log", "at_s": [1, 2, 3]}])
        seen = [action.trigger.id for moment in (0.5, 1.2, 2.2, 3.2, 4.0) for action in self.at(state, moment)]
        self.assertEqual(len(seen), 3, seen)
        report = self.scheduler.report(state.job_id)["triggers"][0]
        self.assertTrue(report["finished"], "eine abgearbeitete Markenliste ist fertig")

    def test_max_fires_begrenzt(self):
        state = self.build_state([{"id": "zaehler", "action": "emit_event", "every_s": 1.0, "max_fires": 2}])
        total = sum(len(self.at(state, moment)) for moment in (1.1, 2.1, 3.1, 4.1))
        self.assertEqual(total, 2)
        self.assertTrue(self.scheduler.report(state.job_id)["triggers"][0]["finished"])

    def test_once_default_haengt_vom_ausloeser_ab(self):
        triggers = [
            Trigger.from_dict({"id": "kante", "when": "elapsed >= 1"}),
            Trigger.from_dict({"id": "intervall", "every_s": 1}),
            Trigger.from_dict({"id": "marken", "at_s": [1, 2]}),
        ]
        self.assertEqual([t.once for t in triggers], [True, False, False])


class TestZustandUndUhr(SchedulerTestCase):
    def test_zustand_ueberlebt_neustart(self):
        state = self.build_state([{"id": "kontrolle", "action": "emit_event", "every_s": 1.0}])
        self.at(state, 1.2)
        self.at(state, 2.2)
        rohteil = json.loads(self.scheduler.path_for(state.job_id).read_text(encoding="utf-8"))
        geladen = ScheduleState.from_dict(rohteil)
        self.assertEqual(geladen.t0, state.t0)
        self.assertEqual(geladen.states["kontrolle"].fires, 2)
        self.assertEqual(len(geladen.history), 2)

    def test_re_attach_setzt_uhr_nicht_zurueck(self):
        """Ein Neustart darf t0 nicht verschieben und nichts doppelt feuern."""
        state = self.build_state([{"id": "schwelle", "action": "emit_event", "when": "elapsed >= 1"}])
        original_t0 = state.t0
        self.at(state, 1.5)
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo", goal="Neu gestartet",
            unlimited=True, job_id=state.job_id, tick_s=TICK,
            schedule=[{"id": "schwelle", "action": "emit_event", "when": "elapsed >= 1"}],
        )
        reattached = self.scheduler.attach(intent, t0=format_timestamp(utc_now()), force=True)
        assert reattached is not None
        self.assertEqual(reattached.t0, original_t0, "t0 muss erhalten bleiben")
        self.assertEqual(reattached.states["schwelle"].fires, 1)
        self.assertTrue(reattached.states["schwelle"].finished)
        self.assertEqual(self.at(reattached, 2.0), [], "schon gefeuert -> kein zweites Mal")

    def test_safety_net_feuert_einmal_und_markiert_mensch(self):
        state = self.build_state([{"id": "kontrolle", "action": "emit_event", "every_s": 1.0}])
        state.safety_net_s = 3.0
        self.scheduler.save(state)
        self.at(state, 3.5)  # das Intervall feuert weiter, das Netz meldet sich zusaetzlich
        report = self.scheduler.report(state.job_id)
        self.assertTrue(report["needs_human"])
        self.assertTrue(report["safety_net_fired"])
        self.assertIn("timer.safety_net", self.kinds())
        self.at(state, 4.5)
        self.assertEqual(self.kinds().count("timer.safety_net"), 1, "das Netz meldet sich genau einmal")

    def test_naechste_faelligkeit(self):
        state = self.build_state([{"id": "kontrolle", "action": "emit_event", "every_s": 2.0}])
        self.at(state, 0.5)
        next_due = self.scheduler.next_due_in_s(state)
        self.assertIsNotNone(next_due)
        self.assertLessEqual(next_due, 2.0)

    def test_uebersprungene_feuerung_wird_dokumentiert(self):
        state = self.build_state([{"id": "kontrolle", "action": "check", "every_s": 1.0,
                                   "payload": {"operation": "sys.ping", "params": {}}}])
        self.scheduler.mark_skipped(state.job_id, "kontrolle", "Kontingent belegt", elapsed_s=1.0)
        report = self.scheduler.report(state.job_id)
        self.assertEqual(report["skipped_total"], 1)
        self.assertEqual(report["triggers"][0]["skipped"], 1)
        self.assertIn("timer.skipped", self.kinds())

    def test_attach_bewahrt_uhr_des_jobs(self):
        """t0 ist die Job-Erstellung -- nicht die Schaerfung (eine Uhr pro Auftrag)."""
        record = self.jobs.create("Beobachtung", timer_mode="unlimited")
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo", goal=record.goal,
            unlimited=True, job_id=record.job_id, tick_s=TICK,
            schedule=[{"id": "log", "action": "log", "at_s": [1]}],
        )
        state = self.scheduler.attach(intent, t0=record.created_at)
        assert state is not None
        self.assertEqual(state.t0, record.created_at)

    def test_zustand_trigger_serialisierung(self):
        state = TriggerState(trigger_id="x", action=ACTION_CHECK, fires=3, pending_marks=[1.0, 2.0], gate_at=1.5)
        clone = TriggerState.from_dict(state.to_dict())
        self.assertEqual(clone.to_dict(), state.to_dict())


class TestAktionen(SchedulerTestCase):
    def test_finish_job_markiert_entscheidung(self):
        state = self.build_state([{"id": "ende", "action": ACTION_FINISH, "when": "elapsed >= 2"}])
        due = self.at(state, 2.2)
        self.assertEqual([a.action for a in due], [ACTION_FINISH])
        self.assertTrue(self.scheduler.report(state.job_id)["finish_requested"])
        self.assertIn("timer.finished", self.kinds())

    def test_emit_event_nutzt_payload_kind(self):
        state = self.build_state([{"id": "schwelle", "action": "emit_event", "when": "elapsed >= 1",
                                   "payload": {"kind": "timer.threshold", "message": "Marke"}}])
        self.at(state, 1.2)
        self.assertIn("timer.threshold", self.kinds())

    def test_jedes_event_traegt_die_uhr(self):
        state = self.build_state([{"id": "marke", "action": "log", "at_s": [1]}])
        self.at(state, 1.2)
        clocks = [record.get("clock_s") for record in self.collector.records]
        self.assertTrue(all(isinstance(value, float) for value in clocks), clocks)
        self.assertGreaterEqual(max(value for value in clocks if value is not None), 1.0)

    def test_beschreibung_ist_lesbar(self):
        text = describe_schedule([
            {"id": "kontrolle", "action": "check", "every_s": 10, "payload": {"operation": "sys.ping"}},
            {"id": "ende", "action": "finish_job", "when": "elapsed >= 60"},
        ])
        self.assertIn("kontrolle", text)
        self.assertIn("alle 10", text)
        self.assertIn("finish_job", text)
        self.assertEqual(describe_schedule(None), "keine zeitgesteuerten Ausloeser")


class TestTriggerParsingCli(unittest.TestCase):
    """Die CLI uebersetzt nur -- die Regeln bleiben im Protokoll."""

    def test_schluesselwert_form(self):
        trigger = _parse_trigger_spec('id=kontrolle;action=check;every=10;op=sys.ping;params={"message":"Status?"}')
        self.assertEqual(trigger["id"], "kontrolle")
        self.assertEqual(trigger["every_s"], 10.0)
        self.assertEqual(trigger["payload"], {"operation": "sys.ping", "params": {"message": "Status?"}})

    def test_json_wird_nicht_zerschnitten(self):
        trigger = _parse_trigger_spec('id=schwelle;action=emit_event;when=elapsed >= 30;kind=timer.threshold')
        self.assertEqual(trigger["when"], "elapsed >= 30")
        self.assertEqual(trigger["payload"]["kind"], "timer.threshold")

    def test_markenliste(self):
        trigger = _parse_trigger_spec("id=marken;action=log;at=1,5,10;message=Zwischenstand")
        self.assertEqual(trigger["at_s"], [1.0, 5.0, 10.0])
        self.assertEqual(trigger["payload"]["message"], "Zwischenstand")

    def test_json_form(self):
        trigger = _parse_trigger_spec('{"id": "roh", "action": "escalate", "when": "elapsed > 60"}')
        self.assertEqual(trigger, {"id": "roh", "action": "escalate", "when": "elapsed > 60"})

    def test_datei_form(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trigger.json"
            path.write_text(json.dumps({"id": "datei", "action": "log", "at_s": [2]}), encoding="utf-8")
            self.assertEqual(_parse_trigger_spec(f"@{path}"), {"id": "datei", "action": "log", "at_s": [2]})

    def test_unbekannter_schluessel(self):
        with self.assertRaises(ValueError) as ctx:
            _parse_trigger_spec("id=x;quatsch=1")
        self.assertIn("unbekannter Trigger-Schluessel", str(ctx.exception))

    def test_semikola_innerhalb_json_bleiben(self):
        parts = _split_trigger_spec('id=a;params={"text":"x;y"};action=log;at=1')
        self.assertEqual(parts, ['id=a', 'params={"text":"x;y"}', "action=log", "at=1"])

    def test_cli_trigger_werden_zu_protokoll_triggern(self):
        config = NeuConfig.load(REPO_ROOT)
        kernel = Kernel(config, Operations.load(config.protocol_dir / "operations.json"))
        intent = kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo", goal="CLI",
            unlimited=True,
            schedule=[_parse_trigger_spec("id=kontrolle;action=check;every=5;op=sys.ping")],
        )
        self.assertEqual(intent.schedule.triggers[0].action, ACTION_CHECK)
        self.assertEqual(intent.schedule.triggers[0].payload["operation"], "sys.ping")


class TestCliZeitplanKommandos(SchedulerTestCase):
    """schedule show/list/clear und watch --job (nur Scheduler, echte Kontrollen)."""

    def _cli(self, argv: list[str]) -> tuple[int, str]:
        """CLI im selben Prozess, aber gegen das isolierte runtime/ dieser Klasse."""
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = cli_main([
                "--repo-root", str(REPO_ROOT),
                "--runtime-dir", str(self.config.runtime_dir),
                "--json",
                *argv,
            ])
        return code, buffer.getvalue()

    def test_schedule_show_list_clear(self):
        state = self.build_state([{"id": "marke", "action": "log", "at_s": [1, 2]}])
        self.at(state, 1.2)

        code, raw = self._cli(["schedule", "list"])
        self.assertEqual(code, 0)
        self.assertIn(state.job_id, raw)

        code, raw = self._cli(["schedule", "show", state.job_id])
        self.assertEqual(code, 0)
        report = json.loads(raw)
        self.assertTrue(report["scheduled"])
        self.assertEqual(report["timer_mode"], "unlimited")
        self.assertEqual(report["fires_total"], 1)
        self.assertIsNotNone(report["t0"])

        code, raw = self._cli(["schedule", "clear", state.job_id])
        self.assertEqual(code, 0)
        self.assertIsNone(self.scheduler.load(state.job_id))

    def test_watch_nur_scheduler_fuehrt_kontrollen_aus(self):
        """watch --job tickt einen bestehenden Zeitplan und startet echte Kontroll-Jobs."""
        state = self.build_state([
            {"id": "kontrolle", "action": "check", "every_s": TICK * 2,
             "payload": {"operation": "sys.ping", "params": {}}},
            {"id": "ende", "action": ACTION_FINISH, "when": f"elapsed >= {TICK * 5}"},
        ])
        # Der Zeitplan liegt auf Platte; watch --job muss ihn ohne Limb-Start abarbeiten.
        code, raw = self._cli([
            "watch", "--job", state.job_id, "--limb", "echo",
            "--max-ticks", "60", "--for", "20",
        ])
        self.assertEqual(code, 0, raw)
        payload = json.loads(raw)
        self.assertTrue(payload["ok"])
        self.assertGreater(payload["ticks"], 0)
        self.assertTrue(payload["report"]["finish_requested"])
        scheduled = self.jobs.list(limit=10, kind=JOB_KIND_SCHEDULED)
        self.assertTrue(scheduled, "der check-Trigger muss einen echten Kontroll-Job erzeugt haben")
        for record in scheduled:
            self.assertEqual(record.parent_job_id, state.job_id)
            self.assertEqual(record.trigger_id, "kontrolle")
        self.assertTrue(any(record.status == "resolved" for record in scheduled))


if __name__ == "__main__":
    unittest.main()
