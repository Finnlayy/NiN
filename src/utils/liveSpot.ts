/**
 * Live spot-price cache fed by the site's own /api/kraken/status endpoint —
 * the same data source the PRO LIVE MESH node (AgentCanvas) reads from.
 *
 * Components keep their simulated fallback values when the feed is
 * unreachable or has not warmed up yet, so the UI never breaks offline.
 */

export type LiveSymbol = 'BTC' | 'SOL';

const FALLBACKS: Record<LiveSymbol, number> = {
  BTC: 64280.5,
  SOL: 182.4,
};

const TICKER_MAP: Record<LiveSymbol, string> = {
  BTC: 'BTCUSD',
  SOL: 'SOLUSD',
};

const REFRESH_INTERVAL_MS = 10_000;

const cache: Partial<Record<LiveSymbol, number>> = {};
let poller: ReturnType<typeof setInterval> | null = null;
let readyFired = false;
const readyListeners: Array<() => void> = [];

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/kraken/status');
    if (!res.ok) return;
    const data = await res.json();
    for (const sym of Object.keys(TICKER_MAP) as LiveSymbol[]) {
      const last = data?.ticker?.[TICKER_MAP[sym]]?.last;
      if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
        cache[sym] = last;
      }
    }
    if (!readyFired && (cache.BTC !== undefined || cache.SOL !== undefined)) {
      readyFired = true;
      for (const cb of readyListeners) {
        try { cb(); } catch { /* listener errors must not break the poller */ }
      }
    }
  } catch {
    // Keep last known value (or fallback) on network errors.
  }
}

function ensurePoller(): void {
  if (poller || typeof window === 'undefined') return;
  void refresh(); // warm the cache immediately
  poller = setInterval(refresh, REFRESH_INTERVAL_MS);
}

/**
 * Returns the latest live spot price for a symbol, or the provided fallback
 * (then the built-in default) when the feed has not delivered a value yet.
 */
export function getLiveSpot(symbol: LiveSymbol, fallback?: number): number {
  ensurePoller();
  return cache[symbol] ?? fallback ?? FALLBACKS[symbol];
}

/**
 * Registers a callback that fires exactly once, when the first live tick
 * arrives. Use this to re-render components that cached a fallback value
 * in a mount-time memo — e.g. `useMemo(() => ..., [])`.
 */
export function onLiveSpotReady(cb: () => void): () => void {
  if (readyFired) {
    cb();
    return () => {};
  }
  readyListeners.push(cb);
  return () => {
    const idx = readyListeners.indexOf(cb);
    if (idx >= 0) readyListeners.splice(idx, 1);
  };
}
