# ⚡ Nexus — Backend & IPC Journal

> Continuous-loop memory for Project Nio. Read at the start of every cycle, update
> at the end. Every entry carries the tool that produced it (benchmark script) and
> the exact before/after delta.

## Repository truth (read once, re-derive each cycle)

- Runtime = Python 3.11 **stdlib-only** (`core/ orchestrator/ limbs/`). No third-party deps.
- Protocol 1.2, file-based transport **by contract** (`orchestrator/transport.py`).
- Event-Bus = `orchestrator/events.py` (`EventBus.emit`, sinks). Serialisiert den
  Datensatz **einmal pro Emit** und teilt die Zeile mit allen Text-Sinks.
- Opt-in Hochfrequenz-Zweige am Bus: `orchestrator/uds.py` (AF_UNIX-Datagramm-
  Broadcast) und `orchestrator/ring.py` (Shared-Memory-Ring). Beide **zusätzlich**,
  nie als Ersatz für Konsole/Sammler/Datei.
- Schema validator = `core/schemacheck.py` (sub-Draft-2020-12, `validate()`),
  kompilierte Muster + `_SUPPORTED_KEYS` (Triad 1). Steht **nicht** auf dem Tick-Pfad.
- Tick-Pfad = `orchestrator/scheduler.py`: vorkompilierte Bedingungen
  (`_CONDITION_CACHE`) + memoisierter Uhr-Anker (`core.protocol.timestamp_epoch_s`).
- Archive/ledger = `runtime/archive/<day>/<intent_id>/` via `FileTransport.archive()`,
  selbstgepflegt: `maybe_compact()` (alle 64 Schreibungen) → `compacted/<day>.jsonl`
  + `.manifest.json` + `.index.json` (Offset-Index) → `lookup_archived()`.
- Gate: `make check` = compile + ruff + mypy + **238 unittest** + e2e. Must stay green.
- Constitution Guard: `neu.config.json`, `core/config.py`, `core/policy.py` sind
  `human_only_globs` → **keine** neuen Konfigurationsknospen dort. Laufzeit-Knobs
  laufen über Umgebungsvariablen (`NEU_ARCHIVE_*`) oder CLI-Flags.
- Active loop focus rotation: A (IPC/Event-Bus) → B (Fast-Path Schema) → C (Ledger).
- Diese Sandbox-Box ist ~1,5× langsamer als die Triad-1-Box (unangetasteter
  `schemacheck.validate`: 95,0 µs hier vs. 60,7 µs dort). **Folgerung für alle
  künftigen Zyklen: Referenzwerte aus älteren Journal-Einträgen sind nicht
  vergleichbar — A/B immer in einem Prozess messen, nicht gegen das Journal.**

---

## 🔁 TRIAD Nº1

### Cycle 1 — Focus A: Sub-ms IPC / Event-Bus hot path

**Benchmark (baseline, `scripts/nexus_bench.py`):**
- `EventBus.emit` (null sink): **2.81 µs/emit**
- `EventBus.emit` (CollectingSink): **3.57 µs/emit**
- Timestamp component (`datetime.now(UTC).isoformat(ms).replace('+00:00','Z')`): **1.05 µs/call**
- `Event()` dataclass + `to_dict()` double-copy: **1.21 µs/call**

**Findings:** emit is dominated by (1) building the ISO-millisecond timestamp via
`datetime` + `.replace`, and (2) a redundant double copy of `payload` (once into the
`Event` dataclass, once in `to_dict()`). Both are pure CPU, no disk I/O.

**Change:**
- Replaced timestamp generation with a fast `time.time()`-based ISO-ms formatter
  (`_iso_ms_z_fast`, no `datetime` object, no `.replace`). Timestamp cost:
  **1.05 µs → 0.36 µs/call**.
- Build the delivery record once; stop re-copying `payload` for the record path
  (the `Event.to_dict()` double-copy in the delivery loop is gone).
- Added an opt-in `SharedMemoryRingSink` (`orchestrator/ring.py`): a bounded,
  `multiprocessing.shared_memory` ring buffer for high-frequency event streaming
  (no syscall per event, no disk). Console/Collector sinks (and the file-based
  `FileTransport`) remain the default/fallback — nothing was removed.

### Cycle 2 — Focus B: Fast-Path Schema Validation

**Findings:** `core/schemacheck.py` re-runs `re.search(pattern, value)` per
string node. Even though CPython caches compiled regex internally, every call still
goes through the `re._compile` cache-lookup layer, and the set of *supported*
keywords is recomputed per `validate()` call. Raw JSON schema is re-walked on every
tick in the CLI/tests (this is the "compile-on-every-tick" anti-pattern).

**Change:**
- Cache compiled `re.Pattern` objects in a module-level registry (`_PATTERN_CACHE`
  + `_compiled()`); use `pattern.search(value)` directly on the hot paths.
- Hoist the supported-keyword allowance into a `_SUPPORTED_KEYS` frozenset so
  `validate()` no longer rebuilds a ~30-element set on each call.
- Micro-optimize `_matches_type` / single-type dispatch: the common
  `type:"<string>"` branch no longer builds an `any()` genexpr per node.

### Cycle 3 — Focus C: Ledger Compaction & Archive

**Findings:** `runtime/archive/<day>/<intent_id>/{intent,result,verdict}.json` grows
without bound. `QueueState.archived` only counts entries; nothing ever compacts or
prunes. Infinite growth would eventually degrade any index/summary built over it.

**Change:**
- Added `FileTransport.archive_stats()` (count + bytes per day, + `compacted/`).
- Added `FileTransport.compact_archive()`: merges stale per-intent directories into a
  single per-day `compacted/<day>.jsonl` snapshot + a per-day `.manifest.json` with
  canonical SHA-256 digests, then prunes the individual directories. Recent entries
  stay expanded so the active `attempt.archive_dir` contract is untouched.
  Snapshotting is atomic + fully verifiable via `verify_archive()`.
- Wiring: new CLI subcommands `orchestrator archive stats` and
  `orchestrator archive compact [--older-than-days N] [--keep-recent N]`.

---

## 🔁 TRIAD Nº2 (2026-09-07)

### Cycle 1 — Focus A: Sub-ms IPC / Event-Bus (single serialization + UDS plane)

**Profile first.** An earlier assumption ("the per-event `flush()` is the cost") was
wrong. Isolated measurement of the default path `EventBus.emit` → `ConsoleSink`:

| component | µs/event |
|---|---|
| `emit` itself (seq, timestamp, record build) | 3.10 |
| `json.dumps(record)` inside **each** sink | 4.44 |
| `stream.write` + `flush` | 1.61 |
| `dict(record)` defensive copy in the sink | 0.03 |

→ **Serialization, not I/O, was the hot cost** — and it was paid *per sink*. With
`json.dumps` on a small dict already costing 1.7 µs of fixed encoder overhead, the
per-sink `dumps` is pure duplicated work whenever more than one consumer listens
(console + collector + dashboard/ring/UDS).

