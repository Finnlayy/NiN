import {
  calculateGravityField,
  calculateGravitationForces,
  calculateViaNegativa,
  generateGravitationForceProfile,
  getLiveOmegaTelemetry,
  type GravityFieldState,
  type GravityForceCurvePoint,
  type GravityForceVectorTelemetry,
  type LiveOmegaTelemetry,
  type OmegaLeaderPrice,
  type ViaNegativaState,
} from '../utils/omegaLogic';

const PUBLIC_ROOT = 'https://api.kraken.com/0/public';

const BASE_NAMES: Record<string, string> = {
  XBT: 'BTC',
  XXBT: 'BTC',
  XDG: 'DOGE',
  XXDG: 'DOGE',
  XETH: 'ETH',
  XXETH: 'ETH',
  XXRP: 'XRP',
  XLTC: 'LTC',
  XETC: 'ETC',
  XXLM: 'XLM',
  XZEC: 'ZEC',
};

export interface KrakenOhlcBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface KrakenSymbol {
  pair: string;
  altname: string;
  wsname: string;
  base: string;
  quote: string;
  display: string;
}

export interface KrakenPairQuote {
  pair: string;
  display: string;
  last: number;
  bid: number;
  ask: number;
  open24h: number;
  vwap24h: number;
  volume24h: number;
  trades24h: number;
  ohlc: KrakenOhlcBar[];
  bidDepthQuote: number;
  askDepthQuote: number;
  spread: number;
  atr14: number | null;
  askImpedance: number;
  bidSupport: number;
  change24h: number;
  visibleL2Depth: number;
  quotedAt: string;
}

export interface GravitySummary {
  pair: string;
  display: string;
  last: number;
  bid: number;
  ask: number;
  atr14: number;
  bLower: number;
  bUpper: number;
  potentialMinimumPrice: number;
  forceNet: number;
  direction: 'BULLISH' | 'BEARISH' | 'EQUILIBRIUM';
  visibleL2Depth: number;
  computedAt: string;
}

export interface GravityComputation {
  summary: GravitySummary;
  viaNegativa: ViaNegativaState;
  gravityField: GravityFieldState;
  forces: GravityForceVectorTelemetry;
  curve: GravityForceCurvePoint[];
  quote: KrakenPairQuote;
}

export interface KrakenPrivateStatus {
  connected: boolean;
  balances: null;
  openOrders: null;
  tradeHistory: null;
}

export interface KrakenLiveFeed {
  quotedAt: string;
  catalog: KrakenSymbol[];
  quotes: Record<string, KrakenPairQuote>;
  privateStatus: KrakenPrivateStatus;
}

interface RawTicker {
  a?: string[];
  b?: string[];
  c?: string[];
  v?: string[];
  p?: string[];
  t?: number[];
  o?: string;
}

interface RawAssetPair {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
  status?: string;
}

type Listener = () => void;

export interface MarketStore {
  feed: KrakenLiveFeed | null;
  selectedPair: string;
  computations: Record<string, GravityComputation>;
  summaries: GravitySummary[];
  calculating: boolean;
  calculatingAll: boolean;
  error: string | null;
}

const listeners = new Set<Listener>();
let catalogCache: { at: number; symbols: KrakenSymbol[] } | null = null;
let primed = false;
let allRun = 0;

let store: MarketStore = {
  feed: null,
  selectedPair: 'XXBTZUSD',
  computations: {},
  summaries: [],
  calculating: false,
  calculatingAll: false,
  error: null,
};

export function getMarketStore(): MarketStore {
  return store;
}

