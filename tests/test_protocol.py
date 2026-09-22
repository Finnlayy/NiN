"""Protokoll-Tests (v1.1): Envelopes, Timer, Job, Statusbericht, strikte Validierung."""

from __future__ import annotations

import copy
import json
import unittest
from datetime import timedelta

from core.config import ABSOLUTE_MAX_ITERATIONS, NeuConfig
from core.kernel import Kernel, arm_timer
from core.protocol import (
    PROTOCOL_MAJOR,
    PROTOCOL_MINOR,
    PROTOCOL_VERSION,
    ErrorCode,
    Intent,
    Operations,
    ProtocolError,
    Result,
    Timer,
    parse_timestamp,
    utc_now,
)

from . import REPO_ROOT  # noqa: F401  (stellt sys.path sicher)

CONFIG = NeuConfig.load()
OPERATIONS = Operations.load(CONFIG.protocol_dir / "operations.json")


def sample_intent_dict(**overrides) -> dict:
    kernel = Kernel(CONFIG, OPERATIONS)
    intent = kernel.build_intent(
        operation="sys.echo",
        params={"message": "hallo"},
        limb="echo",
        goal="Protokolltest",
        title="Echo",
        acceptance=("Result enthaelt die Nachricht.",),
        deadline_s=5.0,
        soft_deadline_s=2.0,
    )
    data = intent.to_dict()
    data.update(overrides)
    return data


class TestEnvelope(unittest.TestCase):
    def test_roundtrip_ist_identisch(self):
        data = sample_intent_dict()
        first = Intent.from_dict(copy.deepcopy(data), operations=OPERATIONS)
        second = Intent.from_dict(json.loads(first.to_json()), operations=OPERATIONS)
        self.assertEqual(first.to_dict(), second.to_dict())

    def test_version_und_protokollname(self):
        data = sample_intent_dict()
        self.assertEqual(data["protocol"], "neu/intent")
        self.assertEqual(data["version"], PROTOCOL_VERSION)
        # Protokoll 1.2: unlimited-Timer + zeitgesteuerte Trigger.
        self.assertEqual(PROTOCOL_VERSION, "1.2")
        self.assertEqual((PROTOCOL_MAJOR, PROTOCOL_MINOR), (1, 2))

    def test_version_1_1_wird_gelesen_und_auf_1_2_gehoben(self):
        """Abwaertskompatibilitaet: 1.1-Umschlaege bleiben lesbar.

        Beim Serialisieren schreibt der Parser die eigene Version (1.2) -- ein
        Upgrade beim Lesen, kein Bruch: 1.2 ist zu 1.1 datengleich, die neuen
        Felder (``timer.mode``, ``schedule``) haben Defaults.
        """
        data = sample_intent_dict()
        data["version"] = "1.1"
        data["timer"].pop("mode", None)
        data.pop("schedule", None)
        intent = Intent.from_dict(data, operations=OPERATIONS)
        self.assertEqual(intent.to_dict()["version"], PROTOCOL_VERSION)
        # Alte Auftraege bleiben Deadline-Auftraege -- kein stiller Moduswechsel.
        self.assertEqual(intent.timer.mode, "deadline")
        self.assertEqual(intent.schedule.triggers, ())

    def test_version_ausserhalb_1_x_wird_abgelehnt(self):
        data = sample_intent_dict()
        data["version"] = "2.0"
        with self.assertRaises(ProtocolError) as ctx:
            Intent.from_dict(data, operations=OPERATIONS)
        self.assertEqual(ctx.exception.code, ErrorCode.SCHEMA_INVALID)

    def test_unbekannte_schluessel_werden_abgelehnt(self):
        data = sample_intent_dict()
        data["retry_policy"] = {"max_attempts": 3}  # in 1.1 entfernt
        with self.assertRaises(ProtocolError) as ctx:
            Intent.from_dict(data, operations=OPERATIONS)
        self.assertEqual(ctx.exception.code, ErrorCode.SCHEMA_INVALID)
        self.assertIn("retry_policy", str(ctx.exception))

    def test_unbekannte_operation_wird_abgelehnt(self):
        data = sample_intent_dict()
        data["task"]["operation"] = "sys.gibt_es_nicht"
        with self.assertRaises(ProtocolError) as ctx:
            Intent.from_dict(data, operations=OPERATIONS)
        self.assertEqual(ctx.exception.code, ErrorCode.UNSUPPORTED_OP)

    def test_inkompatible_protokollversion(self):
        data = sample_intent_dict(version="2.0")
        with self.assertRaises(ProtocolError):
            Intent.from_dict(data, operations=OPERATIONS)

    def test_job_fehlt(self):
        data = sample_intent_dict()
        del data["job"]
        with self.assertRaises(ProtocolError) as ctx:
            Intent.from_dict(data, operations=OPERATIONS)
        self.assertIn("job", ctx.exception.path)


