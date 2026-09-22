"""Phase 2: Bootstrap-Limb -- echte Dateioperationen, echte Subprozesse.

Die Tests schreiben in eine eigene Sandbox unter ``workspace/_neu_p2_*``
(gitignore: ``workspace/*``) und raeumen sie wieder ab. Der Milestone
("Der Kern laesst eine Datei anlegen") laeuft ueber den Orchestrator mit
echtem Limb-Prozess.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from core.config import NeuConfig
from core.job import JOB_RESOLVED
from core.kernel import Kernel, arm_timer
from core.protocol import PROTOCOL_VERSION, ErrorCode, Operations, sha256_text
from limbs.bootstrap_limb import BootstrapLimb
from orchestrator.runner import Orchestrator

from . import REPO_ROOT

LIMB_SCRIPT = REPO_ROOT / "limbs" / "bootstrap_limb.py"


class BootstrapTestCase(unittest.TestCase):
    def setUp(self) -> None:
        token = uuid.uuid4().hex[:12]
        self.sandbox_rel = f"workspace/_neu_p2_{token}"
        self.sandbox = REPO_ROOT / self.sandbox_rel
        self.sandbox.mkdir(parents=True, exist_ok=True)
        # runtime muss im Repo liegen: backup_path im Result ist ein Relativpfad.
        self.runtime = REPO_ROOT / "runtime" / f"_neu_p2_{token}"
        self.config = NeuConfig.load(REPO_ROOT, runtime_dir=self.runtime)
        self.config.ensure_dirs()
        self.operations = Operations.load(self.config.protocol_dir / "operations.json")
        self.kernel = Kernel(self.config, self.operations)
        self.limb = BootstrapLimb(config=self.config, operations=self.operations)

    def tearDown(self) -> None:
        shutil.rmtree(self.sandbox, ignore_errors=True)
        shutil.rmtree(self.runtime, ignore_errors=True)

    def run_op(self, operation: str, params: dict, **kwargs):
        constraints = {"sandbox_root": self.sandbox_rel, "backup": True}
        constraints.update(kwargs.pop("constraints", {}))
        base = {
            "operation": operation,
            "params": params,
            "limb": "bootstrap",
            "goal": "Phase-2-Test",
            "constraints": constraints,
            "deadline_s": kwargs.pop("deadline_s", 30.0),
            "soft_deadline_s": kwargs.pop("soft_deadline_s", 20.0),
        }
        base.update(kwargs)
        intent = arm_timer(self.kernel.build_intent(**base), config=self.config)
        return intent, self.limb.execute(intent)

    def disk(self, name: str) -> Path:
        return self.sandbox / name


class TestLesenUndListen(BootstrapTestCase):
    def test_read_file_liefert_inhalt_und_hash(self):
        self.disk("hallo.txt").write_text("Hallo Kern", encoding="utf-8")
        intent, result = self.run_op("fs.read_file", {"path": "hallo.txt"})
        self.assertEqual(result.status, "success")
        self.assertEqual(result.output["content"], "Hallo Kern")
        self.assertEqual(result.output["sha256"], sha256_text("Hallo Kern"))
        self.assertEqual(result.artifacts[0].action, "read")
        self.assertEqual(result.artifacts[0].sha256, sha256_text("Hallo Kern"))
        verdict = self.kernel.evaluate(intent, result)
        self.assertTrue(verdict.accepted)

    def test_read_file_fehlt(self):
        _, result = self.run_op("fs.read_file", {"path": "gibt_es_nicht.txt"})
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error_code, ErrorCode.PATH_NOT_FOUND)

    def test_read_file_respektiert_max_bytes(self):
        self.disk("lang.txt").write_text("abcdefghij", encoding="utf-8")
        _, result = self.run_op("fs.read_file", {"path": "lang.txt", "max_bytes": 4})
        self.assertEqual(result.status, "success")
        self.assertEqual(result.output["content"], "abcd")
        self.assertTrue(result.output["truncated"])

    def test_list_und_mkdir(self):
        _, mkdir_result = self.run_op("fs.mkdir", {"path": "demo"})
        self.assertEqual(mkdir_result.status, "success")
        self.assertEqual(mkdir_result.output["action"], "created")
        self.assertTrue(self.disk("demo").is_dir())
        self.disk("demo/a.txt").write_text("a", encoding="utf-8")
        _, listed = self.run_op("fs.list", {"path": "demo"})
        self.assertEqual(listed.status, "success")
        names = {Path(entry["path"]).name for entry in listed.output["entries"]}
        self.assertIn("a.txt", names)
        _, again = self.run_op("fs.mkdir", {"path": "demo"})
        self.assertEqual(again.output["action"], "unchanged")


class TestSchreiben(BootstrapTestCase):
    def test_create_legt_datei_mit_hash_an(self):
        intent, result = self.run_op("fs.write_file", {"path": "neu.txt", "content": "Phase 2", "mode": "create"})
        self.assertEqual(result.status, "success")
        self.assertEqual(self.disk("neu.txt").read_text(encoding="utf-8"), "Phase 2")
        self.assertEqual(result.artifacts[0].action, "created")
        self.assertEqual(result.artifacts[0].sha256, sha256_text("Phase 2"))
        self.assertEqual(result.output["sha256"], sha256_text("Phase 2"))
        verdict = self.kernel.evaluate(intent, result)
        self.assertTrue(verdict.accepted, verdict.reasons)

    def test_create_auf_existierende_datei_scheitert(self):
        self.disk("da.txt").write_text("alt", encoding="utf-8")
        _, result = self.run_op("fs.write_file", {"path": "da.txt", "content": "neu", "mode": "create"})
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error_code, ErrorCode.ALREADY_EXISTS)
        self.assertEqual(self.disk("da.txt").read_text(encoding="utf-8"), "alt")

    def test_overwrite_mit_backup_und_expect_sha256(self):
        self.disk("ziel.txt").write_text("alt", encoding="utf-8")
        _, result = self.run_op(
            "fs.write_file",
            {"path": "ziel.txt", "content": "neu", "mode": "overwrite", "expect_sha256": sha256_text("alt")},
        )
        self.assertEqual(result.status, "success")
        self.assertEqual(self.disk("ziel.txt").read_text(encoding="utf-8"), "neu")
        self.assertTrue(result.output["backup_path"])
        backup = REPO_ROOT / result.output["backup_path"]
        self.assertTrue(backup.is_file(), result.output["backup_path"])
        self.assertEqual(backup.read_text(encoding="utf-8"), "alt")
        self.assertEqual(result.artifacts[0].action, "modified")

    def test_expect_sha256_drift_schreibt_nicht(self):
        self.disk("drift.txt").write_text("ist", encoding="utf-8")
        _, result = self.run_op(
            "fs.write_file",
            {"path": "drift.txt", "content": "soll", "mode": "overwrite", "expect_sha256": sha256_text("anders")},
        )
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error_code, ErrorCode.IO)
        self.assertEqual(self.disk("drift.txt").read_text(encoding="utf-8"), "ist")

    def test_append(self):
        self.disk("log.txt").write_text("a", encoding="utf-8")
        _, result = self.run_op("fs.write_file", {"path": "log.txt", "content": "b", "mode": "append"})
        self.assertEqual(result.status, "success")
        self.assertEqual(self.disk("log.txt").read_text(encoding="utf-8"), "ab")

    def test_dry_run_schreibt_nicht(self):
        _, result = self.run_op(
            "fs.write_file",
            {"path": "ghost.txt", "content": "nein", "mode": "create"},
            constraints={"sandbox_root": self.sandbox_rel, "backup": True, "dry_run": True},
        )
        self.assertEqual(result.status, "success")
        self.assertTrue(result.output["dry_run"])
        self.assertFalse(self.disk("ghost.txt").exists())
        self.assertEqual(result.artifacts[0].action, "unchanged")


class TestPatch(BootstrapTestCase):
    def test_patch_all_or_nothing(self):
        self.disk("code.py").write_text("alpha\nbeta\n", encoding="utf-8")
        _, ok = self.run_op(
            "fs.patch",
            {"path": "code.py", "patches": [{"find": "alpha", "replace": "ALPHA"}, {"find": "beta", "replace": "BETA"}]},
        )
        self.assertEqual(ok.status, "success")
        self.assertEqual(self.disk("code.py").read_text(encoding="utf-8"), "ALPHA\nBETA\n")

        self.disk("code.py").write_text("alpha\nbeta\n", encoding="utf-8")
        _, bad = self.run_op(
            "fs.patch",
            {"path": "code.py", "patches": [{"find": "alpha", "replace": "ALPHA"}, {"find": "fehlt", "replace": "X"}]},
        )
        self.assertEqual(bad.status, "failed")
        self.assertEqual(bad.error_code, ErrorCode.PATCH_NO_MATCH)
        self.assertEqual(self.disk("code.py").read_text(encoding="utf-8"), "alpha\nbeta\n", "all-or-nothing: Datei bleibt")

    def test_patch_count(self):
        self.disk("rep.txt").write_text("x x x", encoding="utf-8")
        _, result = self.run_op("fs.patch", {"path": "rep.txt", "patches": [{"find": "x", "replace": "y", "count": 2}]})
        self.assertEqual(result.status, "success")
        self.assertEqual(self.disk("rep.txt").read_text(encoding="utf-8"), "y y x")


class TestSandboxUndUhr(BootstrapTestCase):
    def test_punkt_punkt_wird_abgelehnt(self):
        with self.assertRaises(Exception) as ctx:
            self.kernel.build_intent(
                operation="fs.read_file",
                params={"path": "../core/policy.py"},
                limb="bootstrap",
                goal="Escape",
                constraints={"sandbox_root": self.sandbox_rel},
                deadline_s=15.0,
            )
        self.assertEqual(ctx.exception.code, ErrorCode.SANDBOX_ESCAPE)

    def test_unlimited_erfindet_kein_budget(self):
        self.disk("u.txt").write_text("ok", encoding="utf-8")
        intent, result = self.run_op("fs.read_file", {"path": "u.txt"}, unlimited=True)
        del intent
        self.assertEqual(result.status, "success")
        self.assertEqual(result.timer.mode, "unlimited")
        self.assertIsNone(result.timer.remaining_ms)
        self.assertGreaterEqual(result.timer.elapsed_s, 0.0)

    def test_keine_halben_dateien_nach_write(self):
        _, result = self.run_op("fs.write_file", {"path": "atom.txt", "content": "vollstaendig\n", "mode": "create"})
        self.assertEqual(result.status, "success")
        leftovers = list(self.sandbox.glob("*.neu-tmp")) + list(self.sandbox.glob(".*neu-tmp"))
        self.assertEqual(leftovers, [])
        self.assertEqual(self.disk("atom.txt").read_text(encoding="utf-8"), "vollstaendig\n")


class TestAufrufvertrag(BootstrapTestCase):
    def test_skript_liefert_genau_ein_result(self):
        intent, _ = self.run_op("fs.mkdir", {"path": "via-script"})
        # frischer Intent fuer write, als Datei an den Skript-Weg
        intent = arm_timer(
            self.kernel.build_intent(
                operation="fs.write_file",
                params={"path": "via-script/hi.txt", "content": "skript", "mode": "create"},
                limb="bootstrap",
                goal="Skriptweg",
                constraints={"sandbox_root": self.sandbox_rel, "backup": True},
                deadline_s=30.0,
            ),
            config=self.config,
        )
        with tempfile.TemporaryDirectory(prefix="neu-p2-intent-") as tmp:
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(intent.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            completed = subprocess.run(
                [sys.executable, str(LIMB_SCRIPT), "--intent", str(intent_path)],
                capture_output=True,
                text=True,
                timeout=90,
                cwd=REPO_ROOT,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1200:])
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["protocol"], "neu/result")
        self.assertEqual(payload["version"], PROTOCOL_VERSION)
        self.assertEqual(payload["status"], "success")
        self.assertEqual(self.disk("via-script/hi.txt").read_text(encoding="utf-8"), "skript")
        self.assertEqual(payload["artifacts"][0]["sha256"], sha256_text("skript"))


class TestMeilensteinOrchestrator(BootstrapTestCase):
    def test_kern_legt_datei_ueber_den_limb_an(self):
        """Meilenstein Phase 2: echter Orchestrator, echter Limb, Hash auf Platte."""
        orch = Orchestrator(self.config, quiet=True)
        outcome = orch.run_job(
            goal="Der Kern laesst eine Datei anlegen",
            operation="fs.write_file",
            params={"path": "milestone.txt", "content": "Ouroboros folgt", "mode": "create"},
            limb="bootstrap",
            constraints={"sandbox_root": self.sandbox_rel, "backup": True},
            deadline_s=15.0,
            soft_deadline_s=10.0,
        )
        self.assertEqual(outcome.status, JOB_RESOLVED, outcome.summary())
        self.assertTrue(outcome.ok)
        attempt = outcome.attempts[0]
        self.assertEqual(attempt.result.status, "success")
        self.assertTrue(attempt.verdict.accepted, attempt.verdict.reasons)
        on_disk = self.disk("milestone.txt")
        self.assertTrue(on_disk.is_file())
        self.assertEqual(on_disk.read_text(encoding="utf-8"), "Ouroboros folgt")
        artifact = attempt.result.artifacts[0]
        self.assertEqual(artifact.action, "created")
        self.assertEqual(artifact.sha256, sha256_text("Ouroboros folgt"))
        self.assertEqual(artifact.sha256, sha256_text(on_disk.read_text(encoding="utf-8")))

    def test_check_trigger_laeuft_auf_eigener_spur(self):
        """Kontroll-Job (echo/ping) waehrend eines Bootstrap-Auftrags, ohne dessen Budget."""
        self.disk("beobachten.txt").write_text("stand", encoding="utf-8")
        orch = Orchestrator(self.config, quiet=True)
        outcome = orch.run_job(
            goal="Schreiben beobachten",
            operation="fs.write_file",
            params={"path": "beobachten.txt", "content": "aktualisiert", "mode": "overwrite"},
            limb="bootstrap",
            constraints={"sandbox_root": self.sandbox_rel, "backup": True},
            unlimited=True,
            tick_s=0.2,
            schedule=[
                {
                    "id": "kontrolle",
                    "action": "check",
                    "every_s": 0.2,
                    "max_fires": 1,
                    "payload": {"operation": "sys.ping", "limb": "echo"},
                },
                {"id": "ende", "action": "finish_job", "when": "elapsed >= 0.6"},
            ],
        )
        # Der Write ist schnell: entweder resolved durch Erfolg oder durch finish_job.
        self.assertIn(outcome.status, {JOB_RESOLVED, "resolved"})
        self.assertEqual(self.disk("beobachten.txt").read_text(encoding="utf-8"), "aktualisiert")
        leftovers = list(self.sandbox.glob("*.neu-tmp"))
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
