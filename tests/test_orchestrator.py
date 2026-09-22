"""Orchestrator-End-to-End-Tests (Phase 1).

Alle Tests starten **echte** Limb-Subprozesse mit **echten** Timern unter einem
isolierten ``runtime/``-Verzeichnis (Temp-Dir). Nichts wird gemockt.

Laufzeit bewusst kurz gehalten: Deadline 2s, Soft-Deadline 0.6s.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

from core.config import NeuConfig
from core.job import FAILURE_BUDGET_EXHAUSTED, FAILURE_ESCALATION, JOB_ESCALATED, JOB_FAILED, JOB_RESOLVED, JobStore
from core.kernel import arm_timer
from core.protocol import ErrorCode, Intent, format_timestamp, utc_now
from orchestrator.events import CollectingSink, build_event_bus
from orchestrator.locks import AgentPool, NoSlotAvailable
from orchestrator.runner import Orchestrator

from . import REPO_ROOT

DEV_LIMITS = {"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1}
SCALE_LIMITS = {"max_iterations": 2, "max_agents": 2, "max_limbs": 2, "max_concurrent_jobs": 2}


class OrchestratorTestCase(unittest.TestCase):
    """Gemeinsames Setup: echtes Repo, isoliertes runtime/."""

    mode = "dev"
    limits = DEV_LIMITS

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-test-")
        tmp = Path(self._tmp.name)
        self.config = NeuConfig.load(
            REPO_ROOT,
            mode=self.mode,
            limits=dict(self.limits),
            runtime_dir=tmp / "runtime",
            workspace_dir=tmp / "workspace",
        )
        self.config.ensure_dirs()
        self.orch = Orchestrator(self.config, quiet=True)
        self.kernel = self.orch.kernel

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # ------------------------------------------------------------- Helfer
    def run_job(self, **kwargs):
        base = {"goal": "Test-Job", "operation": "sys.echo", "params": {"message": "ping"}, "limb": "echo"}
        base.update(kwargs)
        return self.orch.run_job(**base)

    def archived_intent(self, attempt) -> dict:
        path = Path(attempt.archive_dir) / "intent.json"
        return json.loads(path.read_text(encoding="utf-8"))


class TestHappyPath(OrchestratorTestCase):
    def test_echo_job_wird_aufgeloest(self):
        outcome = self.run_job(goal="Roundtrip beweisen", params={"message": "Hallo Kern"})
        self.assertEqual(outcome.status, JOB_RESOLVED)
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.iterations, 1)
        self.assertEqual(outcome.attempts[0].result.status, "success")
        self.assertEqual(outcome.attempts[0].result.output["echo"], "Hallo Kern")
        self.assertTrue(outcome.attempts[0].verdict.accepted)
        self.assertFalse(outcome.job.really_failed)

    def test_timer_wird_vor_anbeginn_geschaerft(self):
        outcome = self.run_job(deadline_s=5.0, soft_deadline_s=2.0)
        archived = self.archived_intent(outcome.attempts[0])
        timer = archived["timer"]
        self.assertIsNotNone(timer["armed_at"], "Timer muss vor dem Start geschaerft sein")
        self.assertIsNotNone(timer["soft_expires_at"])
        self.assertIsNotNone(timer["expires_at"])
        self.assertLess(timer["soft_expires_at"], timer["expires_at"])
        self.assertGreaterEqual(timer["armed_at"], archived["created_at"])

    def test_limb_liefert_timernachweis(self):
        outcome = self.run_job(deadline_s=5.0, soft_deadline_s=2.0)
        report = outcome.attempts[0].result.timer
        self.assertTrue(report.self_reported)
        self.assertGreater(report.remaining_ms, 0)
        self.assertEqual(report.overrun_ms, 0)

    def test_intent_liegt_vor_dem_start_in_der_inbox(self):
        """Datei-Transport: Der Limb wird ueber eine Inbox-Datei gesteuert."""
        intent = self.kernel.build_intent(operation="sys.echo", params={"message": "x"}, limb="echo", goal="Inbox")
        inbox_file = self.orch.transport.submit(intent)
        self.assertTrue(inbox_file.is_file())
        payload = json.loads(inbox_file.read_text(encoding="utf-8"))
        self.assertEqual(payload["task"]["operation"], "sys.echo")
        self.assertEqual(payload["target"]["limb"], "echo")

    def test_events_werden_emittiert(self):
        from orchestrator.events import CollectingSink

        collector = CollectingSink()
        orch = Orchestrator(self.config, quiet=True, collector=collector)
        orch.run_job(goal="Events", operation="sys.echo", params={"message": "x"}, limb="echo")
        kinds = collector.kinds()
        for expected in ("job.created", "timer.armed", "agent.lock.acquired", "limb.spawned", "result.recorded", "result.verdict", "job.finished"):
            self.assertIn(expected, kinds)

    def test_agent_slot_wird_freigegeben(self):
        self.run_job()
        self.assertEqual(self.orch.agents.busy(), [])


class TestTimerAblauf(OrchestratorTestCase):
    """Kernanforderung: Timer-Ablauf -> klarer Statusbericht."""

    def test_limb_meldet_sich_selbst_bei_soft_deadline(self):
        outcome = self.run_job(
            goal="Langlauf",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 1.5, "message": "externe Ressource"},
            deadline_s=2.0,
            soft_deadline_s=0.6,
            grace_s=0.5,
        )
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.status, "timeout")
        self.assertTrue(attempt.result.timer.self_reported, "Der Limb muss sich selbst melden, nicht erst der Kill")
        self.assertTrue(attempt.verdict.timer_expired)
        report = attempt.result.status_report
        self.assertIsNotNone(report)
        self.assertEqual(report.state, "timeout")
        self.assertTrue(report.explanation.strip(), "Statusbericht braucht eine Erklaerung")
        self.assertTrue(report.remaining, "Statusbericht muss den offenen Umfang nennen")
        self.assertTrue(report.done, "Statusbericht muss den erreichten Stand nennen")
        self.assertEqual(report.blockers[0]["code"], ErrorCode.TIMEOUT)
        self.assertTrue(report.suggested_next)
        # Der Durchgang endet deutlich vor der harten Deadline (Soft-Report)
        self.assertLess(attempt.result.duration_ms, 2000)

    def test_dev_modus_endet_am_budget_ist_aber_nicht_hilflos(self):
        outcome = self.run_job(
            goal="Langlauf",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 1.5},
            deadline_s=2.0,
            soft_deadline_s=0.6,
            grace_s=0.5,
        )
        self.assertEqual(outcome.status, JOB_FAILED)
        self.assertEqual(outcome.failure_kind, FAILURE_BUDGET_EXHAUSTED)
        self.assertFalse(outcome.job.really_failed, "Massnahme war bekannt -> nicht 'wirklich failed'")
        self.assertIn("identified_measure", outcome.job.outcome)
        self.assertTrue(outcome.job.outcome["measure_available"])
        self.assertFalse(outcome.job.outcome["budget_available"])
        self.assertEqual(outcome.iterations, 1, "Dev-Profil: genau ein Durchgang")

    def test_harter_kill_wird_vom_orchestrator_berichtet(self):
        """Wenn der Limb stumm bleibt, synthetisiert der Orchestrator den Bericht."""
        result = self.orch._timeout_result(
            self.kernel.build_intent(operation="sys.simulate", params={"mode": "timeout"}, limb="echo", goal="Kill", deadline_s=1.0),
            "2026-09-03T00:00:00.000Z",
            stdout="",
            stderr="",
            hard_kill=True,
        )
        self.assertEqual(result.status, "timeout")
        self.assertFalse(result.timer.self_reported)
        self.assertEqual(result.error_code, ErrorCode.TIMEOUT)
        self.assertEqual(result.status_report.state, "timeout")
        self.assertTrue(result.status_report.explanation)


    def test_stummer_limb_ueber_deadline_bekommt_synthese_und_event(self):
        """Regression: Dieser Zweig brach mit ``NameError`` ab.

        Ueberzieht ein Limb die harte Deadline und schreibt nichts Parsbares auf
        stdout, musste der Orchestrator ``timer.expired`` melden und den Bericht
        synthetisieren. Der Event-Zweig griff dabei auf ein ``spec`` zu, das es
        in ``_parse_child_output`` nie gab -- der Timeout-Pfad (der wichtigste
        Fehlerpfad ueberhaupt) warf also statt zu berichten.
        """
        collector = CollectingSink()
        orch = Orchestrator(self.config, bus=build_event_bus(quiet=True, collector=collector), quiet=True)

        intent = self.kernel.build_intent(
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 30},
            limb="echo",
            goal="Stummer Langlaeufer",
            deadline_s=1.0,
            grace_s=0.0,
        )
        armed = arm_timer(intent, config=self.config)
        # Uhr in die Vergangenheit drehen: harte Deadline ist ueberschritten.
        past = utc_now() - timedelta(seconds=20)
        overdue = replace(
            armed,
            timer=replace(
                armed.timer,
                armed_at=format_timestamp(past),
                expires_at=format_timestamp(past + timedelta(seconds=1)),
            ),
        )

        result, spawned, code = orch._parse_child_output(
            overdue,
            stdout="",
            stderr="nur Geraeusche, kein JSON",
            returncode=-9,
            started_at=format_timestamp(past),
        )
        self.assertTrue(spawned)
        self.assertEqual(code, -9)
        self.assertEqual(result.status, "timeout")
        self.assertEqual(result.error_code, ErrorCode.TIMEOUT)
        self.assertFalse(result.timer.self_reported, "Der Limb hat nichts gemeldet -- die Synthese ist ehrlich")
        self.assertEqual(result.status_report.state, "timeout")
        expired = [record for record in collector.records if record.get("kind") == "timer.expired"]
        self.assertEqual(len(expired), 1, "timer.expired muss genau einmal geschrieben werden")
        self.assertEqual(expired[0]["payload"]["hard_kill"], False)
        self.assertGreater(expired[0]["payload"]["overrun_ms"], 0)


class TestAutodidaktik(OrchestratorTestCase):
    mode = "scale"
    limits = SCALE_LIMITS

    def test_zweiter_durchgang_loest_den_job_auf(self):
        outcome = self.run_job(
            goal="Simulation im Budget abschliessen",
            operation="sys.simulate",
            params={"mode": "timeout", "seconds": 1.5},
            max_iterations=2,
            deadline_s=2.0,
            soft_deadline_s=0.6,
            grace_s=0.5,
        )
        self.assertEqual(outcome.status, JOB_RESOLVED)
        self.assertEqual(outcome.iterations, 2)
        self.assertEqual(outcome.job.measures_taken, 1)
        first, second = outcome.attempts
        self.assertEqual(first.result.status, "timeout")
        self.assertEqual(second.result.status, "success")
        # Der zweite Durchgang ist ein neuer Auftrag derselben Spur
        self.assertEqual(second.intent.job_id, first.intent.job_id)
        self.assertEqual(second.intent.iteration, 2)
        self.assertEqual(second.intent.parent_intent_id, first.intent.intent_id)
        self.assertEqual(second.intent.trace_id, first.intent.trace_id)
        self.assertNotEqual(second.intent.intent_id, first.intent.intent_id)
        # Der Orchestrator hat Umfang UND Timer nachgeschaerft
        self.assertLess(second.intent.task.params["seconds"], first.intent.task.params["seconds"])
        self.assertGreater(second.intent.timer.deadline_s, first.intent.timer.deadline_s)
        self.assertTrue(second.intent.context_extra["autodidactic"])
        self.assertIn("FEHLSCHLAGS-BRIEFING", second.intent.context_summary)

    def test_ohne_autodidaktik_wird_eskaliert(self):
        outcome = self.run_job(
            goal="Kein Automatik-Wunsch",
            operation="sys.simulate",
            params={"mode": "fail", "code": ErrorCode.IO, "message": "Platte voll"},
            max_iterations=2,
            auto_iterate=False,
        )
        self.assertEqual(outcome.status, JOB_ESCALATED)
        self.assertEqual(outcome.iterations, 1)
        self.assertEqual(outcome.job.measures_taken, 0)

    def test_falscher_limb_wird_nicht_blind_gestartet(self):
        """echo implementiert fs.write_file nicht -- Policy lehnt ab, Planner zeigt auf bootstrap."""
        base = self.kernel.build_intent(operation="sys.echo", params={"message": "x"}, limb="echo", goal="Falscher Limb").to_dict()
        base["task"]["operation"] = "fs.write_file"
        base["task"]["params"] = {"path": "ziel.txt", "content": "inhalt"}
        forged = Intent.from_dict(base, operations=self.orch.operations)
        attempt = self.orch.dispatch(forged)
        self.assertEqual(attempt.result.status, "rejected")
        self.assertEqual(attempt.result.error_code, ErrorCode.TARGET_NOT_FOUND)
        self.assertFalse(attempt.spawned, "Ein Limb ohne die Operation darf nicht starten")
        self.assertFalse(attempt.diagnosis.escalate, "Die Faehigkeit existiert -- beim Bootstrap-Limb")
        self.assertEqual(attempt.diagnosis.limb_override, "bootstrap")

    def test_bootstrap_limb_ist_aktiv_und_wird_gestartet(self):
        """Phase 2: Der Bootstrap-Limb ist kein geplanter Eintrag mehr."""
        spec = self.orch.registry.get("bootstrap")
        self.assertIsNotNone(spec)
        self.assertTrue(spec.usable)
        self.assertTrue(spec.entrypoint.is_file())
        outcome = self.run_job(
            goal="Bootstrap-Lebenszeichen ueber fs.list",
            operation="fs.list",
            params={},
            limb="bootstrap",
            constraints={"sandbox_root": "workspace", "backup": True},
            deadline_s=15.0,
            soft_deadline_s=10.0,
        )
        self.assertEqual(outcome.attempts[0].result.status, "success")
        self.assertTrue(outcome.attempts[0].spawned)


class TestFehlpfade(OrchestratorTestCase):
    def test_limb_crash_wird_zum_protokollkonformen_result(self):
        outcome = self.run_job(goal="Crash", operation="sys.simulate", params={"mode": "crash", "message": "provokation"})
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.status, "failed")
        self.assertEqual(attempt.result.error_code, ErrorCode.LIMB_CRASH)
        self.assertIn("KEIN JSON", attempt.result.diagnostics_stdout)

    def test_fachlicher_fehler_wird_mit_statusbericht_geliefert(self):
        outcome = self.run_job(
            goal="Fachlicher Fehler",
            operation="sys.simulate",
            params={"mode": "fail", "code": ErrorCode.IO, "message": "Platte voll", "hint": "Freiraum schaffen"},
        )
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.status, "failed")
        self.assertEqual(attempt.result.error_code, ErrorCode.IO)
        self.assertIsNotNone(attempt.result.status_report)
        self.assertEqual(attempt.result.status_report.state, "blocked")
        self.assertEqual(attempt.result.status_report.blockers[0]["code"], ErrorCode.IO)

    def test_teilerfolg_wird_als_partial_gemeldet(self):
        outcome = self.run_job(goal="Teilerfolg", operation="sys.simulate", params={"mode": "partial"})
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.status, "partial")
        self.assertEqual(attempt.result.status_report.state, "partial")
        self.assertEqual(list(attempt.result.status_report.remaining), ["Teil B"])

    def test_unbekannter_limb_wird_abgelehnt(self):
        base = self.kernel.build_intent(operation="sys.echo", params={"message": "x"}, limb="echo", goal="Unbekannt").to_dict()
        base["target"]["limb"] = "gibt_es_nicht"
        forged = Intent.from_dict(base, operations=self.orch.operations)
        attempt = self.orch.dispatch(forged)
        self.assertEqual(attempt.result.status, "rejected")
        self.assertEqual(attempt.result.error_code, ErrorCode.TARGET_NOT_FOUND)

    def_protokoll = None  # Platzhalter gegen versehentliches Ueberschreiben


class TestJobStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-jobs-")
        # scale-Profil: sonst deckelt das Dev-Profil max_iterations auf 1
        self.config = NeuConfig.load(REPO_ROOT, mode="scale", runtime_dir=Path(self._tmp.name) / "runtime")
        self.config.ensure_dirs()
        self.jobs = JobStore(self.config)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_failed_nur_ohne_massnahme(self):
        job = self.jobs.create("Testziel", max_iterations=2)
        job = self.jobs.begin_iteration(job.job_id, operation="sys.echo", limb="echo")
        status, kind = self.jobs.decide_after_failure(job.job_id, measure_available=True, iteration=1)
        self.assertNotEqual(status, JOB_FAILED)  # Massnahme + Budget -> weiter
        status, kind = self.jobs.decide_after_failure(job.job_id, measure_available=True, iteration=2)
        self.assertEqual((status, kind), (JOB_FAILED, FAILURE_BUDGET_EXHAUSTED))
        status, kind = self.jobs.decide_after_failure(job.job_id, measure_available=False, iteration=1)
        self.assertEqual((status, kind), (JOB_FAILED, "no_measure_available"))

    def test_really_failed_nur_bei_keiner_massnahme(self):
        job = self.jobs.create("Ziel A")
        job = self.jobs.finish(job.job_id, JOB_FAILED, failure_kind=FAILURE_BUDGET_EXHAUSTED)
        self.assertFalse(job.really_failed)
        other = self.jobs.create("Ziel B")
        other = self.jobs.finish(other.job_id, JOB_FAILED, failure_kind="no_measure_available")
        self.assertTrue(other.really_failed)

    def test_eskalation_ist_kein_failed(self):
        job = self.jobs.create("Ziel C")
        job = self.jobs.finish(job.job_id, JOB_ESCALATED, failure_kind=FAILURE_ESCALATION)
        self.assertEqual(job.status, JOB_ESCALATED)
        self.assertFalse(job.really_failed)

    def test_historie_wird_mitgeschrieben(self):
        job = self.jobs.create("Ziel D")
        self.jobs.begin_iteration(job.job_id, operation="sys.echo", limb="echo")
        events = [e["event"] for e in self.jobs.read_history(job.job_id)]
        self.assertIn("job.created", events)
        self.assertIn("iteration.started", events)

    def test_agent_slot_limit_im_dev_modus(self):
        dev_config = NeuConfig.load(REPO_ROOT, mode="dev", runtime_dir=Path(self._tmp.name) / "runtime-dev")
        dev_config.ensure_dirs()
        pool = AgentPool(dev_config)
        self.assertEqual(pool.capacity, 1)
        slot = pool.acquire(job_id="job_x", ttl_s=30)
        with self.assertRaises(NoSlotAvailable):
            pool.acquire(job_id="job_y", ttl_s=30)
        pool.release(slot)
        slot2 = pool.acquire(job_id="job_y", ttl_s=30)
        pool.release(slot2)

    def test_verwaiste_slots_werden_zurueckgeholt(self):
        dev_config = NeuConfig.load(REPO_ROOT, mode="dev", runtime_dir=Path(self._tmp.name) / "runtime-stale")
        dev_config.ensure_dirs()
        pool = AgentPool(dev_config)
        path = pool.lock_path(0)
        path.write_text(json.dumps({"job_id": "job_tot", "pid": 999999, "acquired_at": "2020-01-01T00:00:00.000Z", "expires_at": "2020-01-01T00:01:00.000Z"}), encoding="utf-8")
        self.assertEqual(pool.reclaim_stale(), 1)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
