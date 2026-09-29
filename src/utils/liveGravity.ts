/**
 * Browser cache of the last gravity-worker snapshot. The paper worker writes
 * the same shape to `/api/gravity/state`; dashboards read it from here so the
 * vault and the field are not stuck on hardcoded numbers.
 */

import type { GravityParams } from './gravityMath';
import { DEFAULT_GRAVITY_PARAMS } from './gravityMath';

export type PolySource = 'gamma' | 'stale' | 'neutral';

export function readPolySource(value: unknown): PolySource {
  if (value === 'gamma' || value === 'stale' || value === 'neutral') return value;
  return 'neutral';
}

/** Neutral stays a plain percent. Gamma and stale name their source. */
export function polyConsensusText(prob: number, source: PolySource): string {
  const pct = `${(prob * 100).toFixed(0)}% Up`;
  switch (source) {
    case 'neutral':
      return pct;
    case 'gamma':
      return `${pct} · Gamma`;
    case 'stale':
      return `${pct} · stale`;
    default: {
      const unexpected: never = source;
      return unexpected;
    }
  }
}

export interface LiveFill {
  price: number;
  volume: number;
  side: 'buy' | 'sell';
}

export interface LiveOmegaSnapshot {
  updatedAt: string;
  spotPrice: number;
  l2: number;
  iceberg: number;
  poly: number;
  params: GravityParams;
  atr14: number | null;
  lastCandle: { open: number; high: number; low: number; close: number } | null;
  forbidden: boolean;
  band: { lower: number; upper: number } | null;
  equityUSD: number | null;
  pnlUSD: number | null;
  btcVolume: number | null;
  avgEntry: number | null;
  fills: LiveFill[];
  /** neutral is 0.5 with no ladder. gamma is a fresh density. stale is the last good ladder. */
  polySource: PolySource;
}

const listeners = new Set<(snapshot: LiveOmegaSnapshot) => void>();
let snapshot: LiveOmegaSnapshot | null = null;
let poller: ReturnType<typeof setInterval> | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readParams(raw: unknown): GravityParams {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GRAVITY_PARAMS };
  const row = raw as Record<string, unknown>;
  const wVis = isFiniteNumber(row.w_vis) ? row.w_vis : DEFAULT_GRAVITY_PARAMS.w_vis;
  const wBlind = isFiniteNumber(row.w_blind) ? row.w_blind : DEFAULT_GRAVITY_PARAMS.w_blind;
  const wPoly = isFiniteNumber(row.w_poly) ? row.w_poly : DEFAULT_GRAVITY_PARAMS.w_poly;
  const quantile = isFiniteNumber(row.quantile) ? row.quantile : DEFAULT_GRAVITY_PARAMS.quantile;
  const window = isFiniteNumber(row.history_window) ? row.history_window : DEFAULT_GRAVITY_PARAMS.history_window;
  return { w_vis: wVis, w_blind: wBlind, w_poly: wPoly, quantile, history_window: window };
}

export function parseGravityState(payload: unknown): LiveOmegaSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  const field = body.field;
  const row = field && typeof field === 'object' ? (field as Record<string, unknown>) : null;
  const mid = row && isFiniteNumber(row.mid) ? row.mid : 0;
  const candle = row?.candle;
  let lastCandle: LiveOmegaSnapshot['lastCandle'] = null;
  if (candle && typeof candle === 'object') {
    const c = candle as Record<string, unknown>;
    if (isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close)) {
      lastCandle = { open: c.open, high: c.high, low: c.low, close: c.close };
    }
  }
  const bandRaw = row?.band;
  let band: LiveOmegaSnapshot['band'] = null;
  if (bandRaw && typeof bandRaw === 'object') {
    const b = bandRaw as Record<string, unknown>;
    if (isFiniteNumber(b.lower) && isFiniteNumber(b.upper)) band = { lower: b.lower, upper: b.upper };
  }
  const paper = body.paper;
  let equityUSD: number | null = null;
  let pnlUSD: number | null = null;
  if (paper && typeof paper === 'object') {
    const p = paper as Record<string, unknown>;
    if (isFiniteNumber(p.currentValue)) equityUSD = p.currentValue;
    if (isFiniteNumber(p.unrealizedPnl)) pnlUSD = p.unrealizedPnl;
  }
  const fills: LiveFill[] = [];
  const rawFills = body.fills;
  if (Array.isArray(rawFills)) {
    for (const item of rawFills) {
      if (!item || typeof item !== 'object') continue;
      const f = item as Record<string, unknown>;
      if (!isFiniteNumber(f.price) || !isFiniteNumber(f.volume)) continue;
      fills.push({ price: f.price, volume: f.volume, side: f.side === 'sell' ? 'sell' : 'buy' });
    }
  }
  if (mid <= 0 && equityUSD == null) return null;
  return {
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString(),
    spotPrice: mid,
    l2: row && isFiniteNumber(row.l2) ? row.l2 : 0.5,
    iceberg: row && isFiniteNumber(row.iceberg) ? row.iceberg : 0.5,
    poly: row && isFiniteNumber(row.poly) ? row.poly : 0.5,
    params: readParams(row?.params),
    atr14: row && isFiniteNumber(row.atr14) ? row.atr14 : null,
    lastCandle,
    forbidden: row?.forbidden === true,
    band,
    equityUSD,
    pnlUSD,
    btcVolume: isFiniteNumber(body.btcVolume) ? body.btcVolume : null,
    avgEntry: isFiniteNumber(body.avgEntry) ? body.avgEntry : null,
    fills,
    polySource: readPolySource(row?.polySource ?? body.polySource),
  };
}

export function getLiveOmegaSnapshot(): LiveOmegaSnapshot | null {
  return snapshot;
}

export function setLiveOmegaSnapshot(next: LiveOmegaSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* a subscriber must not break the poller */
    }
  }
}

export function subscribeLiveGravity(listener: (snapshot: LiveOmegaSnapshot) => void): () => void {
  listeners.add(listener);
  if (snapshot) listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/gravity/state');
    if (!res.ok) return;
    const parsed = parseGravityState(await res.json());
    if (parsed) setLiveOmegaSnapshot(parsed);
  } catch {
    /* keep the last snapshot */
  }
}

/** Start the 15s poll in the browser. No-op on the server. */
export function ensureLiveGravityPoller(): void {
  if (poller || typeof window === 'undefined') return;
  void refresh();
  poller = setInterval(() => {
    void refresh();
  }, 15_000);
}
