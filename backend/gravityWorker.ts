/**
 * Hourly paper worker. One closed 1h candle, the live book, and the learned
 * gravity parameters decide a single clip on the `nin-paper-gravity` ledger.
 * GET /api/gravity/state only reads. POST/GET /api/worker/gravity learns and,
 * when the Judge passes, sends the clip.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { KrakenOrderExecutor } from './kraken';
import { executionMode } from './kraken';
import { atr14, getClosedCandles, getOrderBook, type Candle } from './candles';
import { getJson, setJsonAwaited } from './stateStore';
import { engineTelemetryHub } from './telemetryEngine';
import {
  bookImbalance,
  computeForces,
  forbiddenBand,
  icebergRatio,
  isInForbiddenZone,
  l2Depth,
  type GravityParams,
} from '../src/utils/gravityMath';
import { GravityFieldLearner, type GravityLearnerJson } from '../src/utils/gravityLearner';
import { setLiveOmegaSnapshot, type LiveFill, type LiveOmegaSnapshot, type PolySource } from '../src/utils/liveGravity';
import { readPolymarket } from './polymarket';

export const GRAVITY_WORKSPACE = 'nin-paper-gravity';
const STATE_KEY = 'nin:gravity:learner';
const PAIR = 'BTCUSD';
const HISTORY_WINDOW = 120;
const CLIP_USD = Number(process.env.KRAKEN_GRAVITY_CLIP_USD || '25');
/** Net force, in price units times k, below which the field is treated as flat. */
const FORCE_MIN = 1;

interface StoredField {
  mid: number;
  l2: number;
  iceberg: number;
  poly: number;
  polySource: PolySource;
  params: GravityParams;
  atr14: number | null;
  candle: { open: number; high: number; low: number; close: number } | null;
  forbidden: boolean;
  band: { lower: number; upper: number } | null;
  vTotal: number;
  forceNet: number;
}

interface GravityStore {
  learner: GravityLearnerJson;
  lastCandleTime: number | null;
  field: StoredField | null;
  updatedAt: string;
}

type WorkerAction = 'BUY' | 'SELL' | 'FLAT' | 'FORBIDDEN' | 'HOLD_CANDLE' | 'NO_BOOK' | 'DISARMED';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

async function loadStore(): Promise<GravityStore | null> {
  return (await getJson<GravityStore>(STATE_KEY)) ?? memoryStore;
}

async function loadLearner(): Promise<{ learner: GravityFieldLearner; lastCandleTime: number | null; field: StoredField | null }> {
  const stored = await loadStore();
  if (stored?.learner) {
    try {
      return {
        learner: GravityFieldLearner.fromJSON(stored.learner),
        lastCandleTime: typeof stored.lastCandleTime === 'number' ? stored.lastCandleTime : null,
        field: stored.field ?? null,
      };
    } catch {
      /* a corrupt blob starts a fresh learner; the paper ledger is untouched */
    }
  }
  return { learner: new GravityFieldLearner(), lastCandleTime: null, field: null };
}

let memoryStore: GravityStore | null = null;

async function saveStore(learner: GravityFieldLearner, lastCandleTime: number | null, field: StoredField | null): Promise<void> {
  const payload: GravityStore = {
    learner: learner.toJSON(),
    lastCandleTime,
    field,
    updatedAt: new Date().toISOString(),
  };
  memoryStore = payload;
  await setJsonAwaited(STATE_KEY, payload);
}

function publish(snapshot: LiveOmegaSnapshot, imbalance: number): void {
  setLiveOmegaSnapshot(snapshot);
  const symbol = 'BTC/USD';
  engineTelemetryHub.emitGravityTick(symbol, snapshot.l2, snapshot.iceberg, snapshot.poly, snapshot.params.w_vis * snapshot.l2 + snapshot.params.w_blind * snapshot.iceberg + snapshot.params.w_poly * snapshot.poly, {
    w_vis: snapshot.params.w_vis,
    w_blind: snapshot.params.w_blind,
    w_poly: snapshot.params.w_poly,
    mid_price: snapshot.spotPrice,
    quantile: snapshot.params.quantile,
  });
  engineTelemetryHub.emitRegimeTick(symbol, 0, Math.min(1, Math.abs(imbalance - 0.5) * 2), snapshot.forbidden ? 1 : 0);
  const footprint = snapshot.lastCandle
    ? [snapshot.lastCandle.close - snapshot.lastCandle.open]
    : [0];
  engineTelemetryHub.emitMicrostructureTick(symbol, imbalance - 0.5, snapshot.l2, footprint);
}

