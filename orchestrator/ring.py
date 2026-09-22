"""Shared-Memory Ring-Sink (hochfrequenter Event-Bus, Protokoll 1.2).

Der Event-Bus der Phase 1 schreibt standardmaessig auf Konsole/Sammler. Fuer
Hochfrequenz-Events (Timer-Ticks, ``loop.tick``, ``transport.archived``) ist
jedoch jede JSON-Zeile auf einem ``TextIO``-Strom ein syscall-reiches Serialisierungs-
+Flush-Ziel. Dieser Sink schreibt kompakte JSON-Blobs in einen **gebundenen
Shared-Memory-Ring** (``multiprocessing.shared_memory``) -- kein syscall pro Event,
keine Datei, und die Daten bleiben fuer benachbarte Prozesse ohne Kopie sichtbar.

Aufbau des Speicherblocks (``struct``-Header + Kapazitaet * Slotgroesse)::

    0  ..  8   producer  (uint64, monotoner Schreibindex)
    8  .. 16   consumer  (uint64, monotoner Leseindex)
    16 ..      Slots (capacity * slot_size Bytes)

Jeder Slot beginnt mit einer 4-Byte-Laenge (``uint32``), gefolgt von den
UTF-8-JSON-Bytes. Der Ring ist **bounded**: vollautomatisch, wenn
``producer - consumer >= capacity``.

Wichtig: Der Standardpfad (``ConsoleSink`` / ``CollectingSink`` / dateibasierter
``FileTransport``) bleibt unveraendert und ist der Fallback. Dieser Sink ist
opt-in (``neu nexus ring-sink`` bzw. ``SharedMemoryRingSink(...)``).

Nur Standardbibliothek (Threading, struct, json).
"""

from __future__ import annotations

import contextlib
import json
import struct
import threading
from collections.abc import Mapping
from multiprocessing import shared_memory
from typing import Any

_HDR_PRODUCER = 0
_HDR_CONSUMER = 8
_HDR_SIZE = 16
_SLOT_LEN_SIZE = 4
_FMT_INDEX = "<Q"
_FMT_LEN = "<I"


class RingFull(Exception):
    """Der gebundene Ring ist voll -- der Sink hat keine Slots mehr frei."""


