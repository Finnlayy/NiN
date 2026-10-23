/**
 * Deterministic REPLAY data — strictly for UI demonstration.
 *
 * Replay records are written to the same append-only ledger but tagged
 * `origin: 'REPLAY'`, are excluded from every LIVE aggregate and from the
 * Kraken paper graduation, and are rendered with an explicit "REPLAY" badge.
 * They can never masquerade as realised live performance.
 */

import { EVALUATION_HORIZONS, HORIZON_MS, type HorizonMinutes, type SnapshotOrigin } from './types';
import { buildFeatureFrame, buildThreeComponentState, type PriceTick } from './featureEngine';
import { computeResolution } from './evaluation';
import {
  appendResolution,
  appendSnapshot,
  createSnapshot,
  type HorizonLedger,
} from './snapshotStore';

export interface ReplaySeedOptions {
  nowExchangeMs: number;
  anchorPrice: number;
  seed?: number;
  hours?: number;
  snapshotIntervalMinutes?: number;
}

export interface ReplaySeedResult {
  ledger: HorizonLedger;
  snapshots: number;
  resolutions: number;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK_INTERVAL_MS = 60_000;

function generateTicks(options: Required<Pick<ReplaySeedOptions, 'nowExchangeMs' | 'anchorPrice' | 'seed' | 'hours'>>): PriceTick[] {
  const { nowExchangeMs, anchorPrice, seed, hours } = options;
  const random = mulberry32(seed);
  const count = Math.floor((hours * 3_600_000) / TICK_INTERVAL_MS) + 1;
  const startMs = nowExchangeMs - (count - 1) * TICK_INTERVAL_MS;

  let price = anchorPrice;
  const ticks: PriceTick[] = [];
  for (let i = 0; i < count; i += 1) {
    // Trend regimes with autocorrelated drift (period ~400 min) plus a faster
    // ~180 min component — realistic crypto trend persistence. It is deliberate: it gives momentum
    // features something real to latch onto so the demo shows how the
    // accuracy/ranking pipeline behaves when a horizon genuinely proves
    // itself. Volatility clusters via the |drift| term.
    const slow = Math.sin((i / 400) * Math.PI * 2 + 0.7);
    const fast = Math.sin((i / 180) * Math.PI * 2 + 2.1);
    const drift = 0.00042 * (0.7 * slow + 0.3 * fast);
    const volatility = 0.0005 * (1 + 0.6 * Math.abs(slow));
    const shock = (random() + random() - 1) * volatility;
    price = price * (1 + drift + shock);
    ticks.push({ tsMs: startMs + i * TICK_INTERVAL_MS, price: Number(price.toFixed(2)) });
  }

  // Re-anchor the series so the newest tick equals the live reference price.
  const scale = anchorPrice / ticks[ticks.length - 1].price;
  return ticks.map((tick) => ({
    tsMs: tick.tsMs,
    price: Number((tick.price * scale).toFixed(2)),
  }));
}

function priceAt(ticks: readonly PriceTick[], tsMs: number): number | null {
  if (ticks.length === 0) return null;
  if (tsMs <= ticks[0].tsMs) return ticks[0].price;
  if (tsMs >= ticks[ticks.length - 1].tsMs) return ticks[ticks.length - 1].price;
  for (let i = 1; i < ticks.length; i += 1) {
    if (ticks[i].tsMs >= tsMs) {
      const previous = ticks[i - 1];
      const current = ticks[i];
      const span = current.tsMs - previous.tsMs;
      const ratio = span === 0 ? 0 : (tsMs - previous.tsMs) / span;
      return Number((previous.price + (current.price - previous.price) * ratio).toFixed(2));
    }
  }
  return ticks[ticks.length - 1].price;
}

/** Removes every REPLAY record, leaving LIVE history untouched. */
export function stripReplayRecords(ledger: HorizonLedger): HorizonLedger {
  return {
    ...ledger,
    snapshots: ledger.snapshots.filter((snapshot) => snapshot.origin !== ('REPLAY' as SnapshotOrigin)),
    resolutions: ledger.resolutions.filter(
      (resolution) => resolution.origin !== ('REPLAY' as SnapshotOrigin)
    ),
  };
}

/**
 * Seeds a deterministic replay history into the ledger. Existing LIVE records
 * are preserved; previous REPLAY records are replaced.
 */
export function seedReplayLedger(
  ledger: HorizonLedger,
  options: ReplaySeedOptions
): ReplaySeedResult {
  const nowExchangeMs = Math.round(options.nowExchangeMs);
  const hours = options.hours ?? 6;
  const snapshotInterval = options.snapshotIntervalMinutes ?? 20;
  const ticks = generateTicks({
    nowExchangeMs,
    anchorPrice: options.anchorPrice,
    seed: options.seed ?? 0x5eed,
    hours,
  });

  let working = stripReplayRecords(ledger);
  let snapshots = 0;
  let resolutions = 0;

  const horizonWindowMs = hours * 3_600_000;
  const firstSnapshotMs =
    nowExchangeMs - horizonWindowMs + Math.max(snapshotInterval, 40) * 60_000;

  for (
    let t0 = firstSnapshotMs;
    t0 <= nowExchangeMs - 2 * 60_000;
    t0 += snapshotInterval * 60_000
  ) {
    const ticksSoFar = ticks.filter((tick) => tick.tsMs <= t0);
    const frame = buildFeatureFrame(ticksSoFar);
    const price = priceAt(ticks, t0);
    if (!frame || price === null) continue;

    const components = buildThreeComponentState(frame, working.calibration);
    const snapshot = createSnapshot({
      t0ExchangeMs: t0,
      btcPriceAtT0: price,
      components,
      priceSource: 'BAR_CLOSE',
      origin: 'REPLAY',
      m8EngineStatus: 'ACTIVE',
    });
    const appended = appendSnapshot(working, snapshot);
    if (appended.error) continue;
    working = appended.ledger;
    snapshots += 1;

    for (const horizon of EVALUATION_HORIZONS) {
      const targetMs = t0 + HORIZON_MS(horizon);
      if (targetMs > nowExchangeMs) continue;
      const actualPrice = priceAt(ticks, targetMs);
      if (actualPrice === null) continue;
      const draft = computeResolution(snapshot, horizon as HorizonMinutes, actualPrice, targetMs);
      const resolved = appendResolution(working, draft, nowExchangeMs);
      if (resolved.error) continue;
      working = resolved.ledger;
      resolutions += 1;
    }
  }

  return { ledger: working, snapshots, resolutions };
}
