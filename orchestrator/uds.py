"""Unix-Domain-Socket-Broadcast-Sink (Hochfrequenz-Events, Protokoll 1.2).

Der Orchestrator stellt Intents **per Vertrag** ueber das Dateisystem zu
(``orchestrator/transport.py``: crash-sicher, sprachneutral, replayfaehig).
Davon zu trennen ist die **Beobachtungsebene**: der Event-Strom, den Console,
Dashboard oder ein ``tail``-Prozess mitlesen will. Genau die ist der heisseste
Pfad des Systems (pro Tick mindestens ein Event, bei ``tick_s=0,05`` bis zu 20
pro Sekunde und Job).

Dieser Sink haengt einen ``AF_UNIX``-``SOCK_DGRAM``-Broadcast an den Bus:

* **ein** ``send``-Syscall pro Event (statt ``write`` + ``flush`` pro Sink),
* **keine** Serialisierung im Sink -- der Bus liefert die fertige Zeile
  (``write_prepared``), der Sink encodiert nur noch nach UTF-8,
* **kein** Dateisystem-Eintrag im hot path, kein ``fsync``, kein Seitenholen,
* Verlieren ist erlaubt und gezaehlt: ein voller Socket-Buffer oder ein
  fehlender Empfaenger darf die Pipeline nie aufhalten (Log-Ebene).

Bewusst *nicht* ersetzt: ``FileTransport`` (Zustellung), ``ConsoleSink``
(menschlicher Live-Strom), ``CollectingSink`` (CLI-Bilanz). Der UDS-Sink ist
opt-in: ``neu ... --uds runtime/bus.sock`` oder ``UDSBroadcastSink(path)``.

Nur Standardbibliothek.
"""

from __future__ import annotations

import contextlib
import errno
import json
import os
import socket
import sys
import time
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

__all__ = ["UDSBroadcastServer", "UDSBroadcastSink"]

#: Linux-Kurzname fuer die abstract namespace; ``\0`` praefixiert umgeht das
#: 108-Byte-Limit von ``sun_path`` (kein Dateisystem-Eintrag noetig).
_SUN_PATH_LIMIT = 108

#: Datagrammgroesse, die ein Empfaenger maximal auf einmal liest.
_RECV_SIZE = 65536

#: Fehlerarten, die ein "Empfaenger ist weg"-Zustand anzeigen.
_GONE = (errno.ENOENT, errno.ECONNREFUSED, errno.ECONNRESET, errno.ENOTCONN)


def _listener_alive(path: Path) -> bool:
    """True, wenn an dem Pfad tatsaechlich jemand empfaengt (kein stale Inode).

    Ein ``connect`` auf einem UDS-Datagramm-Socket antwortet im Kernel mit
    ``ECONNREFUSED``, wenn gar kein Socket mehr gebunden ist.
    """
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        probe.connect(str(path))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def _abstract_name(path: Path | str) -> str:
    """Deterministischer abstract-Name, wenn der Pfad zu lang fuer ``sun_path`` waere."""
    return "\0neu-" + str(path)[: _SUN_PATH_LIMIT - 5]


