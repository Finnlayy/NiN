import type { IncomingMessage, ServerResponse } from 'http';
import { handleRequest } from '../backend/handleRequest';

export const maxDuration = 300;

/**
 * One Node.js function on Fluid Compute for every API route.
 * With the Vite framework, `vercel dev` serves exact files under `api/` and
 * does not register an optional catch-all, so `vercel.json` rewrites
 * `/api/*` and `/learning` to this file. `req.url` stays the original path.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const handled = await handleRequest(req, res);
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
