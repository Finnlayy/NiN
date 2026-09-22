#!/usr/bin/env python3
"""Benchmark fuer Nexus-Triad Nr.2 und Nr.3 (siehe ``.nio/nexus.md``).

Misst die drei Fokusbereiche des kontinuierlichen Loops gegen den Stand nach
Triad Nr.1. Moeglichst werden *beide* Pfade im selben Prozess gemessen (alter
Code als Referenz-Klasse bzw. der bewusste Umweg ueber die Fallback-Methode),
damit der Delta nicht aus einer Zahl im Kommentar hochgerechnet wird:

* **Focus A -- Sub-ms IPC / Event-Bus:** Serialisierung pro Sink (Triad 1) vs.
  genau einmal pro Emit mit geteilter Zeile (Triad 2); dazu UDS-Broadcast gegen
  Konsole/Datei und der Shared-Memory-Ring mit und ohne vorbereitete Zeile.
* **Focus B -- Fast-Path-Validierung:** Bedingungs-Analyse pro Tick (gecachter
  Compiler vs. rohes Parsen pro Aufruf) und Uhr-Anker (memoisierte Epoche vs.
  ``parse_timestamp`` pro Tick).
* **Focus C -- Ledger:** Einzelsatz-Suche ueber Offset-Index vs. kompletten
  Snapshot einlesen; Statistik aus dem Manifest vs. Scan; Integritaetspruefung
  ueber Tages-Digest vs. tiefes Re-Hashen (das einzige Verhalten vor Triad 2).

Ausgabe ist maschinenlesbar (JSON) auf stdout. Laufzeit ~15-30 s, keine
externen Abhaengigkeiten (Python 3.11 Standardbibliothek).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from collections.abc import Mapping
from dataclasses import replace as _replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parent.parent
for _entry in (str(Path(__file__).resolve().parent), str(_REPO), str(_REPO / "orchestrator"), str(_REPO / "core")):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from core.atomic import atomic_write_bytes  # noqa: E402
from core.config import NeuConfig  # noqa: E402
from core.job import JobStore  # noqa: E402
from core.kernel import Kernel  # noqa: E402
from core.protocol import Operations, Result, new_id, parse_timestamp, sha256_bytes, utc_now, utc_now_iso  # noqa: E402
from core.schemacheck import validate as v_validate  # noqa: E402
from orchestrator.events import ConsoleSink, Event, EventBus, _iso_ms_z_fast  # noqa: E402
from orchestrator.ring import SharedMemoryRingSink  # noqa: E402
from orchestrator.scheduler import (  # noqa: E402
    _CONDITION_CACHE,
    Scheduler,
    ScheduleState,
    _compile_condition,
    evaluate_condition,
)
from orchestrator.transport import FileTransport, dir_bytes, read_jsonl, write_json_atomic  # noqa: E402
from orchestrator.uds import UDSBroadcastServer, UDSBroadcastSink  # noqa: E402

#: Referenzpunkte aus dem Journal. ``*_triad0`` = Commit ``2639525`` (vor jedem
#: Nexus-Eingriff), ``*_triad1`` = Stand nach Triad Nr.1 und damit die Baseline,
#: gegen die dieser Triad antritt.
REFERENCE_BASELINE = {
    "emit_null_us_triad0": 2.81,
    "emit_null_us_triad1": 1.99,
    "emit_collect_us_triad1": 3.20,
    "ring_write_us_triad1": 4.70,
    "validate_us_triad0": 77.20,
    "validate_us_triad1": 60.7,
    "condition_eval_us_triad1": 0.841,
    "elapsed_s_us_triad1": 1.523,
    "lookup_scan_us_triad1": 7622.8,
    "verify_us_triad1": 21093.7,
    "stats_us_triad1": 7597.7,
}

_REPEAT = 150_000
#: So viele Ausloeser haelt ein Auftrag im Extremfall (``--trigger`` pro CLI-Zeile).
_TRIGGERS_PER_JOB = 8


def measure(fn: Any, n: int = _REPEAT, warm: int | None = None, between: Any = None) -> float:
    """Mikrosekunden pro Aufruf; Median aus drei Laeufen gegen Messrauschen.

    ``between`` wird vor jedem Lauf aufgerufen -- noetig fuer Pfade mit
    gebundenen Ressourcen (Socket-Buffer, Ring-Slots), die sonst mitten in der
    Messung voll laufen und eine andere Arbeit messen als die intendierte.
    """
    runs: list[float] = []
    for _ in range(3):
        for _ in range(warm if warm is not None else max(50, n // 20)):
            fn()
        if between is not None:
            between()
        start = time.perf_counter_ns()
        for _ in range(n):
            fn()
        runs.append((time.perf_counter_ns() - start) / n / 1000.0)
    runs.sort()
    return round(runs[len(runs) // 2], 3)


def drain_socket(server: Any) -> None:
    """Leert den Socket leer (einmal pro Messlauf, nicht pro Event)."""
    while server.recv_batch(timeout_s=0.0):
        pass


class LegacySink:
    """Console-Sink-Stand nach Triad 1: serialisiert **pro Sink** selbst, mit flush."""

    name = "legacy_console"

    def __init__(self, stream: Any) -> None:
        self.stream = stream

    def write(self, record: Mapping[str, Any]) -> None:
        self.stream.write(json.dumps(dict(record), ensure_ascii=False) + "\n")
        self.stream.flush()


class NullSink:
    name = "null"

    @staticmethod
    def write(record: Mapping[str, Any]) -> None:
        return None


def _legacy_emit(bus: EventBus, kind: str, payload: dict[str, Any], *, job_id: str, clock_s: float) -> None:
    """Replikat des ``emit``-Kerns nach Triad 1 -- inkl. des ``Event``, den der Bus
    immer noch zurueckgibt (und das jeder Aufrufer verwirft: 1,4 µs vom 3,0-µs-
    Emit-Fussboden, der groeste einzelne Posten dort).

    Nur fuer den Vergleich gemessen: zeigt, was der Getattr-Test kostet, den der
    Shared-Line-Pfad pro Sink zahlt.
    """
    bus._seq += 1
    seq = bus._seq
    payload_copy = dict(payload) if payload else {}
    clock = None if clock_s is None else round(float(clock_s), 3)
    timestamp = _iso_ms_z_fast()
    record = {
        "seq": seq,
        "timestamp": timestamp,
        "kind": kind,
        "job_id": job_id,
        "trace_id": "",
        "intent_id": "",
        "limb": "",
        "clock_s": clock,
        "payload": payload_copy,
    }
    for sink in bus.sinks:
        sink.write(record)
    bus_ret = Event(
        kind=kind,
        payload=payload_copy,
        seq=seq,
        timestamp=timestamp,
        job_id=job_id,
        trace_id="",
        intent_id="",
        limb="",
        clock_s=clock,
    )
    del bus_ret


def bench_focus_a(results: dict[str, Any]) -> None:
    """Fokus A: Serialisierung einmal pro Emit statt pro Sink, plus UDS-Zweig.

    Alle Vergleiche laufen in *einem* Prozess ohne Begleit-Thread: ein zweiter
    Thread wuerde ueber das GIL Messrauschen in die Producer-Zahlen mischen.
    Gebundene Ressourcen (Socket-Buffer, Ring-Slots) werden zwischen den Laeufen
    geleert, nicht pro Event.
    """
    payload = {"tick": 42, "tick_s": 0.5, "fired": 0}
    emit = lambda bus: bus.emit("timer.tick", payload, job_id="job_x", clock_s=1.0)  # noqa: E731
    tmp = Path(tempfile.mkdtemp(prefix="nexus-bus-"))

    # 1) Emit ohne Text-Sink -- Regressionsschutz fuer Triad 1 / Cycle 1
    null_bus = EventBus([NullSink()])
    emit_null = measure(lambda: emit(null_bus))
    emit_null_before = measure(lambda: _legacy_emit(null_bus, "timer.tick", payload, job_id="job_x", clock_s=1.0))

    # 2) Ein Text-Sink auf echter Datei: Serialisierung im Sink (Triad 1) gegen
    #    die vorserialisierte Zeile (Triad 2). Schreib- und Flush-Arbeit ist auf
    #    beiden Seiten identisch, gemessen wird also nur die Delta der Serialisierung.
    log_path = tmp / "events.jsonl"
    legacy_fd = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
    legacy_bus = EventBus([LegacySink(legacy_fd)])
    legacy_write = measure(lambda: emit(legacy_bus), n=20_000)
    legacy_fd.close()
    fast_fd = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
    fast_bus = EventBus([ConsoleSink(stream=fast_fd)])
    fast_write = measure(lambda: emit(fast_bus), n=20_000)
    fast_fd.close()

    # 3) Fanout: drei Mitleser. Vorher fiel die Serialisierung dreimal an,
    #    jetzt laeuft sie genau einmal und die Zeile wird geteilt.
    three_legacy_fd = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
    three_fast_fd = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
    bus_legacy3 = EventBus([LegacySink(three_legacy_fd)] * 3)
    bus_fast3 = EventBus([ConsoleSink(stream=three_fast_fd)] * 3)
    fanout_before = measure(lambda: emit(bus_legacy3), n=20_000)
    fanout_after = measure(lambda: emit(bus_fast3), n=20_000)
    three_legacy_fd.close()
    three_fast_fd.close()

    # 4) UDS-Zweig (opt-in). Der Receive-Buffer ist begrenzt (hier ~212 KB),
    #    also wird *zwischen* den Laeufen geleert, nie pro Event, und die
    #    Lauflaengen bleiben unterhalb der Saturation -- sonst misst man die
    #    EAGAIN-Abwurfbehandlung statt den Socket.
    sock_path = tmp / "bus.sock"
    server = UDSBroadcastServer(sock_path)
    try:
        sink = UDSBroadcastSink(sock_path)
        bus_uds = EventBus([sink])
        uds_emit = measure(
            lambda: emit(bus_uds), n=150, warm=0, between=lambda: drain_socket(server)
        )
        batched = UDSBroadcastSink(sock_path, batch_bytes=8192)
        bus_batched = EventBus([batched])

        def batched_round() -> None:
            """64 Events pro Syscall: Produzent fuellt, Konsument leert -- amortisiert."""
            for _ in range(64):
                bus_batched.emit("timer.tick", payload, job_id="job_x", clock_s=1.0)
            batched.flush()
            drain_socket(server)

        uds_batched = measure(batched_round, n=6, warm=0) / 64

        def round_trip() -> None:
            sink.write_prepared({}, '{"kind":"timer.tick","seq":1}')
            server.recv_batch(timeout_s=0.5)

        uds_round_trip = measure(round_trip, n=800, warm=0, between=lambda: drain_socket(server))

        # Burst-Betrieb (der Realfall eines tail-Konsumenten): 32 Events produzieren,
        # einmal abholen. Das zeigt, was ein Mitleser *pro Event* kostet, wenn er
        # nicht jedes Datagramm einzeln holt.
        burst_line = '{"seq":1,"kind":"timer.tick","payload":{"tick":42}}'

        def burst_round() -> None:
            for _ in range(32):
                sink.write_prepared({}, burst_line)
            server.recv_batch(timeout_s=0.5)

        uds_burst = measure(burst_round, n=120, warm=0, between=lambda: drain_socket(server)) / 32

        # Saettigungsfall: kein Konsument, Buffer voll -> Wegwerfen statt Blockieren.
        drain_socket(server)
        saturated = measure(lambda: emit(bus_uds), n=2_000, warm=0)
        stats = sink.stats()
        sink.close()
        batched.close()
    finally:
        server.close()

    # 5) Shared-Memory-Ring: selbst serialisieren (Triad 1) gegen vorbereitete Zeile.
    #    Der Ring ist gebunden, also Kapazitaet fuer die komplette Messung.
    record = {
        "seq": 1,
        "timestamp": "2026-09-07T00:00:00.000Z",
        "kind": "timer.tick",
        "job_id": "job_x",
        "trace_id": "",
        "intent_id": "",
        "limb": "echo",
        "clock_s": 1.0,
        "payload": payload,
    }
    ring_n = 20_000
    ring_slots = ring_n * 3 + ring_n // 20 + 8
    ring_old = SharedMemoryRingSink(capacity=ring_slots, slot_size=512)
    ring_new = SharedMemoryRingSink(capacity=ring_slots, slot_size=512)
    ring_line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    ring_new_bus = EventBus([ring_new])
    try:
        # Apfel-gegen-Apfel: *nur* der Sink-Schreibvorgang, einmal mit eigener
        # Serialisierung (Triad 1) und einmal mit der vom Bus gelieferten Zeile.
        ring_self_serialized = measure(lambda: ring_old.write(record), n=ring_n, warm=8)
        ring_prepared = measure(lambda: ring_new.write_prepared(record, ring_line), n=ring_n, warm=8)
        ring_emit = measure(lambda: emit(ring_new_bus), n=ring_n, warm=8)
    finally:
        ring_old.unlink()
        ring_new.unlink()

    results["focus_a"] = {
        "emit_null_us": emit_null,
        "emit_null_triad1_replica_us": emit_null_before,
        # "Marginal" = was der *eine* zusaetzliche Sink kostet, nachdem der Bus
        # selbst (Seq, Zeitstempel, Record, Zeile) abgezogen ist. Nur diese Zahl
        # ist zwischen Transporten vergleichbar.
        "uds_sink_marginal_us": round(uds_emit - emit_null, 3),
        "ring_sink_marginal_us": round(ring_emit - emit_null, 3),
        "emit_null_reference_triad0_us": REFERENCE_BASELINE["emit_null_us_triad0"],
        "emit_null_reference_triad1_us": REFERENCE_BASELINE["emit_null_us_triad1"],
        "one_sink_serialize_in_sink_us": legacy_write,
        "one_sink_shared_line_us": fast_write,
        "one_sink_delta_us": round(legacy_write - fast_write, 3),
        "one_sink_speedup_x": round(legacy_write / fast_write, 2),
        "fanout_3_sinks_before_us": fanout_before,
        "fanout_3_sinks_after_us": fanout_after,
        "fanout_3_sinks_delta_us": round(fanout_before - fanout_after, 3),
        "fanout_speedup_x": round(fanout_before / fanout_after, 2),
        "uds_emit_us": uds_emit,
        "uds_round_trip_us": uds_round_trip,
        "uds_burst_per_event_us": round(uds_burst, 3),
        "uds_batched_per_event_us": round(uds_batched, 3),
        "uds_batch_events_per_syscall": 64,
        "uds_saturated_drop_path_us": saturated,
        "uds_sent": stats["sent"],
        "uds_dropped": stats["dropped"],
        "ring_self_serialized_us": ring_self_serialized,
        "ring_prepared_line_us": ring_prepared,
        "ring_delta_us": round(ring_self_serialized - ring_prepared, 3),
        "ring_speedup_x": round(ring_self_serialized / ring_prepared, 2),
        "ring_emit_total_us": ring_emit,
        "ring_reference_triad1_us": REFERENCE_BASELINE["ring_write_us_triad1"],
    }


def bench_focus_b(results: dict[str, Any]) -> None:
    when = "elapsed >= 6"
    raw_parse = measure(lambda: _compile_condition(when))
    cached_eval = measure(lambda: evaluate_condition(when, 3.5))
    # "Vorher" = jeder Tick parst neu. Das emuliert der Cache-Leerlauf, denn der
    # Parse war exakt der teure Teil des alten ``evaluate_condition``.
    _CONDITION_CACHE.clear()
    uncached_eval = measure(lambda: (_CONDITION_CACHE.clear(), evaluate_condition(when, 3.5)), n=30_000, warm=50)
    _CONDITION_CACHE.clear()
    per_tick_before = uncached_eval * _TRIGGERS_PER_JOB
    per_tick_after = cached_eval * _TRIGGERS_PER_JOB

    t0 = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    state = ScheduleState(job_id="job_bench", t0=t0, tick_s=0.05)
    elapsed_after = measure(lambda: state.elapsed_s(), n=100_000)

    def elapsed_before() -> float:
        """Wortgleich der Triad-1-Pfad: datetime-Anker pro Aufruf neu geparst."""
        return round(max(0.0, (utc_now() - parse_timestamp(t0, "$.schedule.t0")).total_seconds()), 3)

    elapsed_before_us = measure(elapsed_before, n=100_000)

    config = NeuConfig.load(_REPO, mode="dev", runtime_dir=Path(tempfile.mkdtemp(prefix="neu-bench-")) / "runtime")
    config.ensure_dirs()
    ops = Operations.load(config.protocol_dir / "operations.json")
    kernel = Kernel(config, ops)
    intent = kernel.build_intent(operation="sys.echo", params={"message": "ping"}, limb="echo", goal="Bench")
    schema = json.loads((config.protocol_dir / "intent.schema.json").read_text(encoding="utf-8"))
    data = intent.to_dict()
    validate_us = measure(lambda: v_validate(data, schema), n=4_000, warm=200)
    errors = v_validate({"bad": "x"}, {"type": "object", "required": ["x"]})
    assert errors, "Pruefer darf Fehler nicht durchwinken"

    results["focus_b"] = {
        "condition_parse_raw_us": raw_parse,
        "condition_eval_cached_us": cached_eval,
        "condition_eval_uncached_us": round(uncached_eval, 3),
        "condition_reference_triad1_us": REFERENCE_BASELINE["condition_eval_us_triad1"],
        "condition_speedup_x": round(uncached_eval / cached_eval, 2),
        "condition_per_tick_8_triggers_before_us": round(per_tick_before, 3),
        "condition_per_tick_8_triggers_after_us": round(per_tick_after, 3),
        "elapsed_after_us": elapsed_after,
        "elapsed_before_us": elapsed_before_us,
        "elapsed_delta_us": round(elapsed_before_us - elapsed_after, 3),
        "elapsed_speedup_x": round(elapsed_before_us / elapsed_after, 2),
        "elapsed_reference_triad1_us": REFERENCE_BASELINE["elapsed_s_us_triad1"],
        "schema_validate_us": validate_us,
        "schema_reference_triad0_us": REFERENCE_BASELINE["validate_us_triad0"],
        "schema_reference_triad1_us": REFERENCE_BASELINE["validate_us_triad1"],
        "tick_savings_us": round(per_tick_before - per_tick_after + (elapsed_before_us - elapsed_after), 3),
    }


def _archive_fixture(entries: int = 400) -> tuple[FileTransport, NeuConfig, list[str]]:
    rt = Path(tempfile.mkdtemp(prefix="neu-arch-bench-"))
    os.environ["NEU_ARCHIVE_AUTOCOMPACT"] = "0"  # die manuelle Kompaktierung wird gemessen
    config = NeuConfig.load(_REPO, mode="dev", runtime_dir=rt / "runtime")
    config.ensure_dirs()
    ops = Operations.load(config.protocol_dir / "operations.json")
    kernel = Kernel(config, ops)
    transport = FileTransport(config)
    ids: list[str] = []
    for index in range(entries):
        intent = kernel.build_intent(
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
        transport.archive(intent, result, {"verdict": "accept", "iteration": intent.iteration})
        ids.append(intent.intent_id)
    return transport, config, ids


def bench_focus_c(results: dict[str, Any]) -> None:
    transport, config, ids = _archive_fixture(400)
    before = transport.archive_stats()
    cutoff = time.time() - 10 * 86400
    for day_dir in config.archive_dir.iterdir():
        if day_dir.is_dir() and day_dir.name != "compacted":
            for entry in day_dir.iterdir():
                if entry.is_dir():
                    os.utime(entry, (cutoff, cutoff))

    started = time.perf_counter()
    summary = transport.compact_archive(older_than_days=7, keep_recent=8)
    compact_ms = round((time.perf_counter() - started) * 1000, 2)
    after = transport.archive_stats()
    snapshot_files = sorted((config.archive_dir / "compacted").glob("*.jsonl"))
    snapshot = snapshot_files[0]
    target = ids[len(ids) // 2]

    def scan_lookup() -> Any:
        """Der einzige Weg vor Triad 2: ganze Datei lesen, Zeile fuer Zeile parseen."""
        return next((record for record in read_jsonl(snapshot) if record.get("intent_id") == target), None)

    scan_us = measure(scan_lookup, n=60, warm=5)
    indexed_us = measure(lambda: transport.lookup_archived(target), n=5_000, warm=200)
    sidecar = snapshot.with_name(snapshot.stem + ".index.json")
    sidecar.unlink()
    transport._index_cache.clear()
    cold_us = measure(lambda: (transport._index_cache.clear(), transport.lookup_archived(target)), n=6, warm=0)
    assert transport.lookup_archived(target), "Kalter Neuaufbau muss denselben Datensatz finden"

    def stats_by_scan() -> int:
        return sum(len(read_jsonl(path)) for path in snapshot_files)

    stats_before = measure(stats_by_scan, n=60, warm=5)
    stats_after = measure(lambda: transport.archive_stats(), n=60, warm=5)
    verify_deep = measure(lambda: transport.verify_archive(force=True), n=20, warm=3)
    verify_fast = measure(lambda: transport.verify_archive(), n=200, warm=20)
    gate_us = measure(lambda: transport.stale_entry_count(), n=200, warm=20)

    # Integritaet: Manipulation muss beiden Pradpfaden auffallen
    assert transport.verify_archive() == []
    raw = bytearray(snapshot.read_bytes())
    raw[raw.find(b'"output"') + 1] = ord("X")
    snapshot.write_bytes(bytes(raw))
    tamper_fast = len(transport.verify_archive())
    tamper_deep = len(transport.verify_archive(force=True))

    results["focus_c"] = {
        "entries_before": before["total_entries"],
        "expanded_after": after["total_entries"],
        "pruned_dirs": summary["pruned_dirs"],
        "compact_ms": compact_ms,
        "bytes_freed": summary["bytes_freed"],
        "snapshot_bytes": summary["snapshot_bytes"],
        "index_bytes": summary["index_bytes"],
        "index_overhead_pct": round(100.0 * summary["index_bytes"] / max(1, summary["snapshot_bytes"]), 2),
        "lookup_scan_us": round(scan_us, 3),
        "lookup_indexed_us": indexed_us,
        "lookup_speedup_x": round(scan_us / indexed_us, 1),
        "lookup_cold_rebuild_us": round(cold_us, 1),
        "lookup_reference_triad1_us": REFERENCE_BASELINE["lookup_scan_us_triad1"],
        "stats_scan_us": round(stats_before, 3),
        "stats_manifest_us": round(stats_after, 3),
        "stats_speedup_x": round(stats_before / stats_after, 1),
        "stats_reference_triad1_us": REFERENCE_BASELINE["stats_us_triad1"],
        "verify_deep_us": round(verify_deep, 3),
        "verify_digest_us": round(verify_fast, 3),
        "verify_speedup_x": round(verify_deep / verify_fast, 1),
        "verify_reference_triad1_us": REFERENCE_BASELINE["verify_us_triad1"],
        "stale_gate_us": gate_us,
        "tamper_detected_fast": tamper_fast,
        "tamper_detected_deep": tamper_deep,
        "violations_clean": 0,
    }



# ---------------------------------------------------------------------------
# Triad Nr.3, Cycle 1 -- atomarer JSON-Schreiber (Transport, Job-, Schedule-Zustand)
# ---------------------------------------------------------------------------


def _legacy_write_json_atomic(path: Path, data: Any, *, indent: int | None = 2) -> Path:
    """Der Schreibweg vor Triad Nr.3: NamedTemporaryFile + ``TextIOWrapper`` + fsync.

    Kopie des alten Kernels (inkl. ``os.fsync``), damit der Delta *hier* gemessen
    wird und nicht aus einem Kommentar hochgerechnet wird.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - delete=False ist Absicht: os.replace braucht die Datei
        "w", encoding="utf-8", delete=False, dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp"
    )
    try:
        with handle:
            json.dump(data, handle, ensure_ascii=False, indent=indent)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, target)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise
    return target


