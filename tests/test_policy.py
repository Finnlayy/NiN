"""Policy-Tests: Sandbox, Rechteanhebung, Constitution Guard, Dev-Deckel."""

from __future__ import annotations

import unittest
from pathlib import Path

from core.config import NeuConfig
from core.job import JOB_RUNNING, JobRecord
from core.kernel import Kernel
from core.policy import Policy
from core.protocol import ErrorCode, Operations, ProtocolError

from . import REPO_ROOT  # noqa: F401

CONFIG = NeuConfig.load()
OPERATIONS = Operations.load(CONFIG.protocol_dir / "operations.json")
KERNEL = Kernel(CONFIG, OPERATIONS)
POLICY = Policy(CONFIG, OPERATIONS)

ELEVATION_REASON = "Ouroboros-Test: Der Orchestrator soll durch den Limb erweitert werden."


def intent(**kwargs):
    base = {"operation": "sys.echo", "params": {"message": "x"}, "limb": "echo", "goal": "Policy-Test"}
    base.update(kwargs)
    return KERNEL.build_intent(**base)


class TestSandbox(unittest.TestCase):
    def test_pfad_innerhalb_der_sandbox_ist_erlaubt(self):
        target = POLICY.resolve_path("demo/hallo.txt", intent())
        self.assertTrue(str(target).startswith(str(CONFIG.workspace_dir.resolve())))

    def test_punkt_punkt_fliegt_raus(self):
        with self.assertRaises(ProtocolError) as ctx:
            POLICY.resolve_path("../core/policy.py", intent())
        self.assertEqual(ctx.exception.code, ErrorCode.SANDBOX_ESCAPE)

    def test_absoluter_pfad_fliegt_raus(self):
        with self.assertRaises(ProtocolError) as ctx:
            POLICY.resolve_path("/etc/passwd", intent())
        self.assertEqual(ctx.exception.code, ErrorCode.SANDBOX_ESCAPE)

    def test_nullbyte_fliegt_raus(self):
        with self.assertRaises(ProtocolError):
            POLICY.resolve_path("demo/x\x00.txt", intent())


def elevated(path: str, approved_by: str = "core", **kwargs):
    """Schreib-Auftrag mit Rechteanhebung und deklariertem Zielpfad."""
    return intent(
        operation="fs.write_file",
        params={"path": path, "content": "x", "mode": "overwrite"},
        limb="bootstrap",
        elevation={
            "level": "repo_write",
            "reason": ELEVATION_REASON,
            "approved_by": approved_by,
            "requested_paths": (path,),
        },
        constraints={"sandbox_root": "."},
        **kwargs,
    )


class TestElevation(unittest.TestCase):
    def _elevated(self, path: str, approved_by: str = "core", **kwargs):
        return elevated(path, approved_by, **kwargs)

    def test_systemdatei_mit_core_freigabe_ist_erlaubt(self):
        target = POLICY.resolve_path("orchestrator/events.py", self._elevated("orchestrator/events.py"))
        self.assertEqual(target, (CONFIG.repo_root / "orchestrator" / "events.py").resolve())

    def test_constitution_guard_verlangt_menschen(self):
        with self.assertRaises(ProtocolError) as ctx:
            POLICY.resolve_path("neu.config.json", self._elevated("neu.config.json", approved_by="core"))
        self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED)
        self.assertIn("Constitution Guard", ctx.exception.message)

    def test_constitution_guard_mit_human_freigabe(self):
        target = POLICY.resolve_path("neu.config.json", self._elevated("neu.config.json", approved_by="human"))
        self.assertEqual(target.name, "neu.config.json")

    def test_git_ist_immer_tabu(self):
        with self.assertRaises(ProtocolError) as ctx:
            POLICY.resolve_path(".git/config", self._elevated(".git/config", approved_by="human"))
        self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED)

    def test_nicht_deklarierter_pfad_wird_abgelehnt(self):
        with self.assertRaises(ProtocolError) as ctx:
            POLICY.resolve_path("orchestrator/runner.py", self._elevated("orchestrator/events.py"))
        self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED)

    def test_kurze_begruendung_reicht_nicht(self):
        with self.assertRaises(ProtocolError):
            intent(
                operation="fs.write_file",
                params={"path": "orchestrator/events.py", "content": "x"},
                limb="bootstrap",
                elevation={"level": "repo_write", "reason": "zu kurz", "approved_by": "core"},
            )


