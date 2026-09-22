"""Nexus-Triad Nr.2: Guard-Tests fuer die drei Optimierungszyklen.

Sie sichern die *Semantik* der Schnellpfade, nicht deren Geschwindigkeit:

* **Focus A** -- die vom Bus einmalig erzeugte JSON-Zeile muss exakt das sein,
  was ``json.dumps(record)`` liefert, und sie muss *geteilt* werden (ein Objekt
  fuer alle Text-Sinks). Ausserdem: ohne Text-Sink wird ueberhaupt nicht
  serialisiert, und der UDS-Sink darf bei fehlendem Empfaenger nie werfen.
* **Focus B** -- gecachte Bedingungs-Auswertung muss identische Ergebnisse und
  identische Fehler liefern wie der rohe Parser; die Uhren-Schnellpfade
  (memoisierte Epoche) muessen denselben Wert liefern wie der datetime-Pfad.
* **Focus C** -- Kompaktierung darf keinen Eintrag verlieren. Der Offset-Index ist
  ein *abgeleitetes* Artefakt: fehlt er, wird er neu aufgebaut; passt er nicht,
  verhindert die Paritaetspruefung falsche Treffer. Die Integritaetspruefung muss
  Manipulation in beiden Pradpfaden melden.

Wie alle Tests hier: reine Standardbibliothek, keine echten Limb-Subprozesse.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
try:
    from datetime import UTC
except ImportError:
    UTC = timezone.utc
from pathlib import Path

from core.config import NeuConfig
from core.kernel import Kernel
from core.protocol import (
    Operations,
    ProtocolError,
    Result,
    new_id,
    parse_timestamp,
    timestamp_epoch_s,
    utc_now_iso,
)
from orchestrator.events import CollectingSink, ConsoleSink, EventBus, render_record
from orchestrator.ring import RingFull, SharedMemoryRingReader, SharedMemoryRingSink
from orchestrator.scheduler import (
    _CONDITION_CACHE,
    _compile_condition,
    evaluate_condition,
    parse_condition,
)
from orchestrator.transport import INDEX_SUFFIX, FileTransport
from orchestrator.uds import UDSBroadcastServer, UDSBroadcastSink

from . import REPO_ROOT


class _RecordingSink:
    """Merkt sich, was der Bus liefert -- inkl. Objektidentitaet der Zeile."""

    name = "recorder"
    wants_prepared_line = True

    def __init__(self) -> None:
        self.records: list[dict[str, object]] = []
        self.lines: list[str] = []

    def write_prepared(self, record: object, line: str) -> None:
        self.records.append(dict(record))  # type: ignore[arg-type]
        self.lines.append(line)


class _PlainSink:
    """Alt-Protokoll: kennt nur ``write(record)`` (kein vorserialisierter Pfad)."""

    name = "plain"

    def __init__(self) -> None:
        self.records: list[dict[str, object]] = []
        self.serializations = 0

    def write(self, record: object) -> None:
        self.serializations += 1
        json.dumps(dict(record), ensure_ascii=False)  # was der Sink selbst tun muss
        self.records.append(dict(record))  # type: ignore[arg-type]


class TestSharedLineFanout(unittest.TestCase):
    PAYLOADS: tuple[dict[str, object], ...] = (
        {},
        {"tick": 42, "tick_s": 0.5, "fired": 0},
        {"msg": 'quote " backslash \\ umlaut äöü \n newline'},
        {"nested": {"a": [1, 2.5, None, True], "b": {}}},
        {"empty_text": "", "kind_like": "looks, like: json"},
    )

    def test_line_ist_bitgenau_dumps_des_records(self) -> None:
        for payload in self.PAYLOADS:
            for clock in (None, 0.0, 1.234, -3.5, 1e308):
                sink = _RecordingSink()
                bus = EventBus([sink])
                event = bus.emit(
                    "timer.tick", payload, job_id="job_x", trace_id="trc_1",
                    intent_id="int_1", limb="echo", clock_s=clock,
                )
                record = sink.records[0]
                self.assertEqual(sink.lines[0], render_record(record))
                self.assertEqual(json.loads(sink.lines[0]), record)
                self.assertEqual(event.to_dict(), record)

    def test_eine_Zeile_fuer_alle_Text_Sinks(self) -> None:
        a, b = _RecordingSink(), _RecordingSink()
        EventBus([a, b]).emit("loop.tick", {"i": 1}, job_id="job_x")
        self.assertIs(a.lines[0], b.lines[0], "Serialisierung darf nicht pro Sink passieren")

    def test_ohne_Text_Sink_wird_nicht_serialisiert(self) -> None:
        plain = _PlainSink()
        collector = CollectingSink()
        bus = EventBus([plain, collector])
        bus.emit("loop.tick", {"i": 1})
        self.assertEqual(plain.serializations, 1, "nur der Alt-Sink serialisiert selbst")
        self.assertEqual(len(collector.records), 1)

    def test_ohne_Text_Sink_auft_rendert_der_bus_nicht(self) -> None:
        """Im Standardbetrieb (Sammler + quiet-Konsole) wird gar nicht serialisiert.

        Der Bus rendert die Zeile erst am ersten Sink, das sie haben will. Ein
        ``_render_line``, das in diesem Test feuert, ist ein Rueckfall auf
        unnotige CPU-Arbeit pro Tick -- deshalb der Spike.
        """
        import orchestrator.events as events_module

        real = events_module._render_line

        def spy(*args: object, **kwargs: object) -> str:
            raise AssertionError("Serialisierung ohne Text-Sink ist verschwendete CPU")

        events_module._render_line = spy  # type: ignore[assignment]
        try:
            bus = EventBus([ConsoleSink(stream=None, quiet=True), CollectingSink()])
            for index in range(5):
                bus.emit("timer.tick", {"tick": index}, job_id="job_x", clock_s=1.0)
        finally:
            events_module._render_line = real  # type: ignore[assignment]

    def test_sink_fehler_killt_den_bus_nicht(self) -> None:
        """Ein kaputter Sink wird gemeldet, aber der Bus liefert an den naechsten aus."""

        class Boom:
            name = "boom"
            wants_prepared_line = True

            def write_prepared(self, record: object, line: str) -> None:
                raise RuntimeError("Sink kaputt")

        collector = CollectingSink()
        bus = EventBus([Boom(), collector])
        with contextlib.redirect_stderr(io.StringIO()) as captured:
            event = bus.emit("timer.tick", {"tick": 1}, job_id="job_x")
        self.assertIn("boom", captured.getvalue())
        self.assertEqual(len(collector.records), 1)
        self.assertEqual(event.kind, "timer.tick")

    def test_ring_sink_nutzt_die_geteilte_Zeile_und_ist_verlustfrei(self) -> None:
        ring = SharedMemoryRingSink(capacity=8, slot_size=1024)
        reader = None
        try:
            bus = EventBus([ring])
            for index in range(5):
                bus.emit("timer.tick", {"tick": index}, job_id="job_x", clock_s=float(index))
            reader = SharedMemoryRingReader(ring.shm_name, capacity=8, slot_size=1024)
            records = reader.drain()
            self.assertEqual([r["payload"]["tick"] for r in records], [0, 1, 2, 3, 4])
            self.assertEqual(records[0], json.loads(render_record(records[0])))
        finally:
            if reader is not None:
                reader.close()
            ring.unlink()

    def test_ring_voll_verwirft_im_hot_path_und_wirft_beim_direkten_schreiben(self) -> None:
        """Volllaeuft der Ring im Hot-Path, wird verworfen -- der Lauf lauft weiter."""
        ring = SharedMemoryRingSink(capacity=2, slot_size=1024)
        try:
            bus = EventBus([ring])
            for index in range(10):
                bus.emit("timer.tick", {"tick": index})
            self.assertLessEqual(ring.available(), 2)
            self.assertGreaterEqual(ring.dropped, 8)
            with self.assertRaises(RingFull):  # direkter Schreibpfad bleibt streng
                ring.write({"kind": "x"})
        finally:
            ring.unlink()


class TestUdsBroadcast(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-uds-")
        self.sock = Path(self._tmp.name) / "bus.sock"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_zustellung_ueber_socket(self) -> None:
        with UDSBroadcastServer(self.sock) as server:
            sink = UDSBroadcastSink(self.sock)
            try:
                bus = EventBus([sink])
                for index in range(3):
                    bus.emit("timer.tick", {"tick": index}, job_id="job_x", clock_s=1.0)
                got = server.records(timeout_s=1.0)
                self.assertEqual([r["payload"]["tick"] for r in got], [0, 1, 2])
                self.assertTrue(all(r["job_id"] == "job_x" for r in got))
                self.assertTrue(sink.connected)
            finally:
                sink.close()

    def test_ohne_empfaenger_kein_absturz(self) -> None:
        sink = UDSBroadcastSink(self.sock)  # niemand lauscht
        try:
            for index in range(4):
                sink.write_prepared({}, json.dumps({"seq": index}))
            stats = sink.stats()
            self.assertFalse(stats["connected"])
            self.assertEqual(stats["sent"], 0)
            self.assertEqual(stats["dropped"], 4)
        finally:
            sink.close()

    def test_batch_liefert_mehrere_events_pro_syscall(self) -> None:
        with UDSBroadcastServer(self.sock) as server:
            sink = UDSBroadcastSink(self.sock, batch_bytes=4096)
            try:
                for index in range(20):
                    sink.write_prepared({}, json.dumps({"seq": index, "kind": "timer.tick"}))
                self.assertEqual(sink.sent, 0, "vor dem flush darf nichts gesendet sein")
                sink.flush()
                records = server.records(timeout_s=1.0)
                self.assertEqual(len(records), 20, "ein Datagramm traegt den ganzen Batch")
            finally:
                sink.close()

    def test_socket_rechte_0600(self) -> None:
        with UDSBroadcastServer(self.sock):
            mode = self.sock.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600, "Beobachtungs-Socket darf nicht weltlesbar sein")
        self.assertFalse(self.sock.exists(), "tail-Exit muss den Pfad entfernt haben")


class TestCompiledConditions(unittest.TestCase):
    def setUp(self) -> None:
        _CONDITION_CACHE.clear()

    tearDown = setUp

    def test_gecacht_ergibt_dasselbe_wie_roh(self) -> None:
        cases = ("elapsed >= 6", "elapsed<5", "  elapsed == 10  ", "elapsed != 0.5", "elapsed<=0.25", "elapsed > 1")
        for text in cases:
            with self.subTest(when=text):
                self.assertEqual(parse_condition(text), _compile_condition(text))
                self.assertEqual(parse_condition(text), _compile_condition(text))  # Cache-Treffer
        for elapsed in (0.0, 0.24, 0.26, 4.999, 5.0, 9.8, 10.1, 10.4):
            for text in cases:
                self.assertEqual(
                    evaluate_condition(text, elapsed),
                    _reference_evaluate(text, elapsed),
                    f"{text} bei {elapsed}",
                )

    def test_ungueltige_bedingung_zeigt_rohen_text(self) -> None:
        for bad in ("", "   ", "elapsed ?? 3", "seconds >= 3", "elapsed >"):
            with self.subTest(when=bad), self.assertRaises(ProtocolError) as caught:
                parse_condition(bad)
            self.assertIn("when", str(caught.exception))

    def test_cache_ist_gebunden(self) -> None:
        from orchestrator import scheduler as module

        for index in range(module._CONDITION_CACHE_MAX + 50):
            parse_condition(f"elapsed >= {index}")
        self.assertLessEqual(len(_CONDITION_CACHE), module._CONDITION_CACHE_MAX)

    def test_fehler_werden_nicht_gecacht(self) -> None:
        with self.assertRaises(ProtocolError):
            parse_condition("elapsed ~~~ 3")
        self.assertNotIn("elapsed ~~~ 3", _CONDITION_CACHE)


def _reference_evaluate(when: str, elapsed: float, tolerance_s: float = 0.25) -> bool:
    """Der alte Auswerter: pro Aufruf neu geparst, ohne jeden Cache."""
    op, value = _compile_condition(when)
    if op == "<=":
        return elapsed <= value
    if op == ">=":
        return elapsed >= value
    if op == "==":
        return abs(elapsed - value) <= tolerance_s
    if op == "!=":
        return abs(elapsed - value) > tolerance_s
    if op == "<":
        return elapsed < value
    return elapsed > value


class TestCachedClockAnchor(unittest.TestCase):
    def test_memoisierte_epoche_ist_identisch_zum_parse(self) -> None:
        for seconds_ago in (0, 0.25, 1.5, 3600.75, 86_400):
            stamp = (datetime.now(UTC) - timedelta(seconds=seconds_ago)).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z")
            self.assertAlmostEqual(timestamp_epoch_s(stamp, "$.t0"), parse_timestamp(stamp, "$.t0").timestamp(), places=6)

    def test_schnellpfad_und_now_pfad_decken_sich(self) -> None:
        from orchestrator.scheduler import ScheduleState

        t0 = datetime.now(UTC) - timedelta(seconds=3)
        state = ScheduleState(job_id="job_t", t0=t0.isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        moment = datetime.now(UTC)
        fast = state.elapsed_s()
        slow = state.elapsed_s(now=moment)
        self.assertGreater(fast, 2.5)
        self.assertAlmostEqual(slow, 3.0, delta=1.0)
        # Der ``now``-Pfad ist deterministisch: gleicher Moment -> gleicher Wert.
        self.assertEqual(state.elapsed_s(now=moment), slow)

    def test_timer_elapsed_gegen_manuelle_rechnung(self) -> None:
        from core.protocol import Timer

        stamp = (datetime.now(UTC) - timedelta(seconds=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        timer = Timer(mode="unlimited", t0=stamp)
        self.assertAlmostEqual(timer.elapsed(), 7.0, delta=0.5)
        self.assertEqual(timer.elapsed(now=datetime.fromisoformat(stamp.replace("Z", "+00:00"))), 0.0)


class TestLedgerIndex(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="neu-ledger-")
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

    def _archive(self, count: int) -> list[str]:
        ids: list[str] = []
        for index in range(count):
            intent = self.kernel.build_intent(
                operation="sys.echo", params={"message": f"m{index}"}, limb="echo", goal=f"Goal {index}"
            )
            result = Result(
                result_id=new_id("res"),
                intent_id=intent.intent_id,
                trace_id=intent.trace_id,
                status="success",
                operation="sys.echo",
                limb_name="echo",
                started_at=utc_now_iso(),
                finished_at=utc_now_iso(),
                output={"echo": f"m{index}"},
            )
            self.transport.archive(intent, result, {"verdict": "accept", "iteration": intent.iteration})
            ids.append(intent.intent_id)
        return ids

    def _age_entries(self, days: int = 10) -> None:
        cutoff = time.time() - days * 86400
        for day_dir in self.config.archive_dir.iterdir():
            if day_dir.is_dir() and day_dir.name != "compacted":
                for entry in day_dir.iterdir():
                    if entry.is_dir():
                        os.utime(entry, (cutoff, cutoff))

    def test_suche_findet_kompaktierte_und_expandierte_eintraege(self) -> None:
        ids = self._archive(6)
        # expandiert (frisch): findet ohne Snapshot-Index
        fresh = self.transport.lookup_archived(ids[0])
        self.assertIsNotNone(fresh)
        self.assertFalse(fresh["compacted"])
        self.assertEqual(fresh["intent"]["intent_id"], ids[0])

        self._age_entries()
        summary = self.transport.compact_archive(older_than_days=7, keep_recent=2)
        self.assertEqual(summary["pruned_dirs"], 4)
        self.assertEqual(self.transport.verify_archive(), [])

        resolved = [self.transport.lookup_archived(intent_id) for intent_id in ids]
        self.assertTrue(all(res is not None for res in resolved), "kein Eintrag darf bei der Suche verloren gehen")
        compacted = [res for res in resolved if res["compacted"]]
        expanded = [res for res in resolved if not res["compacted"]]
        self.assertEqual(len(compacted), 4)
        self.assertEqual(len(expanded), 2, "keep_recent bleibt expandiert (attempt.archive_dir)")
        for entry in compacted:
            self.assertIn("intent.json", entry["record"]["files"])
            self.assertEqual(entry["record"]["files"]["result.json"]["status"], "success")

    def test_index_sidecar_wird_mitgeschrieben_und_neu_aufgebaut(self) -> None:
        ids = self._archive(4)
        self._age_entries()
        self.transport.compact_archive(older_than_days=7, keep_recent=0)
        snapshot = sorted((self.config.archive_dir / "compacted").glob("*.jsonl"))[0]
        sidecar = snapshot.with_name(snapshot.stem + INDEX_SUFFIX)
        self.assertTrue(sidecar.is_file())
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(payload["field"], "intent_id")
        self.assertEqual(payload["count"], 4)
        self.assertIn(ids[2], payload["offsets"])

        # Index fehlt -> Suche muss denselben Datensatz finden (Neuaufbau per Scan)
        sidecar.unlink()
        self.transport._index_cache.clear()
        found = self.transport.lookup_archived(ids[2])
        self.assertIsNotNone(found)
        self.assertTrue(found["compacted"])
        self.assertTrue(sidecar.is_file(), "der Neuaufbau darf den Index nicht nur im Kopf behalten")

    def test_verdorbener_index_liefert_nie_fremden_datensatz(self) -> None:
        ids = self._archive(4)
        self._age_entries()
        self.transport.compact_archive(older_than_days=7, keep_recent=0)
        snapshot = sorted((self.config.archive_dir / "compacted").glob("*.jsonl"))[0]
        sidecar = snapshot.with_name(snapshot.stem + INDEX_SUFFIX)
        broken = json.loads(sidecar.read_text(encoding="utf-8"))
        offsets = broken["offsets"]
        offsets[ids[0]] = offsets[ids[1]]  # Zeiger absichtlich verstellt
        sidecar.write_text(json.dumps(broken), encoding="utf-8")
        self.transport._index_cache.clear()
        found = self.transport.lookup_archived(ids[0])
        self.assertIsNotNone(found)
        self.assertEqual(found["record"]["intent_id"], ids[0], "Paritaetspruefung muss den Scan erzwingen")

    def test_manipulation_faellt_beiden_pradpfaden_auf(self) -> None:
        self._archive(4)
        self._age_entries()
        self.transport.compact_archive(older_than_days=7, keep_recent=0)
        snapshot = sorted((self.config.archive_dir / "compacted").glob("*.jsonl"))[0]
        self.assertEqual(self.transport.verify_archive(), [])
        raw = bytearray(snapshot.read_bytes())
        probe = raw.find(b'"output"')
        self.assertGreater(probe, 0)
        raw[probe + 1] = ord("X")
        snapshot.write_bytes(bytes(raw))
        fast = self.transport.verify_archive()
        deep = self.transport.verify_archive(force=True)
        self.assertTrue(fast, "Digest-Schnellpfad darf Manipulation nicht durchlassen")
        self.assertTrue(deep)
        self.assertIn("SHA-256 verletzt", fast[0])

    def test_statistik_zaehlt_aus_dem_manifest(self) -> None:
        self._archive(5)
        self._age_entries()
        self.transport.compact_archive(older_than_days=7, keep_recent=1)
        stats = self.transport.archive_stats()
        day = next(iter(stats["compacted"]))
        info = stats["compacted"][day]
        self.assertEqual(info["records"], 4)
        self.assertEqual(info["source"], "manifest")
        self.assertTrue(info["indexed"])
        self.assertEqual(stats["total_entries"], 1, "keep_recent=1 bleibt expandiert")

    def test_auto_kompaktierung_spurt_nur_bei_genuegend_altlast(self) -> None:
        """Unter der Schwelle passiert nichts; darueber wird das Ledger gebunden."""
        os.environ["NEU_ARCHIVE_AUTOCOMPACT"] = "1"
        os.environ["NEU_ARCHIVE_MIN_STALE"] = "1"
        os.environ["NEU_ARCHIVE_KEEP_RECENT"] = "2"
        try:
            self._archive(3)
            skipped = self.transport.maybe_compact()
            self.assertTrue(skipped["skipped"], "frische Eintraege bleiben unberuehrt")
            self.assertFalse((self.config.archive_dir / "compacted").exists())

            ids = self._archive(12)
            self._age_entries()  # alle 15 Eintraege gelten damit als veraltet
            result = self.transport.maybe_compact()
            self.assertFalse(result["skipped"], "ab Schwelle wird kompaktiert")
            self.assertEqual(result["pruned_dirs"], 13, "die neuesten 2 bleiben expandiert")
            self.assertEqual(self.transport.verify_archive(), [])
            stats = self.transport.archive_stats()
            self.assertEqual(stats["total_entries"], 2)
            self.assertEqual(stats["compacted"][next(iter(stats["compacted"]))]["records"], 13)
            self.assertTrue(
                all(self.transport.lookup_archived(intent_id) for intent_id in ids),
                "nach der Selbstpflege muss jeder Durchgang weiter auffindbar sein",
            )
        finally:
            for key in ("NEU_ARCHIVE_MIN_STALE", "NEU_ARCHIVE_KEEP_RECENT"):
                os.environ.pop(key, None)

    def test_autocompact_knob_deaktiviert(self) -> None:
        os.environ["NEU_ARCHIVE_AUTOCOMPACT"] = "0"
        self._age_entries()
        self._archive(2)
        self.assertTrue(self.transport.maybe_compact()["skipped"])


class UDSStaleSocketTests(unittest.TestCase):
    """Betriebsfaelle nach einem Absturz: stale Inode frei raumen, lebenden zuerkennen."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.sock = self.tmp / "bus.sock"
        self.addCleanup(self._tmp.cleanup)

    def _spawn_dead_listener(self) -> None:
        """Ein Kind bindet den Socket und wird gekillt -- so entsteht ein stale Inode."""
        child = subprocess.Popen(
            [sys.executable, "-c", f"import socket,time;s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);"
             f"s.bind({str(self.sock)!r});time.sleep(30)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 5.0
        while not self.sock.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        child.kill()
        child.wait(timeout=5)
        self.assertTrue(self.sock.exists(), "Kernel hat den Socket beim Kill nicht zurueckgelassen")

    def test_stale_socket_wird_uebernommen(self) -> None:
        self._spawn_dead_listener()
        server = UDSBroadcastServer(self.sock)  # darf nicht an "Address already in use" scheitern
        self.addCleanup(server.close)
        sink = UDSBroadcastSink(self.sock)
        self.addCleanup(sink.close)
        self.assertTrue(sink.connected)
        sink.write_prepared({}, json.dumps({"seq": 1, "kind": "tick"}))
        records = server.records(timeout_s=1.0)
        self.assertEqual([r["kind"] for r in records], ["tick"])

    def test_lebender_listener_wird_nicht_ueberschrieben(self) -> None:
        server = UDSBroadcastServer(self.sock)
        self.addCleanup(server.close)
        with self.assertRaises(OSError):
            UDSBroadcastServer(self.sock)
        self.assertTrue(self.sock.is_socket())

    def test_probe_blockiert_nicht_auf_lebendem_listener(self) -> None:
        server = UDSBroadcastServer(self.sock)
        self.addCleanup(server.close)
        started = time.perf_counter()
        with self.assertRaises(OSError):
            UDSBroadcastServer(self.sock)
        self.assertLess(time.perf_counter() - started, 0.5)


if __name__ == "__main__":
    unittest.main()