def bench_triad3_writer(results: dict[str, Any]) -> None:
    """Was kostet ein atomares JSON-Dokument -- vorher, nachher, und was davon der fsync ist."""
    tmp = Path(tempfile.mkdtemp(prefix="nio-bench-writer-"))
    tiny = {"a": 1, "b": [1, 2, 3], "t": "x"}
    intent_doc = {
        "intent_id": "intent_20260907T000000Z_000000",
        "job_id": "job_20260907T000000Z_000000",
        "operation": {"name": "sys.echo", "version": "1.2"},
        "params": {"message": "Beobachte die Lage"},
        "limits": {"max_iterations": 4, "max_runtime_s": 120},
        "trace_id": "trace_20260907T000000Z_000000",
        "goal": "Zeit tracken statt begrenzen",
        "context": {"recent_ops": ["sys.echo"] * 6},
    }
    index_doc = {f"key_{i}": [i, i * 2, "text"] for i in range(1500)}
    writer: dict[str, Any] = {}
    def legacy(doc: Any, label: str) -> Path:
        return _legacy_write_json_atomic(tmp / f"{label}.old.json", doc)

    def current(doc: Any, label: str) -> Path:
        return write_json_atomic(tmp / f"{label}.new.json", doc)

    def unsynced(doc: Any, label: str) -> Path:
        blob = (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        return atomic_write_bytes(tmp / f"{label}.nosync.json", blob)

    for label, doc in (("tiny", tiny), ("intent", intent_doc), ("index_44kb", index_doc)):
        old = measure(lambda doc=doc, label=label: legacy(doc, label), n=300, warm=30)
        new = measure(lambda doc=doc, label=label: current(doc, label), n=300, warm=30)
        nosync = measure(lambda doc=doc, label=label: unsynced(doc, label), n=300, warm=30)
        writer[f"{label}_before_us"] = old
        writer[f"{label}_after_us"] = new
        writer[f"{label}_fsync_floor_us"] = nosync
        writer[f"{label}_speedup_x"] = round(old / new, 2) if new else 0.0
        writer[f"{label}_delta_us"] = round(old - new, 1)
    results["triad3_writer"] = writer

    # --- Zustandsdateien: ScheduleState.save und JobRecord.save ---------------
    config = NeuConfig.load(
        _REPO,
        mode="dev",
        limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1, "max_scheduled_jobs": 1},
        runtime_dir=tmp / "runtime",
        workspace_dir=tmp / "workspace",
    )
    config.ensure_dirs()
    scheduler = Scheduler(config, bus=None)
    kernel = Kernel(config, Operations.load(config.protocol_dir / "operations.json"))
    jobs = JobStore(config)
    intent = kernel.build_intent(
        operation="sys.echo",
        params={"message": "m"},
        limb="echo",
        goal="Zeit tracken",
        unlimited=True,
        tick_s=0.05,
        schedule=[{"id": "takt", "action": "emit_event", "every_s": 0.05}],
    )
    record = jobs.create(intent.job.goal, timer_mode="unlimited", job_id=intent.job.job_id)
    state = scheduler.attach(intent, t0=record.created_at, force=True)
    assert state is not None
    origin = parse_timestamp(state.t0, "$.t0")
    clock = [0.0]

    def fired_tick() -> None:
        clock[0] += 0.05
        scheduler.tick(state, now=origin + timedelta(seconds=clock[0]))

    for _ in range(240):  # Historie bis an den Limit fuellen
        fired_tick()

    def legacy_save() -> None:
        state.updated_at = utc_now_iso()
        path = scheduler.path_for(state.job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmpf = path.with_suffix(".tmp")
        tmpf.write_text(json.dumps(state.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        tmpf.replace(path)

    def legacy_job_save() -> None:
        stamped = _replace(record, updated_at=utc_now_iso())
        path = jobs.path(stamped.job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmpf = path.with_suffix(".json.tmp")
        tmpf.write_text(json.dumps(stamped.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmpf.replace(path)

    state_before = measure(legacy_save, n=400, warm=40)
    state_after = measure(lambda: scheduler.save(state), n=400, warm=40)
    job_before = measure(legacy_job_save, n=400, warm=40)
    job_after = measure(lambda: jobs.save(record), n=400, warm=40)
    tick_after = measure(fired_tick, n=600, warm=60)

    # Derselbe Tick gegen den alten Speicherweg: die Klasse wird waehrend der
    # Messung auf den Vor-Triad-Kern gesetzt, damit beide Zahlen aus *einer*
    # Messreihe stammen (und nicht aus zwei Harnessen).
    real_save = Scheduler.save
    Scheduler.save = lambda self, st: legacy_save()  # type: ignore[method-assign]
    try:
        tick_before = measure(fired_tick, n=600, warm=60)
    finally:
        Scheduler.save = real_save
    tick_after = measure(fired_tick, n=600, warm=60)
    results["triad3_state"] = {
        "state_save_before_us": state_before,
        "state_save_after_us": state_after,
        "state_save_speedup_x": round(state_before / state_after, 2),
        "state_save_delta_us": round(state_before - state_after, 1),
        "state_file_bytes": scheduler.path_for(state.job_id).stat().st_size,
        "history_entries": len(state.history),
        "job_save_before_us": job_before,
        "job_save_after_us": job_after,
        "job_save_speedup_x": round(job_before / job_after, 2),
        "fired_tick_us_before": tick_before,
        "fired_tick_us_after": tick_after,
        "fired_tick_speedup_x": round(tick_before / tick_after, 2),
        "fired_tick_delta_us": round(tick_before - tick_after, 1),
    }



# ---------------------------------------------------------------------------
# Triad Nr.3, Cycle 2 -- Validierung auf dem Zustell-Pfad (Policy, Protokollprimitve)
# ---------------------------------------------------------------------------


def bench_triad3_validation(results: dict[str, Any]) -> None:
    """Policy-Pre-Flight und die Protokoll-Primitiven, alt gegen neu im selben Prozess.

    Der alte Weg wird nicht zitiert, sondern *rekonstruiert*: die betroffenen
    Modul-Funktionen werden waehrend der Messung auf ihr frueheres Verhalten
    zurueckgesetzt (Menge pro Aufruf neu gebaut, Linearscan fuer Enums,
    Whitespace-Gluettung immer, Sandbox-Wurzel pro Antwort zweimal aufgeloest).
    """
    import core.policy as policy_module
    import core.protocol as protocol_module
    from core.policy import Policy as _Policy
    from core.protocol import Trigger as _Trigger

    tmp = Path(tempfile.mkdtemp(prefix="nio-bench-valid-"))
    config = NeuConfig.load(
        _REPO,
        mode="dev",
        limits={"max_iterations": 4, "max_agents": 2, "max_limbs": 2, "max_concurrent_jobs": 2, "max_scheduled_jobs": 2},
        runtime_dir=tmp / "runtime",
        workspace_dir=tmp / "workspace",
    )
    config.ensure_dirs()
    operations = Operations.load(config.protocol_dir / "operations.json")
    kernel = Kernel(config, operations)
    policy = _Policy(config, operations)
    cold = _Policy(config, operations)
    intent = kernel.build_intent(operation="sys.echo", params={"message": "m"}, limb="echo", goal="g")

    raw_trigger = {"id": "takt", "action": "log", "every_s": 5.0, "when": "elapsed >= 30"}
    raw_trigger_many = {"id": "takt", "action": "check", "every_s": 5.0, "when": "elapsed  >=   30", "payload": {"operation": "sys.echo"}}
    validation: dict[str, Any] = {}

    # --- Primitiv: Trigger.from_dict mit und ohne pro-Aufruf-Mengenbau -------
    def legacy_primitives() -> Any:
        """Setzt die drei geaenderten Stellen auf ihr frueheres Verhalten."""
        real_allowed = protocol_module._allowed_set
        real_condition = protocol_module._validate_condition
        real_label = policy_module.Policy.sandbox_root_label

        def allowed_set_rebuild(allowed: Any) -> frozenset[str]:
            return frozenset(allowed)

        def condition_always_normalized(text: str, path: str) -> tuple[str, float]:
            return real_condition(" ".join(text.split()), path)

        def label_naive(self: Any, checked: Any) -> str:
            # alter Weg: Wurzel-Label pro Antwort, und das mit doppeltem resolve()
            root_name = (checked.constraints.sandbox_root or "workspace").strip()
            base = config.repo_root if root_name in {"", ".", "./"} else (config.repo_root / root_name).resolve()
            self._sandbox_roots.clear()  # der Zustand vor dem Memo
            return config.relative(base)

        protocol_module._allowed_set = allowed_set_rebuild  # type: ignore[assignment]
        protocol_module._validate_condition = condition_always_normalized  # type: ignore[assignment]
        policy_module.Policy.sandbox_root_label = label_naive  # type: ignore[assignment]
        return (real_allowed, real_condition, real_label)

    restored = legacy_primitives()
    trigger_before = measure(lambda: _Trigger.from_dict(raw_trigger), n=200_000, warm=2_000)
    trigger_many_before = measure(lambda: _Trigger.from_dict(raw_trigger_many), n=120_000, warm=1_200)
    policy_before = measure(lambda: (cold._sandbox_roots.clear(), cold.check(intent))[1], n=6_000, warm=600)
    protocol_module._allowed_set, protocol_module._validate_condition = restored[0], restored[1]
    policy_module.Policy.sandbox_root_label = restored[2]
    trigger_after = measure(lambda: _Trigger.from_dict(raw_trigger), n=200_000, warm=2_000)
    trigger_many_after = measure(lambda: _Trigger.from_dict(raw_trigger_many), n=120_000, warm=1_200)
    policy_after = measure(lambda: policy.check(intent), n=20_000, warm=2_000)

    validation["trigger_from_dict_before_us"] = trigger_before
    validation["trigger_from_dict_after_us"] = trigger_after
    validation["trigger_from_dict_speedup_x"] = round(trigger_before / trigger_after, 2)
    validation["trigger_odd_whitespace_before_us"] = trigger_many_before
    validation["trigger_odd_whitespace_after_us"] = trigger_many_after
    validation["trigger_odd_whitespace_speedup_x"] = round(trigger_many_before / trigger_many_after, 2)
    validation["policy_check_before_us"] = policy_before
    validation["policy_check_after_us"] = policy_after
    validation["policy_check_speedup_x"] = round(validation["policy_check_before_us"] / policy_after, 2)
    validation["policy_check_with_cold_cache_us"] = validation["policy_check_before_us"]

    # --- Kontrollpfade: unveraenderter Code muss unveraendert bleiben --------
    validation["intent_from_dict_us"] = measure(lambda: type(intent).from_dict(intent.to_dict(), operations=operations), 20_000, 2_000)
    validation["build_intent_us"] = measure(
        lambda: kernel.build_intent(operation="sys.echo", params={"message": "m"}, limb="echo", goal="g"), 8_000, 800
    )
    validation["build_intent_with_8_triggers_us"] = measure(
        lambda: kernel.build_intent(
            operation="sys.echo",
            params={"message": "m"},
            limb="echo",
            goal="g",
            unlimited=True,
            tick_s=0.05,
            schedule=[{"id": f"t{i}", "action": "log", "when": f"elapsed >= {i + 1}"} for i in range(8)],
        ),
        6_000,
        600,
    )
    validation["defensive_dict_copy_us"] = measure(lambda: dict(raw_trigger), 200_000, 2_000)
    results["triad3_validation"] = validation



# ---------------------------------------------------------------------------
# Triad Nr.3, Cycle 3 -- Ledger-Selbstpflege (Kompaktierung, Verifikation, Tor)
# ---------------------------------------------------------------------------


def _legacy_stale_count(transport: FileTransport, *, older_than_days: int) -> int:
    """Der Zaehlweg vor Triad 3: ``Path.iterdir`` + ``stat`` fuer jeden Eintrag."""
    archive = transport.config.archive_dir
    if not archive.is_dir():
        return 0
    cutoff = time.time() - max(0, older_than_days) * 86_400
    stale = 0
    for day_dir in archive.iterdir():
        if not day_dir.is_dir() or day_dir.name == "compacted":
            continue
        for entry in day_dir.iterdir():
            try:
                if entry.is_dir() and entry.stat().st_mtime <= cutoff:
                    stale += 1
            except OSError:
                continue
    return stale


def bench_triad3_ledger(results: dict[str, Any]) -> None:
    """300 Eintraege auf 150 Tage; dann die drei Bewegungen alt gegen neu."""
    import tempfile as _tempfile

    tmp = Path(_tempfile.mkdtemp(prefix="nio-bench-ledger-"))
    config = NeuConfig.load(
        _REPO,
        mode="dev",
        limits={"max_iterations": 1, "max_agents": 1, "max_limbs": 1, "max_concurrent_jobs": 1, "max_scheduled_jobs": 1},
        runtime_dir=tmp / "runtime",
        workspace_dir=tmp / "workspace",
    )
    config.ensure_dirs()
    kernel = Kernel(config, Operations.load(config.protocol_dir / "operations.json"))
    transport = FileTransport(config)
    from orchestrator.transport import write_json_atomic

    entries = 300
    days_back = 30  # ~10 Eintraege pro Tag -- reale Tagesform, nicht 150 Ein-Tages-Reste
    ids: list[str] = []
    now = time.time()
    for i in range(entries):
        intent = kernel.build_intent(operation="sys.echo", params={"message": f"durchgang {i}"}, limb="echo", goal="Ledger messen")
        result = Result(
            result_id=new_id("res"),
            intent_id=intent.intent_id,
            trace_id=intent.trace_id,
            status="success",
            operation="sys.echo",
            limb_name="echo",
            started_at=utc_now_iso(),
            finished_at=utc_now_iso(),
            job_id=intent.job.job_id,
            output={"message": f"echo {i}"},
            diagnostics_stdout="zeile\n" * 3,
        )
        ids.append(intent.intent_id)
        day = time.strftime("%Y-%m-%d", time.gmtime(now - (i % days_back) * 86_400))
        target = config.archive_dir / day / intent.intent_id
        target.mkdir(parents=True, exist_ok=True)
        for name, doc in (("intent.json", intent.to_dict()), ("result.iteration1.json", result.to_dict()), ("result.json", result.to_dict())):
            write_json_atomic(target / name, doc, indent=None)
        stamp = now - (i % days_back) * 86_400
        os.utime(target, (stamp, stamp))
        os.utime(target.parent, (stamp, stamp))

    ledger: dict[str, Any] = {"fixture_entries": entries, "fixture_days": len([p for p in config.archive_dir.iterdir() if p.is_dir()])}
    ledger["lookup_before_compact_us"] = measure(lambda: transport.lookup_archived(ids[entries // 2]), n=120, warm=10)
    ledger["stale_count_before_us"] = measure(lambda: _legacy_stale_count(transport, older_than_days=0), n=40, warm=5)
    ledger["stale_count_after_us"] = measure(lambda: transport.stale_entry_count(older_than_days=0), n=40, warm=5)
    ledger["stale_count_gate_us"] = measure(lambda: transport.stale_entry_count(older_than_days=0, limit=64), n=40, warm=5)
    ledger["stale_count_speedup_x"] = round(ledger["stale_count_before_us"] / ledger["stale_count_after_us"], 2)
    ledger["stale_count_gate_speedup_x"] = round(ledger["stale_count_before_us"] / ledger["stale_count_gate_us"], 2)
    same = _legacy_stale_count(transport, older_than_days=0) == transport.stale_entry_count(older_than_days=0)
    ledger["stale_count_parity"] = 1 if same else 0

    start = time.perf_counter()
    # keep_recent=0: die Messung interessiert der volle Durchlauf (ein Lauf im
    # Betrieb behaelt 8 frische Eintraege pro Tag, siehe COMPACT_KEEP_RECENT).
    report = transport.compact_archive(older_than_days=0, keep_recent=0)
    ledger["compact_ms"] = round((time.perf_counter() - start) * 1000, 1)
    ledger["pruned_dirs"] = report["pruned_dirs"]
    ledger["bytes_freed"] = report["bytes_freed"]

    compact_dir = config.archive_dir / "compacted"
    day_files = sorted(compact_dir.glob("*.jsonl"))
    if day_files:
        snapshot = day_files[0]
        day = snapshot.stem
        digest = sha256_bytes(snapshot.read_bytes())
        count = snapshot.read_bytes().count(b"\n")
        deep = measure(lambda: transport._verify_day(day, deep=True), n=20, warm=3)
        fast = measure(lambda: transport._verify_snapshot_write(snapshot, digest=digest, count=count), n=20, warm=3)
        ledger["verify_before_prune_deep_us"] = deep
        ledger["verify_before_prune_fast_us"] = fast
        ledger["verify_before_prune_speedup_x"] = round(deep / fast, 2)
        from core.protocol import sha256_file

        ledger["digest_from_file_us"] = measure(lambda: sha256_file(snapshot), 200, 20)
        ledger["digest_from_payload_us"] = measure(lambda: sha256_bytes(snapshot.read_bytes()), 200, 20)
    ledger["lookup_after_compact_us"] = measure(lambda: transport.lookup_archived(ids[entries // 2]), n=200, warm=20)
    ledger["violations_clean"] = len(transport.verify_archive())
    ledger["violations_deep_clean"] = len(transport.verify_archive(force=True))
    ledger["resolved_after_compact"] = 1 if transport.lookup_archived(ids[7]) is not None else 0
    results["triad3_ledger"] = ledger



# ---------------------------------------------------------------------------
# Triad Nr.4, Cycle 1 -- Archiv-Duplikat als Hardlink statt zweiter Schreibvorgang
# ---------------------------------------------------------------------------


def _fsync_count(run) -> int:
    """Wie oft ``run()`` tatsaechlich auf die Platte syncht -- der teure Teil."""
    real = os.fsync
    hits = [0]

    def counted(fd: int) -> None:
        hits[0] += 1
        real(fd)

    os.fsync = counted  # type: ignore[assignment]
    try:
        run()
    finally:
        os.fsync = real  # type: ignore[assignment]
    return hits[0]


def bench_nio4_archive(results: dict[str, Any]) -> None:
    """Legt denselben Durchgang zweimal ab: alter Weg (4 Schreiblaeufe) gegen neu
    (3 Schreiblaeufe + Verlinkung), inklusive der Syscall-Zaehlung."""
    tmp = Path(tempfile.mkdtemp(prefix="nio-bench-archive-"))
    config = NeuConfig.load(
        _REPO,
        mode="dev",
        limits={"max_iterations": 1, "max_agents": 1, "limbs": 1, "max_concurrent_jobs": 1, "max_scheduled_jobs": 1},
        runtime_dir=tmp / "runtime",
        workspace_dir=tmp / "workspace",
    )
    config.ensure_dirs()
    kernel = Kernel(config, Operations.load(config.protocol_dir / "operations.json"))
    transport = FileTransport(config)
    from orchestrator.transport import duplicate_json_atomic

    intent = kernel.build_intent(operation="sys.echo", params={"message": "archiv"}, limb="echo", goal="Nr.4 Cycle 1")
    result = Result(
        result_id=new_id("res"),
        intent_id=intent.intent_id,
        trace_id=intent.trace_id,
        status="success",
        operation="sys.echo",
        limb_name="echo",
        started_at=utc_now_iso(),
        finished_at=utc_now_iso(),
        output={"message": "archiv"},
    )
    verdict = {"verdict": "accept", "iteration": 1}

    def legacy(d: Path) -> None:
        """Wortgleich der alte Koerper von archive(): vier volle Schreiblaeufe."""
        d.mkdir(parents=True, exist_ok=True)
        write_json_atomic(d / "intent.json", intent.to_dict())
        write_json_atomic(d / f"result.iteration{result.iteration}.json", result.to_dict())
        write_json_atomic(d / "result.json", result.to_dict())
        write_json_atomic(d / "verdict.json", dict(verdict))

    def linked(d: Path) -> None:
        """Wortgleich der neue Koerper von archive(): drei Schreiblaeufe + Link."""
        d.mkdir(parents=True, exist_ok=True)
        write_json_atomic(d / "intent.json", intent.to_dict(), ensure_dir=False)
        iteration_doc = d / f"result.iteration{result.iteration}.json"
        write_json_atomic(iteration_doc, result.to_dict(), ensure_dir=False)
        duplicate_json_atomic(iteration_doc, d / "result.json")
        write_json_atomic(d / "verdict.json", dict(verdict), ensure_dir=False)

    legacy_root = tmp / "legacy"
    link_root = tmp / "linked"

    seq = {"i": 0}

    def run_legacy():
        seq["i"] += 1
        legacy(legacy_root / f"e{seq['i']:06d}")

    def run_linked():
        seq["i"] += 1
        linked(link_root / f"e{seq['i']:06d}")

    # Syscall-Zaehlung pro Durchgang
    counts = {"legacy": _fsync_count(run_legacy), "linked": _fsync_count(run_linked)}

    bytes_same = True
    for name in ("intent.json", "result.iteration1.json", "result.json", "verdict.json"):
        if (legacy_root / "e000001" / name).read_bytes() != (link_root / "e000002" / name).read_bytes():
            bytes_same = False

    out: dict[str, Any] = {
        "fsyncs_legacy": counts["legacy"],
        "fsyncs_linked": counts["linked"],
        "payload_bytes": (legacy_root / "e000001" / "result.json").stat().st_size,
        "bytes_identisch": 1 if bytes_same else 0,
        "nlink_result_json": os.stat(link_root / "e000002" / "result.json").st_nlink,
    }
    out["archive_legacy_us"] = measure(run_legacy, 24, 4)
    out["archive_linked_us"] = measure(run_linked, 24, 4)
    out["archive_speedup_x"] = round(out["archive_legacy_us"] / out["archive_linked_us"], 2)
    out["archive_delta_us"] = round(out["archive_legacy_us"] - out["archive_linked_us"], 1)
    out["archive_in_situ_us"] = measure(lambda: transport.archive(intent, result, verdict), 24, 4)

    # Groessenbuchhaltung: geteilte Inodes duerfen nicht doppelt tragen
    day = config.archive_dir / time.strftime("%Y-%m-%d", time.gmtime())
    for _ in range(24):
        other = kernel.build_intent(operation="sys.echo", params={"message": "buchhaltung"}, limb="echo", goal="Nr.4 Cycle 1")
        transport.archive(other, result, verdict)
    naive = sum(doc.stat().st_size for entry in day.iterdir() for doc in entry.iterdir() if doc.is_file())
    counted_bytes = sum(dir_bytes(entry) for entry in day.iterdir())
    out["ledger_bytes_naive"] = naive
    out["ledger_bytes_counted"] = counted_bytes
    out["ledger_bytes_inflation_pct"] = round((naive / counted_bytes - 1) * 100, 1)
    out["entries"] = len(list(day.iterdir()))
    out["verify_clean"] = len(transport.verify_archive())
    out["verify_deep_clean"] = len(transport.verify_archive(force=True))
    out["lookup_resolves"] = 1 if transport.lookup_archived(intent.intent_id) is not None else 0
    results["nio4_archive_link"] = out


def main() -> int:
    results: dict[str, Any] = {"reference_baseline": REFERENCE_BASELINE}
    bench_focus_a(results)
    bench_focus_b(results)
    bench_focus_c(results)
    bench_triad3_writer(results)
    bench_triad3_validation(results)
    bench_triad3_ledger(results)
    bench_nio4_archive(results)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