export function subscribeMarket(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(partial: Partial<MarketStore>): void {
  store = { ...store, ...partial };
  for (const listener of listeners) listener();
}

export function canonicalPairKey(raw: string): string {
  let key = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (key.endsWith('.P')) key = key.slice(0, -2);
  key = key.replace(/-/g, '/');
  if (key.includes('/')) {
    const [base, quote] = key.split('/');
    const named = BASE_NAMES[base] ?? base;
    const quoted = quote === 'ZUSD' || quote === 'USDT' ? 'USD' : quote;
    return `${named}/${quoted}`;
  }
  if (key.endsWith('ZUSD')) {
    const base = key.slice(0, -4);
    return `${BASE_NAMES[base] ?? base}/USD`;
  }
  if (key.endsWith('USD') && key.length > 3) {
    const base = key.slice(0, -3);
    return `${BASE_NAMES[base] ?? base}/USD`;
  }
  return key;
}

export function pairsMatch(left: string, right: string): boolean {
  return canonicalPairKey(left) === canonicalPairKey(right);
}

export function mergeGravitySnapshots(previous: GravitySummary[], incoming: GravitySummary[]): GravitySummary[] {
  const byKey = new Map<string, GravitySummary>();
  for (const row of [...previous, ...incoming]) {
    if (!(row.last > 0)) continue;
    byKey.set(canonicalPairKey(row.display || row.pair), row);
  }
  return [...byKey.values()];
}

function displayFromWs(wsname: string): string {
  return canonicalPairKey(wsname);
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function krakenPublic<T>(path: string): Promise<T> {
  const response = await fetch(`${PUBLIC_ROOT}${path}`);
  if (!response.ok) {
    throw new Error(`Kraken ${response.status}`);
  }
  const body = await response.json() as { error?: string[]; result?: T };
  if (body.error && body.error.length > 0) {
    throw new Error(body.error.join(', '));
  }
  if (!body.result) {
    throw new Error('Kraken result missing');
  }
  return body.result;
}

function isUsdSpot(info: RawAssetPair): boolean {
  if (info.quote !== 'ZUSD' && info.quote !== 'USD') return false;
  if (info.status && info.status !== 'online') return false;
  if (!info.wsname || !info.wsname.includes('/')) return false;
  if (info.altname?.endsWith('.d')) return false;
  return true;
}

export async function loadCatalog(): Promise<KrakenSymbol[]> {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60 * 1000) {
    return catalogCache.symbols;
  }
  const result = await krakenPublic<Record<string, RawAssetPair>>('/AssetPairs');
  const symbols: KrakenSymbol[] = [];
  for (const [pair, info] of Object.entries(result)) {
    if (!isUsdSpot(info) || !info.wsname) continue;
    symbols.push({
      pair,
      altname: info.altname ?? pair,
      wsname: info.wsname,
      base: info.base ?? '',
      quote: info.quote ?? '',
      display: displayFromWs(info.wsname),
    });
  }
  symbols.sort((a, b) => a.display.localeCompare(b.display));
  catalogCache = { at: Date.now(), symbols };
  return symbols;
}

async function fetchTickerMap(pairs: string[]): Promise<Record<string, RawTicker>> {
  const out: Record<string, RawTicker> = {};
  for (let index = 0; index < pairs.length; index += 40) {
    const chunk = pairs.slice(index, index + 40);
    try {
      const result = await krakenPublic<Record<string, RawTicker>>(`/Ticker?pair=${chunk.join(',')}`);
      Object.assign(out, result);
    } catch {
      continue;
    }
  }
  return out;
}

function tickerFor(symbol: KrakenSymbol, tickers: Record<string, RawTicker>): RawTicker | undefined {
  return tickers[symbol.pair] ?? tickers[symbol.altname] ?? tickers[symbol.wsname];
}

function quoteFromTicker(symbol: KrakenSymbol, ticker: RawTicker, quotedAt: string): KrakenPairQuote | null {
  const last = num(ticker.c?.[0]);
  if (last <= 0) return null;
  const bid = num(ticker.b?.[0]);
  const ask = num(ticker.a?.[0]);
  const open24h = num(ticker.o);
  return {
    pair: symbol.pair,
    display: symbol.display,
    last,
    bid,
    ask,
    open24h,
    vwap24h: num(ticker.p?.[1] ?? ticker.p?.[0]),
    volume24h: num(ticker.v?.[1] ?? ticker.v?.[0]),
    trades24h: num(ticker.t?.[1] ?? ticker.t?.[0]),
    ohlc: [],
    bidDepthQuote: 0,
    askDepthQuote: 0,
    spread: ask > 0 && bid > 0 ? ask - bid : 0,
    atr14: null,
    askImpedance: ask > 0 ? ask - last : 0,
    bidSupport: bid > 0 ? last - bid : 0,
    change24h: open24h > 0 ? (last - open24h) / open24h : 0,
    visibleL2Depth: 0,
    quotedAt,
  };
}

export function atr14FromOhlc(bars: KrakenOhlcBar[]): number | null {
  if (bars.length < 16) return null;
  const recent = bars.slice(-16);
  const ranges: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const prev = recent[index - 1].close;
    const bar = recent[index];
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev)));
  }
  if (ranges.length < 15) return null;
  const used = ranges.slice(-15);
  return used.reduce((sum, value) => sum + value, 0) / used.length;
}

