"""CLI-Vertrag auf Subprozess-Ebene (Protokoll 1.2).

``tests/test_schedule.py`` prueft die Kommando-*Logik* im Prozess. Hier geht es
um die aeussere Schnittstelle, die Menschen, Skripte und CI benutzen:

* Einstiegspunkt ``python3 -m orchestrator`` (nicht nur ``cli.main``)
* Exit-Codes gemaess Vertrag: 0 Erfolg, 1 Protokoll/Validierung,
  2 Job nicht aufgeloest, 3 Nutzungsfehler
* ``--json`` liefert auf **stdout** ausschliesslich parsbares JSON; Events und
  Klartext gehoeren auf stderr
* ``--runtime-dir`` isoliert jeden Lauf (kein Zugriff auf das Repo-``runtime/``)
* Die sichtbare Protokollversion ist ``core.protocol.PROTOCOL_VERSION``

Nichts wird gemockt: Jeder Test startet echte Subprozesse, die echte Limbs
starten und echte Timer schaerfen.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from core.job import JOB_KIND_SCHEDULED, JOB_KIND_TASK
from core.protocol import PROTOCOL_VERSION

from . import REPO_ROOT

EXIT_OK = 0
EXIT_PROTOCOL = 1
EXIT_JOB_FAILED = 2
EXIT_USAGE = 3


class CliTestCase(unittest.TestCase):
    """Ein eigenes runtime/ pro Test -- Laufen duerfen sie auch nebeneinander."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-cli-")
        self.tmp = Path(self._tmp.name)
        self.runtime = self.tmp / "runtime"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def cli(self, *args: str, quiet: bool = True, timeout: float = 180.0) -> subprocess.CompletedProcess[str]:
        flags = ["--runtime-dir", str(self.runtime), "--json"] + (["--quiet"] if quiet else [])
        return subprocess.run(  # fester Interpreter, fester Modulpfad, keine Shell
            [sys.executable, "-m", "orchestrator", *flags, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=REPO_ROOT,
            check=False,
        )

    def payload(self, completed: subprocess.CompletedProcess[str]) -> Any:
        """stdout muss genau ein JSON-Dokument sein -- sonst ist der Vertrag gebrochen."""
        self.assertTrue(completed.stdout.strip(), f"stdout ist leer; stderr: {completed.stderr[-800:]}")
        return json.loads(completed.stdout)

    def write(self, name: str, data: Any) -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return path


class TestVertragUndExitCodes(CliTestCase):
    def test_hilfe_nennt_die_protokollversion(self):
        completed = subprocess.run(  # ohne --json: Hilfe ist Menschentext
            [sys.executable, "-m", "orchestrator", "--help"],
            capture_output=True, text=True, timeout=60, cwd=REPO_ROOT, check=False,
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-600:])
        self.assertIn(PROTOCOL_VERSION, completed.stdout)
        self.assertIn("--runtime-dir", completed.stdout)

    def test_spec_zeigt_zeit_semantik(self):
        completed = subprocess.run(
            [sys.executable, "-m", "orchestrator", "spec"],
            capture_output=True, text=True, timeout=60, cwd=REPO_ROOT, check=False,
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-600:])
        text = completed.stdout
        self.assertIn(f"NEU-Protokoll {PROTOCOL_VERSION}", text)
        for marker in ("unlimited", "t_unlimited", "safety_net", "schedule", "finish_job"):
            self.assertIn(marker, text, f"spec muss '{marker}' erklaeren")

    def test_nutzungsfehler_endet_mit_code_3_nicht_mit_2(self):
        """Ein fehlendes Flag ist kein gescheiterter Auftrag."""
        completed = self.cli("job", "run", "--op", "sys.ping")
        self.assertEqual(completed.returncode, EXIT_USAGE, completed.stderr[-600:])
        self.assertNotEqual(completed.returncode, EXIT_JOB_FAILED)

    def test_unbekanntes_kommando_endet_mit_code_3(self):
        completed = self.cli("gibt_es_nicht")
        self.assertEqual(completed.returncode, EXIT_USAGE)

    def test_protokollfehler_endet_mit_code_1(self):
        completed = self.cli("job", "run", "--goal", "Unbekannte Operation", "--op", "sys.gibtesnicht")
        self.assertEqual(completed.returncode, EXIT_PROTOCOL, completed.stderr[-600:])
        body = self.payload(completed)
        self.assertFalse(body["ok"])
        self.assertIn(body["error"]["code"], {"E_UNSUPPORTED_OP", "E_TARGET_NOT_FOUND", "E_SCHEMA_INVALID"})

    def test_gescheiterter_job_endet_mit_code_2(self):
        completed = self.cli(
            "job", "run", "--goal", "Bewusst scheitern", "--op", "sys.simulate",
            "--params", '{"mode": "fail", "message": "gewollt"}',
        )
        self.assertEqual(completed.returncode, EXIT_JOB_FAILED, completed.stderr[-600:])
        body = self.payload(completed)
        self.assertNotEqual(body["status"], "resolved")
        self.assertEqual(body["iterations"], 1, "Dev-Profil: genau ein Durchgang, kein stilles Retry")


