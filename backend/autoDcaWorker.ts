import type { ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { KrakenOrderExecutor } from './kraken';

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
// no-op unless explicitly armed with KRAKEN_AUTO_DCA=true AND API credentials
// are present. Fires only on a >= 2.5% dip versus the stored reference price.
// ---------------------------------------------------------------------------

const DCA_REFERENCE_FILE = vercelTmp('dca-reference.json');
const DCA_CONFIG = [
  { limb: 4 as const, asset: 'BTC' as const, pair: 'BTCUSD', amountUSD: 150, dipThresholdPct: -2.5 },
  { limb: 5 as const, asset: 'SOL' as const, pair: 'SOLUSD', amountUSD: 75, dipThresholdPct: -2.5 },
];

function loadDcaReferences(): Record<string, number> {
  try {
    if (existsSync(DCA_REFERENCE_FILE)) {
      return JSON.parse(readFileSync(DCA_REFERENCE_FILE, 'utf-8'));
    }
  } catch {
    /* fall through to empty */
  }
  return {};
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
  if (!executor.hasApiCredentials()) {
    sendJson(res, 200, { ran: false, reason: 'NO_CREDENTIALS', hint: 'KRAKEN_API_KEY / KRAKEN_API_SECRET missing.' });
    return;
  }

  const references = loadDcaReferences();
  const results: Array<Record<string, unknown>> = [];

  for (const cfg of DCA_CONFIG) {
    const last = await executor.getSpotPrice(cfg.pair);
    if (!last) {
      results.push({ asset: cfg.asset, action: 'SKIPPED', reason: 'NO_TICKER' });
      continue;
    }
    const reference = references[cfg.asset];
    if (!reference) {
      references[cfg.asset] = last;
      results.push({ asset: cfg.asset, action: 'BASELINE_SET', reference: last });
      continue;
    }
    const dipPct = ((last - reference) / reference) * 100;
    if (dipPct <= cfg.dipThresholdPct) {
      const order = await executor.executeDca(cfg.limb, cfg.asset, cfg.amountUSD);
      // Only re-baseline the reference when Kraken actually accepted the
      // order — on a rejection the dip stays armed for the next run.
      if (order.success) {
        references[cfg.asset] = last;
      }
      results.push({
        asset: cfg.asset,
        action: order.success ? 'DCA_EXECUTED' : 'DCA_REJECTED',
        dipPct: Number(dipPct.toFixed(2)),
        status: order.status ?? null,
        txid: order.txid ?? null,
        error: order.error ?? null,
        order,
      });
    } else {
      results.push({ asset: cfg.asset, action: 'NO_DIP', dipPct: Number(dipPct.toFixed(2)), reference });
    }
  }

  try {
    writeFileSync(DCA_REFERENCE_FILE, JSON.stringify(references), 'utf-8');
  } catch {
    /* /tmp write failure is non-fatal; next run re-baselines */
  }

  sendJson(res, 200, { ran: true, armed: true, results, checkedAt: new Date().toISOString() });
}
