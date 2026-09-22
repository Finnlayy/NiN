"""Planner-Tests: Diagnose -> Massnahme -> Entwurf des 2. Durchgangs."""

from __future__ import annotations

import unittest

from core.config import NeuConfig
from core.kernel import Kernel
from core.protocol import ErrorCode, Operations, ProtocolError, Result
from orchestrator.planner import IterationPlanner

from . import REPO_ROOT  # noqa: F401

CONFIG = NeuConfig.load(mode="scale", limits={"max_iterations": 2, "max_agents": 2, "max_limbs": 2, "max_concurrent_jobs": 2})
KERNEL = Kernel(CONFIG, Operations.load(CONFIG.protocol_dir / "operations.json"))
PLANNER = IterationPlanner(KERNEL, CONFIG)


def build(operation="sys.simulate", params=None, **kwargs):
    base = {
        "operation": operation,
        "params": params or {"mode": "timeout", "seconds": 4},
        "limb": "echo",
        "goal": "Planner-Test",
        "iteration": 1,
        "max_iterations": 2,
        "deadline_s": 2.0,
        "soft_deadline_s": 1.0,
    }
    base.update(kwargs)
    return KERNEL.build_intent(**base)


def forge(operation: str, params: dict, limb: str = "echo", **kwargs):
    """Baut einen Auftrag, den der Kernel ablehnen wuerde (z. B. fs.* an echo).

    Fuer Planner-Tests noetig: Der Planner muss auch Auftraege diagnostizieren
    koennen, die aus einer aelteren Spur stammen oder von Hand eingespeist wurden.
    """
    from core.protocol import Intent

    base = build(**kwargs).to_dict()
    base["task"]["operation"] = operation
    base["task"]["params"] = params
    base["target"]["limb"] = limb
    return Intent.from_dict(base, operations=KERNEL.operations)


def result_for(intent, **overrides) -> Result:
    payload = {
        "protocol": "neu/result",
        "version": "1.1",
        "result_id": "res_20260903T000000Z_abc123",
        "intent_id": intent.intent_id,
        "trace_id": intent.trace_id,
        "job_id": intent.job_id,
        "iteration": intent.iteration,
        "status": "failed",
        "operation": intent.operation,
        "limb": {"name": intent.target_limb, "version": "1.0.0", "pid": 1},
        "started_at": intent.created_at,
        "finished_at": intent.created_at,
        "duration_ms": 10,
        "output": {},
        "artifacts": [],
        "error": {"code": ErrorCode.INTERNAL, "message": "unbekannt"},
        "self_report": {"confidence": 0.2},
    }
    payload.update(overrides)
    return Result.from_dict(payload, intent=intent)


