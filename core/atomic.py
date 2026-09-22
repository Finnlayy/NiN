"""Atomares Schreiben von Bytes auf einen Pfad -- der Unterbau von Transport und Zustand.

Crash-Sicherheit schlägt Bequemlichkeit: das Dokument entsteht als Temp-Datei **im
Zielverzeichnis**, wird (auf Wunsch) fsynciert und dann per ``os.replace`` an den
Zielnamen gehoben. Ein Leser sieht deshalb entweder die alte oder die neue Fassung,
niemals ein halbes Dokument.

Bewusst *nicht* benutzt: ``tempfile.NamedTemporaryFile`` und ``TextIOWrapper``.
Beide kosten pro Schreibvorgang mehr als der ``write``-Syscall selbst -- gemessen auf
einem 32-KB-Dokument: ``write_text`` 295 µs gegen ``os.open`` + ``os.write`` +
``os.close`` 198 µs, und der Temp-Datei-Wrapper allein ~200 µs (Objektanlage,
Finalizer, zweiter Flush beim Schliessen). Der Orchestrator schreibt diese Dokumente
pro Zustellung mehrfach, der Scheduler pro Feuerung -- der Fix liegt also im Pfad,
nicht in der Ausnahmekante.

Nur Standardbibliothek, keine Abhängigkeit nach oben (``orchestrator/`` importiert
``core/``, nie umgekehrt).
"""

from __future__ import annotations

import contextlib
import itertools
import os
from pathlib import Path

__all__ = ["atomic_write_bytes"]

#: Eindeutige Temp-Namen pro Prozess. Der Zähler ersetzt das ``mkstemp``-Raten von
#: ``tempfile``: ein ``O_EXCL`` auf einen vorhersehbaren Namen ist ein Syscall, kein
#: Schleifenversuch -- und ``os.getpid()`` hält parallele Prozesse voneinander fern.
_seq = itertools.count()


def atomic_write_bytes(
    target: Path | str,
    data: bytes,
    *,
    fsync: bool = False,
    dir_mode: bool = True,
    mode: int = 0o644,
) -> Path:
    """Schreibt ``data`` atomar auf ``target`` und gibt den Pfad zurück.

    ``fsync``: Daten vor dem ``replace`` auf die Platte zwingen. Der Transport setzt
    das, weil ein Intent, der den Absturz nicht überlebt, eine verlorene Zustellung
    ist -- die Zeile ist vertraglich, nicht verhandelbar. Interne Zustandsdateien
    kommen ohne aus (sie sind reproduzierbar).

    ``mode``: Rechte der neuen Datei. Der Transport hält 0600 (Absicht, wie bisher --
    ``NamedTemporaryFile`` legte die ebenfalls auf 0600 fest), Zustandsdateien 0644.
    Die effective Maske des Prozesses wird nie überschritten: ``os.open`` maskiert sie
    ohnehin ab, hier wird höchstens strenger.
    """
    path = Path(target)
    parent = path.parent
    if dir_mode:
        os.makedirs(str(parent), exist_ok=True)
    tmp = parent / f".{path.name}.{os.getpid()}.{next(_seq)}.tmp"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        try:
            os.write(fd, data)
            if fsync:
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(str(tmp), str(path))
    except BaseException:
        # Auch ein gescheiterter ``replace`` darf keine Temp-Datei hinterlassen --
        # im Zielverzeichnis sammelten sich sonst Halbwaisen eines Docs.
        with contextlib.suppress(OSError):
            os.unlink(str(tmp))
        raise
    return path
