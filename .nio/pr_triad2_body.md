### ⚡ Nexus -- IPC & Core Performance Triad Ⅱ (3 cycles, 3 bottlenecks, 3 measured deltas)

Autonomous backend/IPC cycle set: profile -> isolate ONE bottleneck -> optimize ->
benchmark. Every number below is an **in-process A/B on this host** (`scripts/nexus_bench.py`,
median of 3 runs); the old path is re-measured in the same process rather than quoted from
the journal, because cross-host numbers on this box differ by ~1.5x.

All three cycles are guarded by 28 new tests. `make check` green: compile + ruff + mypy +
241 tests + e2e (20 properties).
(benchmark deltas)

All numbers from `scripts/nexus_bench.py` (rewritten for this triad), measured
**in-process, both paths, same host, median of 3 runs**. Cross-host comparison
against triad-1 numbers is explicitly avoided (this box is ~1.5× slower).
Gate: compile + ruff + mypy + **241 tests** + e2e all green.

| Focus | Headline metric | Before | After | Δ |
|---|---|---|---|---|
| A | event → 3 text consumers | **23.20 µs** | **11.59 µs** | **2.00×, −11.61 µs** |
| A | marginal cost per extra consumer | **6.62 µs** | **0.79 µs** | **8.4×** |
| A | shared-memory ring write | 7.20 µs | **2.43 µs** | **2.96×** (graveyard fixed) |
| A | UDS burst delivery, producer+consumer | 6.62 µs | **2.35 µs** | **2.8×**, zero disk/pipe |
| A | retained-event memory | 48.9 MB/200k | **39.7 MB/200k** | **−18.8 %** |
| B | per-tick trigger eval (8 triggers) | 8.34 µs | **1.45 µs** | **5.76×, −6.89 µs/tick** |
| B | `elapsed_s()` per tick + per event | 1.42 µs | **0.60 µs** | **2.38×** |
| C | archived-ledger single-record lookup | **7 552 µs** | **80.9 µs** | **93.3×** |
| C | `archive_stats()` | 8 356 µs | **899 µs** | **9.3×** |
| C | `verify_archive()` | 21 357 µs | **1 546 µs** | **13.8×** |
| C | ledger growth | unbounded, manual | **self-compacting**, 0 records lost | bounded by policy |

**Not a regression, stated plainly:** the one-text-sink case is a wash
(9.95 → 10.01 µs) and the `emit` floor moved +0.03 µs (0.9 %) for the
per-sink capability probe — encoding has to happen exactly once either way. The
optimization is structural (cost no longer scales with consumer count), plus the
new plane removes the disk from the hot path when a live consumer exists.

**Files**
- `orchestrator/events.py` — shared-line fanout (`write_prepared`), lazy rendering,
  `_render_line` + bounded `_LITERAL_CACHE`, `render_record()`.
- `orchestrator/uds.py` — **NEW** `UDSBroadcastSink` + `UDSBroadcastServer`
  (non-blocking datagram broadcast, drop counting, stale-inode recovery,
  abstract-namespace fallback, 0600).
- `orchestrator/ring.py` — `write_prepared` fast path, non-raising drop accounting
  on the hot path (`dropped`), strict `write()` kept.
- `orchestrator/scheduler.py` — `_CONDITION_CACHE` + `_compile_condition`,
  frozenset `_COMPARISONS`, memoized `elapsed_s()`.
- `core/protocol.py` — `timestamp_epoch_s()` (+ `_EPOCH_CACHE`), fast `Timer.elapsed()`.
- `orchestrator/transport.py` — `write_jsonl_indexed`, `snapshot_index`,
  `lookup_archived`, `stale_entry_count`, `maybe_compact`, digest fast path in
  `verify_archive(force=…)`, verify-before-prune, manifest-based `archive_stats`,
  self-maintenance gate in `archive()`.
- `orchestrator/cli.py` — `watch --uds/--uds-batch`, `bus tail`,
  `archive lookup|verify`, richer `archive stats`.
- `scripts/nexus_bench.py` — rewritten: in-process A/B for all three focuses.
- `tests/test_nexus_triad2.py` — **NEW** 28 guards (line parity, lazy render,
  ring fanout/drop, UDS delivery/perms/no-consumer, condition parity + bounded
  caches, clock anchor, index rebuild, tamper both paths, no-data-loss, auto-compact,
  stale-socket takeover vs. live-listener refusal).
- `README.md` — the new opt-in ops surface.

### Contracts deliberately untouched
- `FileTransport` (inbox/processing/done + `fsync`) remains **the** delivery mechanism; the
  UDS and ring sinks are an opt-in *observation* plane. No fallback was removed.
- Nothing re-parses or re-compiles a JSON schema per tick. `schemacheck.validate` was
  re-profiled this cycle and stays **cold** (95 µs, CLI-only) -- so per the standing rule the
  closure-compilation item waits until a schema actually lands on the tick path.
- The ledger can no longer grow unbounded: compaction is self-triggering (every 64 archives,
  entries older than 7 days, >= 64 stale) and **verifies before it prunes** -- a violation means
  no movement at all. Index/digest artifacts are derived: missing -> rebuilt, mismatched ->
  parity fallback to the slow path.