class TestDiagnose(unittest.TestCase):
    def test_timeout_verkleinert_umfang_und_gibt_mehr_zeit(self):
        intent = build(params={"mode": "timeout", "seconds": 4})
        result = result_for(
            intent,
            status="timeout",
            error={"code": ErrorCode.TIMEOUT, "message": "Budget erschoepft"},
            status_report={"state": "timeout", "explanation": "Nicht fertig geworden.", "done": ["Schritt 1"], "remaining": ["Schritt 2"]},
        )
        verdict = KERNEL.evaluate(intent, result)
        diagnosis = PLANNER.diagnose(intent, result, verdict)
        self.assertEqual(diagnosis.code, ErrorCode.TIMEOUT)
        self.assertFalse(diagnosis.escalate)
        self.assertTrue(PLANNER.measure_available(diagnosis))

        correction = PLANNER.compose(intent, result, verdict, diagnosis=diagnosis)
        self.assertEqual(correction.job_id, intent.job_id)
        self.assertEqual(correction.iteration, 2)
        self.assertEqual(correction.parent_intent_id, intent.intent_id)
        self.assertEqual(correction.trace_id, intent.trace_id)
        self.assertEqual(correction.task.params["seconds"], 2.0)  # halbiert
        self.assertGreater(correction.timer.deadline_s, intent.timer.deadline_s)  # mehr Zeit
        self.assertLess(correction.timer.soft_deadline_s, correction.timer.deadline_s)
        self.assertTrue(correction.context_extra["autodidactic"])
        self.assertTrue(correction.context_extra["forbidden_repeats"])
        self.assertIn("FEHLSCHLAGS-BRIEFING", correction.context_summary)
        self.assertIn("Durchgang 2 von 2", correction.task.objective)
        self.assertIn("Massnahme dieses Durchgangs", correction.task.objective)

    def test_patch_ohne_treffer_wird_zu_lesen_und_schreiben(self):
        intent = forge("fs.patch", {"path": "orchestrator/events.py", "patches": []})
        result = result_for(intent, error={"code": ErrorCode.PATCH_NO_MATCH, "message": "Suchtext nicht gefunden"})
        diagnosis = PLANNER.diagnose(intent, result, KERNEL.evaluate(intent, result))
        self.assertEqual(diagnosis.operation_override, "fs.read_file")
        self.assertIn("fs.read_file", diagnosis.measure)

    def test_sandbox_escape_beantragt_rechteanhebung(self):
        intent = forge("fs.write_file", {"path": "orchestrator/events.py", "content": "x"})
        result = result_for(intent, error={"code": ErrorCode.SANDBOX_ESCAPE, "message": "Ziel liegt ausserhalb der Sandbox"})
        diagnosis = PLANNER.diagnose(intent, result, KERNEL.evaluate(intent, result))
        self.assertIsNotNone(diagnosis.elevation_patch)
        self.assertEqual(diagnosis.elevation_patch["level"], "repo_write")
        self.assertEqual(diagnosis.elevation_patch["approved_by"], "core")
        self.assertGreaterEqual(len(diagnosis.elevation_patch["reason"]), 20)

    def test_profilgrenze_eskaliert_zum_menschen(self):
        intent = build()
        result = result_for(
            intent,
            status="rejected",
            error={"code": ErrorCode.POLICY_DENIED, "message": "max_iterations=2 ueberschreitet das Profil-Limit (mode=dev, max_iterations=1)."},
        )
        diagnosis = PLANNER.diagnose(intent, result, KERNEL.evaluate(intent, result))
        self.assertTrue(diagnosis.escalate)
        self.assertFalse(PLANNER.measure_available(diagnosis))
        self.assertIn("Constitution Guard", diagnosis.escalation_reason)

    def test_constitution_guard_eskaliert(self):
        intent = forge("fs.write_file", {"path": "neu.config.json", "content": "x"})
        result = result_for(
            intent,
            status="rejected",
            error={"code": ErrorCode.POLICY_DENIED, "message": "Pfad 'neu.config.json' unterliegt dem Constitution Guard"},
        )
        diagnosis = PLANNER.diagnose(intent, result, KERNEL.evaluate(intent, result))
        self.assertTrue(diagnosis.escalate)

    def test_teilerfolg_adressiert_nur_den_rest(self):
        intent = build(operation="sys.simulate", params={"mode": "partial"})
        result = result_for(
            intent,
            status="partial",
            error=None,
            status_report={"state": "partial", "explanation": "Teil A fertig.", "done": ["Teil A"], "remaining": ["Teil B"]},
        )
        diagnosis = PLANNER.diagnose(intent, result, KERNEL.evaluate(intent, result))
        self.assertEqual(diagnosis.param_patch.get("remaining_focus"), ["Teil B"])


class TestBudget(unittest.TestCase):
    def test_kein_plan_ohne_budget(self):
        intent = build(iteration=2, max_iterations=2)
        result = result_for(intent, error={"code": ErrorCode.INTERNAL, "message": "krach"})
        verdict = KERNEL.evaluate(intent, result)
        possible, reason = PLANNER.can_plan(intent, result, verdict)
        self.assertFalse(possible)
        self.assertIn("Budget", reason)
        with self.assertRaises(ProtocolError) as ctx:
            PLANNER.compose(intent, result, verdict)
        self.assertEqual(ctx.exception.code, ErrorCode.BUDGET_EXHAUSTED)

    def test_dev_profil_erlaubt_keinen_zweiten_durchgang(self):
        dev_config = NeuConfig.load(mode="dev", limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1})
        dev_kernel = Kernel(dev_config)
        dev_planner = IterationPlanner(dev_kernel, dev_config)
        intent = dev_kernel.build_intent(operation="sys.simulate", params={"mode": "fail"}, limb="echo", goal="Dev", max_iterations=1)
        result = result_for(intent, error={"code": ErrorCode.INTERNAL, "message": "krach"})
        possible, reason = dev_planner.can_plan(intent, result, KERNEL.evaluate(intent, result))
        self.assertFalse(possible)
        self.assertIn("erschoepft", reason)

    def test_akzeptiertes_ergebnis_braucht_keine_iteration(self):
        intent = build(operation="sys.echo", params={"message": "hi"})
        result = result_for(intent, status="success", error=None, output={"echo": "hi"}, self_report={"confidence": 1.0})
        possible, reason = PLANNER.can_plan(intent, result, KERNEL.evaluate(intent, result))
        self.assertFalse(possible)
        self.assertIn("akzeptiert", reason)


if __name__ == "__main__":
    unittest.main()
