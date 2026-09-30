import type { IncomingMessage, ServerResponse } from 'http';
import { handleKrakenApi } from './krakenHttp';
import { handleVercelApi } from './vercelApi';
import { handleRequest } from './handleRequest';
import { KrakenOrderExecutor } from './kraken';

export const maxDuration = 60;

// Module-level singleton: keeps in-memory state (recent order history) across
// warm invocations of this function. A per-request executor would silently
// drop the order history every time.
const sharedExecutor = new KrakenOrderExecutor();

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
    const executor = sharedExecutor;

    // Routes that only exist on the dev server get a Vercel function here:
    // /api/health, /api/ai/*, /api/bots*, /api/worker/dca
    if (await handleVercelApi(req, res, executor)) {
      return;
    }

    if (await handleKrakenApi(req, res, executor)) {
      return;
    }

    // Learning, kernel, omega, Connect, and task routes from the dev server.
    // Kraken, prices, bots, health, and the DCA worker already returned above,
    // so they keep the shared executor and the live-price bot list.
    if (await handleRequest(req, res)) {
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
