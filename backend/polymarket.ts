/**
 * Polymarket Gamma ladder for the gravity field's third component.
 * The feed stays off unless POLYMARKET_FEED=true and POLYMARKET_EVENT_SLUG is set.
 * A missing or rejected ladder is 0.5. gateOpen is never true.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { densityFromLadder, type DensityBin, type StrikeRung } from '../src/utils/polymarketDensity';

export type PolySource = 'gamma' | 'stale' | 'neutral';

export interface PolymarketRung extends StrikeRung {
  volume: number | null;
}

export interface PolymarketSnapshot {
  poly: number;
  polySource: PolySource;
  gateOpen: false;
  gateDisplay: boolean;
  slug: string | null;
  title: string | null;
  volume24hr: number | null;
  liquidity: number | null;
  ladder: PolymarketRung[];
  density: DensityBin[] | null;
  fetchedAt: string | null;
  spot: number | null;
}

interface CachedEvent {
  slug: string;
  at: number;
  title: string | null;
  volume24hr: number | null;
  liquidity: number | null;
  ladder: PolymarketRung[];
}

const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;
const GAMMA_URL = 'https://gamma-api.polymarket.com/events';

let cache: CachedEvent | null = null;

export function polymarketFeedEnabled(): boolean {
  return process.env.POLYMARKET_FEED === 'true' && Boolean(process.env.POLYMARKET_EVENT_SLUG?.trim());
}

/** Age of a cached ladder: fresh, still usable, or discard. */
export function polymarketFreshness(ageMs: number): PolySource {
  if (ageMs < FRESH_MS) return 'gamma';
  if (ageMs < STALE_MS) return 'stale';
  return 'neutral';
}

export function neutralPolymarket(spot: number | null = null): PolymarketSnapshot {
  return {
    poly: 0.5,
    polySource: 'neutral',
    gateOpen: false,
    gateDisplay: false,
    slug: null,
    title: null,
    volume24hr: null,
    liquidity: null,
    ladder: [],
    density: null,
    fetchedAt: null,
    spot,
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function yesPrice(raw: unknown): number | null {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }
    } else {
      const direct = Number(trimmed);
      return direct >= 0 && direct <= 1 ? direct : null;
    }
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const yes = Number(value[0]);
  return yes >= 0 && yes <= 1 ? yes : null;
}

/** "$90,000" and "85,000" are strikes. Anything else is skipped. */
export function parseStrike(title: unknown): number | null {
  if (typeof title === 'number' && Number.isFinite(title) && title > 0) return title;
  if (typeof title !== 'string') return null;
  const cleaned = title.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const strike = Number(cleaned);
  return strike > 0 ? strike : null;
}

export function parseGammaPayload(payload: unknown, slug: string): CachedEvent | null {
  const events = asEvents(payload);
  const match = events.find((event) => {
    if (!event || typeof event !== 'object') return false;
    return (event as Record<string, unknown>).slug === slug;
  }) ?? events[0];
  if (!match || typeof match !== 'object') return null;
  const event = match as Record<string, unknown>;
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const ladder: PolymarketRung[] = [];
  for (const market of markets) {
    if (!market || typeof market !== 'object') continue;
    const row = market as Record<string, unknown>;
    const strike = parseStrike(row.groupItemTitle);
    const yes = yesPrice(row.outcomePrices);
    if (strike == null || yes == null) continue;
    ladder.push({ strike, yes, volume: finiteNumber(row.volume) });
  }
  if (ladder.length === 0) return null;
  return {
    slug,
    at: Date.now(),
    title: typeof event.title === 'string' ? event.title : null,
    volume24hr: finiteNumber(event.volume24hr) ?? finiteNumber(event.volume),
    liquidity: finiteNumber(event.liquidity),
    ladder,
  };
}

function asEvents(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.events)) return record.events;
    if (Array.isArray(record.data)) return record.data;
    return [payload];
  }
  return [];
}

function snapshotFrom(entry: CachedEvent, spot: number, source: 'gamma' | 'stale'): PolymarketSnapshot {
  const density = densityFromLadder(entry.ladder, spot);
  if (!density) return neutralPolymarket(spot);
  return {
    poly: density.poly,
    polySource: source,
    gateOpen: false,
    gateDisplay: density.poly >= 0.6,
    slug: entry.slug,
    title: entry.title,
    volume24hr: entry.volume24hr,
    liquidity: entry.liquidity,
    ladder: entry.ladder,
    density: density.bins,
    fetchedAt: new Date(entry.at).toISOString(),
    spot,
  };
}

async function fetchGamma(slug: string): Promise<unknown> {
  const url = `${GAMMA_URL}?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GAMMA_${response.status}`);
  return response.json() as Promise<unknown>;
}

async function resolvePolymarket(
  spot: number,
  now: number,
  load: (slug: string) => Promise<unknown>,
): Promise<PolymarketSnapshot> {
  if (!polymarketFeedEnabled() || !Number.isFinite(spot)) {
    return neutralPolymarket(Number.isFinite(spot) ? spot : null);
  }
  const slug = process.env.POLYMARKET_EVENT_SLUG?.trim() || '';
  if (cache && cache.slug === slug && now - cache.at < FRESH_MS) {
    return snapshotFrom(cache, spot, 'gamma');
  }
  try {
    const parsed = parseGammaPayload(await load(slug), slug);
    if (!parsed || !densityFromLadder(parsed.ladder, spot)) {
      cache = null;
      return neutralPolymarket(spot);
    }
    parsed.at = now;
    cache = parsed;
    return snapshotFrom(parsed, spot, 'gamma');
  } catch {
    if (cache && cache.slug === slug && polymarketFreshness(now - cache.at) === 'stale') {
      return snapshotFrom(cache, spot, 'stale');
    }
    return neutralPolymarket(spot);
  }
}

export function readPolymarket(spot: number, now = Date.now()): Promise<PolymarketSnapshot> {
  return resolvePolymarket(spot, now, fetchGamma);
}

/** Same path as the worker, with a replacement loader for the fixture check. */
export function readPolymarketWith(
  spot: number,
  now: number,
  load: (slug: string) => Promise<unknown>,
): Promise<PolymarketSnapshot> {
  return resolvePolymarket(spot, now, load);
}

export function resetPolymarketCache(): void {
  cache = null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

export async function handlePolymarketApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const raw = req.url || '/';
  const pathOnly = raw.split('?')[0] || '/';
  if (method !== 'GET' || pathOnly !== '/api/market/polymarket') return false;
  const spot = Number(new URL(raw, 'http://localhost').searchParams.get('spot'));
  if (!Number.isFinite(spot) || !(spot > 0)) {
    sendJson(res, 400, { error: 'SPOT_REQUIRED', gateOpen: false });
    return true;
  }
  sendJson(res, 200, await readPolymarket(spot));
  return true;
}
