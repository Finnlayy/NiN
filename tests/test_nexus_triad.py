"""Nexus-Triad Nr.1: Guard-Tests fuer die drei Optimierungszyklen.

Kurze, isolierte Tests, die verhindern, dass die Optimierungen (a) die
Event-Record-Paritaet, (b) den Shared-Memory-Ring oder (c) die
Archiv-Kompaktierung samt Integritaet wieder brechen. Sie laufen wie alle
anderen Tests rein mit der Standardbibliothek.

Keine echten Limb-Subprozesse -- nur die betroffenen Module.
"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

from core.config import NeuConfig
from core.protocol import Operations, Result, new_id, utc_now_iso
from orchestrator.events import CollectingSink, EventBus
from orchestrator.ring import SharedMemoryRingReader, SharedMemoryRingSink
from orchestrator.transport import FileTransport

from . import REPO_ROOT


class TestOptimizedEventBus(unittest.TestCase):
    def test_record_paritaet_und_format(self):
        collector = CollectingSink()
        bus = EventBus([collector])
        emitted = bus.emit("timer.tick", {"tick_s": 0.5}, job_id="job_x", trace_id="t", intent_id="i", limb="echo", clock_s=1.0)
        record = collector.records[0]
        self.assertEqual(record, emitted.to_dict())
        self.assertEqual(record["kind"], "timer.tick")
        self.assertEqual(record["job_id"], "job_x")
        self.assertEqual(record["intent_id"], "i")
        self.assertEqual(record["limb"], "echo")
        self.assertEqual(record["clock_s"], 1.0)
        self.assertEqual(record["payload"], {"tick_s": 0.5})
        # Format bleibt ``YYYY-MM-DDTHH:MM:SS.mmmZ``
        self.assertRegex(record["timestamp"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class TestSharedMemoryRing(unittest.TestCase):
    def test_roundtrip(self):
        sink = SharedMemoryRingSink(capacity=16, slot_size=2048)
        reader = None
        try:
            for i in range(5):
                sink.write({"seq": i, "kind": "loop.tick", "payload": {"tick": i}})
            reader = SharedMemoryRingReader(sink.shm_name, capacity=16, slot_size=2048)
            records = reader.drain()
            self.assertEqual([r["seq"] for r in records], [0, 1, 2, 3, 4])
        finally:
            if reader is not None:
                reader.close()
            sink.unlink()


class TestArchiveCompaction(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-triad-")
        config = NeuConfig.load(REPO_ROOT, mode="dev", runtime_dir=Path(self._tmp.name) / "runtime")
        config.ensure_dirs()
        self.config = config
        self.transport = FileTransport(config)
        self.operations = Operations.load(config.protocol_dir / "operations.json")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_compaction_verringert_eintraege_und_ist_integritaetssicher(self):
        from core.kernel import Kernel

        kernel = Kernel(self.config, self.operations)
        for i in range(10):
            intent = kernel.build_intent(operation="sys.echo", params={"message": f"m{i}"}, limb="echo", goal=f"Goal {i}")
            result = Result(
                result_id=new_id("res"),
                intent_id=intent.intent_id,
                trace_id=intent.trace_id,
                status="success",
                operation="sys.echo",
                limb_name="echo",
                started_at=utc_now_iso(),
                finished_at=utc_now_iso(),
                output={"echo": f"m{i}"},
            )
            self.transport.archive(intent, result, {"verdict": "accept", "iteration": intent.iteration})

        before = self.transport.archive_stats()
        self.assertEqual(before["total_entries"], 10)

        # Eintraege in die Vergangenheit aeltern -> gelten als veraltet
        cutoff = time.time() - 10 * 86400
        for day_dir in self.config.archive_dir.iterdir():
            if day_dir.is_dir() and day_dir.name != "compacted":
                for entry in day_dir.iterdir():
                    if entry.is_dir():
                        os.utime(entry, (cutoff, cutoff))

        summary = self.transport.compact_archive(older_than_days=7)
        after = self.transport.archive_stats()

        self.assertEqual(summary["pruned_dirs"], 10)
        self.assertEqual(after["total_entries"], 0, "alle Eintraege sollen kompaktiert sein")
        self.assertEqual(self.transport.verify_archive(), [], "Snapshot muss integritaetssicher sein")


if __name__ == "__main__":
    unittest.main()
