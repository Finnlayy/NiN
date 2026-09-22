"""Bootstrap-Limb (Phase 2) -- erster echter Arm.

Liest, schreibt, patcht und listet Dateien. Pfade laufen ausschliesslich ueber
``ctx.resolve()`` (Policy/Sandbox). Schreibvorgaenge sind atomar, bestehende
Dateien werden vorher gesichert, jedes Artefakt traegt einen Hash-Nachweis.

``fs.delete``, ``shell.exec``, ``test.run`` und ``core.memory_write`` gehoeren
nicht zu Phase 2 -- sie bleiben dem Register und der Policy vorbehalten.

Aufruf: ``python3 limbs/bootstrap_limb.py --intent runtime/inbox/bootstrap/<id>.json``
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
for _entry in (str(Path(__file__).resolve().parent), str(_REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

if __package__ in (None, ""):  # direkter Skriptaufruf durch den Orchestrator
    from base import LimbBase, LimbContext, LimbError  # type: ignore[import-not-found]
else:
    from limbs.base import LimbBase, LimbContext, LimbError

from core.protocol import Artifact, ErrorCode, sha256_file, sha256_text  # noqa: E402

WRITE_MODES = ("create", "overwrite", "append")
DEFAULT_MAX_BYTES = 1_048_576
DEFAULT_MAX_ENTRIES = 500
_SHA256_LEN = 64


class BootstrapLimb(LimbBase):
    name = "bootstrap"
    version = "1.0.0"
    description = "Erster echter Arm: fs.read_file / fs.write_file / fs.patch / fs.list / fs.mkdir"

    def handlers(self) -> dict[str, Callable[[Mapping[str, Any], LimbContext], Mapping[str, Any]]]:
        return {
            "fs.read_file": self._read_file,
            "fs.write_file": self._write_file,
            "fs.patch": self._patch,
            "fs.list": self._list,
            "fs.mkdir": self._mkdir,
        }

    # ---------------------------------------------------------------- lesen
    def _read_file(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        raw_path = _require_str(params, "path")
        max_bytes = _optional_int(params, "max_bytes", DEFAULT_MAX_BYTES, minimum=1, maximum=67_108_864)
        max_bytes = min(max_bytes, ctx.intent.constraints.max_output_bytes)
        ctx.plan("Pfad aufloesen", "Datei lesen", "Hash nachweisen")
        target = ctx.resolve(raw_path)
        if not target.exists():
            raise LimbError(ErrorCode.PATH_NOT_FOUND, f"Ziel existiert nicht: {ctx.rel(target)}", hint="Pfad korrigieren oder fs.write_file mit mode=create.")
        if not target.is_file():
            raise LimbError(ErrorCode.IO, f"Ziel ist keine Datei: {ctx.rel(target)}", hint="fs.read_file erwartet eine Datei.")
        ctx.checkpoint("Pfad aufgeloest")
        data = target.read_bytes()
        truncated = len(data) > max_bytes
        if truncated:
            data = data[:max_bytes]
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise LimbError(ErrorCode.IO, f"Datei ist kein UTF-8-Text: {ctx.rel(target)} ({exc})", hint="Nur Textdateien lesen.") from exc
        artifact = ctx.record(target, "read")
        ctx.finish_step("Datei lesen")
        ctx.finish_step("Hash nachweisen")
        return {
            "path": ctx.rel(target),
            "content": text,
            "bytes": artifact.bytes,
            "sha256": artifact.sha256,
            "truncated": truncated,
            "max_bytes": max_bytes,
        }

    # --------------------------------------------------------------- schreiben
    def _write_file(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        raw_path = _require_str(params, "path")
        content = _require_str(params, "content", allow_empty=True, max_len=8_388_608)
        mode = str(params.get("mode") or "create")
        if mode not in WRITE_MODES:
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.mode muss eines von {WRITE_MODES} sein.", hint=f"gefunden: {mode!r}")
        expect = _optional_sha256(params)
        ctx.plan("Pfad aufloesen", "Vorbedingung pruefen", "Schreiben", "Hash nachweisen")
        target = ctx.resolve(raw_path)
        existed = target.is_file()
        ctx.checkpoint("Pfad aufgeloest")

        if mode == "create" and existed:
            raise LimbError(
                ErrorCode.ALREADY_EXISTS,
                f"Datei existiert bereits: {ctx.rel(target)}",
                hint="mode=overwrite mit expect_sha256 verwenden.",
            )
        if mode in {"overwrite", "append"} and expect and not existed:
            raise LimbError(ErrorCode.PATH_NOT_FOUND, f"expect_sha256 gesetzt, aber Datei fehlt: {ctx.rel(target)}", hint="Ohne Vorbedingung mode=create nutzen.")
        if existed:
            _assert_expected_hash(target, expect, ctx)
        elif mode == "append":
            mode = "create"  # Unix-Semantik: Anhaengen an fehlende Datei legt sie an
        ctx.finish_step("Vorbedingung pruefen")

        if mode == "append" and existed:
            try:
                previous = target.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise LimbError(ErrorCode.IO, f"Bestehende Datei ist kein UTF-8-Text: {ctx.rel(target)}", hint="Nur Textdateien anhaengen.") from exc
            new_content = previous + content
        else:
            new_content = content

        action = "created" if not existed else "modified"
        backup_path = ""
        if ctx.intent.constraints.dry_run:
            ctx.note("dry_run: keine Schreibaktion")
            encoded = new_content.encode("utf-8")
            digest = sha256_text(new_content)
            # Kein Platten-Hash: dry_run schreibt nicht -- der Kernel wuerde sonst
            # "Artefakt fehlt" bzw. Drift gegen den alten Inhalt melden.
            ctx.artifacts.append(Artifact(path=ctx.rel(target), action="unchanged", bytes=len(encoded), sha256=""))
            ctx.finish_step("Schreiben")
            ctx.finish_step("Hash nachweisen")
            return {
                "path": ctx.rel(target),
                "bytes": len(encoded),
                "sha256": digest,
                "mode": mode,
                "dry_run": True,
                "would_action": action,
                "__status__": "success",
                "__notes__": ["dry_run: geplant, nicht geschrieben"],
            }

        if existed and ctx.intent.constraints.backup:
            backup_path = ctx.backup(target) or ""
        ctx.write_atomic(target, new_content)
        artifact = ctx.record(target, action, backup_path=backup_path)
        ctx.finish_step("Schreiben")
        ctx.finish_step("Hash nachweisen")
        return {
            "path": artifact.path,
            "bytes": artifact.bytes,
            "sha256": artifact.sha256,
            "mode": mode,
            "backup_path": backup_path,
            "action": action,
        }

    # ----------------------------------------------------------------- patch
    def _patch(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        raw_path = _require_str(params, "path")
        patches = params.get("patches")
        if not isinstance(patches, Sequence) or isinstance(patches, (str, bytes)) or not patches:
            raise LimbError(ErrorCode.SCHEMA_INVALID, "params.patches muss eine nicht-leere Liste sein.", hint='Beispiel: [{"find": "alt", "replace": "neu"}]')
        expect = _optional_sha256(params)
        ctx.plan("Pfad aufloesen", "Patches anwenden", "Schreiben", "Hash nachweisen")
        target = ctx.resolve(raw_path)
        if not target.exists():
            raise LimbError(ErrorCode.PATH_NOT_FOUND, f"Ziel existiert nicht: {ctx.rel(target)}", hint="Datei zuerst anlegen oder Pfad korrigieren.")
        if not target.is_file():
            raise LimbError(ErrorCode.IO, f"Ziel ist keine Datei: {ctx.rel(target)}", hint="fs.patch erwartet eine Datei.")
        ctx.checkpoint("Pfad aufgeloest")
        _assert_expected_hash(target, expect, ctx)
        try:
            original = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise LimbError(ErrorCode.IO, f"Datei ist kein UTF-8-Text: {ctx.rel(target)}", hint="Nur Textdateien patchen.") from exc

        updated, applied = _apply_patches(original, patches)
        ctx.finish_step("Patches anwenden")
        if updated == original:
            artifact = ctx.record(target, "unchanged")
            ctx.finish_step("Schreiben")
            ctx.finish_step("Hash nachweisen")
            return {"path": artifact.path, "bytes": artifact.bytes, "sha256": artifact.sha256, "applied": applied, "action": "unchanged"}

        if ctx.intent.constraints.dry_run:
            ctx.note("dry_run: keine Schreibaktion")
            encoded = updated.encode("utf-8")
            digest = sha256_text(updated)
            ctx.artifacts.append(Artifact(path=ctx.rel(target), action="unchanged", bytes=len(encoded), sha256=digest))
            ctx.finish_step("Schreiben")
            ctx.finish_step("Hash nachweisen")
            return {
                "path": ctx.rel(target),
                "bytes": len(encoded),
                "sha256": digest,
                "applied": applied,
                "dry_run": True,
                "would_action": "modified",
                "__status__": "success",
                "__notes__": ["dry_run: geplant, nicht geschrieben"],
            }

        backup_path = ctx.backup(target) or "" if ctx.intent.constraints.backup else ""
        ctx.write_atomic(target, updated)
        artifact = ctx.record(target, "modified", backup_path=backup_path)
        ctx.finish_step("Schreiben")
        ctx.finish_step("Hash nachweisen")
        return {
            "path": artifact.path,
            "bytes": artifact.bytes,
            "sha256": artifact.sha256,
            "applied": applied,
            "backup_path": backup_path,
            "action": "modified",
        }

    # ------------------------------------------------------------------ list
    def _list(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        raw_path = params.get("path")
        recursive = _optional_bool(params, "recursive", False)
        max_entries = _optional_int(params, "max_entries", DEFAULT_MAX_ENTRIES, minimum=1, maximum=10_000)
        ctx.plan("Pfad aufloesen", "Eintraege sammeln")
        if raw_path in (None, ""):
            target = ctx.sandbox_root
        else:
            if not isinstance(raw_path, str):
                raise LimbError(ErrorCode.SCHEMA_INVALID, "params.path muss ein String sein.")
            target = ctx.resolve(raw_path)
        if not target.exists():
            raise LimbError(ErrorCode.PATH_NOT_FOUND, f"Ziel existiert nicht: {ctx.rel(target)}", hint="Pfad korrigieren oder fs.mkdir zuerst.")
        ctx.checkpoint("Pfad aufgeloest")

        bound = ctx.config.repo_root if ctx.intent.elevation.level == "repo_write" else ctx.sandbox_root
        entries: list[dict[str, Any]] = []
        truncated = False
        if target.is_file():
            entries.append(_entry_dict(target, ctx))
        else:
            try:
                candidates = sorted(target.rglob("*") if recursive else target.iterdir(), key=lambda p: str(p).lower())
            except OSError as exc:
                raise LimbError(ErrorCode.IO, f"Verzeichnis nicht lesbar: {ctx.rel(target)} ({exc})") from exc
            for path in candidates:
                try:
                    resolved = path.resolve()
                except OSError:
                    continue
                if not _is_inside(resolved, bound):
                    continue
                entries.append(_entry_dict(path, ctx))
                if len(entries) >= max_entries:
                    truncated = True
                    break
        ctx.finish_step("Eintraege sammeln")
        return {
            "path": ctx.rel(target),
            "entries": entries,
            "count": len(entries),
            "recursive": recursive,
            "truncated": truncated,
        }

    # ----------------------------------------------------------------- mkdir
    def _mkdir(self, params: Mapping[str, Any], ctx: LimbContext) -> dict[str, Any]:
        raw_path = _require_str(params, "path")
        ctx.plan("Pfad aufloesen", "Verzeichnis anlegen")
        target = ctx.resolve(raw_path)
        ctx.checkpoint("Pfad aufgeloest")
        if target.is_file():
            raise LimbError(ErrorCode.IO, f"Ziel existiert als Datei: {ctx.rel(target)}", hint="Anderen Pfad waehlen.")
        existed = target.is_dir()
        action = "unchanged" if existed else "created"
        if ctx.intent.constraints.dry_run:
            ctx.note("dry_run: keine Schreibaktion")
            ctx.finish_step("Verzeichnis anlegen")
            return {
                "path": ctx.rel(target),
                "existed": existed,
                "dry_run": True,
                "would_action": action,
                "__status__": "success",
                "__notes__": ["dry_run: geplant, nicht geschrieben"],
            }
        target.mkdir(parents=True, exist_ok=True)
        artifact = ctx.record(target, action)
        ctx.finish_step("Verzeichnis anlegen")
        return {"path": artifact.path, "existed": existed, "action": action, "bytes": artifact.bytes}


def _require_str(params: Mapping[str, Any], key: str, *, allow_empty: bool = False, max_len: int = 8192) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key} fehlt oder ist kein String.", hint=f"params.{key} als String uebergeben.")
    if not allow_empty and not value:
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key} darf nicht leer sein.")
    if len(value) > max_len:
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key} ist laenger als {max_len} Zeichen.")
    return value


def _optional_int(params: Mapping[str, Any], key: str, default: int, *, minimum: int, maximum: int) -> int:
    if key not in params or params[key] is None:
        return default
    value = params[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key} muss eine Ganzzahl sein.")
    if not minimum <= value <= maximum:
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key}={value} liegt ausserhalb [{minimum},{maximum}].")
    return value


def _optional_bool(params: Mapping[str, Any], key: str, default: bool) -> bool:
    if key not in params or params[key] is None:
        return default
    value = params[key]
    if not isinstance(value, bool):
        raise LimbError(ErrorCode.SCHEMA_INVALID, f"params.{key} muss ein bool sein.")
    return value


def _optional_sha256(params: Mapping[str, Any]) -> str | None:
    raw = params.get("expect_sha256")
    if raw in (None, ""):
        return None
    if not isinstance(raw, str) or len(raw) != _SHA256_LEN or any(ch not in "0123456789abcdef" for ch in raw):
        raise LimbError(ErrorCode.SCHEMA_INVALID, "params.expect_sha256 muss 64 Kleinbuchstaben-Hex-Zeichen sein.")
    return raw


def _assert_expected_hash(path: Path, expect: str | None, ctx: LimbContext) -> None:
    if not expect:
        return
    digest = sha256_file(path)
    if digest != expect:
        raise LimbError(
            ErrorCode.IO,
            f"Hash-Vorbedingung verfehlt bei {ctx.rel(path)}: erwartet {expect[:12]}…, gefunden {digest[:12]}…",
            hint="Datei zuerst mit fs.read_file lesen, dann mit aktuellem sha256 schreiben.",
        )


def _apply_patches(original: str, patches: Sequence[Any]) -> tuple[str, list[dict[str, Any]]]:
    """Wendet alle Patches im Speicher an. Kein Treffer -> keine Schreibaktion."""
    text = original
    applied: list[dict[str, Any]] = []
    for index, raw in enumerate(patches):
        if not isinstance(raw, Mapping):
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"patches[{index}] muss ein Objekt mit find/replace sein.")
        find = raw.get("find")
        replace = raw.get("replace")
        if not isinstance(find, str) or not find:
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"patches[{index}].find muss ein nicht-leerer String sein.")
        if not isinstance(replace, str):
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"patches[{index}].replace muss ein String sein.")
        count_raw = raw.get("count", 1)
        if count_raw is None:
            count_raw = 1
        if isinstance(count_raw, bool) or not isinstance(count_raw, int):
            raise LimbError(ErrorCode.SCHEMA_INVALID, f"patches[{index}].count muss eine Ganzzahl sein.")
        occurrences = text.count(find)
        needed = occurrences if count_raw <= 0 else count_raw
        if occurrences == 0 or (count_raw > 0 and occurrences < count_raw):
            raise LimbError(
                ErrorCode.PATCH_NO_MATCH,
                f"patches[{index}]: Suchtext nicht gefunden (vorkommen={occurrences}, verlangt={needed}).",
                hint="Erst fs.read_file, dann fs.write_file statt blindem Patch.",
            )
        limit = occurrences if count_raw <= 0 else count_raw
        text = text.replace(find, replace, limit)
        applied.append({"index": index, "find": find, "replace": replace, "count": limit})
    return text, applied


def _entry_dict(path: Path, ctx: LimbContext) -> dict[str, Any]:
    kind = "dir" if path.is_dir() else "file" if path.is_file() else "other"
    size = path.stat().st_size if path.is_file() else 0
    return {"path": ctx.rel(path), "type": kind, "bytes": size}


def _is_inside(target: Path, root: Path) -> bool:
    try:
        target.relative_to(root.resolve())
        return True
    except ValueError:
        return False


if __name__ == "__main__":
    sys.exit(BootstrapLimb().main())
