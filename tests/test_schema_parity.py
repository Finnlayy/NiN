"""Schema-Paritaet: Parser und normative JSON-Schemas duerfen nie driften.

Hintergrund (Befund #2 aus ``docs/REVIEW-2026-09-04.md``): Beim Uebergang auf
Protokoll 1.2 akzeptierte ``core/protocol.py`` bereits ``timer.mode``,
``timer.safety_net_s``, ``t0``, ``elapsed_s`` und ``schedule.triggers[]``,
waehrend ``protocol/*.schema.json`` mit ``additionalProperties: false`` und
``version: ^1\\.[01]$`` dieselben Daten verworfen haette. Zwei Wahrheiten ueber
dasselbe Protokoll -- und niemand merkt es, weil die Schemas nicht ausgefuehrt
werden.

Diese Suite macht die Schemas **ausfuehrbar** (``tests/schema_mini.py``,
Stdlib-only) und prueft in beide Richtungen:

1. Jeder echte Beispiel-Datensatz wird vom Parser *und* vom Schema akzeptiert.
2. Jeder vom Parser erzeugte Schluessel ist im Schema deklariert (kein
   ``additionalProperties``-Bruch) und jedes deklarierte Feld wird vom Parser
   erzeugt (keine Phantomfelder).
3. Fehlercode-Enum und Event-Vertrag stimmen mit dem Code ueberein.
4. Der Pruefer selbst wird positiv *und* negativ getestet -- ein Validator, der
   alles durchwinkt, wuerde sonst eine gruene Suite vortaeuschen.

Der Pruefer lebt als Laufzeitmodul in ``core/schemacheck.py`` (stdlib-only) und
wird von der CLI genutzt (``orchestrator validate --schema``): Normativitaet,
die nur im Test existiert, schuetzt niemanden im Betrieb.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any

from core.config import NeuConfig
from core.kernel import Kernel
from core.protocol import (
    ErrorCode,
    Intent,
    Operations,
    Result,
    Schedule,
    Timer,
    TimerReport,
    Trigger,
)
from core.schemacheck import SchemaError, validate, validate_or_raise
from orchestrator.events import VALID_EVENT_KINDS

from . import REPO_ROOT

PROTOCOL_DIR = REPO_ROOT / "protocol"
EXAMPLES_DIR = PROTOCOL_DIR / "examples"
OPERATIONS = Operations.load(PROTOCOL_DIR / "operations.json")

_IGNORED_SCHEMA_KEYS = {"description", "title", "$schema", "$id", "format", "default", "examples"}


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((PROTOCOL_DIR / name).read_text(encoding="utf-8"))


INTENT_SCHEMA = load_schema("intent.schema.json")
RESULT_SCHEMA = load_schema("result.schema.json")


def example_paths(kind: str) -> list[Path]:
    return sorted(EXAMPLES_DIR.glob(f"{kind}.*.json"))


class TestValidatorSelbsttest(unittest.TestCase):
    """Der Pruefer muss Verstoesse finden -- sonst ist alles hier wertlos."""

    def test_gueltiges_objekt_passiert(self):
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["a"],
            "properties": {"a": {"type": "integer", "minimum": 1}, "b": {"type": ["string", "null"]}},
        }
        self.assertEqual(validate({"a": 2, "b": None}, schema), [])

    def test_unbekannter_schluessel_wird_gefunden(self):
        schema = {"type": "object", "additionalProperties": False, "properties": {"a": {"type": "string"}}}
        errors = validate({"a": "x", "c": 1}, schema)
        self.assertTrue(any("unbekannter Schluessel 'c'" in e for e in errors), errors)

    def test_typ_muster_und_grenzen(self):
        schema = {"type": "string", "pattern": "^[a-z]+$", "maxLength": 3}
        self.assertEqual(validate("abc", schema), [])
        self.assertTrue(validate("AB", schema))
        self.assertTrue(validate("abcd", schema))
        numeric = {"type": "number", "exclusiveMinimum": 0, "maximum": 900}
        self.assertTrue(validate(0, numeric))
        self.assertTrue(validate(901, numeric))
        self.assertEqual(validate(1.5, numeric), [])

    def test_if_then_verzweigung(self):
        schema = {
            "type": "object",
            "properties": {"mode": {"enum": ["deadline", "unlimited"]}, "deadline_s": {"type": ["number", "null"]}},
            "allOf": [
                {
                    "if": {"properties": {"mode": {"const": "unlimited"}}, "required": ["mode"]},
                    "then": {"properties": {"deadline_s": {"type": "null"}}},
                }
            ],
        }
        self.assertEqual(validate({"mode": "unlimited", "deadline_s": None}, schema), [])
        self.assertTrue(validate({"mode": "unlimited", "deadline_s": 60}, schema))
        self.assertEqual(validate({"mode": "deadline", "deadline_s": 60}, schema), [])

    def test_anyof_und_items(self):
        schema = {
            "type": "object",
            "properties": {
                "payload": {"anyOf": [{"required": ["operation"]}, {"required": ["checks"]}]},
                "checks": {"type": "array", "minItems": 1, "items": {"type": "object", "required": ["operation"]}},
            },
        }
        self.assertEqual(validate({"payload": {"operation": "sys.echo"}}, schema), [])
        self.assertTrue(validate({"payload": {}}, schema))
        self.assertTrue(validate({"checks": []}, schema))
        self.assertTrue(validate({"checks": [{"nope": 1}]}, schema))

    def test_nicht_unterstuetztes_schluesselwort_faellt_auf(self):
        errors = validate({}, {"type": "object", "contains": {"type": "string"}})
        self.assertTrue(any("nicht unterstuetzte Schluesselwoerter" in e for e in errors), errors)

    def test_validate_or_raise_meldet_verstoss(self):
        with self.assertRaises(SchemaError) as ctx:
            validate_or_raise({"a": 1}, {"type": "object", "additionalProperties": False, "properties": {}}, label="Test")
        message = str(ctx.exception)
        self.assertIn("Test:", message)
        self.assertIn("unbekannter Schluessel 'a'", message)

    def test_fehlerpfad_zeigt_verschachtelung(self):
        schema = {"type": "object", "properties": {"timer": {"type": "object", "properties": {"mode": {"enum": ["deadline"]}}}}}
        errors = validate({"timer": {"mode": "unlimited"}}, schema)
        self.assertTrue(any("$.timer.mode" in e for e in errors), errors)


class TestBeispieleSindSchemaKonform(unittest.TestCase):
    """Alle hinterlegten Beweisstuecke: Parser *und* Schema muessen zustimmen."""

    def test_alle_intent_beispiele(self):
        paths = example_paths("intent")
        self.assertTrue(paths, "keine Intent-Beispiele gefunden")
        for path in paths:
            with self.subTest(beispiel=path.name):
                data = json.loads(path.read_text(encoding="utf-8"))
                intent = Intent.from_dict(json.loads(json.dumps(data)), operations=OPERATIONS)
                validate_or_raise(intent.to_dict(), INTENT_SCHEMA, label=path.name)

    def test_alle_result_beispiele(self):
        paths = example_paths("result")
        self.assertTrue(paths, "keine Result-Beispiele gefunden")
        for path in paths:
            with self.subTest(beispiel=path.name):
                data = json.loads(path.read_text(encoding="utf-8"))
                result = Result.from_dict(json.loads(json.dumps(data)))
                validate_or_raise(result.to_dict(), RESULT_SCHEMA, label=path.name)

    def test_beispiel_versionen_werden_vom_schema_akzeptiert(self):
        version_pattern = INTENT_SCHEMA["properties"]["version"]["pattern"]
        for path in example_paths("intent") + example_paths("result"):
            data = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(beispiel=path.name):
                self.assertIsNotNone(re.match(version_pattern, str(data.get("version", ""))),
                                     f"{path.name}: Version {data.get('version')} passt nicht auf {version_pattern}")


class TestProtokoll12Daten(unittest.TestCase):
    """Die neuen 1.2-Felder muessen durch beide Instanzen (Parser, Schema)."""

    def setUp(self):
        self.config = NeuConfig.load()
        self.kernel = Kernel(self.config, OPERATIONS)

    def _unlimited_intent(self) -> Intent:
        return self.kernel.build_intent(
            operation="sys.echo",
            params={"message": "Beobachtung laeuft"},
            limb="echo",
            goal="Zeit tracken statt begrenzen",
            unlimited=True,
            safety_net_s=1800.0,
            tick_s=0.25,
            schedule=[
                {
                    "id": "kontrolle",
                    "action": "check",
                    "every_s": 10,
                    "payload": {"operation": "sys.echo", "params": {"message": "Status?"}},
                },
                {"id": "schwelle", "action": "emit_event", "when": "elapsed >= 30",
                 "payload": {"kind": "timer.threshold"}},
                {"id": "marken", "action": "log", "at_s": [5, 15]},
                {"id": "ende", "action": "finish_job", "when": "elapsed >= 120"},
                {"id": "notfall", "action": "escalate", "when": "elapsed > 3600",
                 "payload": {"reason": "Laufzeit ueber einer Stunde"}},
            ],
        )

    def test_unlimited_intent_ist_schema_konform(self):
        intent = self._unlimited_intent()
        data = intent.to_dict()
        self.assertEqual(data["timer"]["mode"], "unlimited")
        self.assertIsNone(data["timer"]["deadline_s"])
        self.assertEqual(data["timer"]["on_expiry"], "none")
        validate_or_raise(data, INTENT_SCHEMA, label="unlimited-intent")

    def test_unlimited_intent_rundlauf(self):
        intent = self._unlimited_intent()
        parsed = Intent.from_json(intent.to_json(), operations=OPERATIONS)
        self.assertEqual(parsed.to_dict(), intent.to_dict())
        validate_or_raise(parsed.to_dict(), INTENT_SCHEMA, label="unlimited-rundlauf")

    def test_geschaerfter_unlimited_timer_bleibt_konform(self):
        from core.kernel import arm_timer

        intent = arm_timer(self._unlimited_intent(), config=self.config)
        data = intent.to_dict()
        self.assertIsNotNone(data["timer"]["t0"])
        self.assertIsNotNone(data["timer"]["armed_at"])
        validate_or_raise(data, INTENT_SCHEMA, label="armed-unlimited")

    def test_deadline_intent_bleibt_konform(self):
        intent = self.kernel.build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo", goal="klassisch", deadline_s=20.0
        )
        data = intent.to_dict()
        self.assertEqual(data["timer"]["mode"], "deadline")
        validate_or_raise(data, INTENT_SCHEMA, label="deadline-intent")

    def test_protokoll_11_intent_ist_weiter_gueltig(self):
        """Abwaertskompatibilitaet: 1.1-Daten ohne mode/schedule bleiben gueltig."""
        data = json.loads(example_paths("intent")[0].read_text(encoding="utf-8"))
        data["version"] = "1.1"
        data["timer"].pop("mode", None)
        data["timer"].pop("safety_net_s", None)
        data["timer"].pop("t0", None)
        data["timer"].pop("elapsed_s", None)
        data.pop("schedule", None)
        validate_or_raise(data, INTENT_SCHEMA, label="1.1-kompatibilitaet")
        Intent.from_dict(json.loads(json.dumps(data)), operations=OPERATIONS)

    def test_schema_verbietet_limit_im_unlimited_modus(self):
        """Wer unlimited sagt, darf kein Aufgabenlimit tragen -- sonst ist es deadline."""
        intent = self._unlimited_intent().to_dict()
        intent["timer"]["deadline_s"] = 60
        errors = validate(intent, INTENT_SCHEMA)
        self.assertTrue(errors, "Schema haette deadline_s=60 bei mode=unlimited akzeptiert")

    def test_schema_verlangt_ausloeser(self):
        intent = self._unlimited_intent().to_dict()
        intent["schedule"]["triggers"][0] = {"id": "nichts", "action": "log"}
        errors = validate(intent, INTENT_SCHEMA)
        self.assertTrue(errors, "Trigger ohne when/every_s/at_s muesste abgelehnt werden")

    def test_schema_verlangt_check_payload(self):
        intent = self._unlimited_intent().to_dict()
        intent["schedule"]["triggers"][0]["payload"] = {"irgendwas": 1}
        errors = validate(intent, INTENT_SCHEMA)
        self.assertTrue(errors, "action='check' ohne operation/checks muesste abgelehnt werden")

    def test_result_mit_unlimited_nachweis(self):
        report = TimerReport(
            mode="unlimited",
            t0="2026-09-04T10:00:00.000Z",
            armed_at="2026-09-04T10:00:00.500Z",
            expires_at=None,
            reported_at="2026-09-04T10:01:30.000Z",
            elapsed_s=89.5,
            remaining_ms=None,
            overrun_ms=0,
            self_reported=True,
        )
        validate_or_raise(report.to_dict(), RESULT_SCHEMA["properties"]["timer"], label="timer-report")

    def test_safety_net_fehlercode_ist_deklariert(self):
        codes = RESULT_SCHEMA["properties"]["error"]["properties"]["code"]["enum"]
        self.assertIn(ErrorCode.SAFETY_NET, codes)
        self.assertIn(ErrorCode.TRIGGER_INVALID, codes)


class TestSchluesselParitaet(unittest.TestCase):
    """Beide Richtungen: kein undeklarierter Schluessel, kein Phantomfeld."""

    def _assert_same_keys(self, produced: Any, schema: dict[str, Any], label: str) -> None:
        produced_keys = set(produced)
        declared = set(schema.get("properties", {})) - _IGNORED_SCHEMA_KEYS
        self.assertEqual(
            produced_keys,
            declared,
            f"{label}: nur im Code {sorted(produced_keys - declared)} / nur im Schema {sorted(declared - produced_keys)}",
        )

    def test_intent_timer_parity(self):
        self._assert_same_keys(Timer(deadline_s=1.0).to_dict(), INTENT_SCHEMA["properties"]["timer"], "intent.timer")

    def test_intent_schedule_parity(self):
        schedule = Schedule(triggers=(Trigger(id="t1", action="log", at_s=(1.0,)),), tick_s=0.5)
        schema = INTENT_SCHEMA["properties"]["schedule"]
        self._assert_same_keys(schedule.to_dict(), schema, "intent.schedule")
        self._assert_same_keys(
            schedule.triggers[0].to_dict(), schema["properties"]["triggers"]["items"], "schedule.triggers[]"
        )

    def test_result_timer_parity(self):
        report = TimerReport(reported_at="2026-09-04T10:00:00.000Z")
        self._assert_same_keys(report.to_dict(), RESULT_SCHEMA["properties"]["timer"], "result.timer")

    def test_intent_toplevel_parity(self):
        config = NeuConfig.load()
        intent = Kernel(config, OPERATIONS).build_intent(
            operation="sys.echo", params={"message": "x"}, limb="echo", goal="Paritaet"
        )
        self._assert_same_keys(intent.to_dict(), INTENT_SCHEMA, "intent")

    def test_result_toplevel_parity(self):
        data = json.loads(example_paths("result")[0].read_text(encoding="utf-8"))
        result = Result.from_dict(data)
        self._assert_same_keys(result.to_dict(), RESULT_SCHEMA, "result")

    def test_fehlercode_enum_parity(self):
        codes = {value for key, value in vars(ErrorCode).items() if key.isupper() and isinstance(value, str)}
        declared = set(RESULT_SCHEMA["properties"]["error"]["properties"]["code"]["enum"])
        self.assertEqual(codes, declared, f"nur im Code {sorted(codes - declared)} / nur im Schema {sorted(declared - codes)}")

    def test_trigger_enum_parity(self):
        import core.protocol as protocol

        item = INTENT_SCHEMA["properties"]["schedule"]["properties"]["triggers"]["items"]["properties"]
        self.assertEqual(set(item["action"]["enum"]), set(protocol.VALID_TRIGGER_ACTIONS))
        self.assertEqual(set(item["clock"]["enum"]), set(protocol.VALID_TRIGGER_CLOCKS))
        self.assertEqual(
            set(INTENT_SCHEMA["properties"]["timer"]["properties"]["mode"]["enum"]),
            set(protocol.VALID_TIMER_MODES),
        )
        self.assertEqual(
            set(INTENT_SCHEMA["properties"]["timer"]["properties"]["on_expiry"]["enum"]),
            set(protocol.VALID_ON_EXPIRY),
        )

    def test_bedingungsmuster_parity(self):
        """Das Schema-Muster fuer 'when' muss dieselbe Grammatik erlauben wie der Parser."""
        import core.protocol as protocol

        pattern = INTENT_SCHEMA["properties"]["schedule"]["properties"]["triggers"]["items"]["properties"]["when"]["pattern"]
        self.assertEqual(pattern, protocol._CONDITION_RE.pattern)
        for condition in ("elapsed >= 30", "elapsed<5", "elapsed == 10.5", "elapsed != 0.25"):
            with self.subTest(bedingung=condition):
                self.assertIsNotNone(re.match(pattern, condition))
        for bad in ("elapsed ~ 5", "runtime >= 5", "elapsed >=", "5 >= elapsed"):
            with self.subTest(bedingung=bad):
                self.assertIsNone(re.match(pattern, bad), f"{bad!r} muesste vom Muster abgelehnt werden")


class TestEventVertrag(unittest.TestCase):
    """Jeder emittierte Event-Kind muss deklariert sein (Befund #11)."""

    def test_emittierte_kinds_sind_deklariert(self):
        emitted: set[str] = set()
        pattern = re.compile(r'_?emit\(\s*\n?\s*"([a-z][a-z0-9_.]*)"')
        for path in REPO_ROOT.rglob("*.py"):
            if any(part in {".git", "node_modules", "__pycache__", "tests", ".venv"} for part in path.parts):
                continue
            emitted.update(pattern.findall(path.read_text(encoding="utf-8")))
        self.assertTrue(emitted, "keine Event-Kinds gefunden -- Suchmuster kaputt?")
        undeclared = sorted(emitted - set(VALID_EVENT_KINDS))
        self.assertEqual(undeclared, [], f"nicht deklarierte Event-Kinds: {undeclared}")

    def test_timer_kinds_sind_deklariert(self):
        for kind in ("timer.armed", "timer.tick", "timer.trigger", "timer.skipped", "timer.safety_net",
                     "timer.log", "timer.escalation", "timer.finished", "job.scheduled"):
            self.assertIn(kind, VALID_EVENT_KINDS)

    def test_clock_s_ist_teil_des_events(self):
        from orchestrator.events import CollectingSink, build_event_bus

        collector = CollectingSink()
        bus = build_event_bus(quiet=True, collector=collector)
        bus.emit("timer.tick", {"note": "Test"}, job_id="job_test", clock_s=12.3456)
        record = collector.records[-1]
        self.assertIn("clock_s", record)
        self.assertEqual(record["clock_s"], 12.346)
        self.assertEqual(record["job_id"], "job_test")


if __name__ == "__main__":
    unittest.main()
