"""Limb-Schicht: Vertrags- und Drift-Tests (Protokoll 1.2).

Drei Dinge kippen hier erfahrungsgemaess still -- deshalb werden sie bewacht:

1. **Ein Limb, zwei Aufrufwege.** Der Orchestrator startet Limbs als *Skripte*
   (``python3 limbs/echo_limb.py --intent ...``), Tests und Tooling importieren
   sie als *Paket*. Beides muss auf dasselbe Modul zeigen; sonst existiert
   ``LimbBase`` zweimal und ``isinstance`` bricht lautlos.
2. **Versions- und Register-Drift.** Limb und Kern muessen dieselbe
   Protokollversion melden, und ``limbs/registry.json`` muss die Operationen des
   Limbs exakt abbilden -- ein geplanter Limb darf nicht als vorhanden gelten.
3. **Unlimited am Limb selbst.** Ohne ``t_limit`` darf der Limb kein eigenes
   Aufgabenlimit erfinden: Er trackt die Zeit und wartet hoechstens auf das
   Safety-Netz (Prozess-Hygiene), nie auf eine selbst ausgedachte Deadline.
"""

from __future__ import annotations

import importlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import limbs.base as limb_base
from core.config import NeuConfig
from core.kernel import Kernel, arm_timer
from core.protocol import PROTOCOL_VERSION, ErrorCode, Intent, Operations
from limbs.bootstrap_limb import BootstrapLimb
from limbs.echo_limb import EchoLimb

from . import REPO_ROOT

REGISTRY_PATH = REPO_ROOT / "limbs" / "registry.json"
LIMB_SCRIPT = REPO_ROOT / "limbs" / "echo_limb.py"
BOOTSTRAP_SCRIPT = REPO_ROOT / "limbs" / "bootstrap_limb.py"


class LimbTestCase(unittest.TestCase):
    """Echte Konfiguration, echter Kernel -- aber kein Orchestrator-Overhead."""

    def setUp(self) -> None:
        self.config = NeuConfig.load(REPO_ROOT)
        self.operations = Operations.load(self.config.protocol_dir / "operations.json")
        self.kernel = Kernel(self.config, self.operations)
        self.limb = EchoLimb()

    def build(self, **kwargs: object) -> Intent:
        base: dict[str, object] = {
            "operation": "sys.ping",
            "params": {},
            "limb": "echo",
            "goal": "Limb-Vertrag pruefen",
            "iteration": 1,
            "max_iterations": 1,
        }
        base.update(kwargs)
        return self.kernel.build_intent(**base)  # type: ignore[arg-type]


class TestAufrufwege(LimbTestCase):
    def test_paket_und_skript_teilen_dieselbe_klasse(self):
        module = importlib.import_module("limbs.echo_limb")
        self.assertIs(
            module.LimbBase,
            limb_base.LimbBase,
            "Paket-Import darf LimbBase nicht verdoppeln (sonst bricht isinstance)",
        )
        self.assertTrue(issubclass(module.EchoLimb, limb_base.LimbBase))
        self.assertEqual(module.EchoLimb.name, "echo")

    def test_skriptaufruf_liefert_genau_ein_result_objekt(self):
        """Der Aufrufvertrag des Orchestrators: stdout = genau ein Result-JSON."""
        intent = arm_timer(self.build(operation="sys.echo", params={"message": "Hallo Limb"}), config=self.config)
        with tempfile.TemporaryDirectory(prefix="neu-limb-") as tmp:
            intent_path = Path(tmp) / "intent.json"
            intent_path.write_text(json.dumps(intent.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            completed = subprocess.run(  # fester Interpreter, fester Pfad, kein Shell-Aufruf
                [sys.executable, str(LIMB_SCRIPT), "--intent", str(intent_path)],
                capture_output=True,
                text=True,
                timeout=90,
                cwd=REPO_ROOT,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1200:])
        payload = json.loads(completed.stdout)  # scheitert, falls mehr als ein Objekt
        self.assertEqual(payload["protocol"], "neu/result")
        self.assertEqual(payload["version"], PROTOCOL_VERSION)
        self.assertEqual(payload["intent_id"], intent.intent_id)
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["output"]["echo"], "Hallo Limb")