class SharedMemoryRingSink:
    """Schreibt serialisierte Event-Datensaetze in einen geteilten Ringspeicher."""

    name = "shared_memory"

    def __init__(self, *, name: str | None = None, capacity: int = 256, slot_size: int = 8192) -> None:
        if capacity < 1 or slot_size < _SLOT_LEN_SIZE + 1:
            raise ValueError("capacity >= 1 und slot_size > 4")
        self.capacity = capacity
        self.slot_size = slot_size
        #: Verworfene Events im Nicht-Strict-Pfad (``write_prepared``).
        self.dropped = 0
        self.total_size = _HDR_SIZE + capacity * slot_size
        self.shm = shared_memory.SharedMemory(name=name, create=True, size=self.total_size)
        self.shm_name = self.shm.name
        self._lock = threading.Lock()
        self._set_index(_HDR_PRODUCER, 0)
        self._set_index(_HDR_CONSUMER, 0)
        self._closed = False

    # -- Offsets / Indizes -------------------------------------------------
    def _buffer(self):
        """Der geteilte Speicherblock (typgerecht als ``memoryview``)."""
        buf = self.shm.buf
        assert buf is not None
        return buf

    def _get_index(self, offset: int) -> int:
        return int(struct.unpack_from(_FMT_INDEX, self._buffer(), offset)[0])

    def _set_index(self, offset: int, value: int) -> None:
        struct.pack_into(_FMT_INDEX, self._buffer(), offset, value)

    def _slot_offset(self, index: int) -> int:
        return _HDR_SIZE + (index % self.capacity) * self.slot_size

    # -- EventSink-Protokoll ----------------------------------------------
    #: Der Ring braucht Text, keinen Dict -- also liefert ihm der Bus die
    #: bereits serialisierte Zeile (ein ``json.dumps`` fuer alle Text-Sinks).
    wants_prepared_line = True

    def write(self, record: Mapping[str, Any]) -> None:
        self._put(json.dumps(dict(record), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def write_prepared(self, record: Mapping[str, Any], line: str) -> None:
        """Fast-Path: nur encodieren + in den Ring kopieren, kein ``json.dumps``.

        Volllaeuft der Ring, *zaehlt* der Sink den Drop statt zu raise'en: ein
        Langsam-Leser darf den Bus nicht pro Event in den
        Fehler-Behandlungspfad (stderr-Zeile) zwingen. Das ist der Unterschied
        zwischen Beobachtungs-Ebene (verwirft) und Zusicherungs-Ebene (wirft).
        """
        self._put(line.encode("utf-8"), strict=False)

    def _put(self, data: bytes, *, strict: bool = True) -> None:
        if self._closed:
            raise ValueError("Ring-Sink ist geschlossen")
        if len(data) > self.slot_size - _SLOT_LEN_SIZE:
            raise ValueError(f"Event ist {len(data)} Bytes gross -- passt nicht in Slot (slot_size-4).")
        with self._lock:
            producer = self._get_index(_HDR_PRODUCER)
            consumer = self._get_index(_HDR_CONSUMER)
            if producer - consumer >= self.capacity:
                if strict:
                    raise RingFull(f"Ring voll: {self.capacity} Slots belegt")
                self.dropped += 1
                return
            offset = self._slot_offset(producer)
            buf = self._buffer()
            struct.pack_into(_FMT_LEN, buf, offset, len(data))
            buf[offset + _SLOT_LEN_SIZE : offset + _SLOT_LEN_SIZE + len(data)] = data
            self._set_index(_HDR_PRODUCER, producer + 1)

    def available(self) -> int:
        return int(self._get_index(_HDR_PRODUCER) - self._get_index(_HDR_CONSUMER))

    def capacity_free(self) -> int:
        return self.capacity - self.available()

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(FileNotFoundError):
            self.shm.close()

    def unlink(self) -> None:
        """Schliesst und gibt den Speicher (und den Namen) frei."""
        self.close()
        with contextlib.suppress(FileNotFoundError):
            self.shm.unlink()


class SharedMemoryRingReader:
    """Konsumiert die von ``SharedMemoryRingSink`` erzeugten Event-Blobs.

    Reader und Sink muessen dieselbe ``capacity`` und ``slot_size`` verwenden.
    """

    def __init__(self, shm_name: str, *, capacity: int = 256, slot_size: int = 8192) -> None:
        self.capacity = capacity
        self.slot_size = slot_size
        self.shm = shared_memory.SharedMemory(name=shm_name, create=False)
        self.shm_name = shm_name
        self._lock = threading.Lock()

    def _get_index(self, offset: int) -> int:
        return int(struct.unpack_from(_FMT_INDEX, self._buffer(), offset)[0])

    def _slot_offset(self, index: int) -> int:
        return _HDR_SIZE + (index % self.capacity) * self.slot_size

    def _buffer(self):
        buf = self.shm.buf
        assert buf is not None
        return buf

    @property
    def available(self) -> int:
        return int(self._get_index(_HDR_PRODUCER) - self._get_index(_HDR_CONSUMER))

    def read(self) -> dict[str, Any] | None:
        """Liest das aelteste Event; ``None``, wenn der Ring leer ist."""
        with self._lock:
            consumer = self._get_index(_HDR_CONSUMER)
            producer = self._get_index(_HDR_PRODUCER)
            if consumer >= producer:
                return None
            offset = self._slot_offset(consumer)
            buf = self._buffer()
            length = int(struct.unpack_from(_FMT_LEN, buf, offset)[0])
            raw = bytes(buf[offset + _SLOT_LEN_SIZE : offset + _SLOT_LEN_SIZE + length])
            self._set_index(_HDR_CONSUMER, consumer + 1)
        decoded = json.loads(raw.decode("utf-8"))
        return decoded if isinstance(decoded, dict) else None

    def _set_index(self, offset: int, value: int) -> None:
        struct.pack_into(_FMT_INDEX, self._buffer(), offset, value)

    def drain(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        while True:
            record = self.read()
            if record is None:
                return out
            out.append(record)

    def close(self) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.shm.close()
