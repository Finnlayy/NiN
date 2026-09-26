import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { multiProviderCore } from './multiProvider';
import { botRegistry } from './bots';
import type { KrakenOrderExecutor } from './kraken';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

async function runAutoDcaWorker(res: ServerResponse, executor: KrakenOrderExecutor): Promise<void> {
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
      references[cfg.asset] = last;
      results.push({ asset: cfg.asset, action: 'DCA_EXECUTED', dipPct: Number(dipPct.toFixed(2)), order });
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

/**
 * Routes the API surface that the dev server (backend/server.ts) exposes but
 * which has no Vercel function of its own. Returns true when the request was
 * handled here.
 */
export async function handleVercelApi(req: IncomingMessage, res: ServerResponse, krakenExecutor: KrakenOrderExecutor): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/api/health') {
    sendJson(res, 200, { status: 'ok', service: 'neural-orchestrator', omega_engine: 'CANONICAL-1.0', learning_subsystem: 'ACTIVE' });
    return true;
  }

  // --- AI Provider Management -------------------------------------------
  if (method === 'GET' && url === '/api/ai/providers') {
    sendJson(res, 200, {
      activeProvider: multiProviderCore.getActiveProviderId(),
      providers: multiProviderCore.getProvidersInfo(),
    });
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/select') {
    try {
      const body = await readJsonBody(req);
      if (body.providerId && typeof body.providerId === 'string') {
        multiProviderCore.setActiveProviderId(body.providerId as any);
        sendJson(res, 200, {
          ok: true,
          activeProvider: multiProviderCore.getActiveProviderId(),
          providers: multiProviderCore.getProvidersInfo(),
        });
        return true;
      }
      sendJson(res, 400, { error: 'Missing providerId' });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/test') {
    try {
      const body = await readJsonBody(req);
      const providerId = (body.providerId || multiProviderCore.getActiveProviderId()) as any;
      const result = await multiProviderCore.testProvider(providerId);
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/config') {
    try {
      const body = await readJsonBody(req);
      if (body.providerId === 'lm_studio' && body.config) {
        multiProviderCore.updateLmStudioConfig(body.config as any);
      } else if (body.providerId === 'oneprovider' && body.config) {
        multiProviderCore.updateOneProviderConfig(body.config as any);
      }
      sendJson(res, 200, { ok: true, providers: multiProviderCore.getProvidersInfo() });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  // --- Bot Fleet ----------------------------------------------------------
  if (url === '/api/bots' || url.startsWith('/api/bots/')) {
    const botId = url.startsWith('/api/bots/') ? url.replace('/api/bots/', '').replace('/trigger', '') : null;

    if (method === 'GET' && url === '/api/bots') {
      sendJson(res, 200, botRegistry.getAll());
      return true;
    }
    if (method === 'POST' && url === '/api/bots') {
      try {
        const body = await readJsonBody(req);
        sendJson(res, 201, botRegistry.create(body as any));
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }
    if (method === 'GET' && botId) {
      const bot = botRegistry.getById(botId);
      sendJson(res, bot ? 200 : 404, bot ?? { error: `Bot '${botId}' not found` });
      return true;
    }
    if (method === 'PATCH' && botId) {
      try {
        const body = await readJsonBody(req);
        const updated = botRegistry.update(botId, body);
        sendJson(res, updated ? 200 : 404, updated ?? { error: `Bot '${botId}' not found` });
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }
    if (method === 'POST' && botId && url.endsWith('/trigger')) {
      try {
        const updated = botRegistry.triggerCycle(botId);
        sendJson(res, updated ? 200 : 404, updated ?? { error: `Bot '${botId}' not found or not active` });
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }
    if (method === 'DELETE' && botId) {
      const ok = botRegistry.delete(botId);
      sendJson(res, ok ? 200 : 404, { success: ok });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  // --- Automatic DCA worker (Vercel Cron target) --------------------------
  if (url === '/api/worker/dca' && (method === 'GET' || method === 'POST')) {
    await runAutoDcaWorker(res, krakenExecutor);
    return true;
  }

  return false;
}
