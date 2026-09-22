# NEU-Kommunikationsprotokoll 1.2

Normative Spezifikation der Kommunikation zwischen **KI-Kern (Core)**,
**Orchestrator** und **Limbs**.

| Rolle | Datei | Verantwortung |
|---|---|---|
| Referenzimplementierung | `core/protocol.py` | **massgeblich** bei Uneinigkeit |
| JSON Schema (Intent) | `protocol/intent.schema.json` | Editoren, CI, fremdsprachige Limbs |
| JSON Schema (Result) | `protocol/result.schema.json` | dito |
| Operations-Register | `protocol/operations.json` | welche Operationen existieren, Risiko, Rechte, Implementierer |
| Limb-Register | `limbs/registry.json` | welche Limbs existieren, Status, Entrypoint, Laufzeit |
| Beispiele (echte Läufe) | `protocol/examples/` | aus `runtime/archive/` kopiert und validiert |

Protokoll-ID: `neu/intent` und `neu/result`, Version `1.2`.
Kompatibilitätsregel: gleiche Major-Version = kompatibel, Minor-Erweiterungen
sind erlaubt, unbekannte Schlüssel auf Envelope-Ebene sind **Fehler**.
Umschläge mit `version: "1.0"`/`"1.1"` werden weiterhin gelesen und beim
Serialisieren auf `1.2` gehoben (Upgrade beim Lesen, kein Bruch: alle neuen
Felder haben Defaults — `timer.mode="deadline"`, `schedule.triggers=[]`).

---

## 1. Warum zwei Envelopes

Ein **Intent** ist ein isolierter Auftrag. Der Limb sieht nichts außer diesem
JSON: keine Chat-Historie, keine Gedanken des Kerns, keine anderen Aufträge.
Ein **Result** ist die einzige Antwort darauf — exakt ein Objekt pro Durchgang.

```
KI-Kern ──(Intent)──▶ Orchestrator ──(Inbox-Datei)──▶ Limb
KI-Kern ◀─(Result)─── Orchestrator ◀─(stdout/JSON)─── Limb
```

Transport ist dateibasiert (`runtime/inbox/<limb>/<intent_id>.json`), weil das
nachvollziehbar, sprachneutral und absturzsicher ist. Ein Limb in Node, Rust
oder Bash liest dieselbe Datei.

---

## 2. Intent (Core → Limb)

```jsonc
{
  "protocol": "neu/intent",
  "version": "1.2",
  "intent_id": "int_20260903T130118Z_ffcc23",   // Pflicht, sortierbar
  "trace_id": "job_20260903T130118Z_69591b",     // = job_id (Korrelation)
  "parent_intent_id": null,                      // Vorgänger bei Korrekturdurchgang
  "idempotency_key": "job_…:i1:int_…",           // Wiederholbarkeit
  "created_at": "2026-09-03T13:01:18.524Z",      // UTC, Millisekunden, "Z"
  "source": { "role": "core", "node_id": "core.kernel" },
  "target": { "limb": "echo", "version": null }, // Name aus limbs/registry.json

  "job": {                                       // Iterationen zählen pro JOB
    "job_id": "job_20260903T130118Z_69591b",
    "goal": "Simulation innerhalb des Zeitbudgets abschliessen",
    "iteration": 1,
    "max_iterations": 2,                         // hartes Maximum: 2
    "on_failure": "autodidactic"                 // autodidactic | return_to_core | abort
  },

  "timer": {                                     // wird VOR ANBEGINN geschaerft
    "mode": "deadline",                          // deadline | unlimited  (1.2)
    "deadline_s": 2.0,                           // hartes Budget; null = unlimited
    "soft_deadline_s": 1.0,                      // hier: Pflicht-Statusbericht
    "grace_s": 1.0,                              // Nachfrist bis zum harten Kill
    "on_expiry": "iterate",                      // iterate | escalate | abort | none
    "safety_net_s": 3600.0,                      // Prozess-Hygiene, kein Aufgabenlimit (1.2)
    "t0": "2026-09-03T13:01:18.000Z",            // Nullpunkt der Uhr (1.2)
    "armed_at": "2026-09-03T13:01:18.524Z",      // vom Orchestrator gesetzt
    "soft_expires_at": "2026-09-03T13:01:19.524Z",
    "expires_at": "2026-09-03T13:01:20.524Z",
    "elapsed_s": 0.524                           // t_unlimited seit t0 (1.2)
  },

  "schedule": { "triggers": [], "tick_s": 0.5 },  // zeitgesteuerte Ausloeser, siehe §3.3

  "task": {
    "operation": "sys.simulate",                 // muss im Register stehen
    "params": { "mode": "timeout", "seconds": 3 },
    "title": "Timer-Test mit Korrektur",
    "objective": "Klartextziel — der einzige Kontext des Limbs",
    "acceptance": ["Kriterium 1", "Kriterium 2"],
    "verification": { "type": "none", "command": "", "expect": {} }
  },

  "constraints": {
    "sandbox_root": "workspace",                 // "." nur mit repo_write
    "allow_shell": false,
    "allow_network": false,
    "max_output_bytes": 1048576,
    "dry_run": false,
    "backup": true
  },

  "elevation": {                                 // Rechteanhebung (Ouroboros)
    "level": "none",                             // none | workspace | repo_write
    "reason": "",                                // ab level != none: >= 20 Zeichen
    "approved_by": "",                           // core | human
    "requested_paths": []                        // Deklaration aller Zielpfade
  },

  "context": {
    "summary": "Fehlschlags-Briefing …",
    "artifacts": [{ "path": "…", "sha256": "…", "role": "input" }],
    "extra": { "autodidactic": true }            // frei erweiterbar
  }
}
```

