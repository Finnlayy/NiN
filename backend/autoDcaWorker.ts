import type { ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLivePrices } from './prices';
import { getJson, setJson } from './stateStore';
import { executionMode, type KrakenOrderExecutor } from './kraken';
import { rollingHighClose } from './candles';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function vercelTmp(file: string): string {
  return join(process.env.VERCEL === '1' ? tmpdir() : process.cwd(), file);
}

// ---------------------------------------------------------------------------
// Automatic DCA worker (L4 BTC / L5 SOL)
// Runs via Vercel Cron (see vercel.json -> crons). Guarded so it is a safe
// no-op unless explicitly armed with KRAKEN_AUTO_DCA=true. The dip is measured
// against the highest close of the last 24 closed 1h candles. A stored mark
// only stops a second buy against that same high. Paper mode does not need
// live API credentials.
// ---------------------------------------------------------------------------

const DCA_REFERENCE_FILE = vercelTmp('dca-reference.json');
const DCA_CONFIG = [
  { limb: 4 as const, asset: 'BTC' as const, pair: 'BTCUSD', amountUSD: 150, dipThresholdPct: -2.5 },
  { limb: 5 as const, asset: 'SOL' as const, pair: 'SOLUSD', amountUSD: 75, dipThresholdPct: -2.5 },
];

/**
 * Dip references, durably: the durable store wins (survives redeploys), the
 * local file is the fallback for un-provisioned deploys and local dev.
 */
interface DipMark {
  high: number;
}

function normalizeMarks(raw: unknown): Record<string, DipMark> {
  const out: Record<string, DipMark> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && typeof (value as DipMark).high === 'number') {
      out[key] = { high: (value as DipMark).high };
    }
  }
  return out;
}

async function loadDcaReferences(): Promise<Record<string, DipMark>> {
  const stored = await getJson<Record<string, DipMark | number>>('nin:dca:references');
  const fromStore = normalizeMarks(stored);
  if (Object.keys(fromStore).length > 0) return fromStore;
  try {
    if (existsSync(DCA_REFERENCE_FILE)) {
      return normalizeMarks(JSON.parse(readFileSync(DCA_REFERENCE_FILE, 'utf-8')));
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

function boughtHigh(value: DipMark | number | undefined): number | null {
  if (!value || typeof value === 'number') return null;
  return typeof value.high === 'number' && Number.isFinite(value.high) ? value.high : null;
}

/** Persist references both locally and durably; both writes best-effort. */
function saveDcaReferences(references: Record<string, DipMark>): void {
  try {
    writeFileSync(DCA_REFERENCE_FILE, JSON.stringify(references), 'utf-8');
  } catch {
    /* /tmp write failure is non-fatal; next run re-baselines */
  }
  setJson('nin:dca:references', references);
}

/**
 * Read-only dip status for alerting: reports each configured asset's live
 * price, stored reference and distance to the buy trigger — WITHOUT placing
 * orders or touching the references. Poll-friendly.
 *
 * Prices come from the Kraken stream (the same venue the orders execute on,
 * and the same source the references were baselined from); CoinGecko only
 * covers an asset if the Kraken ticker is unreachable.
 */
export async function getDcaDipStatus(executor?: KrakenOrderExecutor): Promise<Record<string, unknown>> {
  const references = await loadDcaReferences();
  let prices: Record<string, number>;
  let source: string;
  if (executor) {
    const kraken = await executor.getSymbolTickers();
    prices = { ...kraken.prices };
    const missing = DCA_CONFIG.filter((cfg) => typeof prices[cfg.asset] !== 'number');
    source = missing.length === 0 ? 'kraken' : 'kraken+coingecko-fallback';
    if (missing.length > 0) {
      try {
        const cg = await getLivePrices();
        for (const cfg of missing) {
          const value = cg.prices[cfg.asset];
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            prices[cfg.asset] = value;
          }
        }
      } catch {
        /* keep whatever Kraken returned */
      }
    }
  } else {
    const cg = await getLivePrices();
    prices = cg.prices;
    source = cg.source;
  }
  const assets = [];
  for (const cfg of DCA_CONFIG) {
    const last = prices[cfg.asset] ?? null;
    const reference = await rollingHighClose(cfg.pair, 24, 60);
    const dipPct = last && reference ? Number((((last - reference) / reference) * 100).toFixed(2)) : null;
    const nearTrigger = typeof dipPct === 'number' && dipPct <= cfg.dipThresholdPct + 1.0;
    assets.push({
      asset: cfg.asset,
      pair: cfg.pair,
      amountUSD: cfg.amountUSD,
      thresholdPct: cfg.dipThresholdPct,
      last,
      reference,
      referenceSource: '24h-closed-high',
      boughtHigh: boughtHigh(references[cfg.asset]),
      dipPct,
      nearTrigger,
      needsBaseline: reference == null,
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    priceSource: source,
    armed: process.env.KRAKEN_AUTO_DCA === 'true',
    assets,
  };
}

export async function runAutoDcaWorker(res: ServerResponse, executor: KrakenOrderExecutor): Promise<void> {
  if (process.env.KRAKEN_AUTO_DCA !== 'true') {
    sendJson(res, 200, {
      ran: false,
      reason: 'AUTO_DCA_DISABLED',
      hint: 'Set KRAKEN_AUTO_DCA=true (plus KRAKEN_API_KEY / KRAKEN_API_SECRET) to arm automatic DCA execution.',
    });
    return;
  }
  if (!executor.hasApiCredentials() && executionMode() !== 'paper') {
    sendJson(res, 200, { ran: false, reason: 'NO_CREDENTIALS', hint: 'KRAKEN_API_KEY / KRAKEN_API_SECRET missing.' });
    return;
  }

  const references = await loadDcaReferences();
  const results: Array<Record<string, unknown>> = [];

  for (const cfg of DCA_CONFIG) {
    const last = await executor.getSpotPrice(cfg.pair);
    if (!last) {
      results.push({ asset: cfg.asset, action: 'SKIPPED', reason: 'NO_TICKER' });
      continue;
    }
    const reference = await rollingHighClose(cfg.pair, 24, 60);
    if (!reference) {
      results.push({ asset: cfg.asset, action: 'SKIPPED', reason: 'NO_CANDLES' });
      continue;
    }
    const dipPct = ((last - reference) / reference) * 100;
    const alreadyBought = boughtHigh(references[cfg.asset]);
    if (dipPct <= cfg.dipThresholdPct) {
      if (alreadyBought != null && alreadyBought === reference) {
        results.push({
          asset: cfg.asset,
          action: 'DIP_ALREADY_BOUGHT',
          dipPct: Number(dipPct.toFixed(2)),
          reference,
        });
        continue;
      }
      const order = await executor.executeDca(cfg.limb, cfg.asset, cfg.amountUSD);
      if (order.success) {
        references[cfg.asset] = { high: reference };
      }
      results.push({
        asset: cfg.asset,
        action: order.success ? 'DCA_EXECUTED' : 'DCA_REJECTED',
        dipPct: Number(dipPct.toFixed(2)),
        reference,
        status: order.status ?? null,
        txid: order.txid ?? null,
        error: order.error ?? null,
        order,
      });
    } else {
      results.push({ asset: cfg.asset, action: 'NO_DIP', dipPct: Number(dipPct.toFixed(2)), reference });
    }
  }

  saveDcaReferences(references);

  sendJson(res, 200, { ran: true, armed: true, results, checkedAt: new Date().toISOString() });
}
