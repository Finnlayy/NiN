/**
 * Authoritative exchange clock proxy.
 *
 * The browser must never derive a snapshot timestamp from its own wall clock.
 * This route samples Kraken's public Time endpoint server-side (no API key),
 * caches it for a few seconds and falls back to the local server clock — marked
 * `authoritative: false` so the client can degrade instead of trusting it.
 */

const KRAKEN_TIME_URL = 'https://api.kraken.com/0/public/Time';
const CACHE_TTL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 2_500;

export type ExchangeClockSource = 'KRAKEN' | 'LOCAL_FALLBACK';

export interface ExchangeClockPayload {
  source: ExchangeClockSource;
  authoritative: boolean;
  /** Unix time in seconds, as reported by the venue. */
  unixtime: number;
  rfc1123: string;
  /** Server time when the sample was produced (ms). */
  fetchedAtMs: number;
  /** Round-trip duration of the upstream request (ms). */
  latencyMs: number;
  error?: string;
}

let cache: { payload: ExchangeClockPayload; cachedAtMs: number } | null = null;

function nowPayload(latencyMs = 0, error?: string): ExchangeClockPayload {
  const fetchedAtMs = Date.now();
  return {
    source: 'LOCAL_FALLBACK',
    authoritative: false,
    unixtime: fetchedAtMs / 1000,
    rfc1123: new Date(fetchedAtMs).toUTCString(),
    fetchedAtMs,
    latencyMs,
    ...(error ? { error } : {}),
  };
}

async function fetchKrakenTime(): Promise<ExchangeClockPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(KRAKEN_TIME_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return nowPayload(latencyMs, `Kraken Time HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      error?: unknown;
      result?: { unixtime?: unknown; rfc1123?: unknown };
    };
    if (Array.isArray(body.error) && body.error.length > 0) {
      return nowPayload(latencyMs, `Kraken Time error: ${String(body.error[0])}`);
    }
    const unixtime = Number(body.result?.unixtime);
    if (!Number.isFinite(unixtime) || unixtime <= 0) {
      return nowPayload(latencyMs, 'Kraken Time returned no unixtime');
    }
    return {
      source: 'KRAKEN',
      authoritative: true,
      unixtime,
      rfc1123:
        typeof body.result?.rfc1123 === 'string'
          ? body.result.rfc1123
          : new Date(unixtime * 1000).toUTCString(),
      fetchedAtMs: Date.now(),
      latencyMs,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Kraken Time timeout'
        : String(error);
    return nowPayload(Date.now() - startedAt, message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getExchangeClock(): Promise<ExchangeClockPayload> {
  const now = Date.now();
  if (cache && now - cache.cachedAtMs < CACHE_TTL_MS) {
    return cache.payload;
  }
  const payload = await fetchKrakenTime();
  cache = { payload, cachedAtMs: Date.now() };
  return payload;
}