**Pflichtfelder:** `protocol`, `version`, `intent_id`, `created_at`, `source`,
`target`, `job`, `task.operation`.

---

## 3. Timer-Semantik (Kernanforderung)

Jeder Auftrag bekommt **vor Anbeginn** einen Timer — gesetzt vom Orchestrator,
nicht vom Limb:

```
created_at ──▶ armed_at ──┬─▶ soft_expires_at ──┬─▶ expires_at ──▶ +grace_s
                          │                     │                  │
                 Start des Limbs      Pflicht-Statusbericht    harter Kill
                                      durch den Limb           durch Orchestrator
                                      (self_reported=true)     (self_reported=false)
```

1. `Orchestrator.dispatch()` ruft `arm_timer()` auf, **bevor** die Intent-Datei
   in die Inbox geschrieben wird. Der Limb liest also eine absolute Deadline.
2. Der Limb führt den Handler in einem Arbeitsthread aus und wartet bis zur
   Soft-Deadline. Ist die Arbeit dann nicht fertig, meldet er **selbst**
   `status="timeout"` mit vollständigem `status_report`.
3. Reagiert der Limb nicht, bricht der Orchestrator nach `deadline_s + grace_s`
   hart ab und **synthetisiert** denselben Bericht (`self_reported=false`).
4. `timer.on_expiry="iterate"` → es folgt der zweite Durchgang (siehe §6).

Der Subprozess-Timeout des Orchestrators ist `timer.hard_timeout_s()`
(= `deadline_s + grace_s`, gedeckelt auf 900 s).

### 3.1 Zwei Zeit-Modi (`timer.mode`) — neu in 1.2

| Modus | `deadline_s` | Bedeutung | `hard_timeout_s()` |
|---|---|---|---|
| `deadline` | Zahl > 0 | Zeit wird **begrenzt**; Ablauf erzwingt den Statusbericht | `deadline_s + grace_s` |
| `unlimited` | `null` | Zeit wird **getrackt**, nicht begrenzt | `safety_net_s` (oder `None`) |

Regel: **`deadline_s = null` ⇔ `mode = "unlimited"`.** Wird dem Orchestrator kein
Zeitlimit vorgegeben (weder vom Benutzer noch vom Kern), entsteht kein
„riesiges Limit", sondern der Tracking-Modus. Das Schema verbietet die
Mischform (`mode="unlimited"` mit `deadline_s` belegt → ungültig), damit es
niemals zwei Wahrheiten über denselben Auftrag gibt.

Im Unlimited-Modus gilt:

* `timer.t0` ist der **Nullpunkt** (Job-Erstellung; beim Schärfen wird
  `armed_at` gesetzt, `t0` bleibt die Job-Uhr).
