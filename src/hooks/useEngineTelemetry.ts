import { useState, useEffect, useRef } from 'react';

export interface MicrostructurePayload {
  imbalance_ratio: number;
  depth_2pct: number;
  footprint_delta: number[];
}

export interface GravityPayload {
  l2_depth: number;
  l3_iceberg: number;
  polymarket_prob: number;
  v_total: number;
}

export interface RegimePayload {
  cluster_id: number;
  confidence: number;
  is_forbidden_zone: number;
}

export type TelemetryKind = 'microstructure_tick' | 'gravity_tick' | 'regime_tick';

export interface TelemetryRecord {
  kind: TelemetryKind;
  symbol: string;
  clock_s: number | null;
  timestamp: string;
  timestampNanos: string;
  payload: MicrostructurePayload | GravityPayload | RegimePayload;
}

export type FeedConnectionState = 'CONNECTED_LIVE' | 'STALE_CACHE_DEGRADED' | 'DISCONNECTED';

export interface TelemetryHubStatus {
  state: FeedConnectionState;
  lastAgeMs: number;
  ringCapacity: number;
  ringOccupancy: number;
  totalTicksEmitted: number;
  totalValidationErrors: number;
  activeListeners: number;
  wireContractCompliant: boolean;
}

const STALE_AFTER_MS = 3000;

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && !isNaN(val);
}

/** Fail-closed wire contract verification */
export function parseTelemetryRecord(raw: unknown): TelemetryRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const kind = obj.kind || obj.event_kind;
  if (kind !== 'microstructure_tick' && kind !== 'gravity_tick' && kind !== 'regime_tick') {
    return null;
  }

  const payload = obj.payload;
  if (!payload || typeof payload !== 'object') return null;
  const fields = payload as Record<string, unknown>;

  if (kind === 'microstructure_tick') {
    if (!isFiniteNumber(fields.imbalance_ratio) || !isFiniteNumber(fields.depth_2pct)) return null;
    const vec = fields.footprint_delta;
    if (!Array.isArray(vec) || vec.length === 0 || !vec.every(isFiniteNumber)) return null;
  } else if (kind === 'gravity_tick') {
    for (const k of ['l2_depth', 'l3_iceberg', 'polymarket_prob', 'v_total']) {
      if (!isFiniteNumber(fields[k])) return null;
    }
  } else if (kind === 'regime_tick') {
    for (const k of ['cluster_id', 'confidence', 'is_forbidden_zone']) {
      if (!isFiniteNumber(fields[k])) return null;
    }
  }

  return {
    kind,
    symbol: typeof obj.symbol === 'string' ? obj.symbol : 'BTC/USD',
    clock_s: isFiniteNumber(obj.clock_s) ? obj.clock_s : null,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString(),
    timestampNanos: typeof obj.timestampNanos === 'string' ? obj.timestampNanos : '0',
    payload: fields as unknown as TelemetryRecord['payload'],
  };
}

export function useEngineTelemetry() {
  const [connectionState, setConnectionState] = useState<FeedConnectionState>('DISCONNECTED');
  const [lastAgeMs, setLastAgeMs] = useState<number>(0);
  const [microstructure, setMicrostructure] = useState<MicrostructurePayload | null>({
    imbalance_ratio: 0.38,
    depth_2pct: 1350.0,
    footprint_delta: [12, 18, -4, 9, 22, -15, 8, 14, -7, 19, 25, 11],
  });
  const [gravity, setGravity] = useState<GravityPayload | null>({
    l2_depth: 0.82,
    l3_iceberg: 0.68,
    polymarket_prob: 0.52,
    v_total: 0.25 * 0.82 + 0.35 * 0.68 + 0.40 * 0.52,
  });
  const [regime, setRegime] = useState<RegimePayload | null>({
    cluster_id: 1,
    confidence: 0.94,
    is_forbidden_zone: 0,
  });
  const [recentRecords, setRecentRecords] = useState<TelemetryRecord[]>([]);
  const [validTicksCount, setValidTicksCount] = useState<number>(0);
  const [droppedTicksCount, setDroppedTicksCount] = useState<number>(0);

  const lastEventTimeRef = useRef<number>(Date.now());
  const eventSourceRef = useRef<EventSource | null>(null);

  // Stale age monitor interval
  useEffect(() => {
    const interval = setInterval(() => {
      const age = Date.now() - lastEventTimeRef.current;
      setLastAgeMs(age);
      if (age > STALE_AFTER_MS) {
        setConnectionState((prev) => (prev === 'CONNECTED_LIVE' ? 'STALE_CACHE_DEGRADED' : prev));
      }
    }, 500);

    return () => clearInterval(interval);
  }, []);

  // Connect SSE with fail-closed parser
  useEffect(() => {
    let active = true;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connect = () => {
      try {
        const es = new EventSource('/api/telemetry/stream');
        eventSourceRef.current = es;

        es.onopen = () => {
          if (!active) return;
          setConnectionState('CONNECTED_LIVE');
          lastEventTimeRef.current = Date.now();
        };

        es.onmessage = (e) => {
          if (!active) return;
          try {
            const parsed = parseTelemetryRecord(JSON.parse(e.data));
            if (!parsed) {
              setDroppedTicksCount((c) => c + 1);
              return;
            }

            lastEventTimeRef.current = Date.now();
            setConnectionState('CONNECTED_LIVE');
            setValidTicksCount((c) => c + 1);

            if (parsed.kind === 'microstructure_tick') {
              setMicrostructure(parsed.payload as MicrostructurePayload);
            } else if (parsed.kind === 'gravity_tick') {
              setGravity(parsed.payload as GravityPayload);
            } else if (parsed.kind === 'regime_tick') {
              setRegime(parsed.payload as RegimePayload);
            }

            setRecentRecords((prev) => [...prev.slice(-30), parsed]);
          } catch {
            setDroppedTicksCount((c) => c + 1);
          }
        };

        es.onerror = () => {
          if (!active) return;
          setConnectionState('DISCONNECTED');
          es.close();
          reconnectTimeout = setTimeout(connect, 3000);
        };
      } catch (err) {
        console.error('[useEngineTelemetry] Failed to instantiate EventSource:', err);
        setConnectionState('DISCONNECTED');
        reconnectTimeout = setTimeout(connect, 4000);
      }
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  return {
    connectionState,
    lastAgeMs,
    microstructure,
    gravity,
    regime,
    recentRecords,
    validTicksCount,
    droppedTicksCount,
    isForbiddenZone: regime?.is_forbidden_zone === 1,
  };
}
