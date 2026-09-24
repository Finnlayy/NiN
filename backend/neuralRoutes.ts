import { existsSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { InMemoryLearningStore } from '../src/learning/store';
import { createNeuralCoreMiddleware } from '../src/middleware';
import { InMemoryTelemetryStore } from '../src/telemetry';
import type { HttpRequest, HttpResponse, NextFunction } from '../src/types';
import type { LMStudioConfig } from './lmStudio';
import { multiProviderCore } from './multiProvider';
import type { OneProviderConfig } from './oneProvider';

type NeuralMiddleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: NextFunction,
) => Promise<void>;

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
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  return new URL(raw, 'http://localhost').pathname;
}

function templatePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'prompts', 'system', 'neural_core.yaml'),
    join(moduleDir, '..', 'prompts', 'system', 'neural_core.yaml'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`System template not found. Looked in ${candidates.join(', ')}`);
  }
  return found;
}

let vercelMiddleware: Promise<NeuralMiddleware> | null = null;

function middlewareForVercel(): Promise<NeuralMiddleware> {
  if (!vercelMiddleware) {
    vercelMiddleware = Promise.resolve(createNeuralCoreMiddleware({
      systemTemplatePath: templatePath(),
      complexityThreshold: 1,
      defaultPolitenessTier: 'neutral',
      telemetry: new InMemoryTelemetryStore(),
      coreAdapter: multiProviderCore,
      learning: { store: new InMemoryLearningStore() },
    }));
  }
  return vercelMiddleware;
}

function toResponse(res: ServerResponse): HttpResponse {
  let statusCode = 200;
  const response: HttpResponse = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      sendJson(res, statusCode, body);
      return response;
    },
  };
  return response;
}

function isNeuralRoute(method: string, url: string): boolean {
  if (method === 'GET' && url === '/api/ai/providers') return true;
  if (method === 'POST' && (url === '/api/ai/provider/select' || url === '/api/ai/provider/test' || url === '/api/ai/provider/config')) return true;
  if (method === 'POST' && url === '/api/task') return true;
  return false;
}

/**
 * Neural Konsole routes. On Vercel these run as a serverless function so
 * project env vars such as GEMINI_API_KEY are present. Returns false when
 * the request belongs to another route.
 */
export async function handleNeuralRequest(
  req: IncomingMessage,
  res: ServerResponse,
  middleware?: NeuralMiddleware,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = pathnameOf(req);
  if (!isNeuralRoute(method, url)) return false;

  if (method === 'GET' && url === '/api/ai/providers') {
    sendJson(res, 200, {
      activeProvider: multiProviderCore.getActiveProviderId(),
      providers: multiProviderCore.getProvidersInfo(),
    });
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/select') {
    try {
      const body = await readJsonBody(req);
      if (body.providerId && typeof body.providerId === 'string') {
        multiProviderCore.setActiveProviderId(body.providerId as 'gemini' | 'lm_studio' | 'oneprovider');
        sendJson(res, 200, {
          ok: true,
          activeProvider: multiProviderCore.getActiveProviderId(),
          providers: multiProviderCore.getProvidersInfo(),
        });
        return true;
      }
      sendJson(res, 400, { error: 'Missing providerId' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { error: message });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/test') {
    try {
      const body = await readJsonBody(req);
      const providerId = (typeof body.providerId === 'string' ? body.providerId : multiProviderCore.getActiveProviderId()) as 'gemini' | 'lm_studio' | 'oneprovider';
      const result = await multiProviderCore.testProvider(providerId);
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, message });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/ai/provider/config') {
    try {
      const body = await readJsonBody(req);
      const config = body.config;
      if (body.providerId === 'lm_studio' && config && typeof config === 'object') {
        multiProviderCore.updateLmStudioConfig(config as Partial<LMStudioConfig>);
      } else if (body.providerId === 'oneprovider' && config && typeof config === 'object') {
        multiProviderCore.updateOneProviderConfig(config as Partial<OneProviderConfig>);
      }
      sendJson(res, 200, {
        ok: true,
        providers: multiProviderCore.getProvidersInfo(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { error: message });
    }
    return true;
  }

  try {
    const body = await readJsonBody(req);
    const taskMiddleware = middleware ?? await middlewareForVercel();
    const middlewareReq: HttpRequest = {
      body: {
        taskDescription: typeof body.taskDescription === 'string' ? body.taskDescription : undefined,
        isComplexWorkflow: body.isComplexWorkflow === true,
        domainHint: body.domainHint as HttpRequest['body']['domainHint'],
        algorithmTag: typeof body.algorithmTag === 'string' ? body.algorithmTag : undefined,
        politenessTier: body.politenessTier as HttpRequest['body']['politenessTier'],
        previousInteractionId: typeof body.previousInteractionId === 'string' ? body.previousInteractionId : undefined,
      },
    };
    await taskMiddleware(middlewareReq, toResponse(res), (err) => {
      if (err && !res.headersSent) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        sendJson(res, 500, { error: message });
      }
    });
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Neural core did not produce a response.' });
    }
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : 'Invalid JSON body';
      sendJson(res, 400, { error: message });
    }
  }
  return true;
}