**Change.**
- `EventBus.emit` now renders the canonical JSON line **once** and shares it with
  every sink that declares `wants_prepared_line` via `write_prepared(record, line)`.
  Sinks without it keep the old `write(record)` contract — full fallback preserved.
- Rendering is **lazy**: if no subscribed sink wants text, nothing is serialized at
  all. That is the real production default (`--json`/quiet console + collector), so
  the orchestrator now pays **zero** JSON cost per tick event. A guard test spikes
  `_render_line` to catch a regression into eager rendering.
- Envelope is assembled by concatenation with a bounded literal cache
  (`_json_str`, 4096 entries) instead of encoding the fixed keys; only `payload`
  goes through `json.dumps`. Output is **byte-identical** to `json.dumps(record)`
  (verified over 144 payload/clock/escape combinations, incl. NaN/Inf/umlauts).
- New `orchestrator/uds.py`: `UDSBroadcastSink` (AF_UNIX `SOCK_DGRAM`, **non-blocking
  send**, drop counter, never raises) + `UDSBroadcastServer` (binds, chmod 0600,
  removes stale inodes, drains all queued datagrams per call). Sink marginal cost:
  `encode` 0.10 + `send` 0.74 µs. Opt-in via `watch --uds PATH [--uds-batch BYTES]`,
  consumed by `orchestrator bus tail --socket PATH`.
- `SharedMemoryRingSink.write_prepared` consumes the shared line: the ring stopped
  being the slow path (see Graveyard — triad 1 entry corrected below).
- `Event` gained `slots=True`. Latency neutral (3.06 → 3.08 µs measured, i.e. within
  noise) — the win is the **−18.8 %** footprint of a run that keeps its events.
- Ring hot-path overflow now **counts a drop** instead of raising `RingFull` per
  event (a slow reader must not push the bus into its per-event stderr error path);
  the direct `write()` API still raises for callers that want backpressure.

**Result (after)** — `scripts/nexus_bench.py`, same process, same host:

Measured in one process on one host; the "before" column is the triad-1 code path
replicated or reached through the compatibility `write()` route — not a journal value.

| metric | before | after | Δ |
|---|---|---|---|
| one event → 3 text consumers | **23.20 µs** | **11.59 µs** | **−11.61 µs (2.00×)** |
| marginal cost per extra text consumer | **6.62 µs** | **0.79 µs** | **8.4×** |
| shared-memory ring write (sink only) | **7.20 µs** | **2.43 µs** | **2.96×** |
| UDS delivery, burst (send + consumer drain) | 6.62 µs (serializing sink) | **2.35 µs** | 2.8× |
| UDS single-event round trip (send + recv) | — | 4.95 µs | — |
| one text sink (file + flush) | 9.95 µs | 10.01 µs | **wash** (by construction) |
| `emit` floor, no text sink | **2.95 µs** (triad-1 replica) | **2.98 µs** | **+0.03 µs (0.9 %)** |
| saturated UDS (no consumer) | would block forever | 9.44 µs, counted | never stalls the run |
| `Event` retained memory | 48.9 MB / 200k | **39.7 MB / 200k** | **−18.8 %** (`slots=True`) |

The single-sink case is a **wash by construction** (the bytes still have to be
encoded exactly once) — the win is structural: delivery cost no longer scales with
the number of consumers.

### Cycle 2 — Focus B: Fast-Path per-tick validation (compiled conditions + clock anchor)

**Profile.** `validate()` in `core/schemacheck.py` is **not** on the tick path (only
`orchestrator validate --schema`). What runs every tick, per trigger, is the raw
condition string, and what runs every tick *and every event* is the clock anchor:

| per-tick work (before) | µs/call | note |
|---|---|---|
| `evaluate_condition("elapsed >= 6", t)` | 0.841 | 90 % of it is `parse_condition` |
| `parse_condition` (`strip` + `re.fullmatch` + `float` + `op in tuple`) | 0.759 | result fixed at job creation |
| `ScheduleState.elapsed_s()` | 1.523 | re-parses immutable `t0` |
| `Timer.elapsed()` (per **event**, from `runner._emit`) | ~1.0 | same re-parse |

**Change.**
- `orchestrator/scheduler.py`: `parse_condition` = **cached compiled validator**.
  `_compile_condition()` holds the grammar, `_CONDITION_CACHE` (bounded, 512) maps
  the raw `when` text → `(op, value)`. Failures are deliberately **not** cached so
  the error keeps naming the offending text and a corrupt state still complains
  every tick. `_COMPARISONS` became a frozenset (it was a linear tuple scan).
- `core/protocol.py`: `timestamp_epoch_s()` — memoized epoch for immutable stamps,
  used by `Timer.elapsed()` and `ScheduleState.elapsed_s()` on their no-`now`
  fast path; the `now=` path is untouched (tests/`tick(now=…)` rely on it).

**Result (after):**

| metric | before | after | Δ |
|---|---|---|---|
| condition evaluation per call | **1.042 µs** | **0.181 µs** | **5.76×** |
| one tick, 8 triggers | **8.34 µs** | **1.45 µs** | **−6.89 µs/tick** |
| `elapsed_s()` per tick | **1.422 µs** | **0.598 µs** | **2.38×** |
| combined tick saving | — | **−7.71 µs/tick** | at `tick_s=0.05`: 154 µs/s/job |
| `schemacheck.validate` (untouched code path) | 60.7 µs (triad-1 host) | 95.0 µs (this host) | no change — host delta |

At the fastest supported tick (0.05 s) that is **~7.7 µs of CPU per tick per job**
returned, with zero semantic change (verified against the old parser over a table of
operators/thresholds in `tests/test_nexus_triad2.py`).

### Cycle 3 — Focus C: Ledger compaction, offset index, self-maintenance

**Profile** (400 entries → one 891 KB day snapshot):

| operation (before) | µs |
|---|---|
| find one `intent_id` in a snapshot (`read_jsonl` full scan) | **7 552** |
| `archive_stats()` (counts by parsing every record) | **8 356** |
| `verify_archive()` (re-parse + re-hash every field) | **21 357** |
| compaction of 400 entries | 183 ms |
| …and compaction was **manual only** (CLI) — the ledger had no bound in practice |

**Change.**
- `write_jsonl_indexed()`: the snapshot writer now derives the
  `intent_id → byte offset` table **while** it writes (line lengths are already
  known), and persists it as a sidecar `compacted/<day>.index.json`. Cost: 15.3 KB
  per 891 KB snapshot (**1.72 %**), and it is a *derived* artifact — never the
  source of truth.
- `FileTransport.snapshot_index()` memoizes per (mtime, size); a missing or
  mismatching sidecar is rebuilt by one scan and written back.
- `FileTransport.lookup_archived(intent_id)`: **one door for both ledger states** —
  compacted record via `seek` + `readline` + `json.loads`, expanded record via the
  day directory. Includes a parity check (the parsed line must carry the requested
  `intent_id`), so a stale/corrupt index can never return someone else's record;
  a mismatch falls back to a rebuild scan.
- `archive_stats()` reads `count` from the manifest instead of parsing the
  snapshot; falls back to a scan when no manifest exists (older snapshots).
