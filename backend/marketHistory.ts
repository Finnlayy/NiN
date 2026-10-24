/**
 * Public market-history proxy (Kraken OHLC, no API key).
 *
 * Paragraph 2 features are bar-based: RSI(14) must cover 14 minutes,
 * EMA50/200 must cover 50/200 minutes, and the ATR percentile needs 100 bars.
 * A freshly opened browser tab has none of that history, so the widget
 * backfills 1-minute bars from Kraken through this route instead of computing
 * oscillators over a handful of ticks.
 *
 * The response is cached briefly and never fabricated: on failure the caller
 * receives an empty bar array plus `authoritative: false`, and the UI degrades
 * to a warm-up state.
 */

const KRAKEN_OHLC_URL = 'https://api.kraken.com/0/public/OHLC';
const CACHE_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 4_000;

/** Kraken returns at most 720 rows per OHLC call. */
const KRAKEN_MAX_ROWS = 720;
/** Hard page cap for one batch request (12 h of 1-minute bars). */
const MAX_BATCH_PAGES = 12;

export interface HistoryBar {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketHistoryPayload {
  source: 'KRAKEN' | 'UNAVAILABLE';
  authoritative: boolean;
  pair: string;
  intervalMinutes: number;
  bars: HistoryBar[];
  fetchedAtMs: number;
  latencyMs: number;
  /** Present on batch responses. */
  requestedFromMs?: number;
  requestedToMs?: number;
  /** Number of upstream pages needed for a batch window. */
  pages?: number;
  error?: string;
}

const cache = new Map<string, { payload: MarketHistoryPayload; cachedAtMs: number }>();

const PAIR_WHITELIST = new Set(['XBTUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD']);

function emptyPayload(pair: string, intervalMinutes: number, latencyMs: number, error: string): MarketHistoryPayload {
  return {
    source: 'UNAVAILABLE',
    authoritative: false,
    pair,
    intervalMinutes,
    bars: [],
    fetchedAtMs: Date.now(),
    latencyMs,
    error,
  };
}

function parseBars(result: unknown, pair: string): HistoryBar[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  // Kraken returns the bar array under the canonical pair key ("XXBTZUSD")
  // and a "last" cursor field; accept any array-shaped value.
  for (const [key, value] of Object.entries(record)) {
    if (key === 'last' || !Array.isArray(value)) continue;
    const rows = value as unknown[][];
    const bars: HistoryBar[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const tsSeconds = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[6] ?? 0);
      if (![tsSeconds, open, high, low, close].every(Number.isFinite)) continue;
      bars.push({ tsMs: tsSeconds * 1000, open, high, low, close, volume });
    }
    if (bars.length > 0) {
      bars.sort((a, b) => a.tsMs - b.tsMs);
      void pair;
      return bars;
    }
  }
  return [];
}

export async function getMarketHistory(
  pair: string = 'XBTUSD',
  intervalMinutes = 1
): Promise<MarketHistoryPayload> {
  const safePair = PAIR_WHITELIST.has(pair) ? pair : 'XBTUSD';
  const safeInterval = [1, 5, 15, 60].includes(intervalMinutes) ? intervalMinutes : 1;
  const cacheKey = `${safePair}:${safeInterval}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.cachedAtMs < CACHE_TTL_MS) {
    return hit.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const url = `${KRAKEN_OHLC_URL}?pair=${encodeURIComponent(safePair)}&interval=${safeInterval}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const payload = emptyPayload(safePair, safeInterval, latencyMs, `Kraken OHLC HTTP ${response.status}`);
      cache.set(cacheKey, { payload, cachedAtMs: Date.now() });
      return payload;
    }
    const body = (await response.json()) as { error?: unknown; result?: unknown };
    if (Array.isArray(body.error) && body.error.length > 0) {
      const payload = emptyPayload(safePair, safeInterval, latencyMs, `Kraken OHLC error: ${String(body.error[0])}`);
      cache.set(cacheKey, { payload, cachedAtMs: Date.now() });
      return payload;
    }
    const bars = parseBars(body.result, safePair);
    if (bars.length === 0) {
      const payload = emptyPayload(safePair, safeInterval, latencyMs, 'Kraken OHLC returned no bars');
      cache.set(cacheKey, { payload, cachedAtMs: Date.now() });
      return payload;
    }
    const payload: MarketHistoryPayload = {
      source: 'KRAKEN',
      authoritative: true,
      pair: safePair,
      intervalMinutes: safeInterval,
      // Keep a generous window: 200 bars for EMA200 plus warm-up headroom.
      bars: bars.slice(-480),
      fetchedAtMs: Date.now(),
      latencyMs,
    };
    cache.set(cacheKey, { payload, cachedAtMs: Date.now() });
    return payload;
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError' ? 'Kraken OHLC timeout' : String(error);
    const payload = emptyPayload(safePair, safeInterval, Date.now() - startedAt, message);
    cache.set(cacheKey, { payload, cachedAtMs: Date.now() });
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Batched range fetch for the offline comparison queue.
 *
 * The widget sends **one** request for the whole missed window; this function
 * pages through Kraken internally (`since` cursor), de-duplicates and returns
 * only the bars inside the requested range. Nothing is interpolated: if a
 * minute is missing upstream it stays missing and the client marks the
 * comparison unresolvable.
 */