function sourceOf(field: { polySource?: unknown } | null | undefined): PolySource {
  const value = field?.polySource;
  if (value === 'gamma' || value === 'stale' || value === 'neutral') return value;
  return 'neutral';
}

function snapshotFrom(
  field: StoredField,
  paper: { currentValue: number | null; unrealizedPnl: number | null } | null,
  fills: LiveFill[],
  btcVolume: number | null,
  avgEntry: number | null,
): LiveOmegaSnapshot {
  return {
    updatedAt: new Date().toISOString(),
    spotPrice: field.mid,
    l2: field.l2,
    iceberg: field.iceberg,
    poly: field.poly,
    params: field.params,
    atr14: field.atr14,
    lastCandle: field.candle,
    forbidden: field.forbidden,
    band: field.band,
    equityUSD: paper?.currentValue ?? null,
    pnlUSD: paper?.unrealizedPnl ?? null,
    btcVolume,
    avgEntry,
    fills,
    polySource: sourceOf(field),
  };
}

function weightedEntry(fills: LiveFill[]): number | null {
  let cost = 0;
  let vol = 0;
  for (const fill of fills) {
    if (fill.side !== 'buy') continue;
    cost += fill.price * fill.volume;
    vol += fill.volume;
  }
  if (!(vol > 0)) return null;
  return cost / vol;
}

export async function readGravityState(executor: KrakenOrderExecutor): Promise<Record<string, unknown>> {
  const stored = await loadStore();
  const [paper, fills] = await Promise.all([
    executor.paperWorkspaceReport(GRAVITY_WORKSPACE),
    executor.paperFills(GRAVITY_WORKSPACE),
  ]);
  const liveFills: LiveFill[] = fills.map((fill) => ({
    price: fill.price,
    volume: fill.volume,
    side: fill.side,
  }));
  const btc = await executor.paperAssetBalance(GRAVITY_WORKSPACE, 'BTC');
  return {
    ready: Boolean(stored?.field),
    updatedAt: stored?.updatedAt ?? null,
    executionMode: executionMode(),
    workspace: GRAVITY_WORKSPACE,
    field: stored?.field ? { ...stored.field, polySource: sourceOf(stored.field) } : null,
    learner: stored?.learner
      ? {
          w_vis: stored.learner.weights[0],
          w_blind: stored.learner.weights[1],
          w_poly: stored.learner.weights[2],
          quantile: stored.learner.quantile,
          weight_updates: stored.learner.weight_updates,
          pending: stored.learner.pending.length,
        }
      : null,
    paper,
    fills: liveFills,
    btcVolume: btc,
    avgEntry: weightedEntry(liveFills),
    polySource: sourceOf(stored?.field),
  };
}