class UDSBroadcastSink:
    """Versieht jeden Event-Datensatz als JSON-Zeile per ``SOCK_DGRAM`` nach aussen.

    Der Sink ist absichtlich **nicht** zustellungsgarantiert: der Queue eines
    UDS-Datagramm-Sockets ist begrenzt (auf dieser Box ~278 Datagramme, zaehlt --
    nicht bytes!), und ist er voll, zaehlt der Sink den Drop und macht weiter.
    Ebenso darf ein abwesender Empfaenger nicht blockieren: der Connect wird
    hoechstens alle ``retry_after_s`` Sekunden erneut versucht, dazwischen zaehlt
    der Sink Wegwerfen. Der Rest des Buses laeuft in beiden Faellen ungestoert.

    ``batch_bytes`` (Opt-in) haelt Zeilen zurueck und schickt sie gesammelt -- ein
    Syscall fuer viele Events. Das erhoehmt die Lieferverzoegerung beim Mitleser
    und senkt die Syscall-Rate; gemessen ist der Gewinn klein (der Bus-zu-Bus-
    Vergleich liegt bei ~9 µs/Event, im Burst-Betrieb bei 2,35 µs), weil die
    Serialisierung den Pfad dominiert, nicht der Syscall. Darum: opt-in.
    """

    name = "uds"
    wants_prepared_line = True

    def __init__(
        self,
        path: Path | str,
        *,
        batch_bytes: int = 0,
        retry_after_s: float = 2.0,
        socket_dir: Path | str | None = None,
    ) -> None:
        self.path = Path(path)
        #: Der Empfaenger (``orchestrator bus tail``) kann spaeter starten als der
        # Producer. Also: neu versuchen, aber nur alle ``retry_after_s`` Sekunden --
        # ein erfolgloser Connect kostet zwei Syscalls, pro Event waere das Gift.
        self.retry_after_s = max(0.0, retry_after_s)
        self.batch_bytes = max(0, batch_bytes)
        self.sent = 0
        self.dropped = 0
        self.bytes_sent = 0
        self.errors = 0
        self._sock: socket.socket | None = None
        self._batch = bytearray()
        self._closed = False
        self._abstract: str | None = None
        self._last_attempt = -1.0
        if socket_dir is not None:
            Path(socket_dir).mkdir(parents=True, exist_ok=True)
        self.connect()

    # -- Verbindung ---------------------------------------------------------
    @property
    def connected(self) -> bool:
        return self._sock is not None

    @property
    def degraded(self) -> bool:
        """Aktuell kein Empfaenger erreichbar -- Events werden verworfen, nicht blockiert."""
        return self._sock is None

    def connect(self) -> bool:
        """Verbindet (erneut) mit dem Socket. ``False`` = Empfaenger nicht da.

        Kein Raise: ein Log-Pfad darf einen Lauf nicht scheitern lassen.
        """
        if self._closed or self._sock is not None:
            return self._sock is not None
        self._last_attempt = time.monotonic()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.connect(str(self.path))
        except OSError as exc:
            sock.close()
            self.errors += 1
            # zu langer Pfad: abstract namespace versuchen (Linux, kein Inode noetig)
            if exc.errno == errno.ENAMETOOLONG and sys.platform.startswith("linux"):
                self._abstract = _abstract_name(self.path)
                alt = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
                try:
                    alt.connect(self._abstract)
                except OSError:
                    alt.close()
                    return False
                alt.setblocking(False)
                self._sock = alt
                return True
            return False
        # Nicht blockierend *nach* dem Connect: ein voller Empfaenger-Puffer darf
        # den Producer nie anhalten (ein Log-Sink wartet nicht, er verwirft).
        sock.setblocking(False)
        self._sock = sock
        return True

    def _maybe_reconnect(self) -> None:
        if self._sock is not None or self._closed:
            return
        if time.monotonic() - self._last_attempt >= self.retry_after_s:
            self.connect()

    # -- EventSink-Protokoll ------------------------------------------------
    def write(self, record: Mapping[str, Any]) -> None:
        self._send_line(json.dumps(dict(record), ensure_ascii=False, separators=(",", ":")))

    def write_prepared(self, record: Mapping[str, Any], line: str) -> None:
        """Fast-Path: Zeile ist schon JSON -- nur noch encodieren (und evtl. buendeln)."""
        self._send_line(line)

    def _send_line(self, line: str) -> None:
        if self._sock is None:
            self._maybe_reconnect()
            if self._sock is None:
                self.dropped += 1
                return
        data = line.encode("utf-8")
        if self.batch_bytes:
            # Batch nur fuellen, solange das Datagramm Platz hat; sonst zuerst
            # rausschicken und die Zeile in den naechsten Datagramm-Kopf legen.
            if self._batch and len(self._batch) + len(data) + 1 > self.batch_bytes:
                self.flush()
            self._batch += data
            self._batch += b"\n"
            return
        self._send_bytes(data)

    def _send_bytes(self, data: bytes) -> None:
        sock = self._sock
        if sock is None:
            self._maybe_reconnect()
            sock = self._sock
            if sock is None:
                self.dropped += 1
                return
        try:
            sock.send(data)
        except BlockingIOError:
            self.dropped += 1  # Empfaenger zu langsam: Log verwerfen, Pipeline laufen lassen
        except OSError as exc:
            self.errors += 1
            self.dropped += 1
            if exc.errno in _GONE:
                sock.close()
                self._sock = None
        else:
            self.sent += 1
            self.bytes_sent += len(data)

    def flush(self) -> int:
        """Schickt den Batch (falls aktiv). Gibt die gesendeten Bytes zurueck."""
        if not self._batch:
            return 0
        data = bytes(self._batch)
        self._batch.clear()
        self._send_bytes(data.rstrip(b"\n"))
        return len(data)

    # -- Lebenszyklus --------------------------------------------------------
    def stats(self) -> dict[str, Any]:
        return {
            "socket": str(self.path),
            "connected": self.connected,
            "degraded": self.degraded,
            "sent": self.sent,
            "dropped": self.dropped,
            "bytes_sent": self.bytes_sent,
            "errors": self.errors,
            "batch_bytes": self.batch_bytes,
        }

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.flush()
        if self._sock is not None:
            self._sock.close()
            self._sock = None


