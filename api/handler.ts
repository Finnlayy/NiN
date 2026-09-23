import type { IncomingMessage, ServerResponse } from 'http';

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
 * Kraken routes on Vercel. Imports are inside the handler so a load
 * failure is returned as JSON instead of killing the function process.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { handleKrakenApi } = await import('../backend/krakenHttp');
    const { KrakenOrderExecutor } = await import('../backend/kraken');
    const handled = await handleKrakenApi(req, res, new KrakenOrderExecutor());
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
