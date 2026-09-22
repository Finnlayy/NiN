"""Nexus Triad Nr.3, Cycle 1: der atomare JSON-Schreiber und der Persistenz-Text.

Gegenstand ist die *Semantik*, nicht die Geschwindigkeit:

* ``atomic_write_bytes`` muss byte-identisch das alte Dokument schreiben (gleiches
  ``json.dumps``-Ergebnis, gleicher Modus, kein Temp-Rest), das Ziel bei einem
  Fehler unangetastet lassen und dem ``fsync``-Vertrag des Transports folgen.
* ``ScheduleState.persist_text`` darf kein zweites Format sein: was auf der Platte
  liegt, muss nach ``json.loads`` exakt ``to_dict()`` sein -- auch nach Kuerzung auf
  ``HISTORY_LIMIT``, nach direktem Eingriff von aussen und nach load()/save()-Rundlauf.

Reine Standardbibliothek, kein Limb-Subprozess.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from core.atomic import atomic_write_bytes  # noqa: E402
from core.config import NeuConfig  # noqa: E402
from core.job import JobStore  # noqa: E402
from core.kernel import Kernel  # noqa: E402
from core.policy import Policy  # noqa: E402
from core.protocol import Operations, parse_timestamp, sha256_bytes  # noqa: E402
from orchestrator.events import CollectingSink, build_event_bus  # noqa: E402
from orchestrator.scheduler import HISTORY_LIMIT, Scheduler  # noqa: E402
from orchestrator.transport import FileTransport, write_json_atomic, write_jsonl_atomic  # noqa: E402


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-atomic-")
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_byte_identisch_zum_alten_weg(self) -> None:
        doc = {"job_id": "job_1", "notiz": "Umlaute: äöü ß", "werte": [1, 2.5, None, True]}
        expected = (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        target = self.tmp / "doc.json"
        returned = atomic_write_bytes(target, expected, fsync=True, mode=0o600)
        self.assertEqual(returned, target)
        self.assertEqual(target.read_bytes(), expected)

    def test_kein_temp_reste_und_rechte(self) -> None:
        target = self.tmp / "sub" / "doc.json"
        atomic_write_bytes(target, b"{}\n", mode=0o600)
        self.assertEqual(sorted(p.name for p in target.parent.iterdir()), ["doc.json"])
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        other = self.tmp / "loose.json"
        atomic_write_bytes(other, b"{}\n")
        # nicht grosszuegiger als der Wunsch des Aufrufers (die Maske des Prozesses
        # darf schaerfer sein, aber nie milder):
        self.assertEqual(other.stat().st_mode & 0o777 & ~0o644, 0)

    def test_erscheint_ganz_oder_gar_nicht(self) -> None:
        target = self.tmp / "state.json"
        atomic_write_bytes(target, b'{"v":1}\n')
        with mock.patch("core.atomic.os.replace", side_effect=OSError("replace fehlgeschlagen")):
            with self.assertRaises(OSError):
                atomic_write_bytes(target, b'{"v":2}\n')
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"v": 1})
        self.assertEqual([p.name for p in target.parent.iterdir()], ["state.json"], "kein Temp-Waise")
        with mock.patch("core.atomic.os.write", side_effect=OSError("write fehlgeschlagen")):
            with self.assertRaises(OSError):
                atomic_write_bytes(target, b'{"v":3}\n')
        self.assertEqual([p.name for p in target.parent.iterdir()], ["state.json"])

    def test_fsync_vertrag_des_transports(self) -> None:
        target = self.tmp / "intent.json"
        with mock.patch("core.atomic.os.fsync") as fsync:
            atomic_write_bytes(target, b"{}\n", fsync=True)
            self.assertEqual(fsync.call_count, 1)
            atomic_write_bytes(self.tmp / "state2.json", b"{}\n")
            self.assertEqual(fsync.call_count, 1, "Zustandsdateien syncen nicht zusaetzlich")

    def test_parallele_schreiber_nutzen_getrennte_temps(self) -> None:
        target = self.tmp / "shared.json"
        errors: list[BaseException] = []

        def writer(payload: int) -> None:
            try:
                atomic_write_bytes(target, json.dumps({"n": payload}).encode())
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertIn(json.loads(target.read_text(encoding="utf-8")), [{"n": i} for i in range(12)])
        self.assertEqual([p.name for p in target.parent.iterdir()], ["shared.json"])


class TransportWriterTests(unittest.TestCase):
    """Die alten Dokumente müssen unverändert bleiben -- Format ist Vertrag."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-transport-")
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_write_json_atomic_format_stabil(self) -> None:
        doc = {"intent_id": "intent_x", "text": "äöü", "zahl": 1.5}
        target = write_json_atomic(self.tmp / "intent.json", doc)
        self.assertEqual(target.read_text(encoding="utf-8"), json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_write_json_atomic_indent_none_wie_bisher(self) -> None:
        # indent=None ist beim alten Weg NICHT kompakt (json.dump nutzt dann die
        # Default-Separatoren) -- der Sidecar-Index haengt an genau diesen Bytes.
        doc = {"a": [1, 2]}
        target = write_json_atomic(self.tmp / "idx.json", doc, indent=None)
        self.assertEqual(target.read_bytes(), (json.dumps(doc, ensure_ascii=False) + "\n").encode("utf-8"))

    def test_write_jsonl_atomic_pro_zeile(self) -> None:
        records = [{"i": 0}, {"i": 1, "t": "x"}]
        target = write_jsonl_atomic(self.tmp / "snap.jsonl", records)
        lines = target.read_text(encoding="utf-8").splitlines()
        self.assertEqual([json.loads(line) for line in lines], records)
        self.assertTrue(all(", " not in line and ": " not in line for line in lines), "kompakt wie bisher")


class SchedulerPersistenzTests(unittest.TestCase):
    """persist_text() ist eine Ableitung, kein zweites Format."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-sched3-")
        tmp = Path(self._tmp.name)
        self.config = NeuConfig.load(
            REPO_ROOT,
            mode="dev",
            limits={
                "max_iterations": 1,
                "max_agents": 1,
                "max_limbs": 1,
                "max_concurrent_jobs": 1,
                "max_scheduled_jobs": 1,
            },
            runtime_dir=tmp / "runtime",
            workspace_dir=tmp / "workspace",
        )
        self.config.ensure_dirs()
        self.collector = CollectingSink()
        bus = build_event_bus(quiet=True, collector=self.collector)
        self.scheduler = Scheduler(self.config, bus=bus)
        self.kernel = Kernel(self.config, Operations.load(self.config.protocol_dir / "operations.json"))
        self.jobs = JobStore(self.config)
        self.addCleanup(self._tmp.cleanup)

    def state(self, triggers: list[dict]):
        intent = self.kernel.build_intent(
            operation="sys.echo",
            params={"message": "m"},
            limb="echo",
            goal="g",
            unlimited=True,
            tick_s=0.05,
            schedule=triggers,
        )
        record = self.jobs.create(intent.job.goal, timer_mode="unlimited", job_id=intent.job.job_id)
        return self.scheduler.attach(intent, t0=record.created_at, force=True)

    def fire(self, state, count: int) -> None:
        from datetime import timedelta

        origin = parse_timestamp(state.t0, "$.t0")
        for i in range(count):
            self.scheduler.tick(state, now=origin + timedelta(seconds=(i + 1) * 0.05))

    def test_persistierter_text_ist_to_dict(self) -> None:
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, 5)
        path = self.scheduler.path_for(state.job_id)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), state.to_dict())

    def test_kuerzung_auf_history_limit_bleibt_synchron(self) -> None:
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, HISTORY_LIMIT + 37)
        self.assertGreater(len(state.history), HISTORY_LIMIT - 1)
        self.assertEqual(len(state.history), HISTORY_LIMIT)
        self.assertEqual(len(state.hist_frags), HISTORY_LIMIT)
        path = self.scheduler.save(state)
        disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(disk["history"], state.to_dict()["history"])
        self.assertEqual(disk, state.to_dict())
        self.assertEqual(disk["history"][0]["seq"] if "seq" in disk["history"][0] else 0, 0)

    def test_fremder_griff_in_die_historie_erkennt_der_cache(self) -> None:
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, 3)
        state.history.append({"at": "2026-09-07T00:00:00.000Z", "kind": "fremd", "trigger_id": "", "action": "x"})
        disk = json.loads(self.scheduler.save(state).read_text(encoding="utf-8"))
        self.assertEqual(disk, state.to_dict(), "ohne Cache-Synchronisation wäre der Eintrag verloren")

    def test_frag_cache_reagiert_auf_kanten_der_liste(self) -> None:
        """Der Vertrag: Kopf/Ende muessen sich nur bei ``_record`` bewegen.

        Genau das wird ueberwacht (Anzahl, Laenge, Objekt-Identitaet an beiden
        Kanten). Ein Eingriff in die Listenmitte gilt per Definition als
        unveraendert -- es gibt keinen solchen Pfad; dieser Test haelt fest, dass
        der Cache nach jedem Feuerungs-schritt synchron bleibt.
        """
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, 4)
        self.scheduler.save(state)
        self.assertEqual(state.hist_built, state.hist_appends, "Cache gilt nach save() als frisch")
        for i in range(3):
            self.fire(state, 1)
            self.assertEqual(
                state.hist_frags[-1],
                json.dumps(state.history[-1], ensure_ascii=False, separators=(",", ":")),
                f"Fragment {i} muss zum Eintrag passen",
            )
        state.history.pop(0)  # Kante veraendert sich -> Neubau
        disk = json.loads(self.scheduler.save(state).read_text(encoding="utf-8"))
        self.assertEqual(disk, state.to_dict())

    def test_load_und_save_rundlauf(self) -> None:
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, 12)
        self.scheduler.save(state)
        again = self.scheduler.load(state.job_id)
        assert again is not None
        self.assertEqual(json.loads(self.scheduler.save(again).read_text(encoding="utf-8")), again.to_dict())
        self.fire(again, 3)
        self.assertEqual(json.loads(self.scheduler.save(again).read_text(encoding="utf-8")), again.to_dict())
        self.assertEqual(len(again.hist_frags), len(again.history), "Fragment-Puffer laeuft mit")

    def test_verzeichnis_entfernt_wiederholt_einmal(self) -> None:
        state = self.state([{"id": "takt", "action": "emit_event", "every_s": 0.05}])
        self.fire(state, 2)
        path = self.scheduler.save(state)
        expected = json.loads(path.read_text(encoding="utf-8"))
        for candidate in self.config.schedules_dir.iterdir():
            candidate.unlink()
        self.config.schedules_dir.rmdir()
        saved = self.scheduler.save(state)
        self.assertTrue(saved.is_file(), "fehlendes Verzeichnis wird wieder angelegt")
        disk = json.loads(saved.read_text(encoding="utf-8"))
        self.assertEqual({k: v for k, v in disk.items() if k != "updated_at"}, {k: v for k, v in expected.items() if k != "updated_at"})

    def test_job_record_rundlauf_kompakt(self) -> None:
        record = self.jobs.create("Ziel mit Umlauten: äöü", timer_mode="unlimited")
        raw = self.jobs.path(record.job_id).read_bytes()
        disk = json.loads(raw)
        again = self.jobs.get(record.job_id).to_dict()
        # ``t_unlimited_s`` ist ein abgeleiteter Live-Wert (now - t0), der mit dem
        # Dateiinhalt nur verglichen werden kann, wenn man die Messzeit ausklammert:
        # er steigt zwischen Schreiben und Lesen um die Laufzeit. Kein Fehler der
        # Kompaktschreibung -- der alte indent=2-Pfad war genauso flatterhaft.
        for label, left, right in (("t_unlimited_s", disk.pop("t_unlimited_s"), again.pop("t_unlimited_s")),):
            self.assertIsInstance(left, float, label)
            self.assertGreaterEqual(right, left)
            self.assertLess(right - left, 5.0, label)
        self.assertEqual(disk, again)
        self.assertNotIn(b"\n  ", raw, "kompakt geschrieben statt indent=2")
        self.assertNotIn(b"\\u", raw, "ensure_ascii=False bleibt: Umlaut steht lesbar in der Datei")

    def test_cli_liest_neue_formatierung(self) -> None:
        from orchestrator.cli import main as cli_main

        record = self.jobs.create("g", timer_mode="unlimited")
        self.jobs.heartbeat(record.job_id, note="tick=7")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = cli_main(
                [
                    "--repo-root", str(REPO_ROOT),
                    "--runtime-dir", str(self.config.runtime_dir),
                    "--json",
                    "job", "show", record.job_id,
                ]
            )
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload["job"]["job_id"], record.job_id)
        self.assertEqual(payload["job"]["outcome"]["heartbeat"], "tick=7")
        self.assertIn("tick=7", json.dumps(payload, ensure_ascii=False))

    def test_zustandsuhr_unchanged(self) -> None:
        from datetime import timedelta

        state = self.state([{"id": "schwelle", "action": "emit_event", "when": "elapsed >= 0.1"}])
        origin = parse_timestamp(state.t0, "$.t0")
        due = self.scheduler.tick(state, now=origin + timedelta(seconds=0.2))
        self.assertEqual(len(due), 1)
        self.assertEqual(json.loads(self.scheduler.save(state).read_text(encoding="utf-8")), state.to_dict())


class PolicyMemoTests(unittest.TestCase):
    """Cycle 2: die memoisierte Sandbox-Wurzel darf keine Entscheidung aendern.

    Gegenprobe ist dieselbe Policy-Instanz *mit geleertem Cache* -- das ist der
    alte Rechenweg (Wurzel und Label pro Aufruf aufgelöst), also ein
    Differentiaaltest gegen das Vorher, nicht gegen eine Absicht.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-policy3-")
        tmp = Path(self._tmp.name)
        self.config = NeuConfig.load(
            REPO_ROOT,
            mode="dev",
            limits={
                "max_iterations": 4,
                "max_agents": 2,
                "max_limbs": 2,
                "max_concurrent_jobs": 2,
                "max_scheduled_jobs": 2,
            },
            runtime_dir=tmp / "runtime",
            workspace_dir=tmp / "workspace",
        )
        self.config.ensure_dirs()
        (tmp / "workspace" / "notes").mkdir(parents=True, exist_ok=True)
        self.operations = Operations.load(self.config.protocol_dir / "operations.json")
        self.kernel = Kernel(self.config, self.operations)
        self.warm = Policy(self.config, self.operations)
        self.cold = Policy(self.config, self.operations)
        self.addCleanup(self._tmp.cleanup)

    def _intents(self):
        """Erlaubte Intents, dann mit feindlichen Wurzeln/Globen variiert."""
        base = self.kernel.build_intent(
            operation="core.memory_write", params={"path": "notes/x.md"}, limb="echo", goal="g"
        )
        for root_name in ("workspace", "", ".", "./", "workspace/notes", "core", "nope", "workspace/../workspace"):
            for path in ("notes/x.md", "core/kernel.py", "notes/y.md", "neu.config.json"):
                constraints = replace(base.constraints, sandbox_root=root_name)
                task = replace(base.task, params={"path": path})
                yield replace(base, constraints=constraints, task=task)
                elevation = replace(base.elevation, level="repo_write", approved_by="human", reason="x" * 25)
                yield replace(base, constraints=constraints, task=task, elevation=elevation)

    def _decide(self, policy: Policy, intent, *, clear: bool) -> tuple:
        if clear:
            policy._sandbox_roots.clear()
        try:
            decision = policy.check(intent)
        except Exception as exc:  # beide Pfade müssen hier gleichartig reagieren
            return ("raise", type(exc).__name__, str(exc))
        return (
            decision.allowed,
            decision.code,
            decision.sandbox_root,
            tuple(decision.resolved_targets),
            decision.reason,
        )

    def test_ent_scheidungen_identisch(self) -> None:
        compared = 0
        for intent in self._intents():
            warm = self._decide(self.warm, intent, clear=False)
            cold = self._decide(self.cold, intent, clear=True)
            compared += 1
            self.assertEqual(warm, cold, f"Memo aendert die Entscheidung fuer {intent.constraints.sandbox_root!r}")
        self.assertGreaterEqual(compared, 30)

    def test_label_ist_der_naive_wert(self) -> None:
        for root_name in ("workspace", "workspace/notes", "core"):
            intent = self.kernel.build_intent(
                operation="core.memory_write",
                params={"path": "notes/x.md"},
                limb="echo",
                goal="g",
                constraints={"sandbox_root": root_name},
            )
            naive = self.config.relative((Path(self.config.repo_root) / root_name).resolve())
            self.assertEqual(self.warm.sandbox_root_label(intent), naive)
            self.assertEqual(self.warm.sandbox_root(intent), (Path(self.config.repo_root) / root_name).resolve())

    def test_cache_wachst_nicht_unbegrenzt(self) -> None:
        (Path(self.config.workspace_dir) / "d0").mkdir(parents=True, exist_ok=True)
        base = self.kernel.build_intent(
            operation="core.memory_write", params={"path": "notes/x.md"}, limb="echo", goal="g"
        )
        for i in range(50):
            name = "workspace" if i == 0 else f"workspace/d{i % 4}"
            intent = replace(base, constraints=replace(base.constraints, sandbox_root=name))
            self.warm.sandbox_root(intent)
        self.assertLessEqual(len(self.warm._sandbox_roots), Policy._SANDBOX_CACHE_LIMIT)

    def test_relative_resolved_fallback_gleich(self) -> None:
        inside = Path(self.config.workspace_dir).resolve()
        self.assertEqual(self.config.relative_resolved(inside), self.config.relative(inside))
        outside = Path("/etc/hosts")
        self.assertEqual(self.config.relative_resolved(outside), str(outside))
        self.assertEqual(self.config.relative_resolved(outside), self.config.relative(outside))


class ProtocolPrimitiveTests(unittest.TestCase):
    """Die Validierer muessen dieselben Fehler werfen wie vorher -- nur billiger."""

    def _msg(self, fn):
        try:
            fn()
        except Exception as exc:
            return type(exc).__name__, str(exc)
        return ("ok", "")

    def test_reject_unknown_meldung_stabil(self) -> None:
        from core.protocol import ProtocolError, _reject_unknown

        with self.assertRaises(ProtocolError) as ctx:
            _reject_unknown({"id": "x", "beta": 1, "alpha": 2}, ("id", "action"), "$.t")
        self.assertIn("unbekannte Schluessel ['alpha', 'beta']", str(ctx.exception))
        self.assertEqual(self._msg(lambda: _reject_unknown({"id": "x"}, ("id",), "$"))[0], "ok")

    def test_enum_ohne_index_scan(self) -> None:
        from core.protocol import VALID_TRIGGER_ACTIONS, _as_enum

        self.assertEqual(_as_enum("log", "$.action", VALID_TRIGGER_ACTIONS), "log")
        from core.protocol import ProtocolError as _PE

        with self.assertRaises(_PE) as ctx:
            _as_enum("schlendern", "$.action", VALID_TRIGGER_ACTIONS)
        self.assertIn("nicht in", str(ctx.exception))
        self.assertIn("'schlendern'", str(ctx.exception))

    def test_erlaubte_menge_ist_gecacht_und_korrekt(self) -> None:
        from core.protocol import _allowed_set

        first = _allowed_set(("a", "b", "c"))
        self.assertIs(first, _allowed_set(("a", "b", "c")), "Konstante wird wiederverwendet")
        self.assertEqual(_allowed_set(["a", "b"]), frozenset({"a", "b"}), "unhashbare Eingabe faellt zurueck")
        self.assertEqual(_allowed_set(frozenset({"x"})), frozenset({"x"}))

    def test_bedingung_mit_exotischem_leerraum(self) -> None:
        from core.protocol import _validate_condition

        for text in ("elapsed >= 30", "elapsed>=30", "  elapsed   >=   30  ", "elapsed\t>=\t30", "elapsed > 0.25"):
            with self.subTest(bedingung=text):
                op, value = _validate_condition(text, "$.when")
                reference = _validate_condition(" ".join(text.split()), "$.when")
                self.assertEqual((op, value), reference)
        from core.protocol import ProtocolError

        with self.assertRaises(ProtocolError):
            _validate_condition("elapsed ~ 5", "$.when")

    def test_trigger_without_copy_of_input(self) -> None:
        from core.protocol import Trigger

        raw = {"id": "takt", "action": "log", "every_s": 5.0}
        trigger = Trigger.from_dict(raw)
        self.assertEqual(trigger.id, "takt")
        raw["id"] = "geaendert"
        self.assertEqual(trigger.id, "takt", "der Trigger haelt seine eigenen Werte")



class LedgerMaintenanceTests(unittest.TestCase):
    """Cycle 3: Selbstpflege des Ledgers -- billiger zaehlen, strenger pruefen."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-ledger3-")
        self.config = NeuConfig.load(REPO_ROOT, mode="dev", runtime_dir=Path(self._tmp.name) / "runtime")
        self.config.ensure_dirs()
        self.transport = FileTransport(self.config)
        self.addCleanup(self._tmp.cleanup)

    def _fill(self, days: int = 3, per_day: int = 5, *, age_days: int = 10) -> list[str]:
        import time as _t

        ids: list[str] = []
        stamp = _t.time() - age_days * 86_400
        for day_index in range(days):
            day = f"2026-08-{day_index + 1:02d}"
            for n in range(per_day):
                intent_id = f"int_2026080{day_index}T0000{n:02d}Z_0000{n:02d}"
                entry = self.config.archive_dir / day / intent_id
                entry.mkdir(parents=True, exist_ok=True)
                write_json_atomic(entry / "intent.json", {"intent_id": intent_id, "goal": f"g{n}"}, indent=None)
                write_json_atomic(entry / "result.json", {"status": "success", "intent_id": intent_id}, indent=None)
                os.utime(entry, (stamp, stamp))
                ids.append(intent_id)
            os.utime(entry.parent, (stamp, stamp))
        return ids

    @staticmethod
    def _reference_count(archive: Path, cutoff: float) -> int:
        stale = 0
        for day_dir in archive.iterdir():
            if not day_dir.is_dir() or day_dir.name == "compacted":
                continue
            for entry in day_dir.iterdir():
                if entry.is_dir() and entry.stat().st_mtime <= cutoff:
                    stale += 1
        return stale

    def test_schwelle_zaehlt_identisch(self) -> None:
        import time as _t

        self._fill(days=3, per_day=5)
        cutoff = _t.time() - 0
        reference = self._reference_count(self.config.archive_dir, cutoff)
        self.assertEqual(self.transport.stale_entry_count(older_than_days=0), reference)
        self.assertEqual(reference, 15)

    def test_limit_bricht_frueher_ab_ohne_die_antwort_zu_aendern(self) -> None:
        self._fill(days=4, per_day=6)
        full = self.transport.stale_entry_count(older_than_days=0)
        self.assertEqual(full, 24)
        for limit in (1, 7, 24):
            with self.subTest(limit=limit):
                self.assertEqual(self.transport.stale_entry_count(older_than_days=0, limit=limit), min(limit, full))
        # unterhalb der Schwelle wird weiter gezaehlt -> exakter Wert fuer die Meldung
        self.assertEqual(self.transport.stale_entry_count(older_than_days=0, limit=100), 24)

    def test_frissst_der_merge_keinen_eintrag_wird_nicht_geloescht(self) -> None:
        ids = self._fill(days=2, per_day=4)
        real = FileTransport._read_archive_entry

        def sabotaged(self, entry, day):  # schreibt den Eintrag unter fremdem Schluessel ab
            record = real(self, entry, day)
            return None if record is None else {**record, "intent_id": "untergeschlagen"}

        with mock.patch.object(FileTransport, "_read_archive_entry", sabotaged):
            report = self.transport.compact_archive(older_than_days=0, keep_recent=0)
        days = report["days"]
        self.assertTrue(days, "der Saboteur haette auffallen muessen")
        for day, info in days.items():
            self.assertEqual(info.get("compacted"), 0, day)
            self.assertIn("Merge verliert Eintraege", info.get("aborted", ""), day)
        for intent_id in ids:
            survivors = list(self.config.archive_dir.glob(f"*/{intent_id}"))
            self.assertTrue(survivors, f"{intent_id} wurde praemiert, obwohl der Snapshot ihn nicht kennt")

    def test_ruecklesung_findet_abgeschnittenen_snapshot(self) -> None:
        self._fill(days=1, per_day=3)
        report = self.transport.compact_archive(older_than_days=0, keep_recent=0)
        self.assertEqual(report["pruned_dirs"], 3, report["days"])
        snapshot = next((self.config.archive_dir / "compacted").glob("*.jsonl"))
        intact = snapshot.read_bytes()
        digest = sha256_bytes(intact)
        count = intact.count(b"\n")
        self.assertEqual(self.transport._verify_snapshot_write(snapshot, digest=digest, count=count), [])
        snapshot.write_bytes(intact[: len(intact) // 2])
        violations = self.transport._verify_snapshot_write(snapshot, digest=digest, count=count)
        self.assertEqual(len(violations), 1, violations)
        snapshot.write_bytes(intact)
        self.assertEqual(self.transport._verify_snapshot_write(snapshot, digest=digest, count=count + 1)[0].count("Zeilen"), 1)

    def test_index_ist_wegwerfbar_und_wird_neu_baut(self) -> None:
        ids = self._fill(days=2, per_day=3)
        self.transport.compact_archive(older_than_days=0, keep_recent=0)
        compact_dir = self.config.archive_dir / "compacted"
        indexes = list(compact_dir.glob("*.index.json"))
        self.assertTrue(indexes)
        for index in indexes:
            index.unlink()
        for intent_id in ids:
            self.assertIsNotNone(self.transport.lookup_archived(intent_id), f"{intent_id} nach Indexverlust nicht gefunden")


if __name__ == "__main__":
    unittest.main()
