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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const current = req.url ?? '';
  if (!current.includes('/api/task')) {
    const query = current.includes('?') ? current.slice(current.indexOf('?')) : '';
    req.url = `/api/task${query}`;
  }

  try {
    // Loaded inside the handler so a module-init failure is returned as JSON.
    // A top-level import crash kills the Vercel isolate before this function runs.
    const { handleNeuralRequest } = await import('../backend/neuralRoutes');
    const handled = await handleNeuralRequest(req, res);
    if (!handled && !res.headersSent) {
      sendJson(res, 404, { error: `Unknown API route: ${req.method ?? 'GET'} ${req.url ?? ''}` });
    }
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  }
}