export function computeGravity(quote: KrakenPairQuote, timeDeltaMinutes = 60): GravityComputation | null {
  if (!(quote.last > 0) || quote.atr14 == null || !(quote.atr14 > 0)) return null;
  const viaNegativa = calculateViaNegativa(
    quote.last,
    quote.atr14,
    timeDeltaMinutes,
    quote.askImpedance,
    quote.bidSupport,
  );
  const depth = quote.visibleL2Depth > 0 ? quote.visibleL2Depth : undefined;
  const gravityField = calculateGravityField(quote.last, depth);
  const forces = calculateGravitationForces(quote.last, depth);
  const span = Math.max(quote.atr14 * 4, quote.last * 0.02);
  const curve = generateGravitationForceProfile(quote.last, depth, undefined, undefined, span, 50);
  const summary: GravitySummary = {
    pair: quote.pair,
    display: quote.display,
    last: quote.last,
    bid: quote.bid,
    ask: quote.ask,
    atr14: quote.atr14,
    bLower: viaNegativa.bLower,
    bUpper: viaNegativa.bUpper,
    potentialMinimumPrice: gravityField.potentialMinimumPrice,
    forceNet: forces.forceNet,
    direction: forces.direction,
    visibleL2Depth: quote.visibleL2Depth,
    computedAt: new Date().toISOString(),
  };
  return { summary, viaNegativa, gravityField, forces, curve, quote };
}

export function leaderPricesFromQuotes(quotes: Record<string, KrakenPairQuote>): OmegaLeaderPrice[] {
  const bySymbol = new Map<string, OmegaLeaderPrice>();
  for (const quote of Object.values(quotes)) {
    const symbol = quote.display.split('/')[0];
    if (!symbol || !(quote.last > 0)) continue;
    bySymbol.set(symbol, {
      symbol,
      priceUSD: quote.last,
      change24h: quote.change24h * 100,
    });
  }
  return [...bySymbol.values()];
}

export function telemetryFromComputation(
  computation: GravityComputation | null,
  leaderPrices: OmegaLeaderPrice[],
  equityUSD: number | null,
): LiveOmegaTelemetry | null {
  if (!computation || computation.quote.atr14 == null) return null;
  const bar = computation.quote.ohlc[computation.quote.ohlc.length - 1];
  return getLiveOmegaTelemetry({
    quote: {
      pair: computation.quote.pair,
      display: computation.quote.display,
      last: computation.quote.last,
      open: bar?.open ?? computation.quote.last,
      high: bar?.high ?? computation.quote.last,
      low: bar?.low ?? computation.quote.last,
      close: bar?.close ?? computation.quote.last,
      atr14: computation.quote.atr14,
      askImpedance: computation.quote.askImpedance,
      bidSupport: computation.quote.bidSupport,
      visibleL2Depth: computation.quote.visibleL2Depth,
      change24h: computation.quote.change24h,
      trades24h: computation.quote.trades24h,
    },
    leaderPrices,
    equityUSD,
    orders: null,
  });
}

