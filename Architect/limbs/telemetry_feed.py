"""Engine-Telemetrie auf den UDS-Event-Bus (P1: Live-Feed fuer das Frontend).

Bis hierher rechneten ``MicrostructureEngine`` und ``ACGravityEngine`` nichts:
``git grep`` fand fuer ``compute_gravity_field``/``calculate_obi``/
``calculate_footprint_map`` keinen einzigen Aufrufer im Repo, nur die
Metadata-Strings in ``core/agent_assignment.py``. Dieser Feed ist der fehlende
Producer.

Was er tut, in einem Tick:

1. ein Orderbuch-Zeitfenster entgegennehmen (``on_tape``-Aufruf -- Quelle ist
   hier austauschbar: WebSocket, FIX, Replay-Datei),
2. die **realen** Engines rechnen lassen,
3. drei Events mit dem Wire-Vertrag aus ``core.events.TELEMETRY_PAYLOAD_FIELDS``
   bauen (``microstructure_tick``, ``gravity_tick``, ``regime_tick``),
4. jede Zeile per ``UDSBroadcastSink`` als ``SOCK_DGRAM``-Datagramm senden --
   derselbe Transport, den ``orchestrator/uds.py`` fuer ``runtime/bus.sock``
   nutzt, nur auf einem eigenen Socket, damit der Orchestrator-Bus und die
   Engine-Telemetrie sich nicht in die Quere kommen.

Fail-closed: ein Payload, dem ein Pflichtfeld fehlt, wird von
``validate_telemetry_payload`` abgewiesen und landet nicht auf dem Bus. Ein
Tick, in dem eine Engine wirft, erzeugt **kein** Event -- das Widget faellt
dann auf seinen letzten Stand zurueck, statt einen erfundenen Wert zu zeigen.

Nur Standardbibliothek + numpy (wie die Engines selbst).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

# Paketwurzel ist Architect/ (core.*, limbs.*) -- genau wie in Architect/tests.
# Die Repo-Wurzel darf **nicht** auf sys.path: dort liegt ein zweites Paket
# ``core/`` (ohne events.py), das Architect/core verdecken wuerde.
_ARCHITECT = Path(__file__).resolve().parents[1]
if str(_ARCHITECT) not in sys.path:
    sys.path.insert(0, str(_ARCHITECT))

from core.events import EventBus  # noqa: E402
from limbs.intelligence.microstructure_engine import MicrostructureEngine  # noqa: E402
from limbs.math.ac_gravity_engine import ACGravityEngine  # noqa: E402

#: Repo-Wurzel, nur fuer den UDS-Transport genutzt.
_REPO_ROOT = _ARCHITECT.parent


def load_uds_module():
    """``orchestrator/uds.py`` per Dateipfad laden (nur Standardbibliothek dort).

    Bewusst kein ``sys.path``-Eintrag fuer die Repo-Wurzel: das wuerde das
    ``core``-Paket der Repo-Wurzel vor ``Architect/core`` schieben.
    """
    import importlib.util

    path = _REPO_ROOT / "orchestrator" / "uds.py"
    spec = importlib.util.spec_from_file_location("nio_orchestrator_uds", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

__all__ = ["TelemetryFeed", "hour_labels", "main"]

#: Das CVD-Heatmap-Widget rendert genau 12 Bins (frontend/src/ops/widgets/CvdHeatmap.tsx).
CVD_BINS = 12


def hour_labels(count: int = CVD_BINS, *, now: float | None = None) -> list[str]:
    """Stundenbeschriftung im 2-h-Raster der Widget-Vorlage, ende bei ``now``."""
    base = time.gmtime(now if now is not None else time.time())
    end_hour = (base.tm_hour // 2) * 2
    return ["%02d" % ((end_hour - 2 * i) % 24,) for i in range(count)][::-1]


class TelemetryFeed:
    """Rechnet pro Tick die Engines und schickt drei geprüfte Events hinaus.

    ``polymarket_prob`` ist **kein** Börsenwert: ohne Polymarket-Zulieferung ist
    es eine explizit gesetzte Annahme (Default 0.5 = keine Information) und wird
    als solche im Event mitgeführt (``assumptions``). Dasselbe gilt für die
    Gewichtungen, die aus der Engine kommen (0.25/0.35/0.40).
    """

    #: Blueprint-Prior (0.25/0.35/0.40). Gerechnet wird mit
    #: ``self.gravity.weights``; ein Learner darf davon abweichen.
    WEIGHTS = (0.25, 0.35, 0.40)

    def __init__(
        self,
        bus: EventBus,
        sink: Any | None = None,
        *,
        symbol: str = "BTCUSDT",
        polymarket_prob: float = 0.5,
        bins: int = CVD_BINS,
        clock: Callable[[], float] = time.time,
        learner: Any | None = None,
        history_window: int | None = None,
    ) -> None:
        self.bus = bus
        self.sink = sink
        self.symbol = symbol
        self.polymarket_prob = polymarket_prob
        self.bins = bins
        self.clock = clock
        self.micro = MicrostructureEngine()
        self.learner = learner
        engine_kwargs: dict[str, Any] = {}
        if history_window is not None:
            engine_kwargs["history_window"] = history_window
        if learner is not None:
            tuned = learner.params()
            engine_kwargs["weights"] = (tuned["w_vis"], tuned["w_blind"], tuned["w_poly"])
            engine_kwargs["quantile"] = tuned["quantile"]
        self.gravity = ACGravityEngine(**engine_kwargs)
        self.sent = 0
        self.rejected = 0
        self.ticks = 0
        self._history: deque[float] = deque(maxlen=self.gravity.history_window)

    # -- Eingang ------------------------------------------------------------
    def on_tape(self, bids: Sequence[tuple[float, float]],
                asks: Sequence[tuple[float, float]],
                trades: Iterable[tuple[float, float, bool]]) -> dict[str, bool]:
        """Ein Orderbuch-Fenster durch die Engines schicken und hinaussenden.

        Liefert je Event-Kind, ob es gesendet wurde (``False`` = verworfen).
        """
        self.ticks += 1
        sent: dict[str, bool] = {}
        try:
            price = self._mid(bids, asks)
            obi = self.micro.calculate_obi(bids, asks, current_price=price)
            footprint = self.micro.calculate_footprint_map(
                list(trades), self._low(bids), self._high(asks)
            )
            l2_depth = self._depth(bids, asks)
            l3_iceberg = self._iceberg(bids, asks)
            v_total = self.gravity.compute_gravity_field(
                l2_depth, l3_iceberg, self.polymarket_prob
            )
            history_ready = len(self._history) >= 2
            in_forbidden = self.gravity.is_in_forbidden_zone(price, self._history)
            tuned = self.gravity.params()
        except Exception:  # noqa: BLE001 -- ein Tick darf den Feed nicht beenden
            self.rejected += 1
            return {kind: False for kind in ("microstructure_tick", "gravity_tick", "regime_tick")}

        clock_s = self.clock()
        bins = self._resample(list(footprint), self.bins)

        sent["microstructure_tick"] = self._send(
            "microstructure_tick",
            {
                "imbalance_ratio": round(float(obi), 6),
                "depth_2pct": round(float(l2_depth), 6),
                "footprint_delta": [round(float(v), 6) for v in bins],
            },
            clock_s=clock_s,
        )
        gravity_payload = {
            "l2_depth": round(float(l2_depth), 6),
            "l3_iceberg": round(float(l3_iceberg), 6),
            "polymarket_prob": round(float(self.polymarket_prob), 6),
            "v_total": round(float(v_total), 6),
            "w_vis": round(float(tuned["w_vis"]), 6),
            "w_blind": round(float(tuned["w_blind"]), 6),
            "w_poly": round(float(tuned["w_poly"]), 6),
        }
        if price is not None:
            gravity_payload["mid_price"] = round(float(price), 6)
        sent["gravity_tick"] = self._send(
            "gravity_tick",
            gravity_payload,
            clock_s=clock_s,
            assumptions=("polymarket_prob=static",),
        )
        sent["regime_tick"] = self._send(
            "regime_tick",
            {
                "cluster_id": 0,
                "confidence": round(abs(float(obi)), 6),
                "is_forbidden_zone": 1.0 if in_forbidden else 0.0,
                "quantile": round(float(tuned["quantile"]), 6),
            },
            clock_s=clock_s,
            assumptions=("cluster_id=uncalibrated",),
        )
        # Learner sees the breach flag only once the window can support a
        # quantile. Empty history used to answer "not forbidden", which is not
        # a coverage error and would drag the adaptive quantile down.
        if price is not None:
            breach = bool(in_forbidden) if history_ready else None
            self._adapt(l2_depth, l3_iceberg, float(price), breach)
            self._history.append(float(price))
        return sent

    def _adapt(self, l2_depth: float, l3_iceberg: float, price: float, in_forbidden: bool | None) -> None:
        """One online step, then push the learned parameters back into the engine."""
        if self.learner is None:
            return
        self.learner.observe(
            {
                "l2_depth": float(l2_depth),
                "l3_iceberg": float(l3_iceberg),
                "polymarket_prob": float(self.polymarket_prob),
                "mid_price": float(price),
                "is_forbidden_zone": in_forbidden,
            }
        )
        tuned = self.learner.params()
        self.gravity.set_weights((tuned["w_vis"], tuned["w_blind"], tuned["w_poly"]))
        self.gravity.set_quantile(tuned["quantile"])

    # -- Ausgang ------------------------------------------------------------
    def _send(self, event_kind: str, payload: dict, clock_s: float, **extra) -> bool:
        try:
            event = self.bus.build_telemetry_event(
                event_kind, payload, symbol=self.symbol, clock_s=clock_s, **extra
            )
        except ValueError:
            self.rejected += 1
            return False
        if self.sink is not None:
            # ``UDSBroadcastSink.write`` serialisiert selbst (kompakt, ensure_ascii
            # aus) und verwirft statt zu blockieren, wenn kein Empfaenger da ist.
            self.sink.write(event)
        else:
            if not self.bus.emit(event):
                self.rejected += 1
                return False
        self.sent += 1
        return True

    # -- Aggregation (reine Hilfsfunktionen, keine Engine-Logik) -------------
    def _resample(self, values: list[float], bins: int) -> list[float]:
        """26 Footprint-Bins der Engine auf die ``bins`` des Widgets mitteln."""
        if bins <= 0:
            return []
        out = [0.0] * bins
        if not values:
            return out
        span = len(values) / bins
        for index, value in enumerate(values):
            slot = min(bins - 1, int(index / span))
            out[slot] += value
        return out

    @staticmethod
    def _mid(bids: Sequence[tuple[float, float]], asks: Sequence[tuple[float, float]]) -> float | None:
        if not bids or not asks:
            return None
        return (bids[0][0] + asks[0][0]) / 2.0

    @staticmethod
    def _low(bids: Sequence[tuple[float, float]]) -> float:
        return min((p for p, _ in bids), default=0.0)

    @staticmethod
    def _high(asks: Sequence[tuple[float, float]]) -> float:
        return max((p for p, _ in asks), default=0.0)

    @staticmethod
    def _depth(bids: Sequence[tuple[float, float]], asks: Sequence[tuple[float, float]]) -> float:
        """Sichtbare L2-Tiefe: Gesamtmenge beider Seiten, auf 1 normiert."""
        total = sum(v for _, v in bids) + sum(v for _, v in asks)
        return total / (1.0 + total)

    @staticmethod
    def _iceberg(bids: Sequence[tuple[float, float]], asks: Sequence[tuple[float, float]]) -> float:
        """Anteil versteckter Liquiditaet: Konzentration auf wenige Preisstufen.

        Ein Buch, dessen Menge auf eine Handvoll Levels konzentriert ist, hat
        Eisberg-Charakter (0 = gleichmaessig verteilt, -> 1 = ein Level traegt
        fast alles).
        """
        levels = [v for _, v in bids] + [v for _, v in asks]
        total = sum(levels)
        if not levels or total <= 0:
            return 0.0
        peak = max(levels)
        return peak / total


def main(argv: Sequence[str] | None = None) -> int:
    """Dauerschleife: alle ``tick_s`` ein Orderbuch-Fenster durch die Engines.

    Ohne echte Börsenzulieferung läuft der Feed gegen einen deterministischen,
    zufallsfreien Tape-Generator (``--tape walk``) -- die **Berechnung** ist die
    reale Engine, nur der Input ist synthetisch. Das steht so auch im Event
    (``tape="synthetic-walk"``), damit niemand einen Börsenfeed daraus abliest.
    """
    parser = argparse.ArgumentParser(description="Engine-Telemetrie auf den UDS-Bus")
    parser.add_argument("--socket", default="runtime/telemetry.sock")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--tick-s", type=float, default=1.0)
    parser.add_argument("--ticks", type=int, default=0, help="0 = endlos")
    parser.add_argument("--polymarket-prob", type=float, default=0.5)
    parser.add_argument("--price", type=float, default=100.0, help="Startpreis des Walks")
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--log", default=None, help="zusaetzlich NDJSON in diese Datei")
    parser.add_argument("--learn", action="store_true", help="Gewichte und Quantil online aus den Ticks nachfuehren")
    parser.add_argument("--params", default=None, help="gravity_params.json laden und (mit --learn) beim Beenden schreiben")
    args = parser.parse_args(argv)

    bus = EventBus(system_log_path=args.log or "Architect/runtime/system.log")
    if not args.log:
        bus.event_sinks["stderr"] = False
        bus.event_sinks["file"] = False

    learner = _load_learner(args.learn, args.params)
    uds = load_uds_module()
    feed = TelemetryFeed(bus, uds.UDSBroadcastSink(args.socket), symbol=args.symbol,
                         polymarket_prob=args.polymarket_prob, learner=learner if args.learn else None)
    if learner is not None and not args.learn:
        tuned = learner.params()
        feed.gravity.set_weights((tuned["w_vis"], tuned["w_blind"], tuned["w_poly"]))
        feed.gravity.set_quantile(tuned["quantile"])
    walk = _TapeWalk(args.price, args.seed)
    print("telemetry feed -> %s (symbol=%s, tick=%.2fs)" % (args.socket, args.symbol, args.tick_s),
          file=sys.stderr, flush=True)
    try:
        while args.ticks == 0 or feed.ticks < args.ticks:
            bids, asks, trades = walk.next()
            feed.on_tape(bids, asks, trades)
            time.sleep(max(0.0, args.tick_s))
    except KeyboardInterrupt:
        pass
    finally:
        if feed.sink is not None:
            feed.sink.close()
        if args.learn and args.params and feed.learner is not None:
            out = Path(args.params)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(feed.learner.to_json(), indent=2) + "\n", encoding="utf-8")
    print("telemetry feed beendet: %d Events, %d verworfen" % (feed.sent, feed.rejected),
          file=sys.stderr, flush=True)
    return 0


def _load_learner(learn: bool, params_path: str | None):
    """Learner aus ``--params`` rekonstruieren, oder frisch starten wenn ``--learn``."""
    if not learn and not params_path:
        return None
    from limbs.ml.gravity_learner import GravityFieldLearner

    if params_path and Path(params_path).is_file():
        payload = json.loads(Path(params_path).read_text(encoding="utf-8"))
        return GravityFieldLearner.from_json(payload)
    if learn:
        return GravityFieldLearner()
    return None


class _TapeWalk:
    """Deterministischer Tape-Generator (kein Zufall, kein Börsenfeed)."""

    def __init__(self, price: float, seed: int) -> None:
        self.price = price
        self.state = seed
        self.step = 0

    def _rand(self) -> float:
        # Linearer Kongruenzgenerator: reproduzierbar, keine numpy-Abhaengigkeit.
        self.state = (1103515245 * self.state + 12345) % 2147483648
        return self.state / 2147483648.0

    def next(self):
        self.step += 1
        drift = (self._rand() - 0.5) * self.price * 0.002
        self.price = max(0.01, self.price + drift)
        spread = self.price * 0.0004
        bids = [(self.price - spread * (i + 1), 1.0 + 4.0 * self._rand()) for i in range(8)]
        asks = [(self.price + spread * (i + 1), 1.0 + 4.0 * self._rand()) for i in range(8)]
        trades = [
            (self.price + (self._rand() - 0.5) * spread, 0.2 + self._rand(), self._rand() > 0.5)
            for _ in range(24)
        ]
        return bids, asks, trades


if __name__ == "__main__":
    raise SystemExit(main())
