/**
 * Live spot-price cache. Symbols that Kraken lists (BTC, ETH, SOL, SUI, DOGE,
 * XRP, AVAX) are fed by the site's own /api/kraken/tickers endpoint — the same
 * Kraken stream the terminal panel shows, so every panel quotes the identical
 * venue price. The remaining symbols come from /api/prices (CoinGecko), which
 * also covers the Kraken-listed ones whenever the Kraken stream is down.
 *
 * Trading panels may keep their simulated placeholder values while the feed
 * warms up (legacy `getLiveSpot`). Anything that *records* a price — the
 * Paragraph 2 ledger, backtests, P&L — must use `observeLiveSpot()`, which
 * returns only a genuinely observed quote plus its timestamp and venue, or
 * `null`. There is no synthetic fallback on that path by design.
 */

/** Venue that produced an observation. */
export type LivePriceSource = 'KRAKEN_TICKERS' | 'KRAKEN_STATUS' | 'COINGECKO';

/** A real observation: price, venue and the moment it was received. */
export interface LiveSpotObservation {
  symbol: LiveSymbol;
  price: number;
  updatedAtMs: number;
  source: LivePriceSource;
}

export type LiveSymbol =
  | 'BTC' | 'ETH' | 'SOL' | 'SUI' | 'DOGE' | 'XRP' | 'BNB' | 'AVAX'
  | 'CETUS' | 'NAVX' | 'SCA' | 'JUP' | 'RAY' | 'JTO' | 'HYPE';

const FALLBACKS: Record<LiveSymbol, number> = {
  BTC: 84500,
  ETH: 2705,
  SOL: 121,
  SUI: 1.18,
  DOGE: 0.096,
  XRP: 1.52,
  BNB: 773,
  AVAX: 10.9,
  CETUS: 0.0287,
  NAVX: 0.0117,
  SCA: 0.005,
  JUP: 0.34,
  RAY: 2.15,
  JTO: 0.62,
  HYPE: 93,
};

/** Legacy Kraken status feed (BTC/SOL only) — used as a degradation path. */
const KRAKEN_TICKER_MAP: Partial<Record<LiveSymbol, string>> = {
  BTC: 'BTCUSD',
  SOL: 'SOLUSD',
};

/** Symbols quoted directly by the Kraken stream (authoritative venue feed). */
const KRAKEN_SYMBOLS: LiveSymbol[] = ['BTC', 'ETH', 'SOL', 'SUI', 'DOGE', 'XRP', 'AVAX'];

const REFRESH_INTERVAL_MS = 10_000;

const cache: Partial<Record<LiveSymbol, number>> = {};
/** Provenance of every cached value (only real observations are recorded). */
const meta: Partial<Record<LiveSymbol, { updatedAtMs: number; source: LivePriceSource }>> = {};

function record(symbol: LiveSymbol, price: number, source: LivePriceSource): void {
  cache[symbol] = price;
  meta[symbol] = { updatedAtMs: Date.now(), source };
}
let poller: ReturnType<typeof setInterval> | null = null;
let readyFired = false;
const readyListeners: Array<() => void> = [];

function notifyReadyIfWarmed(): void {
  if (!readyFired && (cache.BTC !== undefined || cache.SOL !== undefined)) {
    readyFired = true;
    for (const cb of readyListeners) {
      try { cb(); } catch { /* listener errors must not break the poller */ }
    }
  }
}

async function refreshFromKraken(): Promise<void> {
  try {
    const res = await fetch('/api/kraken/status');
    if (!res.ok) return;
    const data = await res.json();
    for (const sym of Object.keys(KRAKEN_TICKER_MAP) as LiveSymbol[]) {
      const last = data?.ticker?.[KRAKEN_TICKER_MAP[sym]!]?.last;
      if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
        record(sym, last, 'KRAKEN_STATUS');
      }
    }
    notifyReadyIfWarmed();
  } catch {
    // Keep last known value (or fallback) on network errors.
  }
}

/**
 * Pull the Kraken stream for every Kraken-listed symbol. Returns the set of
 * symbols that actually received a fresh quote, so the caller knows which
 * ones CoinGecko still needs to cover.
 */
async function refreshFromKrakenTickers(): Promise<Set<LiveSymbol>> {
  const updated = new Set<LiveSymbol>();
  try {
    const res = await fetch('/api/kraken/tickers');
    if (!res.ok) return updated;
    const data = await res.json();
    const prices = data?.prices;
    if (!prices || typeof prices !== 'object') return updated;
    for (const sym of KRAKEN_SYMBOLS) {
      const value = (prices as Record<string, unknown>)[sym];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        record(sym, value, 'KRAKEN_TICKERS');
        updated.add(sym);
      }
    }
  } catch {
    // Keep last known value (or fallback) on network errors.
  }
  return updated;
}

async function refresh(): Promise<void> {
  // 1) Kraken stream first — authoritative venue prices, identical to what
  //    the Kraken terminal panel displays.
  const krakenUpdated = await refreshFromKrakenTickers();

  // 2) CoinGecko covers the symbols Kraken doesn't list, and re-covers the
  //    Kraken-listed ones whenever the Kraken stream is unreachable.
  try {
    const res = await fetch('/api/prices');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const prices = data?.prices;
    if (!prices || typeof prices !== 'object') throw new Error('Malformed /api/prices payload');
    for (const sym of Object.keys(FALLBACKS) as LiveSymbol[]) {
      if (krakenUpdated.has(sym)) continue;
      const value = prices[sym];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        record(sym, value, 'COINGECKO');
      }
    }
    notifyReadyIfWarmed();
  } catch {
    // CoinGecko-backed route unavailable — degrade to the legacy Kraken feed
    // so BTC/SOL stay live.
    await refreshFromKraken();
  }
}

function ensurePoller(): void {
  if (poller || typeof window === 'undefined') return;
  void refresh(); // warm the cache immediately
  poller = setInterval(refresh, REFRESH_INTERVAL_MS);
}

/**
 * Legacy accessor for purely cosmetic panels: returns a cached quote, else the
 * caller's placeholder, else a built-in demo constant.
 *
 * Nothing that persists a price may use this — see `observeLiveSpot()`.
 */
export function getLiveSpot(symbol: LiveSymbol, fallback?: number): number {
  ensurePoller();
  return cache[symbol] ?? fallback ?? FALLBACKS[symbol];
}

/**
 * Strict accessor: returns only a real, timestamped venue observation or
 * `null`. Never invents, interpolates or substitutes a fallback price.
 */
export function observeLiveSpot(symbol: LiveSymbol): LiveSpotObservation | null {
  ensurePoller();
  const price = cache[symbol];
  const info = meta[symbol];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || !info) {
    return null;
  }
  return { symbol, price, updatedAtMs: info.updatedAtMs, source: info.source };
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