class TestJobSemantik(unittest.TestCase):
    def test_iterationen_zaehlen_pro_job_und_sind_gedeckelt(self):
        kernel = Kernel(CONFIG, OPERATIONS)
        intent = kernel.build_intent(
            operation="sys.echo",
            params={"message": "x"},
            job_id="job_20260903T000000Z_abcdef",
            goal="Budget",
            iteration=1,
            max_iterations=99,  # bewusst zu gross
        )
        self.assertLessEqual(intent.job.max_iterations, ABSOLUTE_MAX_ITERATIONS)
        self.assertEqual(intent.job_id, "job_20260903T000000Z_abcdef")

    def test_iteration_groesser_als_budget_ist_fehler(self):
        data = sample_intent_dict()
        data["job"] = {**data["job"], "iteration": 2, "max_iterations": 1}
        with self.assertRaises(ProtocolError) as ctx:
            Intent.from_dict(data, operations=OPERATIONS)
        self.assertIn("max_iterations", ctx.exception.message)

    def test_dev_profil_deckelt_auf_eine_iteration(self):
        dev = NeuConfig.load(mode="dev", limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1})
        self.assertEqual(dev.limits.max_iterations, 1)
        kernel = Kernel(dev, OPERATIONS)
        intent = kernel.build_intent(operation="sys.echo", params={"message": "x"}, max_iterations=2)
        self.assertEqual(intent.job.max_iterations, 1)

    def test_absolutes_maximum_ist_zwei(self):
        self.assertEqual(ABSOLUTE_MAX_ITERATIONS, 2)


class TestTimerSemantik(unittest.TestCase):
    def test_timer_ist_vor_anbeginn_nicht_geschaerft(self):
        data = sample_intent_dict()
        self.assertIsNone(data["timer"]["armed_at"])
        self.assertIsNone(data["timer"]["expires_at"])

    def test_armieren_setzt_absolute_deadline_vor_dem_start(self):
        intent = Intent.from_dict(sample_intent_dict(), operations=OPERATIONS)
        before = utc_now()
        armed = arm_timer(intent, config=CONFIG)
        self.assertTrue(armed.timer.armed)
        self.assertIsNotNone(armed.timer.armed_at)
        expires = parse_timestamp(armed.timer.expires_at, "$")
        soft = parse_timestamp(armed.timer.soft_expires_at, "$")
        self.assertGreaterEqual(expires, before + timedelta(seconds=armed.timer.deadline_s - 1))
        self.assertLess(soft, expires)
        # Der urspruengliche Intent bleibt unberuehrt (Unveraenderlichkeit)
        self.assertFalse(intent.timer.armed)

    def test_soft_deadline_muss_vor_harter_deadline_liegen(self):
        with self.assertRaises(ProtocolError):
            Timer.from_dict({"deadline_s": 5.0, "soft_deadline_s": 9.0})

    def test_hard_timeout_ist_deadline_plus_grace(self):
        timer = Timer(deadline_s=10.0, soft_deadline_s=5.0, grace_s=3.0)
        self.assertEqual(timer.hard_timeout_s(), 13.0)

    def test_oversize_deadline_wird_abgelehnt(self):
        with self.assertRaises(ProtocolError):
            Timer.from_dict({"deadline_s": 10_000.0})


class TestResultSemantik(unittest.TestCase):
    def _result(self, **overrides) -> dict:
        base = {
            "protocol": "neu/result",
            "version": PROTOCOL_VERSION,
            "result_id": "res_20260903T000000Z_abc123",
            "intent_id": "int_20260903T000000Z_abc123",
            "trace_id": "job_20260903T000000Z_abc123",
            "job_id": "job_20260903T000000Z_abc123",
            "iteration": 1,
            "status": "success",
            "operation": "sys.echo",
            "limb": {"name": "echo", "version": "1.0.0", "pid": 1},
            "started_at": "2026-09-03T00:00:00.000Z",
            "finished_at": "2026-09-03T00:00:01.000Z",
            "duration_ms": 1000,
            "output": {"echo": "hallo"},
            "artifacts": [],
            "timer": {"self_reported": True, "reported_at": "2026-09-03T00:00:01.000Z"},
        }
        base.update(overrides)
        return base

    def test_timeout_ohne_statusbericht_wird_abgelehnt(self):
        with self.assertRaises(ProtocolError) as ctx:
            Result.from_dict(self._result(status="timeout"))
        self.assertEqual(ctx.exception.code, ErrorCode.SCHEMA_INVALID)
        self.assertIn("status_report", ctx.exception.message)

    def test_timeout_verlangt_passenden_report_state(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(
                self._result(status="timeout", status_report={"state": "completed", "explanation": "fertig"})
            )

    def test_timeout_mit_klartextbericht_geht_durch(self):
        result = Result.from_dict(
            self._result(
                status="timeout",
                status_report={
                    "state": "timeout",
                    "explanation": "Budget war vor Abschluss des Schreibvorgangs erschoepft.",
                    "done": ["Datei geoeffnet"],
                    "remaining": ["Inhalt schreiben", "Hash melden"],
                    "blockers": [{"code": ErrorCode.TIMEOUT, "message": "deadline_s ueberschritten"}],
                    "suggested_next": "Zweiter Durchgang mit halbiertem Inhalt.",
                },
                error={"code": ErrorCode.TIMEOUT, "message": "Timer abgelaufen"},
            )
        )
        self.assertEqual(result.status, "timeout")
        self.assertTrue(result.needs_iteration)
        self.assertEqual(result.status_report.remaining[0], "Inhalt schreiben")

    def test_failed_verlangt_error(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(status="failed"))

    def test_success_verbietet_error(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(status="success", error={"code": ErrorCode.IO, "message": "x"}))

    def test_partial_verlangt_statusbericht(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(status="partial"))

    def test_fremde_intent_id_wird_abgelehnt(self):
        intent = Intent.from_dict(sample_intent_dict(), operations=OPERATIONS)
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(), intent=intent)

    def test_finished_vor_started_ist_unlogisch(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(finished_at="2026-09-02T00:00:00.000Z"))

    def test_unbekannter_fehlercode(self):
        with self.assertRaises(ProtocolError):
            Result.from_dict(self._result(status="failed", error={"code": "E_GIBT_ES_NICHT", "message": "x"}))


if __name__ == "__main__":
    unittest.main()
