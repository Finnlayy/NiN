import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Live spot prices for all dashboard symbols, sourced from CoinGecko's free
 * public API (server-side calls do not need an API key).
 *
 * A module-global cache with a ~60s TTL keeps us well inside CoinGecko's free
 * rate limits; on failure we degrade gracefully to the stale cache and finally
 * to a hardcoded fallback map so the UI never breaks.
 */

export const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  SUI: 'sui',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  CETUS: 'cetus-protocol',
  NAVX: 'navi',
  SCA: 'scallop',
  JUP: 'jupiter-exchange-solana',
  RAY: 'raydium',
  JTO: 'jito-governance-token',
  HYPE: 'hyperliquid', // NOT "hype" — that is a different token
};

/** Roughly current values, used only when CoinGecko is unreachable. */
export const FALLBACK_PRICES: Record<string, number> = {
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

const CACHE_TTL_MS = 60_000;
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(SYMBOL_TO_COINGECKO_ID).join(',')}&vs_currencies=usd`;

let cache: Record<string, number> | null = null;
let cacheTime = 0;

export async function getLivePrices(): Promise<{ prices: Record<string, number>; source: 'coingecko' | 'fallback' }> {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) {
    return { prices: cache, source: 'coingecko' };
  }

  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`CoinGecko responded ${res.status}`);
    }
    const data = await res.json();

    const prices: Record<string, number> = {};
    for (const [symbol, id] of Object.entries(SYMBOL_TO_COINGECKO_ID)) {
      const usd = data?.[id]?.usd;
      if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
        prices[symbol] = usd;
      }
    }
    if (Object.keys(prices).length === 0) {
      throw new Error('CoinGecko response contained no usable prices');
    }

    cache = prices;
    cacheTime = Date.now();
    return { prices, source: 'coingecko' };
  } catch {
    // Degrade to stale cache first; only when nothing was ever fetched do we
    // fall back to the hardcoded map.
    if (cache) {
      return { prices: cache, source: 'coingecko' };
    }
    return { prices: { ...FALLBACK_PRICES }, source: 'fallback' };
  }
}

/**
 * GET /api/prices — returns { prices, updatedAt, source } with permissive CORS.
 */
export async function handlePricesRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { prices, source } = await getLivePrices();
  const payload = JSON.stringify({
    prices,
    updatedAt: new Date().toISOString(),
    source,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}
