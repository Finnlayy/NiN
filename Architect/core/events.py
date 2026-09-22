import logging
import json
import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

VALID_EVENT_KINDS = [
    "execution_started",
    "execution_complete",
    "post_mortem_started",
    "post_mortem_complete",
    "manifest_validated",
    "manifest_applied",
    "manifest_rolled_back",
    "self_modification_complete",
    "self_modification_failed",
    "reflection_complete",
    "plan_updated",
    "agent_assigned",
    "agent_complete",
    "error_pattern_alert",
    "feedback_submitted",
    "model_updated",
    "model_validation_failed",
    "trajectory_collected",
    "alignment_updated",
    "review_due",
    "risk_guard_failed",
    "risk_guard_warning",
    # Engine-Telemetrie (P1 Live-UDS-Feed -> frontend/src/ops/hooks/useMarketData.ts).
    # Die Feldnamen sind der Wire-Vertrag; TELEMETRY_PAYLOAD_FIELDS ist die
    # maschinell gepruefte Quelle dafuer.
    "microstructure_tick",
    "gravity_tick",
    "regime_tick",
]

#: Wire-Vertrag der Engine-Telemetrie: event_kind -> Pflichtfelder.
#: Ein Payload, dem ein Feld fehlt oder dessen Feld kein endlicher Zahlenwert
#: ist, wird abgewiesen -- bevor er auf dem Bus landet, nicht erst im Client.
TELEMETRY_PAYLOAD_FIELDS = {
    "microstructure_tick": ("imbalance_ratio", "depth_2pct", "footprint_delta"),
    "gravity_tick": ("l2_depth", "l3_iceberg", "polymarket_prob", "v_total"),
    "regime_tick": ("cluster_id", "confidence", "is_forbidden_zone"),
}


def _is_finite_number(value):
    """Endliche Zahl -- ``bool`` gilt ausdruecklich nicht (``isinstance(True, int)``)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def validate_telemetry_payload(event_kind, payload):
    """Prueft einen Engine-Payload gegen den Wire-Vertrag.

    Liefert ``(ok, fehler)``. Fail-closed: lieber ein verworfenes Event als ein
    halb gefuelltes Widget, das einen Wert vorgaukelt, den keine Engine
    geliefert hat. Ein Feld ist entweder eine endliche Zahl oder ein nicht
    leerer Vektor endlicher Zahlen (``footprint_delta``).
    """
    required = TELEMETRY_PAYLOAD_FIELDS.get(event_kind)
    if required is None:
        return False, "event_kind %r ist kein Telemetrie-Event" % (event_kind,)
    if not isinstance(payload, dict):
        return False, "Payload ist kein Objekt"
    for field in required:
        if field not in payload:
            return False, "Pflichtfeld %r fehlt" % (field,)
        value = payload[field]
        if _is_finite_number(value):
            continue
        if isinstance(value, (list, tuple)) and value and all(_is_finite_number(v) for v in value):
            continue
        return False, "Feld %r ist weder endliche Zahl noch Vektor endlicher Zahlen (gefunden: %r)" % (
            field, value if not isinstance(value, (list, tuple)) else "%s[%d]" % (type(value).__name__, len(value)))
    return True, ""


class EventBus:
    """NDJSON event emission: stderr, file sink (runtime/system.log), optional UDS/shared-memory."""

    def __init__(self, system_log_path: str = "Architect/runtime/system.log"):
        self.system_log_path = Path(system_log_path)
        self.system_log_path.parent.mkdir(parents=True, exist_ok=True)
        self.event_sinks = {"stderr": True, "file": True}
        # Phase 3: optional advanced sinks (UDS, shared-memory ring) not fully implemented
        # Divergence preserved: events are NDJSON-based, matching blueprint spec (§6)
        # but transport uses file + stderr rather than shared-memory ring (to align with Jules's architecture)

    def emit(self, event_dict: dict):
        """Validate and emit an event to all active sinks."""
        event_kind = event_dict.get("event_kind", "")
        if event_kind not in VALID_EVENT_KINDS:
            logger.error("Event kind '%s' not in VALID_EVENT_KINDS whitelist; event rejected.", event_kind)
            return False

        # Enrich with timestamp and clock_s if missing
        if "timestamp" not in event_dict:
            event_dict["timestamp"] = datetime.datetime.utcnow().isoformat() + "Z"
        if "clock_s" not in event_dict:
            event_dict["clock_s"] = None  # Will be bound by orchestrator/job clock

        # Serialize to compact NDJSON (machine format, matching blueprint optimization)
        event_line = json.dumps(event_dict, separators=(",", ":"))

        # Sink 1: stderr (NDJSON stream)
        if self.event_sinks.get("stderr", False):
            import sys
            sys.stderr.write(event_line + "\n")
            sys.stderr.flush()

        # Sink 2: file sink (Phase 3: runtime/system.log)
        if self.event_sinks.get("file", False):
            try:
                with open(self.system_log_path, "a", encoding="utf-8") as f:
                    f.write(event_line + "\n")
            except Exception as exc:
                logger.error("Failed to write event to %s: %s", self.system_log_path, exc)

        logger.info("Event emitted: %s (kind=%s, job_id=%s)", event_dict.get("event_id"), event_kind, event_dict.get("job_id"))
        return True

    def build_event(self, event_kind: str, job_id: str = None, intent_id: str = None,
                    trace_id: str = None, limb: str = None, clock_s: float = None,
                    message: str = "", **extra) -> dict:
        """Build a validated event dictionary."""
        event_dict = {
            "event_id": f"evt_{datetime.datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{job_id or 'system'}",
            "event_kind": event_kind,
            "job_id": job_id,
            "intent_id": intent_id,
            "trace_id": trace_id,
            "limb": limb,
            "clock_s": clock_s,
            "message": message,
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        }
        event_dict.update(extra)
        return event_dict

    def build_telemetry_event(self, event_kind: str, payload: dict, job_id: str = None,
                              symbol: str = None, clock_s: float = None, **extra) -> dict:
        """Baut ein Engine-Telemetrie-Event und prueft es gegen den Wire-Vertrag.

        Wirft ``ValueError``, wenn der Payload unvollstaendig oder nicht numerisch
        ist -- der Aufrufer soll das hoeren, statt einen stillen Fehlbetrag auf
        den Bus zu schicken.
        """
        ok, reason = validate_telemetry_payload(event_kind, payload)
        if not ok:
            raise ValueError("Telemetrie-Payload fuer %s abgewiesen: %s" % (event_kind, reason))
        event_dict = self.build_event(event_kind, job_id=job_id, clock_s=clock_s,
                                      message="engine telemetry", **extra)
        if symbol is not None:
            event_dict["symbol"] = symbol
        event_dict["payload"] = payload
        return event_dict

    def emit_telemetry(self, event_kind: str, payload: dict, **kwargs) -> bool:
        """Bauen + senden in einem Schritt; ``False`` bei abgewiesenem Payload."""
        try:
            event_dict = self.build_telemetry_event(event_kind, payload, **kwargs)
        except ValueError as exc:
            logger.error("Telemetrie verworfen: %s", exc)
            return False
        return self.emit(event_dict)