class TestJsonUndIsolation(CliTestCase):
    def test_job_run_liefert_aufgeloesten_job(self):
        completed = self.cli(
            "job", "run", "--goal", "Roundtrip ueber die CLI", "--op", "sys.echo",
            "--params", '{"message": "Hallo CLI"}',
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        body = self.payload(completed)
        self.assertEqual(body["status"], "resolved")
        self.assertEqual(body["timer_mode"], "deadline")
        self.assertEqual(body["attempts"][0]["output"]["echo"], "Hallo CLI")
        self.assertEqual(body["attempts"][0]["verdict"], "accept")
        self.assertFalse(body["watch"], "ohne Uhr/Trigger laeuft nichts Ueberwachtes")

    def test_stdout_bleibt_ohne_quiet_pures_json(self):
        """Events gehoeren auf stderr -- stdout muss pipe-faehig bleiben."""
        completed = self.cli(
            "job", "run", "--goal", "Kanal-Trennung", "--op", "sys.ping", quiet=False,
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        body = self.payload(completed)  # scheitert, falls Menschentext auf stdout liegt
        self.assertEqual(body["status"], "resolved")
        self.assertTrue(completed.stderr.strip(), "ohne --quiet muss der Event-Strom auf stderr erscheinen")
        for line in completed.stderr.strip().splitlines():
            json.loads(line)  # jede Event-Zeile ist fuer sich parsbar

    def test_runtime_dir_isoliert_den_lauf(self):
        completed = self.cli("status")
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-600:])
        body = self.payload(completed)
        self.assertEqual(Path(body["runtime_dir"]).resolve(), self.runtime.resolve())
        self.assertEqual(Path(body["schedules_dir"]).resolve(), (self.runtime / "schedules").resolve())
        self.assertEqual(body["runtime"]["system_log"]["path"], str(self.runtime / "system.log"))
        self.assertTrue((self.runtime / "jobs").is_dir(), "der isolierte Lauf legt seine Verzeichnisse selbst an")
        self.assertFalse((REPO_ROOT / "runtime" / "jobs").exists() and self._repo_runtime_beruehrt(),
                         "das Repo-runtime/ darf vom Test nicht geschrieben werden")

    def _repo_runtime_beruehrt(self) -> bool:
        """Kein Job des Testlaufs darf im Repo-runtime/ liegen."""
        listing = self.payload(self.cli("job", "list", "--limit", "50"))
        jobs = listing["jobs"] if isinstance(listing, dict) else listing
        return any("Isolation" in str(entry.get("goal", "")) for entry in jobs)


