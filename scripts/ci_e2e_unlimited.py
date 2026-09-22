#!/usr/bin/env python3
"""End-to-End-Beweis fuer Protokoll 1.2 -- laeuft in CI und lokal (``make e2e``).

Was hier bewiesen wird, ist die Kernforderung: **Wird kein Zeitlimit vorgegeben,
trackt NEU die Zeit, statt sie zu begrenzen** -- und zeitgesteuerte Ausloeser
arbeiten gegen dieselbe Uhr.

Der Beweis startet die echte CLI (``python3 -m orchestrator``) in einem
Temp-``runtime/``: ein Auftrag ohne Deadline, eine Intervall-Kontrolle alle
0,4 s und ein ``finish_job``-Ausloeser bei ``elapsed >= 2.0``. Der Limb selbst
wartet 30 s -- der Auftrag endet trotzdem nach rund zwei Sekunden, weil die Uhr
ihn beendet, nicht ein Budget.

Geprueft werden:

* Exit-Code 0, ``status=resolved``, ``timer_mode=unlimited``
* ``deadline_s``/``expires_at``/``remaining_ms`` sind ``null`` (kein erfundenes Budget)
* ``t_unlimited`` liegt an der Triggerschwelle, nicht an der Wartezeit des Limbs
* Kontroll-Jobs liefen wirklich (``kind=scheduled``, rueckverfolgbar zum Trigger)
* Der Zeitplan ist danach aufgeraeumt (``runtime/schedules/`` leer)

Nur Standardbibliothek. Fehler -> Exit 1 mit Befund.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

THRESHOLD_S = 2.0
INTERVAL_S = 0.4
LIMB_WAIT_S = 30.0


def fail(message: str) -> int:
    print(f"[e2e] FEHLGESCHLAGEN: {message}", file=sys.stderr)
    return 1


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="neu-e2e-") as tmp:
        runtime = Path(tmp) / "runtime"
        command = [
            sys.executable, "-m", "orchestrator",
            "--runtime-dir", str(runtime), "--json", "--quiet",
            "job", "run",
            "--goal", "CI-Beweis: Zeit tracken statt begrenzen (Protokoll 1.2)",
            "--op", "sys.simulate",
            "--params", json.dumps({"mode": "timeout", "seconds": LIMB_WAIT_S}),
            "--unlimited",
            "--tick", "0.1",
            "--trigger", f"id=kontrolle;action=check;every={INTERVAL_S};op=sys.ping",
            "--trigger", f"id=ende;action=finish_job;when=elapsed >= {THRESHOLD_S}",
        ]
        completed = subprocess.run(  # fester Interpreter, keine Shell
            command, capture_output=True, text=True, timeout=300, cwd=REPO_ROOT, check=False,
        )
        if completed.returncode != 0:
            return fail(f"Exit-Code {completed.returncode}\nstderr: {completed.stderr[-2000:]}")
        try:
            body = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            return fail(f"stdout ist kein JSON ({exc}): {completed.stdout[-500:]}")

        checks: list[tuple[str, bool, str]] = [
            ("status=resolved", body.get("status") == "resolved", str(body.get("status"))),
            ("timer_mode=unlimited", body.get("timer_mode") == "unlimited", str(body.get("timer_mode"))),
            ("t0 gesetzt", bool(body.get("t0")), str(body.get("t0"))),
        ]

        attempt = (body.get("attempts") or [{}])[0]
        timer = attempt.get("timer") or {}
        checks += [
            ("deadline_s=null", timer.get("deadline_s") is None, str(timer.get("deadline_s"))),
            ("expires_at=null", timer.get("expires_at") is None, str(timer.get("expires_at"))),
            ("remaining_ms=null", timer.get("remaining_ms") is None, str(timer.get("remaining_ms"))),
            ("Verdict=accept", attempt.get("verdict") == "accept", str(attempt.get("verdict"))),
        ]

        elapsed = float(body.get("t_unlimited_s") or 0.0)
        checks.append(
            (
                f"t_unlimited an der Schwelle (>= {THRESHOLD_S}s, < {LIMB_WAIT_S}s)",
                THRESHOLD_S <= elapsed < LIMB_WAIT_S,
                f"t_unlimited={elapsed}s",
            )
        )

        watch = body.get("watch") or {}
        scheduled = watch.get("scheduled_jobs") or []
        checks += [
            ("durch finish_job beendet", watch.get("finish_requested") is True, str(watch.get("finish_requested"))),
            ("nicht eskaliert", watch.get("needs_human") is False, str(watch.get("needs_human"))),
            (f"Kontroll-Jobs gelaufen (alle {INTERVAL_S}s)", len(scheduled) >= 2, f"anzahl={len(scheduled)}"),
            (
                "Kontrollen rueckverfolgbar",
                all(item.get("trigger_id") == "kontrolle" and item.get("kind") == "scheduled" for item in scheduled)
                and bool(scheduled),
                json.dumps([{k: item.get(k) for k in ("trigger_id", "kind", "status")} for item in scheduled])[:200],
            ),
            (
                "Kontrollen aufgeloest",
                all(item.get("status") == "resolved" for item in scheduled) and bool(scheduled),
                json.dumps([item.get("status") for item in scheduled])[:200],
            ),
        ]

        # Drei Uhren, eine Zahl: Job-Ledger, Result und Ueberwachungsbilanz.
        shown = subprocess.run(
            [sys.executable, "-m", "orchestrator", "--runtime-dir", str(runtime), "--json",
             "job", "show", str(body.get("job_id"))],
            capture_output=True, text=True, timeout=60, cwd=REPO_ROOT, check=False,
        )
        ledger: dict[str, object] = {}
        if shown.returncode == 0:
            try:
                ledger = (json.loads(shown.stdout) or {}).get("job") or {}
            except json.JSONDecodeError:
                ledger = {}
        outcome = ledger.get("outcome") or {}
        checks += [
            ("Ledger: timer_mode=unlimited", ledger.get("timer_mode") == "unlimited", str(ledger.get("timer_mode"))),
            ("Ledger: t0 identisch zum Auftrag", bool(ledger.get("t0")) and ledger.get("t0") == body.get("t0"),
             f"ledger={ledger.get('t0')} auftrag={body.get('t0')}"),
            ("Ledger: t_unlimited identisch zum Result",
             outcome.get("t_unlimited_s") == timer.get("elapsed_s"),
             f"ledger={outcome.get('t_unlimited_s')} result={timer.get('elapsed_s')}"),
            ("Bilanz: t_unlimited identisch zum Result",
             watch.get("t_unlimited_s") == timer.get("elapsed_s"),
             f"bilanz={watch.get('t_unlimited_s')} result={timer.get('elapsed_s')}"),
            ("Ledger: durch Trigger beendet", outcome.get("trigger_decision") == "finish_job",
             str(outcome.get("trigger_decision"))),
        ]

        leftovers = sorted((runtime / "schedules").glob("*.json")) if (runtime / "schedules").is_dir() else []
        checks.append(("Zeitplan aufgeraeumt", not leftovers, str([path.name for path in leftovers])))

        listing = subprocess.run(
            [sys.executable, "-m", "orchestrator", "--runtime-dir", str(runtime), "--json", "schedule", "list"],
            capture_output=True, text=True, timeout=60, cwd=REPO_ROOT, check=False,
        )
        checks.append(
            (
                "schedule list ist leer",
                listing.returncode == 0 and json.loads(listing.stdout or "null") == [],
                f"exit={listing.returncode} stdout={listing.stdout[:120]!r}",
            )
        )

        width = max(len(name) for name, _, _ in checks)
        failed = 0
        for name, ok, detail in checks:
            print(f"[e2e] {'ok  ' if ok else 'FEHL'}  {name:<{width}}  {detail}")
            failed += 0 if ok else 1

        if failed:
            return fail(f"{failed} von {len(checks)} Nachweisen fehlgeschlagen")
        print(
            f"[e2e] Beweis erbracht: t_unlimited={elapsed:.3f}s, {len(scheduled)} Kontroll-Jobs, "
            f"{watch.get('ticks')} Ticks, Auftrag durch Zeitplan beendet."
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