class UDSBroadcastServer:
    """Gegenseite: nimmt datagrammuebermittelte Event-Zeilen ab und parst sie.

    Beispiel::

        with UDSBroadcastServer("runtime/bus.sock") as server:
            for record in server.records(timeout_s=1.0):
                print(record["kind"])

    Ein ``with`` entfernt den Socket-Pfad beim Verlassen -- ``SOCK_DGRAM``-Pfade
    bleiben sonst als stale Inodes liegen und ein erneutes ``bind`` scheitert.
    """

    def __init__(self, path: Path | str, *, recv_size: int = _RECV_SIZE, mode: int = 0o600) -> None:
        self.path = Path(path)
        self.recv_size = recv_size
        self.mode = mode
        self.received = 0
        self.abstract: str | None = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.bind(str(self.path))
        except OSError as exc:
            if exc.errno in (errno.ENAMETOOLONG, errno.EINVAL) and sys.platform.startswith("linux"):
                # Pfad zu lang fuer sun_path: abstract namespace (Linux, kein Inode).
                sock.close()
                self.abstract = _abstract_name(self.path)
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
                sock.bind(self.abstract)
            elif exc.errno == errno.EADDRINUSE:
                # Stale Inode eines toten Produzenten ist der Regelfall nach einem
                # Absturz: erreichbar? -> echt belegt. Sonst entfernen und neu binden.
                sock.close()
                if _listener_alive(self.path):
                    raise
                self.path.unlink(missing_ok=True)
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
                sock.bind(str(self.path))
            else:
                sock.close()
                raise
        # UDS-Inodes erben die Maske des Prozesses; fuer ein Beobachtungs-Socket
        # im runtime-Verzeichnis wollen wir strikt 0600 (kein Mitlesen durch
        # andere User), auch wenn ``runtime/`` selbst schon private Rechte hat.
        if self.abstract is None:
            os.chmod(self.path, self.mode)
        self.sock = sock

    # -- Ein-/Ausstieg -------------------------------------------------------
    def __enter__(self) -> UDSBroadcastServer:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def recv_batch(self, timeout_s: float | None = None) -> list[str]:
        """Holt **alle** bereits eingetroffenen Datagramme ab und liefert ihre Zeilen.

        Bis zum ersten Datagramm wird bis ``timeout_s`` gewartet; danach wird nur
        noch nachgezogen, was schon im Queue liegt (nicht blockierend). Ein
        Konsument, der 20 Events in 20 Datagrammen empfaengt, braucht damit
        einen Aufruf statt zwanzig -- und ein ``stream``-Leser haelt seine
        Leerlaufzeit ein, statt pro Stapel ein weiteres Timeout zu bezahlen.
        """
        out: list[str] = []
        # Genau zwei Umstellungen pro Aufruf (einmal Vorlauf, einmal "nicht mehr
        # blockieren"), nicht eine pro Datagramm: ``settimeout`` ist ein
        # setsockopt-Syscall und war im Burst-Fall teurer als das Abholen selbst.
        self.sock.settimeout(timeout_s)
        switched = False
        while True:
            try:
                data = self.sock.recv(self.recv_size)
            except (TimeoutError, BlockingIOError):
                break
            except OSError:
                break
            if not data:
                # Leeres Datagramm (Sonde) oder Shutdown: keine weiteren Zeilen.
                break
            out.extend(line for line in data.decode("utf-8", "replace").split("\n") if line.strip())
            if not switched:
                    self.sock.settimeout(0.0)
                    switched = True
        self.received += len(out)
        return out

    def records(self, timeout_s: float | None = None) -> list[dict[str, Any]]:
        """Wie ``recv_batch``, aber geparst; unparsebare Zeilen werden uebersprungen."""
        parsed: list[dict[str, Any]] = []
        for line in self.recv_batch(timeout_s=timeout_s):
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(raw, Mapping):
                parsed.append(dict(raw))
        return parsed

    def stream(self, *, timeout_s: float = 1.0) -> Iterator[dict[str, Any]]:
        """Endloser Generator ueber eingehende Events (Timeout = Leerlauf, kein Fehler)."""
        while True:
            yield from self.records(timeout_s=timeout_s)

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self.sock.close()
        if self.abstract is None:
            self.path.unlink(missing_ok=True)
