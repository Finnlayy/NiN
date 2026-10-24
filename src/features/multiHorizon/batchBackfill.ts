/**
 * [Noir] — offline comparison queue resolution.
 *
 * When the live feed drops out, matured horizons cannot be evaluated from
 * observed ticks. Instead of leaving them as dead orphans (the previous
 * behaviour) or inventing a price (never allowed), the widget queues them as
 * comparison jobs. As soon as the venue is reachable again **one** batch
 * request covers the whole missed window (`GET /api/exchange/ohlc/batch`), and
 * every queued target is matched against the real bar closes inside it.
 *
 * Matching rules:
 *   · a bar whose minute contains the target → its close is the first observed
 *     price at/after the target;
 *   · a bar starting within `BACKFILL_BAR_SLACK_MS` after the target → accepted;
 *   · no bar at all (hole in the venue history) → the job becomes
 *     `unresolvable` with an explicit reason. Nothing is interpolated.
 */

import {
  BACKFILL_BAR_SLACK_MS,
  MAX_BACKFILL_WINDOW_MS,
} from './config';
import { computeResolution } from './evaluation';
import type { Bar } from './featureEngine';
import {
  appendResolution,
  transitionJobs,
  type HorizonLedger,
} from './snapshotStore';
import type { ComparisonJob } from './types';

export const BATCH_ENDPOINT = '/api/exchange/ohlc/batch';
const BAR_INTERVAL_MS = 60_000;

export interface BatchBarsResult {
  bars: Bar[];
  authoritative: boolean;
  requestedFromMs: number;
  requestedToMs: number;
  latencyMs: number;
  error: string | null;
}

interface BatchPayload {
  source?: string;
  authoritative?: boolean;
  bars?: Array<{ tsMs?: number; open?: number; high?: number; low?: number; close?: number }>;
  error?: string;
  latencyMs?: number;
}

/**
 * One request for the entire missed window. The server pages through Kraken's
 * OHLC history internally, so the widget never issues a request per data point.
 */
