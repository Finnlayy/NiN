import type { IncomingMessage, ServerResponse } from 'http';
import { handleKrakenApi } from './krakenHttp';
import { handleVercelApi } from './vercelApi';
import { KrakenOrderExecutor } from './kraken';

export const maxDuration = 60;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Vercel entry for the shared API function (api/handler.js is a CJS shim
 * requiring the esbuild bundle of this file — see scripts/build-api.mjs).
 * Bundling everything into one CJS file avoids the @vercel/node TS
 * compilation issues that made the previous api/handler.ts crash at
 * invocation time (the same reason api/kraken/status.js is hand-written
 * CommonJS).
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const executor = new KrakenOrderExecutor();

    // Routes that only exist on the dev server get a Vercel function here:
    // /api/health, /api/ai/*, /api/bots*, /api/worker/dca
    if (await handleVercelApi(req, res, executor)) {
      return;
    }

    const handled = await handleKrakenApi(req, res, executor);
    if (handled || res.headersSent) {
      return;
    }
    sendJson(res, 404, { error: 'Not found', url: req.url || '' });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    }
  }
}
