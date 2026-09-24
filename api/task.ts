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
  if (req.method !== 'POST') {
    sendJson(res, 200, {
      ok: true,
      method: req.method ?? 'GET',
      url: req.url ?? '',
      geminiKey: Boolean(process.env.GEMINI_API_KEY),
      oneProviderKey: Boolean(process.env.ONEPROVIDER_KEY),
    });
    return;
  }

  try {
    const { handleNeuralRequest } = await import('../backend/neuralRoutes');
    const handled = await handleNeuralRequest(req, res);
    if (!handled && !res.headersSent) {
      sendJson(res, 404, { error: 'Neural route was not handled.' });
    }
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  }
}
