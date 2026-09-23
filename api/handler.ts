import type { IncomingMessage, ServerResponse } from 'http';
import { handleKrakenApi } from '../backend/krakenHttp';
import { KrakenOrderExecutor } from '../backend/kraken';

export const maxDuration = 60;

const krakenExecutor = new KrakenOrderExecutor();

/**
 * Vercel serves this for the Kraken routes rewritten in vercel.json.
 * req.url stays the public path, so /api/kraken/status reaches the CLI.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const handled = await handleKrakenApi(req, res, krakenExecutor);
    if (handled || res.headersSent) {
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    }
  }
}