async function fetchOhlc(pair: string): Promise<KrakenOhlcBar[]> {
  const result = await krakenPublic<Record<string, unknown>>(`/OHLC?pair=${encodeURIComponent(pair)}&interval=60`);
  const rows = Object.values(result).find(Array.isArray) as unknown[] | undefined;
  if (!rows) return [];
  return rows.map((row) => {
    const cells = row as unknown[];
    return {
      time: num(cells[0]),
      open: num(cells[1]),
      high: num(cells[2]),
      low: num(cells[3]),
      close: num(cells[4]),
    };
  }).filter((bar) => bar.time > 0 && bar.close > 0);
}

async function fetchDepth(pair: string): Promise<{ bid: number; ask: number }> {
  const result = await krakenPublic<Record<string, { bids?: string[][]; asks?: string[][] }>>(`/Depth?pair=${encodeURIComponent(pair)}&count=25`);
  const book = Object.values(result)[0];
  const sum = (rows: string[][] | undefined) => (rows ?? []).reduce((total, row) => total + num(row[1]), 0);
  return { bid: sum(book?.bids), ask: sum(book?.asks) };
}

export async function loadPairQuote(symbol: KrakenSymbol, tickerQuote?: KrakenPairQuote): Promise<KrakenPairQuote | null> {
  const quotedAt = new Date().toISOString();
  let base = tickerQuote;
  if (!base || !(base.last > 0)) {
    const tickers = await fetchTickerMap([symbol.pair]);
    const ticker = tickerFor(symbol, tickers);
    if (!ticker) return null;
    base = quoteFromTicker(symbol, ticker, quotedAt) ?? undefined;
  }
  if (!base) return null;
  const [ohlc, depth] = await Promise.all([
    fetchOhlc(symbol.pair),
    fetchDepth(symbol.pair),
  ]);
  const atr14 = atr14FromOhlc(ohlc);
  return {
    ...base,
    ohlc,
    atr14,
    bidDepthQuote: depth.bid,
    askDepthQuote: depth.ask,
    visibleL2Depth: depth.bid + depth.ask,
    quotedAt,
  };
}

export async function buildPublicFeed(privateStatus?: KrakenPrivateStatus): Promise<KrakenLiveFeed> {
  const catalog = await loadCatalog();
  const tickers = await fetchTickerMap(catalog.map((symbol) => symbol.pair));
  const quotedAt = new Date().toISOString();
  const quotes: Record<string, KrakenPairQuote> = {};
  for (const symbol of catalog) {
    const ticker = tickerFor(symbol, tickers);
    if (!ticker) continue;
    const quote = quoteFromTicker(symbol, ticker, quotedAt);
    if (quote) quotes[symbol.pair] = quote;
  }
  return {
    quotedAt,
    catalog,
    quotes,
    privateStatus: privateStatus ?? {
      connected: false,
      balances: null,
      openOrders: null,
      tradeHistory: null,
    },
  };
}

function findSymbol(catalog: KrakenSymbol[], pairOrDisplay: string): KrakenSymbol | undefined {
  const key = canonicalPairKey(pairOrDisplay);
  return catalog.find((symbol) => symbol.pair === pairOrDisplay || canonicalPairKey(symbol.display) === key || canonicalPairKey(symbol.altname) === key || canonicalPairKey(symbol.wsname) === key);
}

export function quoteForDisplay(feed: KrakenLiveFeed | null, display: string): KrakenPairQuote | null {
  if (!feed) return null;
  const key = canonicalPairKey(display);
  return Object.values(feed.quotes).find((quote) => canonicalPairKey(quote.display) === key) ?? null;
}

async function publishIntel(rows: GravitySummary[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const response = await fetch('/api/market/intel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshots: rows }),
    });
    if (!response.ok) return;
    const text = await response.text();
    if (text.trim().startsWith('<')) return;
  } catch {
    return;
  }
}

async function loadFeedPreferApi(privateStatus?: KrakenPrivateStatus): Promise<KrakenLiveFeed> {
  if (privateStatus) return buildPublicFeed(privateStatus);
  try {
    const response = await fetch('/api/market/feed');
    const text = await response.text();
    if (!response.ok || text.trim().startsWith('<')) {
      return buildPublicFeed();
    }
    const body = JSON.parse(text) as KrakenLiveFeed;
    if (!Array.isArray(body.catalog) || !body.quotes) return buildPublicFeed();
    return body;
  } catch {
    return buildPublicFeed();
  }
}