* `elapsed_s` ist die seit `t0` vergangene Zeit — im Projekt **`t_unlimited`**
  genannt. Sie steht im Intent (nach dem Schärfen), in **jedem Event**
  (`clock_s`) und im Result (`timer.elapsed_s`).
* `on_expiry` ist zwingend `"none"`: Es gibt keinen Ablauf, also keine
  Ablaufaktion. `soft_deadline_s` ist `null`.
* Der Limb wartet **ohne** Watchdog-Abbruch; `remaining_ms` im Result ist `null`.

### 3.2 Safety-Netz (`timer.safety_net_s`) — Prozess-Hygiene, kein Aufgabenlimit

Das Safety-Netz verhindert Zombies (hängender Prozess, blockierte Pipeline). Es
begrenzt **nicht** die Aufgabe. Default `3600 s`, `0`/`null` = wirklich
unbegrenzt (nur mit menschlicher Freigabe sinnvoll, weil `neu.config.json` unter
dem Constitution Guard steht).

Greift das Netz, meldet der Limb (oder der Orchestrator, falls der Limb selbst
hängt) `status="failed"` mit `error.code="E_SAFETY_NET"` und einem vollständigen
`status_report` (`state="blocked"`). Der Kern **eskaliert** dann
(`next_action="escalate_to_human"`) statt zu iterieren: Ein zweiter Durchgang
würde dieselbe Uhr erneut überlaufen. Maßnahmen: Auftrag zerlegen oder
`safety_net_s` bewusst anheben.

### 3.3 Zeitgesteuerte Auslöser (`intent.schedule`) — neu in 1.2

`schedule.triggers[]` macht die Job-Uhr zur **Ereignisquelle**: „Wenn
`t_unlimited` ≥/≤/= `event_time`, führe X aus" und „prüfe alle X Sekunden X und
Y". Der Orchestrator tickt (`schedule.tick_s`, Default `0.5 s`), vergleicht
`elapsed` mit den Auslösern und führt fällige Aktionen aus.

```jsonc
"schedule": {
  "tick_s": 0.5,
  "triggers": [
    { "id": "kontrolle", "action": "check", "every_s": 10,
      "payload": { "operation": "sys.echo", "params": { "message": "Status?" } } },
    { "id": "schwelle", "action": "emit_event", "when": "elapsed >= 30",
      "payload": { "kind": "timer.threshold" } },
    { "id": "marken",  "action": "log", "at_s": [5, 15] },
    { "id": "ende",    "action": "finish_job", "when": "elapsed >= 120" }
  ]
}
```

**Auslöser** (mindestens einer pro Trigger, kombinierbar):

