/**
 * Closed-candle feed. Kraken's OHLC payload includes the still-open bar as
 * the last row; that bar is dropped so learning and the dip reference only
 * see completed candles. Public REST is the fallback when the CLI is absent.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { BookLevel } from '../src/utils/gravityMath';

const execFileAsync = promisify(execFile);

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

const CACHE_TTL_MS = 60_000;
const CLI_TIMEOUT_MS = 20_000;

const cache = new Map<string, { at: number; candles: Candle[] }>();

function cliBinary(): string | null {
  const candidates = [
    process.env.KRAKEN_CLI_PATH,
    path.join(process.cwd(), 'bin', 'kraken'),
    '/var/task/bin/kraken',
    '/tmp/kraken',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function runCli(args: string[]): Promise<string> {
  const bin = cliBinary();
  if (!bin) throw new Error('NO_CLI');
  const { stdout } = await execFileAsync(bin, args, {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCandle(row: unknown): Candle | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const time = num(rec.time);
  const open = num(rec.open);
  const high = num(rec.high);
  const low = num(rec.low);
  const close = num(rec.close);
  const volume = num(rec.volume) ?? 0;
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return { time, open, high, low, close, volume };
}

/**
 * Drop the still-open bar. The CLI's `last` is the timestamp of the last
 * closed candle (one interval before the tail). REST has no such field, so
 * the trailing row is dropped instead.
 */
function closedCandles(rows: Candle[], lastClosed: number | null, count: number): Candle[] {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  let closed = sorted;
  if (lastClosed != null) {
    closed = sorted.filter((candle) => candle.time <= lastClosed);
  } else if (sorted.length > 0) {
    closed = sorted.slice(0, -1);
  }
  if (count > 0 && closed.length > count) return closed.slice(-count);
  return closed;
}

function parseCliCandles(stdout: string, count: number): Candle[] {
  const parsed = JSON.parse(stdout) as { candles?: unknown; last?: unknown };
  const rows = Array.isArray(parsed.candles) ? parsed.candles.map(parseCandle).filter((c): c is Candle => c != null) : [];
  const last = num(parsed.last);
  return closedCandles(rows, last, count);
}

const REST_PAIR: Record<string, string> = {
  BTCUSD: 'XBTUSD',
  XBTUSD: 'XBTUSD',
};

async function fetchRestCandles(pair: string, intervalMin: number, count: number): Promise<Candle[]> {
  const restPair = REST_PAIR[pair.toUpperCase()] ?? pair.toUpperCase();
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(restPair)}&interval=${intervalMin}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OHLC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: Record<string, unknown> };
  const result = body.result ?? {};
  const series = Object.values(result).find((value) => Array.isArray(value)) as unknown[] | undefined;
  if (!series) return [];
  const rows: Candle[] = [];
  for (const item of series) {
    if (!Array.isArray(item) || item.length < 7) continue;
    const time = num(item[0]);
    const open = num(item[1]);
    const high = num(item[2]);
    const low = num(item[3]);
    const close = num(item[4]);
    const volume = num(item[6]) ?? 0;
    if (time == null || open == null || high == null || low == null || close == null) continue;
    rows.push({ time, open, high, low, close, volume });
  }
  return closedCandles(rows, null, count);
}

export async function getClosedCandles(pair: string, intervalMin = 60, count = 120): Promise<Candle[]> {
  const safeCount = Math.max(1, Math.min(720, Math.floor(count)));
  const safeInterval = Math.max(1, Math.floor(intervalMin));
  const key = `${pair.toUpperCase()}:${safeInterval}:${safeCount}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles;

  let candles: Candle[] = [];
  try {
    const stdout = await runCli(['ohlc', pair, '--interval', String(safeInterval), '-o', 'json']);
    candles = parseCliCandles(stdout, safeCount);
  } catch {
    candles = await fetchRestCandles(pair, safeInterval, safeCount);
  }
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

function parseLevels(rows: unknown): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const levels: BookLevel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const price = num(rec.price);
    const volume = num(rec.volume);
    if (price == null || volume == null || price <= 0 || volume < 0) continue;
    levels.push({ price, volume });
  }
  return levels;
}

export async function getOrderBook(pair: string, count = 25): Promise<OrderBook | null> {
  try {
    const stdout = await runCli(['orderbook', pair, '--count', String(Math.max(1, Math.min(100, count))), '-o', 'json']);
    const parsed = JSON.parse(stdout) as { bids?: unknown; asks?: unknown };
    return { bids: parseLevels(parsed.bids), asks: parseLevels(parsed.asks) };
  } catch {
    return null;
  }
}

/** Wilder-style simple mean of the last 14 true ranges. Null until 15 closes exist. */
export function atr14(candles: readonly Candle[]): number | null {
  if (candles.length < 15) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose));
    trs.push(tr);
  }
  const window = trs.slice(-14);
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

export function highestClose(candles: readonly Candle[], bars: number): number | null {
  const slice = candles.slice(-Math.max(1, bars));
  if (slice.length === 0) return null;
  return slice.reduce((max, candle) => (candle.close > max ? candle.close : max), slice[0].close);
}

export async function rollingHighClose(pair: string, bars = 24, intervalMin = 60): Promise<number | null> {
  const candles = await getClosedCandles(pair, intervalMin, Math.max(bars, 30));
  return highestClose(candles, bars);
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

export async function handleCandlesApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const raw = req.url || '/';
  const pathOnly = raw.split('?')[0] || '/';
  if (method !== 'GET' || pathOnly !== '/api/market/candles') return false;
  const query = new URL(raw, 'http://localhost').searchParams;
  const pair = (query.get('pair') || 'BTCUSD').toUpperCase();
  const interval = Number(query.get('interval') || '60');
  const count = Number(query.get('count') || '120');
  try {
    const candles = await getClosedCandles(pair, Number.isFinite(interval) ? interval : 60, Number.isFinite(count) ? count : 120);
    sendJson(res, 200, {
      pair,
      intervalMin: Number.isFinite(interval) ? interval : 60,
      closed: true,
      atr14: atr14(candles),
      candles,
    });
  } catch (error) {
    sendJson(res, 503, { error: String(error) });
  }
  return true;
}