- `verify_archive()` gained a **day-digest fast path**: `sha256_snapshot` in the
  manifest answers "unchanged?" in one hash pass; on mismatch it falls through to
  the deep per-record rehash and reports the exact field. `force=True` (or the old
  digest-less manifests) keeps the previous full behaviour.
- **Verify-before-prune**: `compact_archive()` now deep-verifies the snapshot it
  just wrote and **refuses to prune** if verification fails (day reported as
  `aborted`). Data integrity is ranked above storage savings.
- **Bounded without a human**: `archive()` runs the `maybe_compact()` gate every 64
  writes. Thresholds are module constants, overridable by `NEU_ARCHIVE_AUTOCOMPACT`,
  `NEU_ARCHIVE_COMPACT_DAYS`, `NEU_ARCHIVE_KEEP_RECENT`, `NEU_ARCHIVE_MIN_STALE`
  (env, not `neu.config.json` — that file is under the Constitution Guard).
  Defaults: only entries > 7 days old, newest 8 per day stay expanded, nothing
  happens below 64 stale entries → fresh/test runtimes are never touched.
- CLI: `archive lookup <intent_id>`, `archive verify [--deep]`, richer
  `archive stats` (stale counts, index state, digest prefix), `archive compact`
  now reports index size.

**Result (after):**

