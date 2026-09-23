import type { IncomingMessage, ServerResponse } from 'http';
import { handleKrakenApi } from '../backend/krakenHttp';
import { KrakenOrderExecutor } from '../backend/kraken';

export const maxDuration = 60;

const krakenExecutor = new KrakenOrderExecutor();

/**
 * Vercel serves this for the Kraken routes rewritten in vercel.json.
 * req.url stays the public path, so /api/kraken/status reaches the CLI.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const handled = await handleKrakenApi(req, res, krakenExecutor);
  if (handled || res.headersSent) {
    return;
  }
  const payload = JSON.stringify({ error: 'Not found' });
  res.writeHead(404, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
