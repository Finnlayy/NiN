import type { IncomingMessage, ServerResponse } from 'http';

export const maxDuration = 300;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * One Node.js function on Fluid Compute for every API route except
 * `/api/kraken/status`, which stays on `api/kraken/status.js`.
 * Imports stay inside the handler so a load failure is returned as JSON.
 * `req.url` stays the original path after the vercel.json rewrite.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { handleRequest } = await import('../backend/handleRequest');
    const handled = await handleRequest(req, res);
    if (handled || res.headersSent) {
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    }
  }
}