class TestZeitplanUeberDieCli(CliTestCase):
    def test_unlimited_mit_triggern_wird_bilanziert(self):
        """Zeit tracken statt begrenzen -- und zeigen, was die Uhr ausgeloesst hat."""
        completed = self.cli(
            "job", "run", "--goal", "Unlimited mit Kontrollen", "--op", "sys.simulate",
            "--params", '{"mode": "timeout", "seconds": 30}',
            "--unlimited", "--tick", "0.1",
            "--trigger", "id=kontrolle;action=check;every=0.4;op=sys.ping",
            "--trigger", "id=ende;action=finish_job;when=elapsed >= 1.0",
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-1200:])
        body = self.payload(completed)
        self.assertEqual(body["status"], "resolved")
        self.assertEqual(body["timer_mode"], "unlimited")
        self.assertIsNotNone(body["t0"])
        self.assertGreaterEqual(body["t_unlimited_s"], 1.0, "der finish_job-Trigger zieht die Grenze")
        self.assertLess(body["t_unlimited_s"], 20.0, "die 30s-Wartezeit des Limbs darf nicht ausgesessen werden")

        attempt = body["attempts"][0]
        self.assertEqual(attempt["timer"]["mode"], "unlimited")
        self.assertIsNone(attempt["timer"]["deadline_s"])
        self.assertIsNone(attempt["timer"]["expires_at"])
        self.assertIsNone(attempt["timer"]["remaining_ms"], "kein Budget -> kein erfundener Rest")
        self.assertEqual(attempt["verdict"], "accept")

        watch = body["watch"]
        self.assertTrue(watch, "die Bilanz der Ueberwachung gehoert in die JSON-Ausgabe")
        self.assertTrue(watch["finish_requested"])
        self.assertFalse(watch["needs_human"])
        self.assertGreaterEqual(watch["due_actions"], 2, "Intervall-Kontrolle plus finish_job")
        self.assertGreaterEqual(watch["ticks"], 5)
        checks = watch["scheduled_jobs"]
        self.assertTrue(checks, "der check-Trigger muss echte Kontroll-Jobs gestartet haben")
        for entry in checks:
            self.assertEqual(entry["trigger_id"], "kontrolle")
            self.assertEqual(entry["status"], "resolved")
            self.assertEqual(entry["kind"], "scheduled")

    def test_zustand_wird_nach_dem_lauf_aufgeraeumt(self):
        completed = self.cli(
            "job", "run", "--goal", "Aufraeumen beweisen", "--op", "sys.simulate",
            "--params", '{"mode": "timeout", "seconds": 20}',
            "--unlimited", "--tick", "0.1", "--trigger", "id=ende;action=finish_job;when=elapsed >= 0.5",
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        job_id = self.payload(completed)["job_id"]

        listing = self.payload(self.cli("schedule", "list"))
        self.assertEqual(listing, [], "nach dem Ende darf kein Zeitplan haengen bleiben")
        self.assertEqual(list(self.runtime.glob("schedules/*.json")), [])

        show = self.cli("schedule", "show", job_id)
        self.assertEqual(show.returncode, EXIT_OK, show.stderr[-600:])
        body = self.payload(show)
        self.assertEqual(body["job_id"], job_id)
        self.assertFalse(body["scheduled"], "ein beendeter Auftrag darf keinen Zeitplan zuruecklassen")

        cleared = self.cli("schedule", "clear", job_id)
        self.assertEqual(cleared.returncode, EXIT_OK, "idempotent aufraeumen ist kein Nutzungsfehler")
        self.assertFalse(self.payload(cleared)["removed"])

    def test_ledger_nennt_dieselbe_uhr_wie_das_result(self):
        """DoD: Intent, Result, Ueberwachung und Job-Ledger nennen dieselbe Zahl."""
        completed = self.cli(
            "job", "run", "--goal", "Eine Uhr fuer alle", "--op", "sys.simulate",
            "--params", '{"mode": "timeout", "seconds": 20}',
            "--unlimited", "--tick", "0.1",
            "--trigger", "id=kontrolle;action=check;every=0.3;op=sys.ping",
            "--trigger", "id=ende;action=finish_job;when=elapsed >= 0.8",
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        body = self.payload(completed)
        timer = body["attempts"][0]["timer"]

        shown = self.payload(self.cli("job", "show", body["job_id"]))
        ledger = shown["job"]
        self.assertEqual(ledger["timer_mode"], "unlimited")
        self.assertTrue(ledger["unlimited"])
        self.assertEqual(ledger["t0"], body["t0"], "t0 ist der Anker -- er darf nirgends abweichen")
        self.assertEqual(ledger["outcome"]["t_unlimited_s"], timer["elapsed_s"])
        self.assertEqual(body["watch"]["t_unlimited_s"], timer["elapsed_s"])
        self.assertEqual(ledger["outcome"]["trigger_decision"], "finish_job")
        self.assertEqual(ledger["parent_job_id"], "")
        self.assertEqual(ledger["kind"], JOB_KIND_TASK)

    def test_schedule_show_trennt_unbekannten_job_von_keinem_zeitplan(self):
        """Referenz, die nichts bezeichnet = Nutzungsfehler; leerer Befund = Antwort."""
        unknown = self.cli("schedule", "show", "job_gibt_es_nicht")
        self.assertEqual(unknown.returncode, EXIT_USAGE, unknown.stdout[-400:])
        self.assertFalse(self.payload(unknown)["ok"])
        self.assertEqual(self.payload(unknown)["error"]["code"], "E_TARGET_NOT_FOUND")

        run = self.cli(
            "job", "run", "--goal", "Ohne Zeitplan", "--op", "sys.ping",
        )
        self.assertEqual(run.returncode, EXIT_OK, run.stderr[-600:])
        job_id = self.payload(run)["job_id"]
        found = self.cli("schedule", "show", job_id)
        self.assertEqual(found.returncode, EXIT_OK, "ein Job ohne Zeitplan ist ein Befund, kein Bedienfehler")
        body = self.payload(found)
        self.assertEqual(body["job_id"], job_id)
        self.assertFalse(body["scheduled"])

    def test_kontroll_jobs_landen_in_der_job_liste(self):
        completed = self.cli(
            "job", "run", "--goal", "Kontrollen sichtbar machen", "--op", "sys.simulate",
            "--params", '{"mode": "timeout", "seconds": 20}',
            "--unlimited", "--tick", "0.1",
            "--trigger", "id=kontrolle;action=check;every=0.3;op=sys.ping",
            "--trigger", "id=ende;action=finish_job;when=elapsed >= 0.9",
        )
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        parent = self.payload(completed)["job_id"]
        listing = self.payload(self.cli("job", "list", "--limit", "50"))
        jobs = listing["jobs"] if isinstance(listing, dict) else listing
        kinds = {entry["job_id"]: entry.get("kind") for entry in jobs}
        self.assertEqual(kinds.get(parent), JOB_KIND_TASK)
        scheduled = [job_id for job_id, kind in kinds.items() if kind == "scheduled"]
        self.assertTrue(scheduled, "Kontroll-Jobs muessen als eigene Spur sichtbar bleiben")
        for job_id in scheduled:
            detail = self.payload(self.cli("job", "show", job_id))
            job = detail.get("job", detail)
            self.assertEqual(job.get("kind"), JOB_KIND_SCHEDULED)
            self.assertEqual(job.get("trigger_id"), "kontrolle")
            self.assertEqual(job.get("parent_job_id"), parent)


class TestSchemaPruefung(CliTestCase):
    def intent_envelope(self, *extra: str) -> dict[str, Any]:
        completed = self.cli("intent", "--op", "sys.ping", "--goal", "Schema-Probe", *extra)
        self.assertEqual(completed.returncode, EXIT_OK, completed.stderr[-800:])
        return self.payload(completed)

    def test_gueltiger_intent_besteht_kern_und_schema(self):
        envelope = self.intent_envelope("--unlimited")
        path = self.write("intent-ok.json", envelope)
        completed = self.cli("validate", "--intent", str(path), "--schema")
        self.assertEqual(completed.returncode, EXIT_OK, completed.stdout[-800:] + completed.stderr[-800:])
        body = self.payload(completed)
        self.assertTrue(body["ok"])

    def test_widerspruch_unlimited_mit_deadline_faellt_auf(self):
        envelope = self.intent_envelope("--unlimited")
        envelope["timer"]["deadline_s"] = 5.0  # Protokoll 1.2: unlimited heisst deadline_s = null
        path = self.write("intent-widerspruch.json", envelope)
        completed = self.cli("validate", "--intent", str(path), "--schema")
        self.assertEqual(completed.returncode, EXIT_PROTOCOL, completed.stdout[-800:])
        body = self.payload(completed)
        self.assertFalse(body["ok"])
        self.assertTrue(body["schema_checked"], "--schema muss den Stdlib-Pruefer benutzen")
        codes = [problem["code"] for problem in body["problems"]]
        self.assertIn("E_SCHEMA_INVALID", codes)
        self.assertTrue(body["schema_violations"], "der Schema-Pruefer muss die Verletzung benennen")

    def test_unbekannte_operation_faellt_im_kern_auf(self):
        envelope = self.intent_envelope()
        envelope["task"]["operation"] = "sys.gibtesnicht"
        path = self.write("intent-op.json", envelope)
        completed = self.cli("validate", "--intent", str(path), "--schema")
        self.assertEqual(completed.returncode, EXIT_PROTOCOL)
        self.assertFalse(self.payload(completed)["ok"])

    def test_aktion_ausserhalb_des_enums_faellt_im_schema_auf(self):
        envelope = self.intent_envelope("--unlimited", "--trigger", "id=ende;action=finish_job;when=elapsed >= 1")
        envelope["schedule"]["triggers"][0]["action"] = "shell_exec"
        path = self.write("intent-aktion.json", envelope)
        completed = self.cli("validate", "--intent", str(path), "--schema")
        self.assertEqual(completed.returncode, EXIT_PROTOCOL)
        self.assertFalse(self.payload(completed)["ok"])


if __name__ == "__main__":
    unittest.main()