class TestUnlimitedAmLimb(LimbTestCase):
    def test_ohne_deadline_erfindet_der_limb_kein_limit(self):
        intent = arm_timer(self.build(unlimited=True), config=self.config)
        self.assertTrue(intent.timer.unlimited)
        self.assertIsNone(intent.timer.deadline_s)
        budget = self.limb._wait_budget(intent)  # gezielter Unit-Zugriff auf die Limb-Uhr
        self.assertIsNotNone(budget, "das Safety-Netz bleibt als Prozess-Hygiene bestehen")
        self.assertGreater(
            budget,
            3000.0,
            "Ohne Aufgabenlimit darf der Limb nicht nach Sekunden aufgeben -- er wartet auf das Safety-Netz",
        )

    def test_unlimited_result_traegt_modus_und_uhr(self):
        intent = arm_timer(self.build(unlimited=True), config=self.config)
        result = self.limb.execute(intent)
        self.assertEqual(result.status, "success")
        self.assertEqual(result.timer.mode, "unlimited")
        self.assertIsNone(result.timer.remaining_ms, "kein Budget -> kein erfundener Rest")
        self.assertIsNotNone(result.timer.t0)
        self.assertGreaterEqual(result.timer.elapsed_s, 0.0)
        self.assertTrue(result.timer.self_reported)

    def test_deadline_result_meldet_restbudget(self):
        """Gegenprobe: Der klassische Modus behaelt seine Budget-Semantik."""
        intent = arm_timer(self.build(deadline_s=30.0, soft_deadline_s=20.0), config=self.config)
        self.assertFalse(intent.timer.unlimited)
        result = self.limb.execute(intent)
        self.assertEqual(result.timer.mode, "deadline")
        self.assertIsNotNone(result.timer.remaining_ms)
        self.assertGreater(result.timer.remaining_ms, 0)


class TestRegisterUndVersion(LimbTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        self.entry = self.registry["limbs"]["echo"]

    def test_protokollversion_stimmt_mit_kern_ueberein(self):
        module = importlib.import_module("limbs.echo_limb")
        self.assertEqual(module.PROTOCOL_VERSION, PROTOCOL_VERSION)
        self.assertIs(module.ErrorCode, ErrorCode, "der Limb muss dieselben Fehlercodes nutzen wie der Kern")

    def test_register_bildet_den_limb_exakt_ab(self):
        self.assertEqual(
            sorted(self.entry["operations"]),
            sorted(self.limb.handlers()),
            "Register und Implementierung duerfen nicht auseinanderlaufen",
        )
        self.assertEqual(self.entry["version"], self.limb.version)
        self.assertEqual(self.entry["status"], "active", "nur aktive Limbs darf der Orchestrator starten")
        self.assertEqual(self.entry["entrypoint"], "limbs/echo_limb.py")
        self.assertTrue(LIMB_SCRIPT.is_file(), "der registrierte Einstiegspunkt muss existieren")

    def test_jede_register_operation_ist_im_protokoll_bekannt(self):
        for name, entry in self.registry["limbs"].items():
            for operation in entry["operations"]:
                self.assertTrue(
                    self.operations.known(operation),
                    f"{name}: Operation '{operation}' fehlt in protocol/operations.json",
                )

    def test_bootstrap_register_bildet_den_limb_exakt_ab(self):
        entry = self.registry["limbs"]["bootstrap"]
        limb = BootstrapLimb()
        self.assertEqual(sorted(entry["operations"]), sorted(limb.handlers()))
        self.assertEqual(entry["version"], limb.version)
        self.assertEqual(entry["status"], "active")
        self.assertEqual(entry["entrypoint"], "limbs/bootstrap_limb.py")
        self.assertTrue(BOOTSTRAP_SCRIPT.is_file())
        module = importlib.import_module("limbs.bootstrap_limb")
        self.assertIs(module.LimbBase, limb_base.LimbBase)
        self.assertTrue(issubclass(module.BootstrapLimb, limb_base.LimbBase))


if __name__ == "__main__":
    unittest.main()
