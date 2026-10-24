/**
 * [Blanche] — bar history feed.
 *
 * Ticks observed while the tab is open are far too few for bar-based features
 * (EMA200 needs 200 minutes). This feed backfills 1-minute bars from Kraken
 * through `/api/exchange/ohlc` on mount and every few minutes, then the hook
 * overlays the live ticks on top. If the route is unavailable the feed reports
 * `authoritative: false` and the caller degrades to a warm-up state instead of
 * pretending a 12-tick window is a 200-bar history.
 */

import { BAR_INTERVAL_MS, resampleToBars, type Bar, type PriceTick } from './featureEngine';

export const HISTORY_REFRESH_MS = 180_000;
/** Beyond this age the backfilled history is considered stale and is flagged. */
export const HISTORY_MAX_AGE_MS = 600_000;

/**
 * Two independent feeds feed the frame: Kraken OHLC bars and the live spot
 * price (Kraken tickers or CoinGecko). If they disagree by more than this,
 * overlaying the live price would inject a phantom jump into ATR / volatility /
 * regime detection (and could fake a HIGH_VOL_CRISIS). Such a bar is dropped
 * and reported instead of being silently absorbed.
 */
export const FEED_GAP_TOLERANCE_PERCENT = 3;

export interface HistoryState {
  bars: Bar[];
  authoritative: boolean;
  source: 'KRAKEN' | 'UNAVAILABLE';
  fetchedAtMs: number | null;
  error: string | null;
  isLoading: boolean;
}

export const emptyHistory = (): HistoryState => ({
  bars: [],
  authoritative: false,
  source: 'UNAVAILABLE',
  fetchedAtMs: null,
  error: null,
  isLoading: false,
});

interface OhlcPayload {
  source?: string;
  authoritative?: boolean;
  intervalMinutes?: number;
  bars?: Array<{ tsMs?: number; open?: number; high?: number; low?: number; close?: number }>;
  error?: string;
}

export async function fetchHistoryBars(
  fetcher: typeof fetch = fetch
): Promise<HistoryState> {
  try {
    const response = await fetcher('/api/exchange/ohlc?pair=XBTUSD&interval=1', {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as OhlcPayload;
    const raw = Array.isArray(payload.bars) ? payload.bars : [];
    const bars: Bar[] = raw
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
      );

    return {
      bars,
      authoritative: Boolean(payload.authoritative) && bars.length > 0,
      source: payload.source === 'KRAKEN' && bars.length > 0 ? 'KRAKEN' : 'UNAVAILABLE',
      fetchedAtMs: Date.now(),
      error: bars.length === 0 ? payload.error ?? 'Keine OHLC-Historie verfügbar.' : null,
      isLoading: false,
    };
  } catch (error) {
    return {
      ...emptyHistory(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface MergedBars {
  bars: Bar[];
  /** Absolute divergence (%) between the last history close and the live price. */
  gapPercent: number | null;
  /** True when the live overlay was rejected because the feeds disagree. */
  gapRejected: boolean;
}

/**
 * Merges historical bars with bars resampled from live ticks. Live ticks win
 * for the overlapping bucket, so the most recent bar is the freshest observed
 * price rather than the last OHLC close — unless the two feeds materially
 * disagree, in which case the live overlay is rejected (never interpolated).
 */
export function mergeBarsWithQuality(
  historyBars: readonly Bar[],
  liveTicks: readonly PriceTick[]
): MergedBars {
  const liveBars = resampleToBars(liveTicks, BAR_INTERVAL_MS);
  if (historyBars.length === 0) {
    return { bars: liveBars, gapPercent: null, gapRejected: false };
  }
  if (liveBars.length === 0) {
    return { bars: [...historyBars], gapPercent: null, gapRejected: false };
  }

  const lastHistoryClose = historyBars[historyBars.length - 1].close;
  const lastLiveClose = liveBars[liveBars.length - 1].close;
  const gapPercent =
    lastHistoryClose > 0 ? ((lastLiveClose - lastHistoryClose) / lastHistoryClose) * 100 : null;

  if (gapPercent !== null && Math.abs(gapPercent) > FEED_GAP_TOLERANCE_PERCENT) {
    return { bars: [...historyBars], gapPercent, gapRejected: true };
  }
  return { bars: mergeBarSeries(historyBars, liveBars), gapPercent, gapRejected: false };
}

function mergeBarSeries(historyBars: readonly Bar[], liveBars: readonly Bar[]): Bar[] {

  const merged = new Map<number, Bar>();
  for (const bar of historyBars) merged.set(bar.tsMs, bar);
  for (const bar of liveBars) {
    const existing = merged.get(bar.tsMs);
    merged.set(
      bar.tsMs,
      existing
        ? {
            tsMs: bar.tsMs,
            open: existing.open,
            high: Math.max(existing.high, bar.high),
            low: Math.min(existing.low, bar.low),
            close: bar.close,
          }
        : bar
    );
  }
  return [...merged.values()].sort((a, b) => a.tsMs - b.tsMs);
}

/** Convenience wrapper without the quality metadata. */
export function mergeBars(historyBars: readonly Bar[], liveTicks: readonly PriceTick[]): Bar[] {
  return mergeBarsWithQuality(historyBars, liveTicks).bars;
}
