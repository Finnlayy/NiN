"""Nexus Triad Nr.4, Cycle 1: das Archiv-Duplikat als Verlinkung, nicht als zweiter Schreibvorgang.

``archive()`` legte ``result.json`` und ``result.iterationN.json`` aus demselben Dict
ab -- identische Bytes, zwei Vollzugriffe, zwei ``fsync``. Der Zyklus ersetzt den
zweiten Zugriff durch einen Hartlink und darf daran nichts andern:

* beide Dateien existieren, sind byte-identisch und haben denselben Inhalt wie das
  Dokument, das der alte Weg geschrieben haette;
* eine spaetere Iteration ueberschreibt nur ``result.json``, das fruehere
  Iterations-Dokument bleibt unangetastet (geteilte Inodes duerfen nicht mitlaufen);
* ohne Hardlink-Unterstuetzung des Dateisystems zaehlt der Rueckfall auf ein normales
  Schreiben, ebenfalls ohne Rest;
* die Groessenbuchhaltung des Ledgers traegt geteilte Bytes nicht doppelt ein.

Reine Standardbibliothek, kein Limb-Subprozess.
"""

from __future__ import annotations

import dataclasses
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from core.config import NeuConfig  # noqa: E402
from core.kernel import Kernel  # noqa: E402
from core.protocol import Operations, Result, new_id, utc_now_iso  # noqa: E402
from orchestrator.transport import (  # noqa: E402
    FileTransport,
    dir_bytes,
    duplicate_json_atomic,
    write_json_atomic,
)


class ArchiveLinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="nio-archive-link-")
        self._auto = os.environ.get("NEU_ARCHIVE_AUTOCOMPACT")
        os.environ["NEU_ARCHIVE_AUTOCOMPACT"] = "0"
        self.config = NeuConfig.load(REPO_ROOT, mode="dev", runtime_dir=Path(self._tmp.name) / "runtime")
        self.config.ensure_dirs()
        self.operations = Operations.load(self.config.protocol_dir / "operations.json")
        self.kernel = Kernel(self.config, self.operations)
        self.transport = FileTransport(self.config)

    def tearDown(self) -> None:
        if self._auto is None:
            os.environ.pop("NEU_ARCHIVE_AUTOCOMPACT", None)
        else:
            os.environ["NEU_ARCHIVE_AUTOCOMPACT"] = self._auto
        self._tmp.cleanup()

    def _pair(self, iteration: int = 1, message: str = "m"):
        intent = self.kernel.build_intent(operation="sys.echo", params={"message": message}, limb="echo", goal="Link messen")
        result = Result(
            result_id=new_id("res"),
            intent_id=intent.intent_id,
            trace_id=intent.trace_id,
            status="success",
            operation="sys.echo",
            limb_name="echo",
            started_at=utc_now_iso(),
            finished_at=utc_now_iso(),
            iteration=iteration,
            output={"message": message},
        )
        return intent, result

    # ------------------------------------------------------------------ Layout
    def test_result_json_zeigt_auf_dieselben_bytes_wie_die_iteration(self) -> None:
        intent, result = self._pair()
        target = self.transport.archive(intent, result, {"verdict": "accept"})
        iteration_doc = target / "result.iteration1.json"
        final_doc = target / "result.json"
        self.assertTrue(iteration_doc.is_file() and final_doc.is_file())
        same_bytes = iteration_doc.read_bytes() == final_doc.read_bytes()
        self.assertTrue(same_bytes, "das Duplikat waere nicht mehr inhaltsleich")
        left, right = iteration_doc.stat(), final_doc.stat()
        self.assertEqual((left.st_dev, left.st_ino), (right.st_dev, right.st_ino), "erwartet wurde ein geteilter Inode")
        self.assertEqual(right.st_nlink, 2)
        self.assertEqual(oct(stat.S_IMODE(right.st_mode)), "0o600", "Rechte dürfen sich nicht geaendert haben")
        # der Inhalt ist weiterhin exakt das Dokument des alten Weges
        import json

        expected = (json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.assertEqual(final_doc.read_bytes(), expected)

    def test_zweite_iteration_laesst_die_erste_unangetastet(self) -> None:
        intent, first = self._pair(iteration=1, message="eins")
        target = self.transport.archive(intent, first, {"verdict": "accept", "iteration": 1})
        first_bytes = (target / "result.iteration1.json").read_bytes()
        second = dataclasses.replace(first, iteration=2, result_id=new_id("res"), output={"message": "zwei"})
        self.transport.archive(intent, second, {"verdict": "accept", "iteration": 2})

        self.assertEqual((target / "result.iteration1.json").read_bytes(), first_bytes, "Iteration 1 wurde ueber die Verlinkung veraendert")
        two = (target / "result.iteration2.json").read_bytes()
        self.assertEqual((target / "result.json").read_bytes(), two, "result.json zeigt nicht auf die letzte Iteration")
        self.assertNotEqual(first_bytes, two)
        self.assertEqual(os.stat(target / "result.iteration1.json").st_nlink, 1, "Iteration 1 haengt weiter an result.json")
        self.assertEqual(os.stat(target / "result.iteration2.json").st_nlink, 2)
        self.assertEqual(os.stat(target / "result.json").st_nlink, 2)
        # iteration2 und result.json teilen sich den Inode, iteration1 nicht mehr
        self.assertNotEqual(
            (target / "result.iteration1.json").stat().st_ino,
            (target / "result.json").stat().st_ino,
        )

    def test_kein_temporaeres_Rest_im_Eintrag(self) -> None:
        intent, result = self._pair()
        target = self.transport.archive(intent, result, {"verdict": "accept"})
        leftovers = [p.name for p in target.iterdir() if p.name.startswith(".")]
        self.assertEqual(leftovers, [], f"Link-Reste im Archiv: {leftovers}")

    # ------------------------------------------------------------------ Rueckfall
    def test_ohne_hardlinks_wird_ganz_normal_geschrieben(self) -> None:
        intent, result = self._pair()
        target = self.transport.archive(intent, result)
        iteration_doc = target / "result.iteration1.json"
        final_doc = target / "result.json"
        payload = iteration_doc.read_bytes()
        final_doc.unlink()
        with mock.patch("os.link", side_effect=OSError(1, "Operation not permitted")):
            linked = duplicate_json_atomic(iteration_doc, final_doc)
        self.assertFalse(linked)
        self.assertEqual(final_doc.read_bytes(), payload)
        self.assertEqual(os.stat(final_doc).st_nlink, 1, "der Rueckfall darf nicht verlinkt haben")
        self.assertEqual([p.name for p in target.iterdir() if p.name.startswith(".")], [])

    def test_ganzes_archiv_ohne_hardlinks_ist_noch_dicht(self) -> None:
        intent, result = self._pair()
        with mock.patch("os.link", side_effect=OSError(1, "not permitted")):
            target = self.transport.archive(intent, result, {"verdict": "accept"})
        for name in ("intent.json", "result.iteration1.json", "result.json", "verdict.json"):
            self.assertTrue((target / name).is_file(), name)
        self.assertEqual(len(self.transport.verify_archive()), 0)
        self.assertIsNotNone(self.transport.lookup_archived(intent.intent_id))

    def test_fehlender_replace_hinterlaesst_keinen_link(self) -> None:
        src = self.config.runtime_dir / "dup-src.json"
        dst = self.config.runtime_dir / "dup-dst.json"
        write_json_atomic(src, {"a": 1})
        # nur der replace des Links scheitert, der des Rueckfalls läuft echt
        real = os.replace

        def only_the_link(old, new, **kwargs):
            if str(old).endswith(".lnk"):
                raise OSError(2, "nope")
            return real(old, new, **kwargs)

        with mock.patch("os.replace", side_effect=only_the_link):
            self.assertFalse(duplicate_json_atomic(src, dst))
        self.assertEqual(dst.read_bytes(), src.read_bytes())
        self.assertEqual([p.name for p in self.config.runtime_dir.iterdir() if p.name.startswith(".")], [])

    # ------------------------------------------------------------------ Buchhaltung
    def test_geteilte_bytes_zaehlen_nur_einmal(self) -> None:
        day = None
        for index in range(4):
            intent, result = self._pair(message=f"n{index}")
            day = self.transport.archive(intent, result, {"verdict": "accept"}).parent
        naive = sum(doc.stat().st_size for entry in day.iterdir() for doc in entry.iterdir() if doc.is_file())
        counted = sum(dir_bytes(entry) for entry in day.iterdir())
        self.assertLess(counted, naive, "die Verlinkung wurde doppelt gezaehlt")
        unique: set[tuple[int, int]] = set()
        expected = 0
        for entry in day.iterdir():
            for f in entry.iterdir():
                info = f.stat()
                key = (info.st_dev, info.st_ino)
                if key in unique:
                    continue
                unique.add(key)
                expected += info.st_size
        self.assertEqual(counted, expected)

        stats = self.transport.archive_stats()
        self.assertEqual(stats["days"][day.name]["bytes"], expected)
        report = self.transport.compact_archive(older_than_days=0, keep_recent=0)
        self.assertGreater(report["bytes_freed"], 0)
        self.assertEqual(report["bytes_freed"], expected, "freigegeben must sich auf dasselbe Zaehlen stuetzen")
        self.assertEqual(len(self.transport.verify_archive()), 0)
        self.assertEqual(len(self.transport.verify_archive(force=True)), 0)

    def test_dir_bytes_ohne_verlinkung_ist_die_naive_summe(self) -> None:
        probe = self.config.runtime_dir / "plain"
        probe.mkdir(parents=True, exist_ok=True)
        for index in range(3):
            write_json_atomic(probe / f"doc{index}.json", {"i": index})
        naive = sum(f.stat().st_size for f in probe.iterdir())
        self.assertEqual(dir_bytes(probe), naive)
        self.assertEqual(dir_bytes(self.config.runtime_dir / "gibt-es-nicht"), 0)


if __name__ == "__main__":
    unittest.main()
