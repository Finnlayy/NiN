import type { IncomingMessage, ServerResponse } from 'http';
import { KrakenOrderExecutor } from './kraken';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

function requestPath(req: IncomingMessage): string {
  const raw = req.url || '/';
  return raw.split('?')[0] || '/';
}

/**
 * Kraken routes shared by the standalone server and the Vercel function.
 * Returns true when this request was a Kraken route.
 */
export async function handleKrakenApi(
  req: IncomingMessage,
  res: ServerResponse,
  krakenExecutor: KrakenOrderExecutor
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = requestPath(req);

  if (method === 'OPTIONS' && (url.startsWith('/api/kraken') || url === '/api/execute-kraken' || url === '/api/execute-order')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  if (method === 'POST' && url === '/api/execute-kraken') {
    try {
      const body = await readJsonBody(req);
      const result = await krakenExecutor.executeCommand(String(body.command ?? ''));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/execute-order') {
    try {
      const body = await readJsonBody(req);
      const result = await krakenExecutor.executeOrder({
        pair: String(body.pair),
        type: body.type === 'sell' ? 'sell' : 'buy',
        ordertype: body.ordertype === 'market' ? 'market' : 'limit',
        volume: Number(body.volume),
        price: body.price ? Number(body.price) : undefined,
      });
      sendJson(res, result.success ? 200 : result.connected ? 400 : 503, result);
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
    }
    return true;
  }

  if (method === 'GET' && url === '/api/kraken/status') {
    const status = await krakenExecutor.getExecutionStatus();
    sendJson(res, 200, status);
    return true;
  }

  if (method === 'POST' && url === '/api/kraken/dca') {
    try {
      const body = await readJsonBody(req);
      const limb = body.limb === 5 ? 5 : 4;
      const asset = body.asset === 'SOL' ? 'SOL' : 'BTC';
      const amount = Number(body.amountUSD) || (asset === 'BTC' ? 150 : 75);
      const result = await krakenExecutor.executeDca(limb, asset, amount);

      if (!result.success) {
        sendJson(res, result.connected ? 400 : 503, {
          success: false,
          limb: `Limb ${limb} (${asset} Dca)`,
          amountUSD: amount,
          orderResult: result,
          error: result.error,
        });
        return true;
      }

      sendJson(res, 200, {
        success: true,
        limb: `Limb ${limb} (${asset} Dca)`,
        amountUSD: amount,
        orderResult: result,
      });
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
    }
    return true;
  }

  return false;
}
