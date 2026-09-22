"""Unlimited-Modus Ende-zu-Ende: echte Subprozesse, echte Uhr, echte Kontrollen.

Diese Suite beweist die Kernforderung von Protokoll 1.2 am laufenden System:

* Ohne ``t_limit`` wird die Zeit **getrackt** statt begrenzt, und ``t_unlimited``
  steht in Intent, Result, Events, Job-Ledger und Zeitplan-Zustand -- ueberall
  dieselbe Zahl (eine Uhr pro Auftrag).
* Zeitgesteuerte Ausloeser feuern, **waehrend** der Limb laeuft (das geht nur im
  ueberwachten Pfad; ``subprocess.run`` wuerde blockieren).
* ``check``-Trigger erzeugen eigene Kontroll-Jobs mit eigenem Kontingent und
  verbrauchen kein Iterations-Budget des beobachteten Auftrags.
* Das Safety-Netz ist Prozess-Hygiene: Es eskaliert (``E_SAFETY_NET``) statt zu
  iterieren.
* Nichts bleibt liegen: Slots frei, Trigger-Zustand entfernt, keine Waisen.

Laufzeit bewusst kurz (Safety-Netz 0.6-1.2 s, finish_job bei ~1 s).
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from core.job import FAILURE_ESCALATION, JOB_ESCALATED, JOB_KIND_SCHEDULED, JOB_RESOLVED
from core.protocol import ErrorCode
from orchestrator.events import CollectingSink, build_event_bus
from orchestrator.runner import Orchestrator, SpawnHandle

from . import REPO_ROOT  # noqa: F401
from .test_orchestrator import OrchestratorTestCase


class UnlimitedTestCase(OrchestratorTestCase):
    """Wie die Basis-Klasse, aber mit Event-Sammler fuer Zeit-Nachweise."""

    def setUp(self) -> None:
        super().setUp()
        self.collector = CollectingSink()
        bus = build_event_bus(quiet=True, collector=self.collector)
        self.orch = Orchestrator(self.config, bus=bus, quiet=True)
        self.kernel = self.orch.kernel

    def kinds(self) -> list[str]:
        return [str(record.get("kind")) for record in self.collector.records]

    def records(self, kind: str) -> list[dict]:
        return [record for record in self.collector.records if record.get("kind") == kind]


class TestUnlimitedGrundlagen(UnlimitedTestCase):
    def test_zeit_wird_getrackt_statt_begrenzt(self):
        outcome = self.run_job(
            goal="Zeit aufzeichnen, nicht begrenzen",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 1.2},
            unlimited=True,
            tick_s=0.1,
        )
        self.assertEqual(outcome.status, JOB_RESOLVED, outcome.summary()["outcome"])
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.intent.timer.mode, "unlimited")
        self.assertIsNone(attempt.intent.timer.deadline_s)
        self.assertIsNone(attempt.intent.timer.expires_at, "unlimited hat keine Ablauf-Frist")
        self.assertEqual(attempt.result.timer.mode, "unlimited")
        self.assertIsNone(attempt.result.timer.remaining_ms, "kein Budget -> keine Restzeit (null, nicht 0)")
        self.assertGreaterEqual(attempt.result.timer.elapsed_s, 1.0, "t_unlimited muss die echte Laufzeit zeigen")

    def test_eine_uhr_pro_auftrag(self):
        """Job-Ledger, Intent, Result und Zeitplan muessen dieselbe Uhr zeigen."""
        outcome = self.run_job(
            goal="Eine Uhr",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 0.6},
            unlimited=True,
            tick_s=0.1,
            schedule=[{"id": "marke", "action": "log", "at_s": [0.3]}],
        )
        attempt = outcome.attempts[0]
        job = outcome.job
        self.assertEqual(job.timer_mode, "unlimited", "das Ledger darf nicht auf deadline zurueckfallen")
        self.assertIsNone(job.deadline_s)
        self.assertEqual(attempt.intent.timer.t0, job.created_at, "t0 des Intents ist die Job-Erstellung")
        self.assertAlmostEqual(attempt.result.timer.elapsed_s, outcome.summary()["t_unlimited_s"], delta=0.35)
        armed = [record for record in self.records("timer.armed") if record.get("job_id") == job.job_id]
        self.assertTrue(armed)
        self.assertEqual(armed[0]["payload"]["mode"], "unlimited")

    def test_events_tragen_die_uhr(self):
        outcome = self.run_job(
            goal="Events mit Uhr",
            operation="sys.echo",
            params={"message": "x"},
            unlimited=True,
            tick_s=0.1,
            schedule=[{"id": "marke", "action": "log", "at_s": [0.05]}],
        )
        job_id = outcome.job.job_id
        relevant = [r for r in self.collector.records if r.get("job_id") == job_id and r.get("kind") != "job.created"]
        self.assertTrue(relevant)
        missing = [r["kind"] for r in relevant if r.get("clock_s") is None]
        self.assertEqual(missing, [], f"diese Events tragen keine Uhr: {missing}")

    def test_intent_aus_datei_behaelt_unlimited(self):
        """Auch der Weg ueber eine Intent-Datei darf den Modus nicht verlieren."""
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "datei"}, limb="echo",
            goal="Datei-Weg", unlimited=True, safety_net_s=30.0,
        )
        path = Path(self.config.inbox_dir) / "echo" / "unlimited_probe.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(intent.to_json(), encoding="utf-8")
        attempt = self.orch.dispatch_file(path)
        self.assertEqual(attempt.intent.timer.mode, "unlimited")
        record = self.orch.jobs.get(intent.job.job_id)
        self.assertIsNotNone(record)
        self.assertEqual(record.timer_mode, "unlimited", "Befund #8: Ledger und Intent muessen einig sein")


class TestZeitgesteuerteAusloeser(UnlimitedTestCase):
    def test_kontrollen_feuern_waehrend_der_limb_laeuft(self):
        outcome = self.run_job(
            goal="Alle 0.4s kontrollieren, bei 1.0s planmaessig beenden",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            limb="echo",
            unlimited=True,
            tick_s=0.1,
            schedule=[
                {"id": "kontrolle", "action": "check", "every_s": 0.4,
                 "payload": {"operation": "sys.ping", "params": {}, "title": "Kontrolle"}},
                {"id": "ende", "action": "finish_job", "when": "elapsed >= 1.0"},
            ],
        )
        self.assertEqual(outcome.status, JOB_RESOLVED)
        summary = outcome.summary()
        self.assertEqual(summary["outcome"]["decided_by"], "schedule")
        self.assertEqual(summary["outcome"]["trigger_decision"], "finish_job")
        self.assertLess(summary["t_unlimited_s"], 5.0, "finish_job muss den Limb stoppen, nicht auslaufen lassen")
        self.assertTrue(outcome.attempts[0].verdict.accepted, "planmaessiger Stopp ist kein Korrekturbedarf")

        scheduled = self.orch.jobs.list(limit=20, kind=JOB_KIND_SCHEDULED)
        self.assertGreaterEqual(len(scheduled), 2, "das Intervall muss mehrfach kontrolliert haben")
        for record in scheduled:
            self.assertEqual(record.parent_job_id, outcome.job.job_id)
            self.assertEqual(record.trigger_id, "kontrolle")
            self.assertEqual(record.max_iterations, 1, "eine Kontrolle ist eine Stichprobe, kein Projekt")
        self.assertTrue(any(record.status == JOB_RESOLVED for record in scheduled))

    def test_kontrollen_verbrauchen_kein_eltern_budget(self):
        outcome = self.run_job(
            goal="Budget-Trennung beweisen",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            unlimited=True,
            tick_s=0.1,
            schedule=[
                {"id": "kontrolle", "action": "check", "every_s": 0.3,
                 "payload": {"operation": "sys.ping", "params": {}}},
                {"id": "ende", "action": "finish_job", "when": "elapsed >= 0.9"},
            ],
        )
        self.assertEqual(outcome.iterations, 1, "der beobachtete Auftrag hat genau einen Durchgang")
        self.assertEqual(outcome.job.iteration, 1)
        self.assertGreaterEqual(len(self.orch.jobs.list(limit=20, kind=JOB_KIND_SCHEDULED)), 2)

    def test_escalate_trigger_verlangt_menschen(self):
        outcome = self.run_job(
            goal="Eskalation ueber die Uhr",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            unlimited=True,
            tick_s=0.1,
            schedule=[{"id": "notfall", "action": "escalate", "when": "elapsed >= 0.6",
                       "payload": {"reason": "Laufzeit ueber Schwelle"}}],
        )
        self.assertEqual(outcome.status, JOB_ESCALATED)
        self.assertEqual(outcome.failure_kind, FAILURE_ESCALATION)
        self.assertEqual(outcome.summary()["outcome"]["trigger_decision"], "escalate")
        self.assertFalse(outcome.job.really_failed, "Eskalation ist kein Scheitern ohne Massnahme")

    def test_kontingent_blockiert_keine_beobachtung(self):
        """Dev-Profil: ein Kontroll-Slot pro Tick. Ueberzaehlige Feuerungen werden dokumentiert.

        Beide Ausloeser werden im selben Tick faellig -- der zweite findet das
        Kontingent belegt und wird als ``timer.skipped`` sichtbar, statt still
        wegzufallen oder den beobachteten Auftrag zu blockieren.
        """
        outcome = self.run_job(
            goal="Kontingent-Grenzfall",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            unlimited=True,
            tick_s=0.1,
            schedule=[
                {"id": "erste", "action": "check", "every_s": 0.2,
                 "payload": {"operation": "sys.ping", "params": {}}},
                {"id": "zweite", "action": "check", "every_s": 0.2,
                 "payload": {"operation": "sys.ping", "params": {}}},
                {"id": "ende", "action": "finish_job", "when": "elapsed >= 0.6"},
            ],
        )
        self.assertIn(outcome.status, {JOB_RESOLVED, JOB_ESCALATED})
        skipped = self.records("timer.skipped")
        self.assertTrue(skipped, "eine ueberzaehlige Feuerung muss als timer.skipped sichtbar sein")
        self.assertIn("max_scheduled_jobs", skipped[0]["payload"]["reason"])
        self.assertEqual(self.orch.scheduler.load(outcome.job.job_id), None, "Zustand muss aufgeraeumt sein")
        self.assertEqual(self.orch.jobs.active_count(kind=JOB_KIND_SCHEDULED), 0)

    def test_zeitplan_wird_nach_abschluss_entfernt(self):
        outcome = self.run_job(
            goal="Aufraeumen",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            unlimited=True,
            tick_s=0.1,
            schedule=[{"id": "ende", "action": "finish_job", "when": "elapsed >= 0.5"}],
        )
        self.assertEqual(outcome.status, JOB_RESOLVED)
        self.assertIsNone(self.orch.scheduler.load(outcome.job.job_id))
        self.assertIn("schedule.detached", self.kinds())
        self.assertEqual(self.orch.agents.busy(), [], "alle Slots muessen frei sein")
        self.assertEqual(self.orch.jobs.active_count(), 0)
        self.assertEqual(self.orch.jobs.active_count(kind=JOB_KIND_SCHEDULED), 0)


class TestSafetyNetz(UnlimitedTestCase):
    def test_safety_net_eskaliert_statt_zu_iterieren(self):
        outcome = self.run_job(
            goal="Safety-Netz muss greifen",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 20},
            unlimited=True,
            safety_net_s=1.0,   # Protokoll-Minimum: 1 s
            tick_s=0.1,
            max_iterations=2,
        )
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.error_code, ErrorCode.SAFETY_NET)
        self.assertEqual(attempt.result.status, "failed")
        self.assertIsNotNone(attempt.result.status_report)
        self.assertIn("Safety-Netz", attempt.result.status_report.explanation)
        self.assertEqual(attempt.verdict.next_action, "escalate_to_human")
        self.assertEqual(outcome.iterations, 1, "kein 2. Durchgang: Er wuerde dieselbe Uhr erneut ueberlaufen")
        self.assertEqual(outcome.status, JOB_ESCALATED)
        self.assertEqual(self.orch.agents.busy(), [])

    def test_orchestrator_synthetisiert_safety_net_bericht(self):
        """Auch wenn der Limb selbst nichts mehr meldet, entsteht ein vollwertiger Bericht."""
        intent = self.kernel.build_intent(
            operation="sys.simulate", params={"mode": "timeout", "seconds": 30}, limb="echo",
            goal="Synthese", unlimited=True, safety_net_s=1.0,
        )
        record = self.orch.jobs.create(intent.job.goal, timer_mode="unlimited", job_id=intent.job.job_id)
        handle = self.orch.spawn_async(intent, job=record)
        self.assertIsInstance(handle, SpawnHandle)
        result = self.orch._safety_net_result(
            handle.intent, handle.started_at, stdout="", stderr="", exit_code=-9, hard_kill=True
        )
        self.orch._terminate_child(handle, reason="test")
        self.orch._release_slot(handle.prepared)
        self.assertEqual(result.error_code, ErrorCode.SAFETY_NET)
        self.assertEqual(result.status, "failed")
        self.assertFalse(result.timer.self_reported, "vom Orchestrator synthetisiert")
        self.assertEqual(result.timer.mode, "unlimited")
        self.assertIsNone(result.timer.remaining_ms)
        self.assertIsNotNone(result.status_report)
        self.assertEqual(result.status_report.state, "blocked")
        self.assertEqual(self.orch.agents.busy(), [])

    def test_deadline_modus_bleibt_unberuehrt(self):
        """Regression: Der klassische Pfad behaelt Timeout-Semantik und Budget."""
        outcome = self.run_job(
            goal="Deadline bleibt Deadline",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 5},
            deadline_s=1.0,
            soft_deadline_s=0.5,
            grace_s=0.5,
            max_iterations=1,
        )
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.intent.timer.mode, "deadline")
        self.assertIsNotNone(attempt.intent.timer.expires_at)
        self.assertEqual(attempt.result.timer.mode, "deadline")
        self.assertIsNotNone(attempt.result.timer.remaining_ms)
        self.assertIn(attempt.result.status, {"timeout", "failed"})
        self.assertNotEqual(attempt.result.error_code, ErrorCode.SAFETY_NET)


class TestPolicyFailFast(UnlimitedTestCase):
    """Trigger werden vor dem Start geprueft -- nicht irgendwann zur Laufzeit."""

    def _intent(self, triggers: list[dict]):
        return self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo",
            goal="Policy", unlimited=True, schedule=triggers,
        )

    def test_unbekannte_kontroll_operation(self):
        with self.assertRaises(Exception) as ctx:
            self._intent([{"id": "x", "action": "check", "every_s": 5,
                           "payload": {"operation": "sys.gibt_es_nicht", "params": {}}}])
        self.assertEqual(getattr(ctx.exception, "code", ""), ErrorCode.TRIGGER_INVALID)

    def test_shell_im_trigger_ist_gesperrt(self):
        with self.assertRaises(Exception) as ctx:
            self._intent([{"id": "shell", "action": "check", "every_s": 5,
                           "payload": {"operation": "shell.exec", "params": {"command": "ls"}}}])
        self.assertEqual(getattr(ctx.exception, "code", ""), ErrorCode.TRIGGER_INVALID)
        self.assertIn("shell.exec", str(ctx.exception))

    def test_pfad_escape_im_trigger(self):
        with self.assertRaises(Exception) as ctx:
            self._intent([{"id": "pfad", "action": "check", "every_s": 5,
                           "payload": {"operation": "fs.read_file", "params": {"path": "../../etc/passwd"},
                                       "limb": "bootstrap"}}])
        self.assertEqual(getattr(ctx.exception, "code", ""), ErrorCode.TRIGGER_INVALID)

    def test_intervall_unter_tick_rate_warnt_nur(self):
        # every_s=0.05 bei Standard-Tick 0.5s: feuert spaetestens pro Tick -> Warnung
        intent = self._intent([{"id": "flott", "action": "check", "every_s": 0.05,
                                "payload": {"operation": "sys.ping", "params": {}}}])
        decision = self.orch.policy.check(intent)
        self.assertTrue(decision.allowed)
        self.assertTrue(any("Tick-Rate" in warning for warning in decision.warnings), decision.warnings)

    def test_zu_viele_kontroll_trigger_warnen(self):
        intent = self._intent([
            {"id": "eins", "action": "check", "every_s": 5, "payload": {"operation": "sys.ping", "params": {}}},
            {"id": "zwei", "action": "check", "every_s": 5, "payload": {"operation": "sys.ping", "params": {}}},
        ])
        decision = self.orch.policy.check(intent)
        self.assertTrue(decision.allowed)
        self.assertTrue(any("max_scheduled_jobs" in warning for warning in decision.warnings), decision.warnings)


class TestSchedulerAllein(UnlimitedTestCase):
    """Der Scheduler ist auch ohne laufenden Limb nutzbar (Neustart-Fall)."""

    def test_neustart_setzt_uhr_fort(self):
        record = self.orch.jobs.create("Beobachtung nach Neustart", timer_mode="unlimited")
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo",
            goal=record.goal, job_id=record.job_id, unlimited=True, tick_s=0.1,
            schedule=[{"id": "marke", "action": "log", "at_s": [1]}],
        )
        state = self.orch.scheduler.attach(intent, t0=record.created_at)
        self.assertIsNotNone(state)
        self.assertEqual(state.t0, record.created_at)

        # "Neustart": neuer Orchestrator, derselbe Zustand auf Platte
        neu = Orchestrator(self.config, quiet=True)
        geladen = neu.scheduler.load(record.job_id)
        self.assertIsNotNone(geladen)
        self.assertEqual(geladen.t0, record.created_at)
        self.assertGreaterEqual(geladen.elapsed_s(), 0.0)

    def test_scheduler_bericht_ist_json_faehig(self):
        record = self.orch.jobs.create("Bericht", timer_mode="unlimited")
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo",
            goal=record.goal, job_id=record.job_id, unlimited=True, tick_s=0.1,
            schedule=[{"id": "marke", "action": "log", "at_s": [1]}],
        )
        self.orch.scheduler.attach(intent, t0=record.created_at)
        report = self.orch.scheduler.report(record.job_id)
        text = json.dumps(report, ensure_ascii=False)
        self.assertIn("t_unlimited_s", text)
        self.assertIn("next_due_in_s", text)
        self.assertEqual(report["job_id"], record.job_id)


if __name__ == "__main__":
    unittest.main()