export async function refreshWarmFeed(privateStatus?: KrakenPrivateStatus): Promise<KrakenLiveFeed> {
  const feed = await loadFeedPreferApi(privateStatus);
  const btc = feed.catalog.find((symbol) => symbol.display === 'BTC/USD');
  const selected = feed.quotes[store.selectedPair]
    ? store.selectedPair
    : btc?.pair ?? feed.catalog[0]?.pair ?? store.selectedPair;
  const previous = store.computations[selected];
  const computations = { ...store.computations };
  const fresh = feed.quotes[selected];
  if (previous && fresh && previous.quote.atr14) {
    const merged: KrakenPairQuote = {
      ...fresh,
      ohlc: previous.quote.ohlc,
      atr14: previous.quote.atr14,
      bidDepthQuote: previous.quote.bidDepthQuote,
      askDepthQuote: previous.quote.askDepthQuote,
      visibleL2Depth: previous.quote.visibleL2Depth,
    };
    const next = computeGravity(merged);
    if (next) computations[selected] = next;
  }
  commit({ feed, selectedPair: selected, computations, error: null });
  if (!primed && feed.quotes[selected]) {
    primed = true;
    void calculatePair(selected);
  }
  return feed;
}

export async function calculatePair(pair: string): Promise<GravityComputation | null> {
  const feed = store.feed;
  if (!feed) return null;
  const symbol = findSymbol(feed.catalog, pair);
  if (!symbol) {
    commit({ error: 'Das Paar steht nicht im Kraken-Katalog.' });
    return null;
  }
  commit({ calculating: true, selectedPair: symbol.pair, error: null });
  try {
    const quote = await loadPairQuote(symbol, feed.quotes[symbol.pair]);
    if (!quote) {
      commit({ calculating: false, error: 'Kraken-Quote fehlt.' });
      return null;
    }
    const computation = computeGravity(quote);
    if (!computation) {
      commit({ calculating: false, error: 'ATR fehlt für dieses Paar. Kein Demo-Kurs eingesetzt.' });
      return null;
    }
    commit({
      calculating: false,
      computations: { ...store.computations, [symbol.pair]: computation },
      feed: { ...feed, quotes: { ...feed.quotes, [symbol.pair]: quote } },
    });
    await publishIntel([computation.summary]);
    return computation;
  } catch (error) {
    commit({ calculating: false, error: error instanceof Error ? error.message : 'Berechnung fehlgeschlagen.' });
    return null;
  }
}

export async function calculateAllPairs(): Promise<GravitySummary[]> {
  const feed = store.feed;
  if (!feed) return [];
  const run = allRun + 1;
  allRun = run;
  commit({ calculatingAll: true, summaries: [], error: null });
  const rows: GravitySummary[] = [];
  const queue = [...feed.catalog];
  const worker = async () => {
    while (queue.length > 0 && allRun === run) {
      const symbol = queue.shift();
      if (!symbol) return;
      try {
        const quote = await loadPairQuote(symbol, feed.quotes[symbol.pair]);
        if (!quote) continue;
        const computation = computeGravity(quote);
        if (!computation) continue;
        rows.push(computation.summary);
        commit({
          summaries: [...rows],
          computations: { ...store.computations, [symbol.pair]: computation },
        });
      } catch {
        continue;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (allRun === run) {
    commit({ calculatingAll: false });
    await publishIntel(rows);
  }
  return rows;
}

export function selectPair(pair: string): void {
  commit({ selectedPair: pair });
}

export function selectedComputation(): GravityComputation | null {
  return store.computations[store.selectedPair] ?? null;
}

export function selectedTelemetry(): LiveOmegaTelemetry | null {
  const computation = selectedComputation();
  const leaders = leaderPricesFromQuotes(store.feed?.quotes ?? {});
  return telemetryFromComputation(computation, leaders, null);
}