| Feld | Semantik | Feuerungsverhalten |
|---|---|---|
| `when` | Bedingung `elapsed <op> <sekunden>`, `op ∈ {<=, >=, ==, !=, <, >}` | **kantengesteuert**: feuert in dem Tick, in dem sie wahr *wird* |
| `every_s` | Intervall („alle N Sekunden") | wiederholend; mit `when` zählt das Intervall erst ab Eintritt der Bedingung |
| `at_s` | diskrete Zeitmarken (Sekunden seit `t0`) | jede Marke feuert genau einmal, die Liste wird abgearbeitet |

`tolerance_s` (Default `0.25`) gilt **nur** für `==`/`!=`: Ticks sind diskret,
Gleichheit braucht ein Fenster. Ordnungsvergleiche sind exakt — „`elapsed >= 30`"
darf nicht bei 29,8 s feuern. Verspätung ist erlaubt und wird dokumentiert:
`elapsed_s` im Event zeigt die echte Uhrzeit der Feuerung, `catch_up` die Zahl
nachgeholter Intervalle.

**Aktionen:**

| `action` | Wirkung | `payload` |
|---|---|---|
| `emit_event` | Event auf dem Bus (`payload.kind`, Default `timer.trigger`) | optional |
| `log` | Freitext-Logeintrag (`timer.log`) | optional (`message`) |
| `check` | **eigenen Kontroll-Job** dispatchen (`kind="scheduled"`) | **Pflicht**: `operation`+`params` oder `checks[]` (bis 8) |
| `escalate` | Eskalation markieren (`needs_human=true`, `timer.escalation`) | optional (`reason`) |
| `finish_job` | beobachteten Auftrag als abgeschlossen beenden (`timer.finished`) | optional |

**Budget-Trennung (wichtig):** `check`-Trigger verbrauchen **kein**
Iterations-Budget des beobachteten Jobs. Sie erzeugen eigene Jobs mit eigener
Spur (`kind="scheduled"`, `parent_job_id`, `trigger_id`) und eigenem
Slot-Kontingent (`limits.max_scheduled_jobs`, Dev-Profil `1`). Eine laufende
Beobachtung blockiert ihre eigenen Kontrollen damit nicht — und Kontrollen
können den Auftrag nicht „aufbrauchen".

`once` (Default: `true` bei reiner `when`-Kante, sonst `false`) und `max_fires`
(`0` = unbegrenzt) begrenzen die Feuerungen. Der Trigger-Zustand ist persistent
(`runtime/schedules/<job_id>.json`): Ein Neustart des Orchestrators setzt weder
`t0` zurück noch vergisst er erfolgte Feuerungen. Kann ein Auslöser nicht
ausgeführt werden (z. B. Kontingent belegt), entsteht ein `timer.skipped`-Event —
**kein stiller Verlust**.

**Validierung:** Trigger werden beim Intent-Pre-Flight geprüft
(`core/policy.py`): Aktions-Whitelist, `check`-Operationen gegen das
Operationsregister, Rechte wie beim Hauptauftrag, Anzahl gegen
`limits.max_scheduled_jobs`. Verstöße → `E_TRIGGER_INVALID` **vor** dem Start.

---

## 4. Result (Limb → Core)

```jsonc
{
  "protocol": "neu/result",
  "version": "1.1",
  "result_id": "res_20260903T130119Z_9f1a2b",
  "intent_id": "int_20260903T130118Z_ffcc23",
  "trace_id": "job_20260903T130118Z_69591b",
  "job_id": "job_20260903T130118Z_69591b",
  "iteration": 1,
  "status": "timeout",                 // success | partial | failed | rejected | timeout
  "operation": "sys.simulate",
  "limb": { "name": "echo", "version": "1.0.0", "pid": 4242 },
  "started_at": "2026-09-03T13:01:18.574Z",
  "finished_at": "2026-09-03T13:01:19.523Z",
  "duration_ms": 949,
  "output": { "handler_alive": true, "done_steps": ["Warten begonnen"] },
  "artifacts": [
    { "path": "workspace/demo.txt", "action": "created", "bytes": 12,
      "sha256": "…64 hex…", "backup_path": "runtime/backups/…" }
  ],
  "status_report": {                   // PFLICHT bei timeout und partial
    "state": "timeout",                // completed | partial | blocked | timeout
    "explanation": "Warum es in diesem Durchgang nicht abschließbar war",
    "done": ["Warten begonnen"],
    "remaining": ["3.0s warten", "Ergebnis melden"],
    "blockers": [{ "code": "E_TIMEOUT", "message": "…", "hint": "…" }],
    "suggested_next": "Zweiter Durchgang mit verkleinertem Umfang."
  },
  "timer": {
    "armed_at": "2026-09-03T13:01:18.524Z",
    "expires_at": "2026-09-03T13:01:20.524Z",
    "reported_at": "2026-09-03T13:01:19.523Z",
    "remaining_ms": 999,               // negativ = Budget überschritten
    "overrun_ms": 0,
    "self_reported": true              // true = Limb, false = Orchestrator
  },
  "diagnostics": { "stdout": "", "stderr": "…", "exit_code": null },
  "error": { "code": "E_TIMEOUT", "message": "…", "hint": "…" },
  "self_report": { "confidence": 0.2, "notes": "…" }
}
```

**Konsistenzregeln (vom Parser erzwungen):**

| Regel | Fehler |
|---|---|
| `status` ∈ {failed, rejected} ⇒ `error` Pflicht | `E_SCHEMA_INVALID` |
| `status` = success ⇒ `error` verboten | `E_SCHEMA_INVALID` |
| `status` = timeout ⇒ `status_report` Pflicht, `state` ∈ {timeout, blocked, partial} | `E_SCHEMA_INVALID` |
| `status` = partial ⇒ `status_report` Pflicht | `E_SCHEMA_INVALID` |
| `status` = success mit `status_report` ⇒ `state` = completed | `E_SCHEMA_INVALID` |
| `error.code` muss aus der Code-Tabelle stammen | `E_SCHEMA_INVALID` |
| `finished_at` ≥ `started_at` | `E_SCHEMA_INVALID` |
| `intent_id`, `trace_id`, `job_id`, `iteration`, `operation`, `limb.name` müssen zum Intent passen | `E_SCHEMA_INVALID` |
| `self_report.confidence` < 0.5 ⇒ Erfolg wird zu `needs_correction` | Verdict |

---

## 5. Fehlercodes

| Code | Bedeutung | Typische Maßnahme |
|---|---|---|
| `E_SCHEMA_INVALID` | Envelope verletzt das Protokoll | Parameter/Struktur korrigieren |
| `E_UNSUPPORTED_OP` | Operation nicht im Register | Operation aus `operations.json` wählen |
| `E_TARGET_NOT_FOUND` | Limb unbekannt, `planned` oder Entrypoint fehlt | Register prüfen / Limb bauen |
| `E_SANDBOX_ESCAPE` | Pfad verlässt Sandbox / enthält `..` / absolut | `elevation.level=repo_write` beantragen |
| `E_POLICY_DENIED` | Rechte, Profil oder Constitution Guard | Eskalation, ggf. menschliche Freigabe |
| `E_PATH_NOT_FOUND` | Ziel existiert nicht | `mode=create` bzw. Pfad korrigieren |
| `E_ALREADY_EXISTS` | Ziel existiert schon | `mode=overwrite` + `expect_sha256` |
| `E_PATCH_NO_MATCH` | Suchtext von `fs.patch` nicht gefunden | erst lesen, dann ganz schreiben |
| `E_TIMEOUT` | Timer abgelaufen (Modus `deadline`) | Umfang verkleinern, Timer anpassen |
| `E_SAFETY_NET` | Safety-Netz hat den Prozess beendet (**kein** Aufgabenlimit) | eskalieren: Auftrag zerlegen oder `safety_net_s` anheben |
| `E_TRIGGER_INVALID` | `schedule.triggers[]` ungültig (Grammatik, Aktion, Payload, Rechte) | Trigger korrigieren; wird vor dem Start abgelehnt |
| `E_DEADLINE_EXCEEDED` | Deadline im Limb überschritten | dito |
| `E_BUDGET_EXHAUSTED` | Iterations-Budget des Jobs erschöpft | Job neu aufsetzen oder Profil anheben |
| `E_SHELL_BLOCKED` | `shell.exec` ohne Freigabe | `allow_shell_ops` + `constraints.allow_shell` |
| `E_IO` | Dateisystemfehler | Backup aktivieren, Pfad prüfen |
| `E_LIMB_CRASH` | kein protokollkonformes Result / Exit ≠ 0 | Umfang halbieren, stdout-Vertrag prüfen |
| `E_INTERNAL` | unerwarteter Fehler | Diagnose aus `stderr` |

---

## 6. Job-, Iterations- und Fehlersemantik

```
open ──▶ running ──▶ resolved                       Ziel erreicht
                 ├──▶ iterating ──▶ resolved        Autodidaktik wirkt
                 │              ├──▶ failed         keine Maßnahme ODER Budget leer
                 │              └──▶ escalated      Mensch nötig
                 └──▶ escalated                     Ablehnung vor Ausführung
```

**Regel 1 — Iterationen zählen pro Job.** Ein Agentenaufruf ist ein *Durchgang*;
gezählt wird pro `job_id`. Hartes Maximum: **2**. Dev-Profil: **1**.

**Regel 2 — kein stilles Retry.** Es gibt keine automatische Wiederholung
derselben Aktion. Ein Fehlschlag erzeugt entweder einen *neu entworfenen*
Auftrag oder einen Terminalzustand.

**Regel 3 — „wirklich failed".** Ein Job ist nur dann wirklich gescheitert, wenn
nach dem Versagen **keine Maßnahme** ergriffen werden kann
(`failure_kind = no_measure_available`). Weitere Terminalfälle:

| `failure_kind` | Bedeutung | `really_failed` |
|---|---|---|
| `no_measure_available` | keine Lösungsidee, System hilflos | **ja** |
| `budget_exhausted` | Maßnahme bekannt, aber kein Budget mehr | nein |
| `escalation_required` | menschliche Freigabe/Fähigkeit fehlt | nein (→ `escalated`) |
| `stale_reclaimed` | verwaister Job (Prozessabsturz) | nein (→ `escalated`) |
| `internal_error` | unbehandelter Fehler im Orchestrator | nein (→ `escalated`) |

**Regel 4 — Autodidaktischer Modus.** Ist eine Maßnahme verfügbar *und* Budget
übrig, geht das System selbst in die Korrektur: `orchestrator/planner.py`
diagnostiziert den Fehlschlag und entwirft den nächsten Intent (siehe §7). Das
zählt als ergriffene Maßnahme (`measures_taken += 1`) und ist der gewünschte
Normalfall.

---

## 7. Der zweite Durchgang (vom Orchestrator entworfen)

Der Korrektur-Intent unterscheidet sich vom ersten — niemals bloße Wiederholung:

| Feld | Änderung |
|---|---|
| `intent_id` | neu |
| `job.job_id`, `trace_id` | **identisch** (dieselbe Spur) |
| `job.iteration` | `+1` |
| `parent_intent_id` | zeigt auf den Fehlversuch |
| `timer.deadline_s` | skaliert (Faktor je Diagnose, z. B. ×1.5) |
| `task.params` | Umfang verkleinert (z. B. `seconds` halbiert, Batches begrenzt) |
| `task.objective` | Diagnose + Maßnahme + Wiederholungsverbot in Klartext |
| `task.acceptance` | um messbare Kriterien des Fehlschlags ergänzt |
| `context.summary` | vollständiges Fehlschlags-Briefing |
| `context.extra` | `autodidactic`, `diagnosis`, `previous`, `forbidden_repeats` |

`forbidden_repeats` enthält den Fingerabdruck (`sha256`-Präfix) der Kombination
aus Operation und Parametern des Fehlversuchs.

Diagnose-Matrix (Auszug, vollständig in `orchestrator/planner.py`):

| Auslöser | Maßnahme |
|---|---|
| `timeout` / `E_TIMEOUT` | Umfang verkleinern, Timer anheben, nur ein prüfbares Teilergebnis |
| `E_PATCH_NO_MATCH` | erst `fs.read_file`, dann `fs.write_file` statt blindem Patch |
| `E_SANDBOX_ESCAPE` | `elevation.level=repo_write` mit Begründung und deklarierten Pfaden |
| `E_PATH_NOT_FOUND` | `mode=create` |
| `E_ALREADY_EXISTS` | `mode=overwrite` + Backup |
| `E_LIMB_CRASH` | Umfang halbieren, stdout-Vertrag im Objective erneut klarstellen |
| `partial` | nur die offenen Punkte als Mikro-Auftrag |
| Profil-/Constitution-Guard-Verstoß | **keine** Automatik → Eskalation zum Menschen |

---

## 8. Rechte, Sandbox und Constitution Guard

* Ohne Elevation: Basis ist `constraints.sandbox_root` (Default `workspace/`).
  `..`, absolute Pfade und Nullbytes → `E_SANDBOX_ESCAPE`.
* Mit `elevation.level="repo_write"`: Basis ist das Repo-Root. Der Pfad muss
  `allowed_repo_globs` treffen, darf `denied_globs` **nicht** treffen und muss
  in `elevation.requested_paths` deklariert sein.
* `human_only_globs` (**Constitution Guard**: `neu.config.json`,
  `core/policy.py`, `core/config.py`, `.git/*`, `.github/*`) verlangen
  `approved_by="human"`. Ein Limb darf sich seine Rechte nie selbst erweitern.
* Schreiboperationen legen vorher ein Backup unter `runtime/backups/` ab
  (`constraints.backup=true`, Default).
* Die Pfadprüfung wirkt **doppelt**: Pre-Flight im Orchestrator und erneut zur
  Laufzeit im Limb (`Policy.resolve_path`).
* Budget- und Profilfragen prüft ausschließlich der Orchestrator
  (`Policy.check`), der Limb nur Sandbox/Rechte (`Policy.check_runtime`) —
  sonst entsteht Konfigurations-Drift zwischen den Prozessen.

---

## 9. Skalierungsprofile

| Profil | `max_iterations` | `max_agents` | `max_limbs` | `max_concurrent_jobs` |
|---|---|---|---|---|
| `dev` (aktuell) | 1 | 1 | 1 | 1 |
| `scale` | 2 | 4 | 4 | 2 |

`max_limbs` begrenzt die Limb-Vielfalt **pro Job**, `max_agents` die Zahl
gleichzeitiger Limb-Prozesse (Datei-Locks in `runtime/locks/`, PID- und
TTL-geprüft). Dauerhaft umschalten nur mit menschlicher Freigabe:

```bash
python3 -m orchestrator scale --profile scale --approved-by human
```

Für einen einzelnen Aufruf (nicht persistiert): `python3 -m orchestrator --mode scale …`

---

## 10. Aufrufvertrag für Limbs

```bash
python3 limbs/<name>_limb.py --intent <datei.json> [--out <datei>] [--pretty]
cat intent.json | python3 limbs/<name>_limb.py --stdin
```

* **stdout** = genau ein JSON-Objekt (`neu/result`). Nichts sonst.
* **stderr** = frei für Diagnose.
* Exit-Code `0` = Result erzeugt (auch bei `failed`/`timeout`);
  `70` = kein Result möglich → Orchestrator synthetisiert `E_LIMB_CRASH`.
* Der Orchestrator reicht `--iteration` und `--profile` durch.

---

## 11. Änderungsprotokoll

### 1.2 (2026-09-04) — Zeit tracken statt begrenzen + zeitgesteuerte Auslöser

* `timer.mode` (`deadline` | `unlimited`); `deadline_s`/`soft_deadline_s` sind
  nullable. **`deadline_s = null` ⇔ unlimited**: Ohne Vorgabe wird die Zeit
  aufgezeichnet, nicht begrenzt.
* `timer.t0` (Nullpunkt) und `timer.elapsed_s` (**`t_unlimited`**) — im Intent,
  im Result (`timer.mode`, `timer.t0`, `timer.elapsed_s`, `remaining_ms`
  nullable) und in jedem Event (`clock_s`).
* `timer.safety_net_s` + Fehlercode `E_SAFETY_NET`: Prozess-Hygiene statt
  Aufgabenlimit; Eingriff eskaliert (kein 2. Durchgang, der dieselbe Uhr
  überlaufen würde).
* `intent.schedule.triggers[]` mit `when` (kantengesteuert), `every_s`
  (Intervall) und `at_s` (Marken); Aktionen `emit_event`, `log`, `check`,
  `escalate`, `finish_job`; `once`, `max_fires`, `tolerance_s`, `clock`.
* `check`-Trigger erzeugen Jobs mit `kind="scheduled"` (eigene Spur, eigenes
  Kontingent `limits.max_scheduled_jobs`) — sie verbrauchen kein
  Iterations-Budget des beobachteten Jobs.
* Fehlercode `E_TRIGGER_INVALID`; Trigger werden beim Pre-Flight geprüft
  (fail-fast statt Laufzeitfehler).
* Persistenter Trigger-Zustand (`runtime/schedules/<job_id>.json`), übersprungene
  Feuerungen als `timer.skipped`-Event (kein stiller Verlust).
* Abwärtskompatibel: 1.0/1.1-Umschläge bleiben gültig; Schemas akzeptieren
  `^1\.[0-2]$`. Parität zwischen Parser und Schema wird maschinell geprüft
  (`tests/test_schema_parity.py`).

### 1.1 (2026-09-03) — Timer-, Statusberichts- und Autodidaktik-Semantik

* Timer wird **vor Anbeginn** vom Orchestrator geschärft; Ablauf erzwingt einen
  vollständigen `status_report` (`self_reported` unterscheidet Limb und
  Synthese).
* Iterationen zählen pro Job (hartes Maximum 2); kein stilles Retry.
* Autodidaktischer Modus: Nach einem Fehlschlag entwirft der Kern den zweiten
  Durchgang. „Failed" gilt erst, wenn keine Maßnahme ergriffen wurde.
* `retry_policy` entfernt; Skalierungsprofile (`dev`, `scale`); Constitution
  Guard für menschenpflichtige Dateien.