export async function getMarketHistoryRange(
  pair: string,
  intervalMinutes: number,
  fromMs: number,
  toMs: number
): Promise<MarketHistoryPayload> {
  const safePair = PAIR_WHITELIST.has(pair) ? pair : 'XBTUSD';
  const safeInterval = [1, 5, 15, 60].includes(intervalMinutes) ? intervalMinutes : 1;
  const startedAt = Date.now();
  const fromSeconds = Math.floor(fromMs / 1000);
  const toSeconds = Math.ceil(toMs / 1000);

  if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || toSeconds <= fromSeconds) {
    return {
      ...emptyPayload(safePair, safeInterval, 0, 'Ungültiges Backfill-Fenster.'),
      requestedFromMs: fromMs,
      requestedToMs: toMs,
      pages: 0,
    };
  }

  const collected = new Map<number, HistoryBar>();
  let cursor = fromSeconds;
  let pages = 0;
  let lastError: string | undefined;

  while (cursor < toSeconds && pages < MAX_BATCH_PAGES) {
    pages += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = `${KRAKEN_OHLC_URL}?pair=${encodeURIComponent(safePair)}&interval=${safeInterval}&since=${cursor}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        lastError = `Kraken OHLC HTTP ${response.status}`;
        break;
      }
      const body = (await response.json()) as { error?: unknown; result?: unknown };
      if (Array.isArray(body.error) && body.error.length > 0) {
        lastError = `Kraken OHLC error: ${String(body.error[0])}`;
        break;
      }
      const pageBars = parseBars(body.result, safePair);
      if (pageBars.length === 0) break;

      let newest = cursor;
      for (const bar of pageBars) {
        if (bar.tsMs >= fromMs && bar.tsMs <= toMs) {
          collected.set(bar.tsMs, bar);
        }
        newest = Math.max(newest, Math.floor(bar.tsMs / 1000));
      }
      if (newest <= cursor) break;
      cursor = newest;
      // A short page means the venue has no more history in this range.
      if (pageBars.length < KRAKEN_MAX_ROWS) break;
    } catch (error) {
      lastError =
        error instanceof Error && error.name === 'AbortError'
          ? 'Kraken OHLC timeout'
          : String(error);
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  const bars = [...collected.values()].sort((a, b) => a.tsMs - b.tsMs);
  const payload: MarketHistoryPayload = {
    source: bars.length > 0 ? 'KRAKEN' : 'UNAVAILABLE',
    authoritative: bars.length > 0,
    pair: safePair,
    intervalMinutes: safeInterval,
    bars,
    fetchedAtMs: Date.now(),
    latencyMs: Date.now() - startedAt,
    requestedFromMs: fromMs,
    requestedToMs: toMs,
    pages,
    ...(lastError && bars.length === 0 ? { error: lastError } : {}),
  };
  return payload;
}
