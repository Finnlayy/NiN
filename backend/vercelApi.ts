import type { IncomingMessage, ServerResponse } from 'http';
import { multiProviderCore } from './multiProvider';
import { botRegistry } from './bots';
import { runAutoDcaWorker, getDcaDipStatus } from './autoDcaWorker';
import { handlePricesRequest } from './prices';
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

  if (method === 'GET' && (url === '/api/prices' || url === '/api/prices/')) {
    await handlePricesRequest(req, res);
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
      sendJson(res, 200, await botRegistry.getAllWithLivePrices());
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
  if (url === '/api/worker/dca/status' && method === 'GET') {
    sendJson(res, 200, await getDcaDipStatus(krakenExecutor));
    return true;
  }

  if (url === '/api/worker/dca' && (method === 'GET' || method === 'POST')) {
    await runAutoDcaWorker(res, krakenExecutor);
    return true;
  }

  return false;
}