export async function runGravityWorker(executor: KrakenOrderExecutor): Promise<Record<string, unknown>> {
  if (executionMode() === 'real' && process.env.KRAKEN_GRAVITY_LIVE !== 'true') {
    return { ran: false, action: 'DISARMED' as WorkerAction, reason: 'REAL_MODE_DISARMED' };
  }

  const { learner, lastCandleTime } = await loadLearner();
  const candles = await getClosedCandles(PAIR, 60, HISTORY_WINDOW);
  const book = await getOrderBook(PAIR, 25);
  const last: Candle | undefined = candles[candles.length - 1];
  const midFromBook = book && book.bids[0] && book.asks[0] ? (book.bids[0].price + book.asks[0].price) / 2 : null;
  const mid = midFromBook ?? last?.close ?? null;
  if (mid == null || !last) {
    return { ran: false, action: 'NO_BOOK' as WorkerAction, reason: 'NO_MARKET_DATA' };
  }

  const l2 = book ? l2Depth(book.bids, book.asks, mid) : 0.5;
  const iceberg = book ? icebergRatio(book.bids, book.asks) : 0.5;
  const polySnap = await readPolymarket(mid);
  const poly = polySnap.poly;
  const polySource = polySnap.polySource;
  const imbalance = book ? bookImbalance(book.bids, book.asks, mid) : 0.5;
  const closes = candles.map((candle) => candle.close);
  const learnedBefore = learner.params();
  const historyReady = closes.length >= 2;
  const forbidden = historyReady && isInForbiddenZone(mid, closes, learnedBefore.quantile, HISTORY_WINDOW);

  let observed = false;
  if (last.time !== lastCandleTime) {
    observed = learner.observe({
      l2_depth: l2,
      l3_iceberg: iceberg,
      polymarket_prob: poly,
      mid_price: last.close,
      is_forbidden_zone: historyReady ? forbidden : undefined,
    });
  }

  const learned = learner.params();
  const params: GravityParams = {
    w_vis: learned.w_vis,
    w_blind: learned.w_blind,
    w_poly: learned.w_poly,
    quantile: learned.quantile,
    history_window: HISTORY_WINDOW,
  };
  const band = historyReady ? forbiddenBand(closes, params.quantile, HISTORY_WINDOW) : null;
  const forces = computeForces(mid, mid, l2, iceberg, poly, params);
  const atr = atr14(candles);

  const field: StoredField = {
    mid,
    l2,
    iceberg,
    poly,
    polySource,
    params,
    atr14: atr,
    candle: { open: last.open, high: last.high, low: last.low, close: last.close },
    forbidden,
    band,
    vTotal: forces.vTotal,
    forceNet: forces.fNet,
  };

  let action: WorkerAction = 'FLAT';
  let order: Record<string, unknown> | null = null;
  if (last.time === lastCandleTime) {
    action = 'HOLD_CANDLE';
  } else if (!book) {
    action = 'NO_BOOK';
  } else if (forbidden) {
    action = 'FORBIDDEN';
  } else if (forces.fNet > FORCE_MIN || forces.fNet < -FORCE_MIN) {
    const side: 'buy' | 'sell' = forces.fNet > 0 ? 'buy' : 'sell';
    const usd = await executor.paperAssetBalance(GRAVITY_WORKSPACE, 'USD');
    const btc = await executor.paperAssetBalance(GRAVITY_WORKSPACE, 'BTC');
    const clip = Number.isFinite(CLIP_USD) && CLIP_USD > 0 ? CLIP_USD : 25;
    const volume = Number((clip / mid).toFixed(8));
    const canBuy = side === 'buy' && usd != null && usd >= clip;
    const canSell = side === 'sell' && btc != null && btc * mid >= clip && btc >= volume;
    if (canBuy || canSell) {
      action = side === 'buy' ? 'BUY' : 'SELL';
      order = await executor.executeOrder(
        { pair: PAIR, type: side, ordertype: 'market', volume },
        { limb: 6, name: 'gravity' },
      );
      if (order.success !== true) action = 'FLAT';
    }
  }

  const tradedCandle = last.time;
  await saveStore(learner, observed || action === 'HOLD_CANDLE' ? tradedCandle : lastCandleTime, field);

  const [paper, rawFills, btcVolume] = await Promise.all([
    executor.paperWorkspaceReport(GRAVITY_WORKSPACE),
    executor.paperFills(GRAVITY_WORKSPACE),
    executor.paperAssetBalance(GRAVITY_WORKSPACE, 'BTC'),
  ]);
  const fills: LiveFill[] = rawFills.map((fill) => ({ price: fill.price, volume: fill.volume, side: fill.side }));
  const snap = snapshotFrom(field, paper, fills, btcVolume, weightedEntry(fills));
  publish(snap, imbalance);

  const report = learner.params();
  return {
    ran: true,
    action,
    observed,
    candleTime: last.time,
    mid,
    l2,
    iceberg,
    poly,
    polySource,
    gateOpen: polySnap.gateOpen,
    forbidden,
    forceNet: Number(forces.fNet.toFixed(4)),
    vTotal: Number(forces.vTotal.toFixed(6)),
    params: report,
    order,
    paper,
    workspace: GRAVITY_WORKSPACE,
    executionMode: executionMode(),
  };
}

export async function handleGravityApi(
  req: IncomingMessage,
  res: ServerResponse,
  executor: KrakenOrderExecutor,
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = (req.url || '/').split('?')[0] || '/';
  if (url === '/api/gravity/state' && method === 'GET') {
    sendJson(res, 200, await readGravityState(executor));
    return true;
  }
  if (url === '/api/worker/gravity' && (method === 'GET' || method === 'POST')) {
    try {
      sendJson(res, 200, await runGravityWorker(executor));
    } catch (error) {
      sendJson(res, 500, { ran: false, error: String(error) });
    }
    return true;
  }
  return false;
}
