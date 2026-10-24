/**
 * [Blanche] — reference price selection with **no fallback path**.
 *
 * The Paragraph 2 ledger records prices, so it may only ever use a genuinely
 * observed exchange value. This module is the single gate for that rule:
 *
 *   · a fresh live quote            → LIVE_TICK   (preferred: current quote)
 *   · a fresh venue bar close       → BAR_CLOSE   (real price, bar cadence)
 *   · nothing fresh                 → null        (caller must NOT snapshot)
 *
 * There is deliberately no third branch: no built-in constant, no last-known
 * value, no interpolation. A stale quote is treated exactly like a missing one,
 * because a stale price is still a fabricated price for the current instant.
 */

import type { Bar } from './featureEngine';
import type { LiveSpotObservation } from '../../utils/liveSpot';

export type ReferenceSource = 'LIVE_TICK' | 'BAR_CLOSE';

export interface ReferencePrice {
  price: number;
  source: ReferenceSource;
  /** Exchange timestamp of the observation itself. */
  observedAtMs: number;
  /** now − observedAtMs. */
  ageMs: number;
}

export interface ReferenceInput {
  observation: LiveSpotObservation | null;
  /** Newest 1-minute bar of the merged history, if any. */
  lastBar: Bar | null;
  nowMs: number;
  /** Maximum accepted staleness (ms). Defaults to the feed tolerance. */
  maxAgeMs: number;
  barIntervalMs?: number;
}

/**
 * Picks the freshest *real* observation, or null when neither source is fresh
 * enough. `null` is a first-class outcome — the UI shows "keine Live-Daten" and
 * the comparison queue takes over instead of a price being invented.
 */
export function selectReferencePrice(input: ReferenceInput): ReferencePrice | null {
  const { observation, lastBar, nowMs, maxAgeMs } = input;
  const barIntervalMs = input.barIntervalMs ?? 60_000;
  const isUsable = (candidate: ReferencePrice | null): candidate is ReferencePrice =>
    candidate !== null &&
    candidate.ageMs >= -MAX_FUTURE_DRIFT_MS &&
    candidate.ageMs <= maxAgeMs;

  const liveCandidate: ReferencePrice | null =
    observation && Number.isFinite(observation.price) && observation.price > 0
      ? {
          price: observation.price,
          source: 'LIVE_TICK',
          observedAtMs: observation.updatedAtMs,
          ageMs: nowMs - observation.updatedAtMs,
        }
      : null;

  // A bar's close is the last observed price inside that minute.
  const barCloseMs = lastBar ? lastBar.tsMs + barIntervalMs : null;
  const barCandidate: ReferencePrice | null =
    lastBar && barCloseMs !== null && Number.isFinite(lastBar.close) && lastBar.close > 0
      ? {
          price: lastBar.close,
          source: 'BAR_CLOSE',
          observedAtMs: barCloseMs,
          ageMs: nowMs - barCloseMs,
        }
      : null;

  // A fresh live quote always wins: it is an actual current price for this
  // instant, while a bar close happened somewhere inside its minute. The bar is
  // the fallback path when the live route is stale or unavailable.
  if (isUsable(liveCandidate)) return liveCandidate;
  if (isUsable(barCandidate)) return barCandidate;
  return null;
}

/** A clock-skewed "future" observation is tolerated only this far. */
const MAX_FUTURE_DRIFT_MS = 5_000;

export type FeedStatus = 'LIVE' | 'BAR_ONLY' | 'MISSING';

export function feedStatusOf(reference: ReferencePrice | null): FeedStatus {
  if (!reference) return 'MISSING';
  return reference.source === 'LIVE_TICK' ? 'LIVE' : 'BAR_ONLY';
}