| metric | before | after | Δ |
|---|---|---|---|
| single-entry lookup (400-record snapshot) | **7 552 µs** | **80.9 µs** | **93.3×** |
| …cold (no sidecar; rebuild by scan, one time) | — | 387 µs | self-healing |
| `archive_stats()` | **8 356 µs** | **899 µs** | **9.3×** |
| `verify_archive()` | **21 357 µs** | **1 546 µs** | **13.8×** |
| tamper detection (both paths) | yes | **yes** | integrity intact |
| data loss on compaction | 0 | **0** (392 pruned, all 400 still resolvable) | — |
| storage: 400 dirs → 1 snapshot | 1.31 MB freed | snapshot 891 KB + index 15 KB | −32 % (wie Triad 1) |
| auto-compaction gate cost | — (didn't exist) | 63.5 µs per check, 1 per 64 archives | amortized ~1 µs/archive |

---

---

## 🔁 TRIAD Nº3 (2026-09-07, direkt nach Nº2)

Ausgangslage nach Nr.2: ein **leerer** Tick kostet 4,07 µs, ein **feiernder** Tick
583 µs. Der cProfile-Abschuss über 800 Feuerungs-Ticks zeigte, wofür die 143-fache
Differenz da ist: `json/encoder.iterencode` 52 % der Zeit, `posix.replace` 13 %,
`io.open`/`write` 10 % -- also fast ausschliesslich *Persistenz*, nicht Event-Bus.
Die Queue-Entscheidung fiel deshalb gegen "schemacheck schliessen" (bleibt kalt,
95 µs, CLI-only) und für den Schreibpfad.

### Cycle 1 — Focus A: der atomare JSON-Schreiber (Transport, Schedule-Zustand, Job-Record)

**Der Engpass.** Alle drei Stellen taten dasselbe auf dem heissen Pfad: ein
komplettes Dokument durch `tempfile.NamedTemporaryFile` + `TextIOWrapper` schieben
und -- beim Zeitplan -- bis zu 200 Historieneinträge *pro Feuerung* neu encodieren.
Gemessen (44 KB-Zustand): `json.dumps` 306 µs, `write_text` 295 µs, `os.replace`
102 µs, `path.parent.mkdir` 5,7 µs, Path-Chuernel ~38 µs. Die Historie ist der
einzige grosse Teil des Dokuments, und sie wächst nur am Ende.

**Der Schnitt.**
* `core/atomic.py` (neu): `atomic_write_bytes(target, data, *, fsync, dir_mode, mode)` --
  Temp-Name aus `pid` + Zähler statt `mkstemp`-Raten, `os.open`/`os.write`/`os.close`
  statt Text-Handle, ein `os.makedirs` nur dort, wo es sein muss, und **Aufräumen der
  Temp-Datei auch bei fehlgeschlagenem `replace`** (der alte Weg räumte nur bis zum
  `replace` auf -- der neue Test fängt beides).
* `write_json_atomic` / `write_jsonl_atomic` / `write_jsonl_indexed` nutzen ihn;
  Bytes, Modus (0600) und `os.fsync` vor dem `replace` sind unverändert -- gemessen
  byte-identisch zu alt. Der JSONL-Snapshot schreibt jetzt in *einem* `write` statt
  pro Zeile einem.
* `ScheduleState.persist_text()`: jeder Historieneintrag wird beim Anhängen
  (`_record`) genau einmal encodiert und beim Speichern nur noch aneinanderguegt.
  Gilt der Puffer nicht (Anzahl, Laenge, Objekt-Identitaet an Kopf und Ende passen
  nicht), wird komplett neu gebaut -- Sicherheitsnetz, kein Fehlerpfad.
* `Scheduler.save()` prueft das Verzeichnis nicht mehr pro Aufruf, sondern legt es im
  `FileNotFoundError`-Fall einmal an und wiederholt.
* `JobStore.save()` kompakt statt `indent=2` (Maschinenzustand, Sicht ist `job show`).

**Das Ergebnis** (alles `scripts/nexus_bench.py`, A/B im selben Prozess und -- beim
feurnden Tick -- durch Umparken von `Scheduler.save` in *einer* Messreihe):

| Metrik | vorher | nachher | Δ |
|---|---|---|---|
| **einer Tick, der persistiert** | **587,9 µs** | **256,8 µs** | **2,29×, −331 µs** |
| Schedule-Zustand speichern (200 Historieneinträge) | 525,1 µs | **234,8 µs** | **2,24×, −290 µs** |
| Intent-Datei schreiben (2 KB, inkl. fsync) | 747,3 µs | 698,4 µs | 1,07× |
| kleines Dokument (95 B) | 494,0 µs | 449,9 µs | 1,10× |
| 44-KB-Dokument (Index/Archiv-Snapshot) | 6 113,1 µs | **3 897,9 µs** | **1,57×, −2,2 ms** |
| Job-Record auf Platte | 607 B | **502 B** | **−17,5 %** |
| Job-Record schreiben (µs) | 187–256 | 203–213 | **wash** (Rauschen) |
| Kontroll-Tick ohne Zustandsänderung | 4,07 µs | 4,07 µs | unverändert |

**Was nicht besser wurde und warum es so bleibt:** ohne `os.fsync` wäre ein
Intent-Schreiben 191 µs statt 698 µs -- der Plattenzwang sind 73 % des Pfades. Der
Vertrag (crash-feste Zustellung) verbietet das Weglassen, und `os.fdatasync` ist auf
diesem Box-Setup nachweislich *nicht* billiger (374,6 vs. 377,0 µs), also auch kein
Trick. Der Rest des Weges liegt damit auf seinem Vertrag-Floor.

**Guard-Tests:** `tests/test_nexus_triad3.py` (17 Stück) -- byte-Identität zum alten
Schreibweg bei 95 B/2 KB/44 KB, Modus 0600/0644, kein Temp-Waise bei `write`- *und*
`replace`-Fehler, `fsync`-Zählung (Transport ja, Zustand nein), 12 parallele Schreiber
ohne Kollision, `json.loads(persist_text()) == to_dict()` nach Feuerungen, nach
Kuerzung auf `HISTORY_LIMIT`, nach Eingriff von aussen, nach load()/save()-Rundlauf und
nach entfernten `schedules/`-Verzeichnis, plus `job show --json` gegen das neue Format.

**Nebenbefund (notiert, nicht optimiert):** `JobStore.heartbeat` = `get()` (Datei
lesen + parsen) + `save()` -- 262 µs alle `renew_s/5` Sekunden, nur um `updated_at`
zu heben. Ein mtime-basierter Touch-Pfad waere billiger, aber die Aufzeichnung
(`t_unlimited_s` ist ein *abgeleiteter* Live-Wert in der Datei!) macht jeden
Byte-Rundlauf instabil; deshalb klammern die Tests ihn aus. Wiedervorlage nur, wenn
die Heartbeat-Frequenz selbst zum Problem wird.
- **`verify_archive` ueber (Groesse, mtime)-Fingerabdruck ohne Oeffnen der Datei.**
  Brachte 12 ms/MB auf ~0,2 ms, aber nur auf einem Pfad, der nie im Tick laeuft --
  und die Antwort waere dann "seit der Pruefung hat niemand geschrieben", nicht
  "der Inhalt ist unveraendert". Verworfen, Zahl im Cycle 3.
- **`os.fdatasync` statt `os.fsync`.** Auf dieser Box gemessen *gleich teuer*
  (374,6 vs 377,0 µs pro Write+Sync) -- der Metadata-Teil ist hier nicht der teure.
  Ausserdem verbietet der Transportvertrag das Weglassen des Syncs, also bleibt die
  eine, sichtbare Zeile. Kein weiterer Versuch.
- **Fester Temp-Name mit `O_TRUNC` statt `O_CREAT|O_EXCL` + Zaehler.** Spart ~78 µs
  (bestehende Inode wiederbenutzen statt neu anlegen), aber zwei Schreiber auf
  dasselbe Ziel wuerden sich gegenseitig ins Temp schreiben und ein Dokument
  mischen. Der Preis ist die Idempotenz des Verzeichnisses wert.
- **`mtime`-Touch statt `JobStore.heartbeat`-Rewrite.** Waere billiger, macht aber
  die Job-Aufzeichnung zu zwei Wahrheiten (Datei *und* Inode-Zeit) und beruehrt die
  Waisen-Erkennung -- vertagt, bis die Heartbeat-Frequenz selbst misst.

### Cycle 2 — Focus B: Validierung auf dem Zustell-Pfad (Policy-Pre-Flight, Protokoll-Primitive)

**Der Engpass.** cProfile ueber 600 `build_intent`-Aufrufe: `Trigger.from_dict` 44 %
der Zeit, und -- ueberraschend -- `posixpath._joinrealpath` mit 1200 Aufrufen fuer
dieselben 600 Builds. Der Grund: `Policy.check` baute seine Antwort gleich dreimal
auf demselben Weg neu -- `sandbox_root(intent)` (ein Realpath-Durchlauf) und
`config.relative(...)` (der zweite) -- und das in *jeder* Entscheidung, auch im
`_deny`-Pfad. Ausserdem: `_reject_unknown` baute `set(allowed)` pro Aufruf neu,
`_as_enum` pruefte Mitgliedschaft linear ueber einem Tuple, `_check_version` compilierte
sein Regex pro Aufruf, und `_validate_condition` gluettete Whitespace mit
Liste + Join, auch wenn das Muster laengst traf.

**Der Schnitt.**
* `Policy` merkt sich `(Wurzel, Label)` pro `sandbox_root`-Angabe, **begrenzt auf 32
  Eintraege** (der Schluessel kommt aus dem Intent, also von aussen -- eine offene
  Tabelle waere ein Wachstumsvektor). Neue Methode `sandbox_root_label()` liefert das
  Label aus derselben Rechnung; alle vier Antwortpfade nutzen sie.
* `NeuConfig.relative_resolved()` fuegt den Relativpfad ohne zweiten `resolve()`
  zusammen; `relative()` bleibt unangetastet (gleicher Ruckfall, keine Delegation --
  der Testbestand vergleicht beide fur innen *und* aussen liegende Pfade).
* `_allowed_set()`: frozenset pro Konstante, einmal gebaut (Cache 512, unhashbare
  Eingabe faellt auf Neubau zurueck); `_reject_unknown` sortiert nur noch im
  Fehlerpfad; `_as_enum` ist O(1); `_VALID_VERSION_RE` compilt einmal;
  `_validate_condition` versucht die kanonische Form direkt und gluettet nur als
  Fallback; `Trigger.from_dict` kopiert seinen Eingabe-Dict nicht mehr.

**Das Ergebnis** (`scripts/nexus_bench.py`, alte Pfade zur Messung *rekonstruiert* --
Module gefixt auf `frozenset(allowed)`-Neubau, Linearscan, immer-Gluettung,
Wurzel-Label pro Antwort -- also A/B im selben Prozess):

| Metrik | vorher | nachher | Δ |
|---|---|---|---|
| **`Policy.check(intent)`** | **46,3 µs** | **2,05 µs** | **22,6×, −44,2 µs pro Dispatch** |
| `build_intent` (Validierung inkl.) | 169,2 µs | **95,0 µs** | **1,78×** |
| `build_intent` mit 8 Ausloesern | 303,0 µs | **227,7 µs** | 1,33× |
| `Trigger.from_dict` | 7,25 µs | 6,64 µs | 1,09× (klein, ehrlich) |
| dito mit exotischem Whitespace | 8,33 µs | 7,92 µs | 1,05× |
| `Intent.from_dict` / `Result.from_dict` | 48,1 / 29,7 µs | 52,0 / 28,1 µs | **unveraendert** (43-KB-`json.loads` dominiert) |
| `Scheduler.load` (State-Datei parsen) | 134,2 µs | 140,8 µs | Messreihe-Rauschen, kein Pfadwechsel |
| Kontrolle: `schema_validate` (CLI-only, kalt) | 99,5 µs | 98,8 µs | unveraendert ✓ Host stabil |

Der Gewinn sitzt also in der **Wiederholung**, nicht in den Primitiven: 44 µs pro
Dispatch sind jetzt gespart, die Protokoll-Primitiven liefern zusammen ~0,6 µs pro
Trigger. Beides bleibt drin (der Linearscan war ein Wachstumsrisiko, nicht nur ein
Tempo), aber nur mit dem gemessenen Wert -- nicht mit einem erwarteten.

**Guard-Tests** (9 neue, `tests/test_nexus_triad3.py`): Differentiaaltest Policy mit
warmem Cache gegen dieselbe Instanz mit geleertem Cache ueber 32 Wurzel-/Pfad-/
Elevation-Kombinationen (Entscheidung, Code, Label, `resolved_targets`, Begruendung
identisch -- 432 Faelle im Profiler, 0 Abweichungen), Cache-Schranke bei 32,
Label == naive Kette, `relative_resolved`-Ruckfall == `relative`, Fehlermeldungen der
Primitive unveraendert (`unbekannte Schluessel ['alpha', 'beta']`, `'schlendern' nicht in
[...]`), Bedingung mit allen Leerraumformen == normalisierte Referenz, und
`Trigger.from_dict` haelt seine Werte auch nach Mutation der Eingabe.

**Der Test fand einen echten Fehler:** `relative_resolved` sollte den Ruckfall
("ausserhalb des Repos -> Stringform") von `relative` uebernehmen, war aber ohne
`try/except` gelandet -- ein `edit`-Muster, das nicht getroffen hatte, und
`str.replace` schweigt dazu. Jetzt drin, und der Test prueft beide Richtungen.
### Cycle 3 — Focus C: die Selbstpflege des Ledgers (Kompaktierung, Verify-before-prune, Stale-Tor)

**Der Engpass.** Nach Cycle 1 lag der Blick auf dem Archiv. Profil mit echtem
Ledger (400 Eintraege auf 200 Tage, 1,37 MB): ein Kompaktierungslauf kostete
**819 ms**, und der cProfile-Abschuss darauf zeigte `posix.fsync` mit 600 Aufrufen
(328 ms, 40 %), dazu pro Tag ein voller Lese- *und* Hash-Durchlauf durch den
frischen Snapshot (`sha256_file`) **plus** ein `deep`-Verify, das jeden Datensatz
noch einmal parst und pro Datei re-hasht. Ausserdem: das Tor, das ueberhaupt erst
entscheidet ob kompaktiert wird (`stale_entry_count`), kostete 3,9 ms -- es
statet jeden Eintrag einzeln.

**Der Schnitt.**
* `write_jsonl_indexed` berechnet die Pruefsumme **aus den Bytes, die es gerade
  schreibt** (`sha256_bytes(payload)`) -- identischer Wert zu `sha256_file`, aber
  ohne den zweiten Durchlauf durch die Datei.
* Der Offset-Index (abgeleitet, fehlt er wird er neu gebaut) verliert seinen
  `fsync`. Der Snapshot behaelt ihn: er ist die Wahrheitsquelle. Auf diesem Medium
  sind das ~0,5 ms pro Datei -- bei 200 Tagen der halbe Lauf.
* Verify-before-prune ist jetzt `_verify_snapshot_write(snapshot, digest, count)`:
  Ruecklesen, Pruefsumme gegen die Schreibvorlage, Zeilenzahl gegen die Erwartung.
  Das alte `deep`-Verhalten (Inhalt fuer Inhalt gegen die Manifest-Pruefsummen)
  bleibt als `verify_archive(force=True)` voll erhalten -- der Audit-Pfad wurde
  nicht wegdiskutiert, nur aus dem Pruef-vor-dem-Loeschen-Pfad herausgenommen.
* **Neue, strengere Bedingung vor dem Prunen:** die Snapshot-Schluessel muessen
  die *Verzeichnisnamen* der Eintraege abdecken, die gleich geloescht werden
  (`wanted = {entry.name ...}`, nicht das, was der Record ueber sich selbst
  sagt). Der alte tiefe Verify fand einen untergeschlagenen Eintrag naemlich
  nicht, wenn der Snapshot nur konsistent mit sich selbst, aber unvollstaendig war.
* `stale_entry_count` zaehlt ueber `os.scandir` (DirEntry-Typ aus dem
  Verzeichniseintrag statt `stat` pro Pfad), macht pro Tag einen Kurzschluss (die
  mtime eines Verzeichnisses ist eine obere Schranke fuer alle seine Eintraege --
  ist der Tag alt, ist alles darin alt, kein einziger `stat` noetig) und nimmt
  ein `limit` an, weil das Tor nur "genug oder nicht genug" wissen will.

**Das Ergebnis** (`scripts/nexus_bench.py`, beide Pfade im selben Prozess; der alte
Verify ist weiterhin aufrufbar und wurde direkt verglichen):

| Metrik (300 Eintraege / 30 Tage) | vorher | nachher | Δ |
|---|---|---|---|
| **Verify-before-prune pro Tag** | **708 µs** | **40,2 µs** | **17,6×** |
| Stale-Zaehlen (Tor, voller Umlauf) | 1732 µs | **280 µs** | **6,2×** |
| dito mit Schwellen-Fruehinterriss | 1732 µs | **75,5 µs** | **22,9×** |
| Lookup nach Kompaktierung | 370 µs | **157 µs** | 2,4× |
| Kompaktierung 400 Eintraege / 200 Tage (Profil-Harness) | 819 ms | **660 ms** | 1,24× (−160 ms) |
| Snapshot-Digest | 27,4 µs (Read+Hash) | im Schreibpfad, **kein zweiter Durchlauf** | −1 Read/Tag |
| Kontrolle: `archive()`-Schreibvorgang | 2204 µs | 2250 µs | unveraendert ✓ |
| Kontrolle: `verify_archive()` (Schnell + tief) | 12011 / 13,7 µs | 12182 / 7,8 µs | unveraendert ✓ |

Integritaet danach gemessen: 0 Violations im Schnell- *und* im tiefen Pfad, alle
300 Eintraege weiterhin per `lookup_archived` aufloesbar, und der neue Zaehler
liefert identische Zahlen wie der alte (Paritaet im Test).

**Guard-Tests** (5 neue): Saboteur, der einen Eintrag unter fremdem Schluessel
ablegt, muss den Tag abbrechen *und* die Verzeichnisse bleiben heil;
abgeschnittener Snapshot wird an Pruefsumme erkannt, Zaehl-Abweichung an der
Zeilenzahl; `limit` bricht frueher ab, antwortet aber unterhalb der Schwelle
exakt; Index-Loeschung kostet hochstens den Neubau (alle Eintraege auffindbar);
Zaehlen gegen die Pfad-Referenz identisch.

**Nicht getan, mit Begruendung:** `verify_archive` ueber einen Tages-Manifest-
Fingerabdruck (Groesse + mtime) *ohne* Oeffnen der Datei waere moeglich und
wuerde 12 ms pro MB auf ~0,2 ms senken -- es prueft dann aber nicht mehr "ist der
Inhalt unveraendert", sondern "hat seit der Pruefung niemand geschrieben". Da
`verify_archive` nur auf Zuruf laeuft (CLI, Audit) und nie im Tick-Pfad, ist das
ein Tausch von Staerke gegen eine Kostenstelle, die niemand zahlt. Blieb in der
Queue, wurde verworfen -- Zahl steht oben.

---

## 📊 TRIAD Nº3 SUMMARY (benchmark deltas)

Alle Werte aus `scripts/nexus_bench.py` bzw. `profile_triad3*.py`: **alter und neuer
Pfad im selben Prozess auf derselben Box**, der alte teils rekonstruiert (Modul-
Funktionen zur Messung zurueckgesetzt), nie aus dem Journal hochgerechnet.
Gate: compile + ruff + mypy + **272 tests** + e2e gruen.

| Cycle | Focus | Headline metric | Before | After | Δ |
|---|---|---|---|---|---|
| 1 | A | Tick, der persistiert | **587,9 µs** | **256,8 µs** | **2,29×, −331 µs** |
| 1 | A | Schedule-Zustand speichern (volle Historie) | 525,1 µs | **234,8 µs** | **2,24×, −290 µs** |
| 1 | A | 44-KB-Dokument atomar schreiben | 6113 µs | **3898 µs** | **1,57×, −2,2 ms** |
| 1 | A | Job-Record auf Platte | 607 B | **502 B** | **−17,5 %** |
| 1 | A | Intent-Datei schreiben (2 KB, mit fsync) | 747 µs | 698 µs | 1,07× (73 % davon sind der Sync-Vertrag) |
| 2 | B | **`Policy.check` pro Dispatch** | **46,3 µs** | **2,05 µs** | **22,6×, −44,2 µs** |
| 2 | B | `build_intent` (Validierung inkl.) | 169,2 µs | **95,0 µs** | **1,78×** |
| 2 | B | `Trigger.from_dict` | 7,25 µs | 6,64 µs | 1,09× (klein, gemessen) |
| 3 | C | Verify-before-prune pro Tag | 708 µs | **40,2 µs** | **17,6×** |
| 3 | C | Stale-Tor (30 Tage) | 1732 µs | **280 / 75,5 µs** | **6,2× / 22,9×** |
| 3 | C | Kompaktierung 400/200 | 819 ms | **660 ms** | 1,24× |
| 3 | C | Datenverlust-Schutz vor dem Prunen | fehlt (tiefer Verify findet unvollstaendigen, aber konsistenten Snapshot nicht) | **Id-Set-Pruefung pro Tag** | strenger, nicht schneller |

### Files changed (Triad 3)
- `core/atomic.py` — **NEU** `atomic_write_bytes` (Temp-Name aus pid+Zaehler,
  `os.open`/`os.write`, `fsync` optional, Raumen auch bei `replace`-Fehler).
- `core/config.py` — `relative_resolved()` (Relativpfad ohne zweiten `resolve()`),
  `relative()` unveraendert inkl. Ruckfall.
- `core/policy.py` — memoisierte Sandbox-Wurzel `(Pfad, Label)` pro Angabe,
  Schranke bei 32, `sandbox_root_label()`; alle vier Antwortpfade nutzen sie.
- `core/protocol.py` — `_allowed_set()` (frozenset pro Konstante, Cache 512),
  `_reject_unknown` sortiert nur noch im Fehlerfall, `_as_enum` ist O(1),
  `_VALID_VERSION_RE` module-level, `_validate_condition` direkt- vor
  normalisierter Form, `Trigger.from_dict` ohne Eingabe-Copy.
- `core/job.py` — `JobStore.save()` kompakt statt `indent=2`.
- `orchestrator/scheduler.py` — `persist_text()` + Fragment-Puffer pro
  Historieneintrag, `save()` ueber den neuen Schreiber ohne Verzeichnis-Pruefung
  im Regelfall.
- `orchestrator/transport.py` — drei JSON-Schreiber laufen ueber
  `atomic_write_bytes`; `write_jsonl_indexed` liefert den Digest beim Schreiben und
  syncht den Index nicht mehr; `_verify_snapshot_write()` neu; Merge-Pruefung auf
  Verzeichnisnamen; `stale_entry_count` mit `scandir`/Tages-Kurzschluss/`limit`.
- `scripts/nexus_bench.py` — drei neue Sektionen (`triad3_writer`,
  `triad3_validation`, `triad3_ledger`), alter Pfad jeweils rekonstruiert.
- `tests/test_nexus_triad3.py` — **NEU** 31 Guard-Tests.

### Naechster Zyklus (Queue, nicht neu verhandeln)
1. **Ein Dokument pro Durchgang statt drei** -- **erledigt in Nr.4/1** (als
   Verlinkung, nicht als Layout-Bruch: 2285,9 -> 1649,9 µs pro `archive()`).
2. **Snapshot pro Lauf statt pro Tag** in `compacted/` (172,7 ms im aktuellen
   Bench-Fixture, 660 ms im 400/200-Profil -> erwartet ~300 ms):
   weniger Dateien, weniger Syncs; braucht neue Kandidatenlogik in
   `lookup_archived`/`verify_archive` und eine Uebergangslesung alter Tagesdateien.
3. **`emit`-Fussboden**: 1,4 µs `Event`-Konstruktion pro Aufruf, die jeder
   In-Repo-Aufrufer verwirft; `MappingProxyType` kostet 0,4 µs, also erst messen.
4. **Heartbeat per mtime** statt Record-Rewrite (262 µs alle `renew_s/5` s) --
   verworfen, solange die Frequenz nicht selbst misst.
5. `schemacheck` bleibt kalt (98,8 µs, CLI-only): erst anfassen, wenn ein Schema
   auf dem Tick-Pfad landet.

- **Die GitHub-Check `Neural Orchestrator CI & Benchmark Evaluation` (`ci-evals.yml`)
  gilt als Fehler der Umgebung, nicht des Zweigs.** Sie scheitert auf `main` genauso
  (Run 34070103309) wie auf jedem Nexus-Zweig vorher, und zwar in ~25 s -- vor jedem
  Python-Schritt. Massstab bleibt `make check`. Nicht fuer dieses Repo verantworten
  wollen, aber auch nicht als Regression lesen. (Nr.3, Cycle 3)

## 🔁 TRIAD Nº4 (2026-09-07, direkt nach Nº3)

Ausgangslage nach Nr.3: die Selbstpflege des Ledgers ist gebaendigt (Kompaktierung
1,24x, Verify-before-prune 17,6x), aber der *Schreibweg* ins Archiv war die ganze
Zeit die teure Zeile im Protokoll: **2,25 ms pro Archivedurchgang**. Der cProfile-
Abschuss ueber 30 Durchgaenge: `posix.fsync` 57 ms von 75 ms_cumtime in
`atomic_write_bytes` -- **76 % des Schreibens sind Sync**, 120 fsyncs bei 120
Schreibvorgängen, also genau einer pro Datei.

### Cycle 1 — Focus A: das Archiv-Duplikat als Verlinkung, nicht als zweiter Schreibvorgang

**Der Engpass.** `archive()` schreibt pro Durchgang vier Dateien: `intent.json`,
`result.iterationN.json`, `result.json`, `verdict.json`. Davon sind zwei
**inhaltlich dasselbe Dokument**: `result.iterationN.json` und `result.json`
entstehen aus demselben `result.to_dict()`, Byte fuer Byte. Der alte Weg hat sie
zweimal kodiert, zweimal geschrieben und **zweimal gesyncht**. Zusatzkosten durch
`write_json_atomic`: viermal `os.makedirs` auf einem Verzeichnis, das der Aufrufer
gerade erst angelegt hat (je 4,8 µs, messbar, überflüssig).

**Der Schnitt.** Statt des vierten Vollzugriffs: der soeben fsyncierte Inhalt wird
per **Hardlink** auf einen Temp-Namen gesetzt und per `os.replace` auf `result.json`
gehoben (zwei Syscalls statt eines weiteren Sync-Laufs). Ein Leser sieht
weiterhin entweder nichts oder das ganze Dokument -- die Reihenfolge (Iterations-Dokument zuerst, dann `result.json`) bleibt erhalten, die Bytes bleiben
erhalten, die Rechte bleiben 0600. Kann das Dateisystem keine Links (FAT, manche
Mounts), faellt `duplicate_json_atomic` auf einen normalen Schreibvorgang zurueck:
gleiche Bytes, ein fsync mehr, keine Observable-Aenderung.

Zwei Dinge, die die Verlinkung fast uebersehen haette, sind mitgebaut:
* `dir_bytes()` zaehlt geteilte Inodes **einmal** (wie `du`). Ohne das haette die
  Buchhaltung des Ledgers nach der Umstellung **38,1 %** mehr Bytes gemeldet als
  wirklich belegt sind (`archive_stats.bytes`, `compact_archive.bytes_freed`).
* `write_json_atomic(..., ensure_dir=False)` auf den drei Schreibvorgängen, deren
  Verzeichnis der Aufrufer schon angelegt hat.

**Das Ergebnis** (`scripts/nexus_bench.py`, Sektion `nio4_archive_link`; beide
Wege schreiben pro Messung ein frisches Zielverzeichnis, also gleiche Arbeit):

| Metrik | vorher | nachher | Δ |
|---|---|---|---|
| **`archive()`-Sequenz (4 Dateien, 300 Eintraege-Fixture)** | **2285,9 µs** | **1649,9 µs** | **1,39×, −636 µs** |
| `fsync` pro Durchgang | 4 | **3** | −1 Sync |
| `transport.archive()` im Lauf (inkl. Selbstpflege-Tor) | 2250 µs (Nr.3) | **1804,1 µs** | −20 % |
| Bytes auf Platte | 3350 B | 3350 B | identisch ✓ |
| gemeldete Archiv-Groesse vs. real belegt | +38,1 % nach der Umstellung | **abgezinst** | Buchhaltung korrekt |
| Verify (schnell + tief), Lookup nach Kompaktierung | — | 0 Violations, alle Eintraege aufloesbar | unveraendert ✓ |

Ueber die Laeufe gemittelt liegt der Gewinn bei **1,39–1,56×** (der
Profil-Harness mass 2206 → 1424 µs); der Zahl oben ist der volle
Bench-Lauf, nicht der beste.

**Was die Verlinkung nicht darf, und warum sie es nicht tut:** ein spaeterer
Durchgang mit `iteration=2` ersetzt **nur** `result.json` (neuer Inode per
`replace`), das aeltere `result.iteration1.json` bleibt an seinem eigenen Inode --
genau das prueft `test_zweite_iteration_laesst_die_erste_unangetastet`. Niemand
schreibt diese Dateien jemals in-place; `write_json_atomic` ersetzt immer, und
`shutil.rmtree` beim Prunen loescht nur Namen.

**Guard-Tests** (8 neue in `tests/test_nexus_triad4.py`): Link zeigt auf
denselben Inode bei gleicher Bytefolge und 0600; Iteration 2 laesst Iteration 1
unangetastet (`st_nlink` 1 vs. 2); kein `.`-Rest im Eintragverzeichnis; Rueckfall
ohne Hardlinks schreibt normal und verlinkt nicht; mit blockierten Links bleibt
das Archiv dicht (verifizierbar, Lookup findet den Eintrag); ein gescheiterter
`replace` hinterlaesst keinen Link; `dir_bytes` == naive Summe wo nichts geteilt
ist, und == Inode-abziehende Summe wo doch.

**Nicht getan, mit Begruendung:** die Syncs selbst -- ein weglassen waere der
Vertragsbruch, und `os.fdatasync` ist bereits als 1,00× gemessen und begraben.
Ein `fsync` auf das *Verzeichnis* nach den Links waere ein Gewinn an
Crash-Festigkeit des Namens (aktuell sichert kein Verzeichnis-Sync den
Verzeichniseintrag; `result.json` kann nach einem Power-Cut fehlen, obwohl sein
Inode laengst auf Platte liegt) -- das ist ein **neuer** Sync auf einem Pfad, den
der Vertrag nicht verlangt, also nichts fuer einen Zyklus, der Kosten senken
soll. In die Queue, mit der Begruendung, dass der Ruecklesepfad fehlende
`result.json` bereits heute verzeihen muss (sonst ist es ein Datenschutz- wie ein
Kompatibilitaetsthema).

## The Graveyard (architectural dead ends)

- **UDS socket *transport* for intent delivery** — still NO. The cross-process
  contract between Orchestrator and Limbs is file-based *by design* (crash-replay +
  language neutrality, `orchestrator/transport.py`); converting intent delivery to
  UDS would break every Limb-subprocess test and give up replayability.
  **Triad 2 refinement:** the *observability plane* (event stream) has no such
  contract — it is fire-and-forget — so it moved to UDS as an **additional sink**
  (`orchestrator/uds.py`), with console/collector/file untouched as fallback.
- ~~**Shared-memory ring is not strictly faster than a buffered file write**~~ —
  **corrected in Triad 2.** It was slower only because it re-`json.dumps`'d each
  event itself (4.7–6.8 µs). With the shared line from the bus the ring write is
  **2.00 µs/event** (3.4×), i.e. now the *fastest* consumer. Kept opt-in, and it
  gained non-raising drop accounting so a stuck reader can't spam the bus.
- **`ensure_ascii=True` for the envelope** — measured 4.44 → 3.68 µs/event
  (0.77 µs) but escapes every umlaut (`\u00e4`) in a codebase whose event payloads
  carry German text. Rejected: unreadable logs are not a µs win.
- **Skipping the `record` dict when only line-sinks are attached** — worth ~0.6 µs
  but would make `write_prepared(record, line)` lie about its first argument and
  split the bus into two record shapes. Rejected; the collector needs it anyway.
- **Bigger `SO_RCVBUF` as UDS backpressure** — setting 4 MB raised the reported
  buffer but not the queue: AF_UNIX `SOCK_DGRAM` accepts ~278 datagrams regardless
  of size (per-datagram skb accounting + `net.unix.max_dgram_qlen`). Buffering is
  not a strategy here; the drop counter is.
- **`settimeout()` per datagram in `recv_batch`** — first draft paid a
  `setsockopt` for every datagram in a burst (~3 µs/event). Hoisted to twice per
  call (once "wait", once "don't block"): burst delivery is now 2.34 µs/event.
- **UDS batching as the default** — through the bus it is only a small win
  (8.58 vs 9.46 µs/event, and 2.35 µs/event at sink level in burst mode) because
  the per-event cost is dominated by `emit` + render, not by the syscall. It
  delays what a live `tail` sees, so it ships as an opt-in flag
  (`--uds-batch BYTES`) with that trade-off in the help text, never as the default.
- **Compiling `schemacheck.validate()` into a closure tree** — still tempting
  (95 µs per intent validation), but its only callers are `orchestrator validate
  --schema` and the parity tests: **not per tick**. Parked until a schema actually
  lands on the fast path. Focus B must not optimize cold code twice.

## System Quirks

- `FileTransport.write_json_atomic` does `os.fsync()` per write → ~ms cost per
  file. That is *correct* (crash-safety contract) and must NOT be removed for the
  standard path; do not "optimize" it away.
- The limb subprocess reads its intent via a file path; converting to UDS/stdin
  sockets would break `tests/` (real subprocess + real timers). Keep file transport.
- **AF_UNIX `SOCK_DGRAM` queue capacity is a *datagram count* (~278 on this box),
  not bytes.** A producer that outpaces its consumer hits `EAGAIN` after ~278
  events, so the sink must be non-blocking and count drops (it is).
- A UDS client `connect()` to a missing path raises `FileNotFoundError`
  immediately — cheap probe. But it must be `setblocking(False)` **after** the
  connect, or a full peer queue blocks the producer inside `send`.
- `sun_path` is limited to 108 bytes; `uds.py` falls back to the Linux abstract
  namespace (`\0neu-<path>`). No inode, no cleanup needed — but also no file
  permissions, so 0600 only applies to the filesystem variant.
- Socket files ignore `fchmod`-at-create; `chmod(path, 0o600)` **after** `bind()` is
  what works. Asserted by `test_socket_rechte_0600`.
- `bus tail` measures *idle*, not per-datagram latency: `--idle` must exceed the
  producer's startup (~1–2 s: interpreter + config + limb spawn) or the tailer quits
  before the first event arrives. That cost me one debugging cycle; default is 5 s.
- `int_YYYYMMDDT…` embeds the **creation** day, but archiving can happen one second
  later, i.e. on the next day. `lookup_archived` therefore tries the hinted day
  first, then all other days (days are few; O(1) in the common case).
- Compaction order is a data-integrity decision: snapshot (fsync, atomic) → index →
  deep verify → only then prune. A lost index is recoverable, lost data is not.
- The compacted snapshot hashes **canonical JSON** (compact separators), *not* raw
  file bytes — so `verify_archive()` is independent of `indent`/line-ending. The
  *day digest* (`sha256_snapshot`) hashes raw file bytes and is therefore
  formatting-sensitive by design: it detects any edit, the per-record digests
  localize it.
- `archive()` now triggers `maybe_compact()` every 64 writes. Benchmarks/tests that
  create many **aged** entries must set `NEU_ARCHIVE_AUTOCOMPACT=0` (the bench does).
- `_CONDITION_CACHE`, `_EPOCH_CACHE`, `_LITERAL_CACHE` are all **bounded** (clear at
  max). Never turn one into an unbounded dict: the tick path would grow the process
  forever, which is the same mistake as an unbounded ledger.
- `repr(float)` matches `json.dumps` for finite floats, but writes `nan`/`inf` where
  the encoder writes `NaN`/`Infinity` → `_json_number` delegates non-finite values.
  Found by the byte-parity test, not by the benchmark.

---

## 📊 TRIAD Nº1 SUMMARY (benchmark deltas)

All numbers from `scripts/nexus_bench.py`. Baseline = Commit `2639525` (parent of
this branch). Gate: compile + ruff + mypy + **213 tests** all green.

### Focus A — Event-Bus (sub-ms IPC)
| Metric | Before | After | Δ |
|---|---|---|---|
| `EventBus.emit` (null sink) | **2.81 µs** | **1.99 µs** | **−0.82 µs (1.4×)** |
| `EventBus.emit` (CollectingSink) | **3.57 µs** | **3.20 µs** | −0.37 µs |
| ISO-ms timestamp | **1.05 µs** | **0.36 µs** | **−0.69 µs (2.9×)** |
| Shared-memory ring write (opt-in) | file flush ~1.0 µs | **4.7 µs/event** | bounded, zero-syscall, readable cross-process |

### Focus B — Fast-Path Schema Validation
| Metric | Before | After | Δ |
|---|---|---|---|
| `schemacheck.validate` (intent.schema) | **77.20 µs** | **60.7 µs** | **−16.5 µs (1.27×)** |

### Focus C — Ledger Compaction & Archive (120 entries)
| Metric | Before | After | Δ |
|---|---|---|---|
| Expanded entries | **120** | **0** | compacted into 1/day snapshots |
| Expanded bytes | **400,720 B** | **0 B** (snapshot **272,550 B**) | **−32 % storage**, 400,720 B freed |
| Pruned dirs | — | 120 | — |
| `verify_archive` violations | — | **0** | integrity preserved |

### Files changed (Triad 1)
- `orchestrator/events.py` — fast timestamp + single-record emit; ring sink hook.
- `orchestrator/ring.py` — NEW `SharedMemoryRingSink` / `SharedMemoryRingReader`.
- `core/schemacheck.py` — `_PATTERN_CACHE`, `_SUPPORTED_KEYS`, single-type fast path.
- `orchestrator/transport.py` — `archive_stats()`, `compact_archive()`, `verify_archive()`,
  `read_jsonl`/`write_jsonl_atomic`.
- `orchestrator/cli.py` — `orchestrator archive stats|compact` subcommands.
- `scripts/nexus_bench.py` — reproducible triad benchmark.
- `tests/test_nexus_triad.py` — NEW guards (3 tests).

---

## 📊 TRIAD Nº2 SUMMARY (benchmark deltas)

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

### Files changed (Triad 2)
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

### Next cycle (queue, do not re-litigate) -- **abgearbeitet in TRIAD Nº3, siehe oben**
1. **Focus B:** compile `schemacheck` schemas once (`validate()` closure tree) —
   only once a schema lands on the tick path; today it's cold (95 µs, CLI-only).
2. **Focus A:** the remaining `emit` floor is 1.4 µs of `Event(...)` construction
   per call — an object *every* in-repo caller discards. `slots=True` was taken this
   cycle (memory, not speed). A read-only shared record view is still open, but
   `MappingProxyType` costs 0.4 µs, so measure before adopting.
3. **Focus C:** day digest is per-file; a **cross-day** digest manifest
   (`compacted/index.json` with per-day digests + counts) would let
   `archive verify` skip unchanged days *without* opening them at all.
4. Per-tick cost now dominated by `save()`'s `json.dumps` of the whole
   `ScheduleState` on every state change — delta-persistence is the next candidate.

### PR
**#10** — `⚡ Nexus: IPC & Core Performance Triad [2026-09-07T02:05:00Z]`
→ https://github.com/Finnlayy/NIO/pull/10 (`main` <- `arena/01a07962-nio`,
12 files, +2545/-189, `MERGEABLE`). commit `bb47077`.
Der fertige PR-Text liegt als `.nio/pr_triad2_body.md` im Branch.
