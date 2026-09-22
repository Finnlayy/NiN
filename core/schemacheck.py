"""JSON-Schema-Pruefer (Stdlib-only, Teilmenge von Draft 2020-12).

Laufzeitmodul des Kerns: ``orchestrator validate --schema`` prueft damit Intents
und Results gegen die normativen ``protocol/*.schema.json`` -- nicht nur gegen
den Parser. Tests nutzen dasselbe Modul (``tests/test_schema_parity.py``), damit
Pruefung und Beweis nicht auseinanderlaufen.

Warum das hier lebt und nicht als Abhaengigkeit: Das Projekt ist per Vertrag
**stdlib-only** (Python 3.11). Gleichzeitig sind ``protocol/*.schema.json`` die
normative Schnittstellenbeschreibung -- sie muessen *ausfuehrbar* sein, sonst
driften Parser und Schema still auseinander (genau das ist beim Uebergang auf
Protokoll 1.2 passiert: Der Parser akzeptierte ``timer.mode``/``schedule``, das
Schema mit ``additionalProperties: false`` haette dieselben Daten verworfen).

Unterstuetzte Schluesselwoerter: ``type`` (inkl. Union und ``null``), ``enum``,
``const``, ``pattern``, ``minimum``/``maximum``/``exclusiveMinimum``/
``exclusiveMaximum``, ``minLength``/``maxLength``, ``minItems``/``maxItems``,
``required``, ``properties``, ``additionalProperties`` (bool oder Schema),
``items``, ``anyOf``/``allOf``/``oneOf``, ``if``/``then``/``else``, ``not``.
Ignoriert (bewusst, da ohne normative Wirkung): ``format``, ``description``,
``$schema``, ``$id``, ``title``, ``default``, ``examples``.

Aufruf::

    from core.schemacheck import validate
    errors = validate(data, schema)   # leer == gueltig
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

__all__ = ["SchemaError", "validate", "validate_or_raise"]

_IGNORED = {
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "format",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
}

#: Von ``validate`` verstandene Schluesselwoerter (hochgezogen auf Modulebene).
#: Frueher wurde dieser ~30-Elemente-Set bei *jedem* ``validate()``-Aufruf neu
#: gebaut (``set(schema) - _IGNORED - {...}``). Im Fast-Path (Validierung eines
#: Intent-Schemas pro Tick/Event) ist das reine CPU-Verschwendung.
_SUPPORTED_KEYS = frozenset(
    {
        "type",
        "enum",
        "const",
        "pattern",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "required",
        "properties",
        "additionalProperties",
        "patternProperties",
        "items",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
    }
)

#: Cache fuer kompilierte Muster. ``re.search(pattern, text)`` geht bei jedem
#: Aufruf durch die interne ``re._compile``-Cache-Ebene (Funktionsaufruf +
#: Dict-Lookup). Das Kompilieren selber ist zwar durch CPython gecacht, aber der
#: Umweg kostet ~0.16 µs pro Treffer. Der Fast-Path nutzt direkt
#: ``_compiled(pattern).search(...)`` -- Muster werden genau einmal kompiliert.
_PATTERN_CACHE: dict[str, re.Pattern[str]] = {}


def _compiled(pattern: str) -> re.Pattern[str]:
    cached = _PATTERN_CACHE.get(pattern)
    if cached is None:
        cached = re.compile(pattern)
        _PATTERN_CACHE[pattern] = cached
    return cached


# Immer Tupel: ``isinstance`` braucht einen Klassentyp (oder ein Tupel davon),
# und mypy kann sonst den Werttyp der Tabelle nicht auf _ClassInfo eingrenzen.
_TYPE_MAP: dict[str, tuple[type, ...]] = {
    "object": (Mapping,),
    "array": (list, tuple),
    "string": (str,),
    "boolean": (bool,),
    "null": (type(None),),
}


class SchemaError(ValueError):
    """Ein Datenwert verletzt das Schema."""

    def __init__(self, message: str, path: str = "$") -> None:
        self.path = path
        super().__init__(f"{path}: {message}" if path else message)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, Mapping):
        return "object"
    if isinstance(value, (list, tuple)):
        return "array"
    if _is_integer(value):
        return "integer"
    if _is_number(value):
        return "number"
    return type(value).__name__


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "number":
        return _is_number(value)
    if expected == "integer":
        # JSON Schema: 1.0 zaehlt als integer, unsere Serialisierung schreibt aber int
        return _is_integer(value) or (_is_number(value) and float(value).is_integer())
    python_type = _TYPE_MAP.get(expected)
    if python_type is None:
        raise SchemaError(f"unbekannter Typ '{expected}' im Schema")
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "object":
        return isinstance(value, Mapping)
    if expected == "array":
        return isinstance(value, (list, tuple))
    return isinstance(value, python_type)


def _check_number(value: Any, schema: Mapping[str, Any], path: str, errors: list[str]) -> None:
    if "minimum" in schema and _is_number(value) and value < schema["minimum"]:
        errors.append(f"{path}: {value} < minimum {schema['minimum']}")
    if "maximum" in schema and _is_number(value) and value > schema["maximum"]:
        errors.append(f"{path}: {value} > maximum {schema['maximum']}")
    if "exclusiveMinimum" in schema and _is_number(value) and value <= schema["exclusiveMinimum"]:
        errors.append(f"{path}: {value} <= exclusiveMinimum {schema['exclusiveMinimum']}")
    if "exclusiveMaximum" in schema and _is_number(value) and value >= schema["exclusiveMaximum"]:
        errors.append(f"{path}: {value} >= exclusiveMaximum {schema['exclusiveMaximum']}")


def _branch_errors(value: Any, schema: Any, path: str) -> list[str]:
    """Prueft ein Teil-Schema isoliert: leere Liste = dieser Zweig passt.

    ``anyOf``/``oneOf``/``not``/``if`` brauchen jeweils einen eigenen Fehlerkanal,
    der die Hauptliste nicht verschmutzt -- sonst zaehlt ein verworfener Zweig
    als echter Schema-Fehler.
    """
    branch: list[str] = []
    _validate_node(value, schema, path, branch)
    return branch


def _validate_node(value: Any, schema: Any, path: str, errors: list[str]) -> None:
    if schema is True:
        return
    if schema is False:
        errors.append(f"{path}: Schema verbietet jeden Wert")
        return
    if not isinstance(schema, Mapping):
        errors.append(f"{path}: ungueltiges Schema ({type(schema).__name__})")
        return

    # --- Typ ------------------------------------------------------------
    if "type" in schema:
        expected = schema["type"]
        # Fast-Path: Der haeufigste Fall ist eine einzelne ``type: "<string>"``
        # Angabe. Das ``any(...)`` + ``<genexpr>`` fuer einen Einzeleintrag kostet
        # einen Generator-Umbau pro Knoten -- hier direkt pruefen.
        if isinstance(expected, str):
            if not _matches_type(value, expected):
                errors.append(f"{path}: Typ {_type_name(value)} passt nicht auf [{expected!r}]")
                return  # Folgepruefungen waeren irrefuehrend
        else:
            allowed = expected if isinstance(expected, (list, tuple)) else (expected,)
            if not any(_matches_type(value, item) for item in allowed):
                errors.append(f"{path}: Typ {_type_name(value)} passt nicht auf {list(allowed)}")
                return  # Folgepruefungen waeren irrefuehrend

    # --- Werte ----------------------------------------------------------
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} nicht in enum {list(schema['enum'])}")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: {value!r} != const {schema['const']!r}")

    if isinstance(value, str):
        if "pattern" in schema and _compiled(schema["pattern"]).search(value) is None:
            errors.append(f"{path}: {value!r} verletzt Muster {schema['pattern']!r}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: zu kurz (min {schema['minLength']})")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: zu lang (max {schema['maxLength']})")

    if _is_number(value):
        _check_number(value, schema, path, errors)

    # --- Objekte --------------------------------------------------------
    if isinstance(value, Mapping):
        properties: Mapping[str, Any] = schema.get("properties", {}) or {}
        required: Sequence[str] = schema.get("required", ()) or ()
        for key in required:
            if key not in value:
                errors.append(f"{path}: Pflichtschluessel '{key}' fehlt")
        additional = schema.get("additionalProperties", True)
        pattern_props: Mapping[str, Any] = schema.get("patternProperties", {}) or {}
        for key, item in value.items():
            key_path = f"{path}.{key}"
            if key in properties:
                _validate_node(item, properties[key], key_path, errors)
                continue
            matched_pattern = False
            for pattern, sub_schema in pattern_props.items():
                if _compiled(pattern).search(str(key)):
                    matched_pattern = True
                    _validate_node(item, sub_schema, key_path, errors)
            if matched_pattern:
                continue
            if additional is False:
                errors.append(f"{path}: unbekannter Schluessel '{key}' (additionalProperties: false)")
            elif isinstance(additional, Mapping):
                _validate_node(item, additional, key_path, errors)

    # --- Arrays ---------------------------------------------------------
    if isinstance(value, (list, tuple)):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: zu wenige Eintraege (min {schema['minItems']})")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: zu viele Eintraege (max {schema['maxItems']})")
        items_schema = schema.get("items")
        if items_schema is not None:
            for index, item in enumerate(value):
                _validate_node(item, items_schema, f"{path}[{index}]", errors)

    # --- Kombinationen --------------------------------------------------
    if "allOf" in schema:
        for sub in schema["allOf"]:
            _validate_node(value, sub, path, errors)
    if "anyOf" in schema:
        collected: list[list[str]] = []
        for sub in schema["anyOf"]:
            branch = _branch_errors(value, sub, path)
            if not branch:
                break
            collected.append(branch)
        else:
            errors.append(f"{path}: kein anyOf-Zweig passt ({collected[0][0] if collected else ''})")
    if "oneOf" in schema:
        passing = sum(1 for sub in schema["oneOf"] if not _branch_errors(value, sub, path))
        if passing != 1:
            errors.append(f"{path}: oneOf muss genau einmal passen (passt {passing}x)")
    if "not" in schema and not _branch_errors(value, schema["not"], path):
        errors.append(f"{path}: 'not'-Schema darf nicht passen")

    # --- Bedingte Schemata ----------------------------------------------
    if "if" in schema:
        if not _branch_errors(value, schema["if"], path):
            _validate_node(value, schema.get("then", True), path, errors)
        elif "else" in schema:
            _validate_node(value, schema["else"], path, errors)


def validate(data: Any, schema: Mapping[str, Any]) -> list[str]:
    """Prueft ``data`` gegen ``schema``; liefert alle Verstoesse (leer == gueltig)."""
    unknown = set(schema) - _IGNORED - _SUPPORTED_KEYS
    errors: list[str] = []
    if unknown:
        # Ein nicht unterstuetztes Schluesselwort waere stille Sicherheitsluecke.
        errors.append(f"$: Schema nutzt nicht unterstuetzte Schluesselwoerter {sorted(unknown)}")
    _validate_node(data, schema, "$", errors)
    return errors


def validate_or_raise(data: Any, schema: Mapping[str, Any], *, label: str = "") -> None:
    """Wirft ``SchemaError`` mit den ersten acht Verstössen (Pfade stehen bereits darin)."""
    errors = validate(data, schema)
    if errors:
        prefix = f"{label}: " if label else ""
        raise SchemaError(prefix + "; ".join(errors[:8]), path="")