class TestPhase3Grenze(unittest.TestCase):
    """Voraussetzungen des Ouroboros-Tests (docs/ARCHITECTURE.md, Abschnitt 6).

    Phase 3 verlangt eine genaue Arbeitsteilung: Der Limb **patcht** den
    Event-Bus (``orchestrator/events.py``), aber er **schreibt niemals** das
    Log selbst. ``denied_globs`` wird vor ``allowed_repo_globs`` und vor
    ``human_only_globs`` geprueft und kennt keine Ausnahme -- deshalb ist das
    Log fuer Arme unerreichbar, auch mit menschlicher Freigabe im Intent.
    """

    def test_patch_ziel_ist_erlaubt_und_der_anker_steht_noch_da(self):
        target = POLICY.resolve_path("orchestrator/events.py", elevated("orchestrator/events.py"))
        self.assertEqual(target, (CONFIG.repo_root / "orchestrator" / "events.py").resolve())
        self.assertIn(
            "NEU-PHASE-3-ANCHOR",
            target.read_text(encoding="utf-8"),
            "die Andockstelle fuer den File-Sink darf nicht still verschwinden",
        )

    def test_log_ist_fuer_limbs_unerreichbar_auch_mit_mensch(self):
        for approved_by in ("core", "human"):
            with self.assertRaises(ProtocolError) as ctx:
                elevated("runtime/system.log", approved_by=approved_by)
            self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED)
            self.assertIn("denied_globs", ctx.exception.message)

    def test_laufzeitzustand_ist_unerreichbar(self):
        """Jobs, Zeitplaene und Locks sind Buchhaltung des Kerns, nicht Limb-Material."""
        for path in ("runtime/jobs/job_x.json", "runtime/schedules/job_x.json", "runtime/locks/agent-1.lock"):
            with self.assertRaises(ProtocolError) as ctx:
                elevated(path)
            self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED, path)

    def test_ci_tor_ist_fuer_das_system_unerreichbar(self):
        """Das System darf sein eigenes Qualitaetstor nicht lockern koennen.

        Beide Orte der CI-Definition sind gesperrt, jeweils aus anderem Grund:
        ``.github/*`` steht in ``denied_globs`` (schlaegt sogar
        ``approved_by="human"``), ``ci/*`` ist schlicht nicht durch
        ``allowed_repo_globs`` freigegeben.
        """
        for path in (".github/workflows/ci-evals.yml", ".github/workflows/neu.yml", "ci/neu.yml", "Makefile"):
            with self.assertRaises(ProtocolError) as ctx:
                elevated(path, approved_by="human")
            self.assertEqual(ctx.exception.code, ErrorCode.POLICY_DENIED, path)

    def test_doku_und_tests_darf_der_kern_selbst_aendern(self):
        for path in ("docs/ARCHITECTURE.md", "tests/test_policy.py"):
            target = POLICY.resolve_path(path, elevated(path))
            self.assertEqual(target, (CONFIG.repo_root / path).resolve())


class TestSkalierungsdeckel(unittest.TestCase):
    def test_dev_profil_verbietet_zweite_iteration(self):
        dev = NeuConfig.load(mode="dev", limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1})
        policy = Policy(dev, OPERATIONS)
        data = intent(max_iterations=1).to_dict()
        data["job"] = {**data["job"], "max_iterations": 2, "iteration": 2}
        # Direkt gebaut, um die Deckelung der Kernel zu umgehen (Simuliert Fremd-Intent)
        from core.protocol import Intent

        forged = Intent.from_dict(data, operations=OPERATIONS)
        decision = policy.check(forged)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, ErrorCode.POLICY_DENIED)

    def test_check_runtime_ignoriert_budgetfragen(self):
        """Der Limb prueft nur Sandbox/Rechte -- sonst entsteht Konfigurations-Drift."""
        dev = NeuConfig.load(mode="dev", limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1})
        policy = Policy(dev, OPERATIONS)
        scale_kernel = Kernel(NeuConfig.load(mode="scale"), OPERATIONS)
        forged = scale_kernel.build_intent(operation="sys.echo", params={"message": "x"}, max_iterations=2, iteration=2)
        self.assertFalse(policy.check(forged).allowed)
        self.assertTrue(policy.check_runtime(forged).allowed)

    def test_max_limbs_pro_job(self):
        job = JobRecord(
            job_id="job_20260903T000000Z_abc123",
            goal="Test",
            status=JOB_RUNNING,
            iteration=1,
            max_iterations=2,
            limbs_used=("echo",),
        )
        data = intent(limb="echo").to_dict()
        data["target"]["limb"] = "bootstrap"
        data["task"]["operation"] = "fs.read_file"
        data["task"]["params"] = {"path": "demo.txt"}
        from core.protocol import Intent

        forged = Intent.from_dict(data, operations=OPERATIONS)
        decision = POLICY.check(forged, job=job)
        self.assertFalse(decision.allowed)
        self.assertIn("max_limbs", decision.reason)

    def test_shell_ist_in_phase_1_blockiert(self):
        data = intent().to_dict()
        data["task"]["operation"] = "shell.exec"
        data["task"]["params"] = {"argv": ["ls"]}
        data["constraints"]["allow_shell"] = True
        from core.protocol import Intent

        forged = Intent.from_dict(data)  # ohne Register: Operation ist strukturell gueltig
        decision = POLICY.check(forged)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, ErrorCode.SHELL_BLOCKED)


class TestOperationsRegister(unittest.TestCase):
    def test_alle_register_operationen_sind_bekannt(self):
        raw = Path(CONFIG.protocol_dir / "operations.json")
        import json

        for name in json.loads(raw.read_text())["operations"]:
            self.assertTrue(OPERATIONS.known(name), name)

    def test_echo_limb_deckt_sys_operationen_ab(self):
        for name in ("sys.echo", "sys.ping", "sys.noop", "sys.simulate"):
            self.assertIn("echo", OPERATIONS.spec(name).implemented_by)

    def test_fs_operationen_zeigen_auf_phase_2(self):
        for name in ("fs.read_file", "fs.write_file", "fs.patch"):
            spec = OPERATIONS.spec(name)
            self.assertEqual(spec.phase, 2, name)
            self.assertEqual(spec.implemented_by, ("bootstrap",), name)


if __name__ == "__main__":
    unittest.main()