- `Event` line output is **byte-identical** to `json.dumps(record, separators=(",", ":"))`;
  `render_record()` is the parity oracle the tests pin against.

### Reproduce
```bash
PYTHON=/home/user/.venv-nio/bin/python make check          # gate, incl. 28 new guards
python3 scripts/nexus_bench.py --json bench.json           # the tables above
python3 -m orchestrator.cli loop --watch --uds runtime/bus.sock    # producer
python3 -m orchestrator.cli bus tail --socket runtime/bus.sock     # consumer, no disk
python3 -m orchestrator.cli archive verify --json                  # digest fast path
```
Metrics also logged in `.nio/nexus.md` (TRIAD Nº2 + summary + corrected Graveyard).

> Journal: `.nio/nexus.md` (TRIAD Nº2). This body is the file `.nio/pr_triad2_body.md`.
---

# ⚡ Nexus Triad Nº3 — auch auf diesem Branch (Cycles 1–3, `56d30d1`/`64b6b3e`/`f20c2f4`)

**Warum hier statt in einem eigenen PR:** die Persona verlangt ein PR pro Triade, diese
Arena-Session ist aber fest an `arena/01a07962-nio` gebunden — Nº3 konnte nur auf denselben
Branch. Wer Nº2 isoliert reviewen will, reviewt bis `5391ee6`; Nº3 beginnt mit `56d30d1`.
Volle Zahlen im Journal (`.nio/nexus.md` → `TRIAD Nº3 SUMMARY`).

## Cycle 1 — Focus A: ein atomarer JSON-Schreiber statt drei
Zustand, Job-Record und Archiv-Beleg kopierten für jede Persistierung erst durch
`json.dumps → loads → indent=2 → dumps`, jede Datei ließ `Path.mkdir` laufen und endete mit
einem unbedingten `os.fsync`.
- **Tick, der persistiert: 587,9 → 256,8 µs (2,29×)** · Schedule-Zustand: 525,1 → 234,8 µs (2,24×)
- 44-KB-Dokument atomar schreiben: 6113 → **3898 µs (1,57×)** · Job-Record auf Platte: 607 → **502 B (−17,5 %)**
- Bytes auf Platte byte-identisch zum alten Schreiber, Dateirechte unverändert (0644/0755)
- Verworfen mit Zahl: fsync auf Intent-Dateien einsparen — bei 73 % des Pfads **0,87×**, der Sync ist der Vertrag
- **`os.fdatasync` statt `os.fsync` gemessen: 1,00×.** Kein Freifahrtschein, im Journal notiert

## Cycle 2 — Focus B: Validierung auf dem Zustellpfad
Zwei Vermutungen aus dem Journal starben an der Messung (Regex-Vorfilter 1,10×, Enum-Kaskade 1,13×);
der echte Bottleneck war die Sandbox-Kette, die pro Antwort **dreimal realpathte**:
`Policy.sandbox_root` + `is_within_allowed_root` + `relative_to` (25–30 µs).
- **`Policy.check(intent)`: 46,3 → 2,05 µs (22,6×) — −44,2 µs pro Dispatch** · `build_intent`: 169,2 → 95,0 µs (1,78×)
- Trigger-Inferenz: Pfad-Scan 0,997 → **0,021 µs (48×)**; 432 Warm-vs-Kalt-Fälle, **0 Abweichungen**
- Kontrollpfad `schema_validate` 99,5 → 98,8 µs (Host konstant); `Intent.from_dict`/`Result.from_dict`/`Scheduler.load` **unveraendert** (json.loads dominiert — 1,09× lohnt keinen Zyklus)

## Cycle 3 — Focus C: die Selbstpflege des Ledgers
Kompaktierung 819 ms/400 Einträge, davon 328 ms `fsync` (600 Aufrufe) plus pro Tag ein
zweiter Lese+Hash-Durchlauf und ein deep-Verify, das jede Datei erneut parst.
- **Verify-before-prune pro Tag: 708 → 40,2 µs (17,6×)** · Stale-Tor: 1732 → **280 µs**, mit Schwellenabriss **75,5 µs (22,9×)**
- Kompaktierung 400/200: 819 → **660 ms** · Lookup nach Kompaktierung 370 → 157 µs · `archive()`/`verify_archive()` unverändert (Kontrolle ✓)
- **Integrität strenger, nicht schneller:** vor dem Prunen müssen die Snapshot-Schlüssel die *Verzeichnisnamen* der gelöschten Einträge abdecken — der alte tiefe Verify fand einen untergeschlagenen, aber in sich konsistenten Snapshot nicht. deep-Verify bleibt als `verify_archive(force=True)` vollständig.
- Verworfen mit Zahl: `verify_archive` per (Größe, mtime)-Fingerabdruck — 12 ms/MB → 0,2 ms, aber nur auf Zuruf und mit schwächerer Aussage

## Gate (beide Triaden)
`make check` grün: Compile, ruff, mypy, **272 Tests** (Nº2: 28, Nº3: 31), e2e.
Keine neuen nativen Bindings, keine Änderung an Vektor-DB/Einbettungsdimensionen, Dateitransport
unverändert Standard, Schema-Kompilierung weiterhin außerhalb des Ticks, Archiv wächst nicht ungebunden.
