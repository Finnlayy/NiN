/**
 * Exchange clock synchronisation.
 *
 * Every timestamp in the ledger is an exchange timestamp, never `Date.now()`.
 * The browser samples `/api/exchange/clock`, which proxies Kraken's public
 * Time endpoint server-side, and derives the offset with round-trip correction:
 *
 *   offset = serverTime - (t_send + rtt / 2)
 *
 * If Kraken (and the local API) are unreachable the clock degrades to a local
 * reading and is flagged as non-authoritative, which downgrades the M8 engine
 * status to THROTTLED but never silently invents an exchange timestamp.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CLOCK_SYNC_MS, MAX_CLOCK_SKEW_MS } from './config';

export type ClockSource = 'KRAKEN' | 'LOCAL_FALLBACK';

export interface ExchangeClockResponse {
  source: ClockSource;
  authoritative: boolean;
  unixtime: number;
  rfc1123?: string;
  fetchedAtMs: number;
  latencyMs?: number;
  error?: string;
}

export type ClockState = 'SYNCED' | 'DEGRADED' | 'LOCAL';

export interface ExchangeClock {
  /** Best estimate of "now" on the exchange, in ms. */
  nowMs: number;
  offsetMs: number;
  rttMs: number;
  source: ClockSource;
  authoritative: boolean;
  state: ClockState;
  lastSyncMs: number | null;
  ageMs: number;
  skewExceeded: boolean;
  resync: () => void;
}

interface ClockSample {
  offsetMs: number;
  rttMs: number;
  source: ClockSource;
  authoritative: boolean;
  atMs: number;
}

export const SYNC_MAX_AGE_MS = CLOCK_SYNC_MS * 3;

const DEFAULT_CLOCK_SAMPLE: ClockSample = {
  offsetMs: 0,
  rttMs: 0,
  source: 'LOCAL_FALLBACK',
  authoritative: false,
  atMs: 0,
};

function currentNow(sample: ClockSample | null, wallMs: number): number {
  if (!sample) return wallMs;
  return wallMs + sample.offsetMs;
}

function classifyClock(sample: ClockSample | null, wallMs: number): ClockState {
  if (!sample || !sample.authoritative || sample.atMs === 0) return 'LOCAL';
  if (Math.abs(sample.offsetMs) > MAX_CLOCK_SKEW_MS) return 'DEGRADED';
  if (wallMs - sample.atMs > SYNC_MAX_AGE_MS) return 'DEGRADED';
  return 'SYNCED';
}

/** Fetches one clock sample. Exported for tests and manual resync. */
export async function sampleExchangeClock(
  fetcher: typeof fetch = fetch
): Promise<ClockSample> {
  const sentAt = Date.now();
  try {
    const response = await fetcher('/api/exchange/clock', { cache: 'no-store' });
    const receivedAt = Date.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as ExchangeClockResponse;
    if (!payload || !Number.isFinite(payload.unixtime)) {
      throw new Error('Malformed exchange clock payload');
    }
    const rttMs = Math.max(0, receivedAt - sentAt);
    const exchangeAtResponse = payload.unixtime * 1000;
    const offsetMs = exchangeAtResponse - (sentAt + rttMs / 2);
    return {
      offsetMs,
      rttMs,
      source: payload.source === 'KRAKEN' ? 'KRAKEN' : 'LOCAL_FALLBACK',
      authoritative: Boolean(payload.authoritative),
      atMs: receivedAt,
    };
  } catch {
    return { ...DEFAULT_CLOCK_SAMPLE, atMs: 0, rttMs: Date.now() - sentAt };
  }
}

/**
 * React hook: keeps an offset-corrected exchange clock and refreshes it on a
 * fixed cadence. A 1 s ticker keeps consumer render (countdowns) smooth.
 */
export function useExchangeClock(pollMs = CLOCK_SYNC_MS): ExchangeClock {
  const sampleRef = useRef<ClockSample | null>(null);
  const [sample, setSample] = useState<ClockSample | null>(null);
  const [wallMs, setWallMs] = useState<number>(() => Date.now());
  const [nonce, setNonce] = useState(0);

  const resync = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const next = await sampleExchangeClock();
      if (cancelled) return;
      if (next.atMs === 0 && sampleRef.current) {
        // Keep the last good offset on a transient failure; age marks it stale.
        return;
      }
      sampleRef.current = next;
      setSample(next);
      setWallMs(Date.now());
    };

    void pull();
    const syncTimer = setInterval(pull, pollMs);
    return () => {
      cancelled = true;
      clearInterval(syncTimer);
    };
  }, [pollMs, nonce]);

  useEffect(() => {
    const ticker = setInterval(() => setWallMs(Date.now()), 1_000);
    return () => clearInterval(ticker);
  }, []);

  const state = classifyClock(sample, wallMs);
  const ageMs = sample ? wallMs - sample.atMs : Number.POSITIVE_INFINITY;
  const offsetMs = sample?.offsetMs ?? 0;

  return {
    nowMs: currentNow(sample, wallMs),
    offsetMs,
    rttMs: sample?.rttMs ?? 0,
    source: sample?.source ?? 'LOCAL_FALLBACK',
    authoritative: sample?.authoritative ?? false,
    state,
    lastSyncMs: sample?.atMs || null,
    ageMs,
    skewExceeded: Math.abs(offsetMs) > MAX_CLOCK_SKEW_MS,
    resync,
  };
}