export async function fetchBatchBars(
  fromMs: number,
  toMs: number,
  fetcher: typeof fetch = fetch
): Promise<BatchBarsResult> {
  const requestedFromMs = Math.round(fromMs);
  const requestedToMs = Math.round(toMs);
  const startedAt = Date.now();

  if (!Number.isFinite(requestedFromMs) || !Number.isFinite(requestedToMs) || requestedToMs <= requestedFromMs) {
    return {
      bars: [],
      authoritative: false,
      requestedFromMs,
      requestedToMs,
      latencyMs: 0,
      error: 'Leeres Backfill-Fenster.',
    };
  }

  const query = new URLSearchParams({
    pair: 'XBTUSD',
    interval: '1',
    from: String(requestedFromMs),
    to: String(requestedToMs),
  });

  try {
    const response = await fetcher(`${BATCH_ENDPOINT}?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as BatchPayload;
    const bars: Bar[] = (Array.isArray(payload.bars) ? payload.bars : [])
      .map((bar) => ({
        tsMs: Number(bar.tsMs),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
      }))
      .filter(
        (bar) =>
          Number.isFinite(bar.tsMs) &&
          Number.isFinite(bar.close) &&
          bar.close > 0 &&
          Number.isFinite(bar.open)
      )
      .sort((a, b) => a.tsMs - b.tsMs);

    return {
      bars,
      authoritative: Boolean(payload.authoritative) && bars.length > 0,
      requestedFromMs,
      requestedToMs,
      latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : Date.now() - startedAt,
      error: bars.length === 0 ? payload.error ?? 'Keine Bars im Backfill-Fenster.' : null,
    };
  } catch (error) {
    return {
      bars: [],
      authoritative: false,
      requestedFromMs,
      requestedToMs,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface BarMatch {
  bar: Bar;
  /** Exchange timestamp of the observation used (the bar close). */
  observedAtMs: number;
}

/**
 * Finds the observation for one target: the bar that contains the target
 * minute, else the first bar starting shortly after it. Returns null on a hole.
 */
export function matchBarToTarget(
  targetMs: number,
  bars: readonly Bar[],
  intervalMs = BAR_INTERVAL_MS
): BarMatch | null {
  for (const bar of bars) {
    if (bar.tsMs <= targetMs && targetMs < bar.tsMs + intervalMs) {
      return { bar, observedAtMs: bar.tsMs + intervalMs };
    }
  }
  for (const bar of bars) {
    if (bar.tsMs >= targetMs && bar.tsMs - targetMs <= BACKFILL_BAR_SLACK_MS) {
      return { bar, observedAtMs: bar.tsMs + intervalMs };
    }
  }
  return null;
}

/** Window a batch request has to cover for the given jobs. */
export function backfillWindow(jobs: readonly ComparisonJob[], nowExchangeMs: number): { fromMs: number; toMs: number } | null {
  const queued = jobs.filter((job) => job.status === 'queued');
  if (queued.length === 0) return null;
  const earliest = Math.min(...queued.map((job) => job.targetMs));
  const latest = Math.max(...queued.map((job) => job.targetMs));
  const fromMs = Math.max(earliest - BAR_INTERVAL_MS, nowExchangeMs - MAX_BACKFILL_WINDOW_MS);
  return { fromMs, toMs: Math.min(Math.max(latest + BAR_INTERVAL_MS, fromMs + BAR_INTERVAL_MS), nowExchangeMs) };
}

export interface FlushResult {
  ledger: HorizonLedger;
  resolved: number;
  unresolvable: number;
  skipped: number;
}

/**
 * Resolves as many queued comparisons as the fetched bars allow.
 *
 * Point-in-time rules preserved:
 *   · the snapshot is never touched (the resolution is a separate record);
 *   · a job only resolves once its target has matured;
 *   · the recorded observation is the real bar close, and the record is marked
 *     `verification: 'BATCH_BACKFILL'` so the audit trail distinguishes it from
 *     a live-tick resolution.
 */
export function resolveQueuedJobs(
  ledger: HorizonLedger,
  bars: readonly Bar[],
  nowExchangeMs: number
): FlushResult {
  const queued = ledger.jobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.targetMs - b.targetMs);
  if (queued.length === 0) return { ledger, resolved: 0, unresolvable: 0, skipped: 0 };

  let working = ledger;
  const resolvedTransitions: Array<Parameters<typeof transitionJobs>[1][number]> = [];
  const failedTransitions: Array<Parameters<typeof transitionJobs>[1][number]> = [];
  let resolved = 0;
  let unresolvable = 0;
  let skipped = 0;

  for (const job of queued) {
    if (nowExchangeMs < job.targetMs) {
      skipped += 1;
      continue;
    }
    const snapshot = working.snapshots.find((entry) => entry.id === job.snapshotId);
    if (!snapshot) {
      failedTransitions.push({
        id: job.id,
        status: 'unresolvable',
        attempts: job.attempts + 1,
        lastAttemptExchangeMs: nowExchangeMs,
        lastError: 'Snapshot nicht im Ledger — Vergleich nicht belegbar.',
      });
      unresolvable += 1;
      continue;
    }

    const match = matchBarToTarget(job.targetMs, bars);
    if (!match) {
      // Keep it queued unless the whole window has already been requested and
      // still has no bar: then the venue history genuinely has a hole.
      if (bars.length > 0 && bars[bars.length - 1].tsMs + BAR_INTERVAL_MS >= job.targetMs + BACKFILL_BAR_SLACK_MS) {
        failedTransitions.push({
          id: job.id,
          status: 'unresolvable',
          attempts: job.attempts + 1,
          lastAttemptExchangeMs: nowExchangeMs,
          lastError: `Keine Börsen-Bar im Zielminute ${new Date(job.targetMs).toISOString()} — keine Schätzung.`,
        });
        unresolvable += 1;
      } else {
        failedTransitions.push({
          id: job.id,
          status: 'queued',
          attempts: job.attempts + 1,
          lastAttemptExchangeMs: nowExchangeMs,
          lastError: 'Backfill-Fenster deckt das Ziel noch nicht ab.',
        });
        skipped += 1;
      }
      continue;
    }

    const draft = computeResolution(snapshot, job.horizonMinutes, match.bar.close, match.observedAtMs, {
      observedAtExchangeMs: match.observedAtMs,
      verifiedAtExchangeMs: nowExchangeMs,
      verification: 'BATCH_BACKFILL',
    });
    const appended = appendResolution(working, draft, nowExchangeMs);
    if (appended.error) {
      // Another path already resolved it (or it is immature): close the job out.
      failedTransitions.push({
        id: job.id,
        status: 'resolved',
        attempts: job.attempts + 1,
        lastAttemptExchangeMs: nowExchangeMs,
        lastError: appended.error.message,
      });
      continue;
    }
    working = appended.ledger;
    resolvedTransitions.push({
      id: job.id,
      status: 'resolved',
      attempts: job.attempts + 1,
      lastAttemptExchangeMs: nowExchangeMs,
      lastError: null,
    });
    resolved += 1;
  }

  working = transitionJobs(working, [...resolvedTransitions, ...failedTransitions]);
  return { ledger: working, resolved, unresolvable, skipped };
}

/** Human-readable queue summary for the widget. */
export function summariseQueue(jobs: readonly ComparisonJob[], nowExchangeMs: number): {
  queued: number;
  oldestTargetMs: number | null;
  oldestAgeMs: number | null;
  unresolvable: number;
  resolvedByBackfill: number;
  byHorizon: Array<{ horizonMinutes: number; queued: number }>;
} {
  const queued = jobs.filter((job) => job.status === 'queued');
  const oldest = queued.length > 0 ? Math.min(...queued.map((job) => job.targetMs)) : null;
  const byHorizonMap = new Map<number, number>();
  for (const job of queued) {
    byHorizonMap.set(job.horizonMinutes, (byHorizonMap.get(job.horizonMinutes) ?? 0) + 1);
  }
  return {
    queued: queued.length,
    oldestTargetMs: oldest,
    oldestAgeMs: oldest === null ? null : Math.max(0, nowExchangeMs - oldest),
    unresolvable: jobs.filter((job) => job.status === 'unresolvable').length,
    resolvedByBackfill: jobs.filter((job) => job.status === 'resolved').length,
    byHorizon: [...byHorizonMap.entries()]
      .map(([horizonMinutes, count]) => ({ horizonMinutes, queued: count }))
      .sort((a, b) => a.horizonMinutes - b.horizonMinutes),
  };
}
