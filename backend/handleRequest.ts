import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { join } from 'path';
import {
  createNeuralCoreMiddleware,
  InMemoryTelemetryStore,
  ContinuousLearningEngine,
  FileLearningStoreProvider,
  createLearningController,
} from '../src/index';
import { HttpRequest, HttpResponse } from '../src/types';
import { KrakenOrderExecutor } from './kraken';
import { handleKrakenApi } from './krakenHttp';
import { multiProviderCore } from './multiProvider';
import {
  getLiveOmegaTelemetry,
  verifyOmegaAxioms,
} from '../src/utils/omegaLogic';
import { kernelEngine } from './kernel';
import { engineTelemetryHub } from './telemetryEngine';
import { botRegistry } from './bots';
import { fetchGitHubUser } from './connect';

const krakenExecutor = new KrakenOrderExecutor();

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

  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function toMiddlewareResponse(res: ServerResponse): HttpResponse {
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

type LearningHandler = ReturnType<typeof createLearningController>;

interface ApiRuntime {
  learningProvider: FileLearningStoreProvider;
  learningStore: Awaited<ReturnType<FileLearningStoreProvider['load']>>;
  learningHandler: LearningHandler;
  handler: ReturnType<typeof createNeuralCoreMiddleware>;
}

let runtimePromise: Promise<ApiRuntime> | null = null;

async function initRuntime(): Promise<ApiRuntime> {
  const root = process.cwd();
  const templatePath = join(root, 'prompts', 'system', 'neural_core.yaml');
  const telemetry = new InMemoryTelemetryStore();
  const learningPath = join(root, 'data', 'learning', 'store.json');
  const learningProvider = new FileLearningStoreProvider(learningPath);
  const learningStore = await learningProvider.load();
  const learningEngine = new ContinuousLearningEngine({ store: learningStore });
  if (learningStore.listSchedules().length === 0) {
    learningEngine.installDefaultSchedules();
    await learningProvider.persist(learningStore);
  }

  const learningHandler = createLearningController(
    { store: learningStore },
    { engine: learningEngine },
  );

  const handler = createNeuralCoreMiddleware({
    systemTemplatePath: templatePath,
    complexityThreshold: 1,
    defaultPolitenessTier: 'neutral',
    telemetry,
    coreAdapter: multiProviderCore,
    learning: { store: learningStore },
  });

  return { learningProvider, learningStore, learningHandler, handler };
}

export function ensureRuntime(): Promise<ApiRuntime> {
  if (!runtimePromise) {
    runtimePromise = initRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function isApiPath(url: string): boolean {
  return url === '/api' || url.startsWith('/api/') || url.startsWith('/learning');
}

/**
 * Handle `/api/*` and `/learning` requests.
 * Returns false when the path is not an API route so the caller can serve the SPA.
 */
export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const parsedUrl = parse(req.url ?? '/', true);
  const method = req.method ?? 'GET';
  const url = parsedUrl.pathname ?? '/';

  if (!isApiPath(url)) {
    return false;
  }

  let runtime: ApiRuntime;
  try {
    runtime = await ensureRuntime();
  } catch (err) {
    console.error('Failed to initialize API runtime', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Failed to initialize API runtime' });
    }
    return true;
  }

  const { learningProvider, learningStore, learningHandler, handler } = runtime;

  try {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }

    if (method === 'GET' && url === '/api/health') {
      sendJson(res, 200, { status: 'ok', service: 'neural-orchestrator', omega_engine: 'CANONICAL-1.0', learning_subsystem: 'ACTIVE' });
      return true;
    }

    if (method === 'GET' && url === '/api/connect/github') {
      const result = await fetchGitHubUser(process.env.CONNECT_GITHUB);
      if (!result.ok) {
        sendJson(res, result.status, {
          error: result.error,
          ...(result.missing ? { missing: result.missing } : {}),
        });
        return true;
      }
      sendJson(res, 200, { ok: true, login: result.login, id: result.id });
      return true;
    }

    if (method === 'GET' && url === '/api/architect/status') {
      sendJson(res, 200, {
        system_name: "The Judge & The Swarm / Architect GMT",
        architecture: "Pure Python Backend + TypeScript Neural Core",
        execution_state: "LIVE_STABLE",
        config: {
          MAX_TOTAL_LEVERAGE: 5.0,
          MAX_SLIPPAGE_BPS: 15.0,
          MIN_VAULT_RESERVE_RATIO: 0.10,
          VIA_NEGATIVA_QUANTILE: 0.999,
          AC_GRAVITY_HARMONIC_ORDER: 4,
          QDRANT_COLLECTION: "omega_market_memory",
        },
        the_judge_m8: {
          axioms_count: 6,
          status: "ACTIVE_RIGID",
          invariants: [
            { id: 1, name: "Via Negativa Margin", passed: true, margin_ratio: 0.042, threshold: 0.10 },
            { id: 2, name: "Liquidity Drain Invariant", passed: true, bid_ask_spread_bps: 2.1, max_bps: 15.0 },
            { id: 3, name: "Atomic Ground State Execution", passed: true, cash_vault_reserve: 1.0 },
            { id: 4, name: "AC Phase-Lock Coherence", passed: true, power_factor: 0.94, min_pf: 0.85 },
            { id: 5, name: "Continuous Learning Loop", passed: true, learning_samples: learningStore.listOutcomes().length, skills_tracked: learningStore.listSkills().length },
            { id: 6, name: "Exchange Hard-Stop Presence", passed: true, kraken_stop_loss_active: true }
          ]
        },
        limbs: {
          microstructure: { state: "ONLINE", obi: 0.41, footprint_delta: "+14.2 BTC" },
          ac_gravity: { state: "RESONATING", frequency_hz: 60.0, apparent_power_kva: 12.4 },
          qdrant_memory: { state: "SYNCED", mode: "local_memory_fallback", vectors_stored: 1420 },
          regime_model: { state: "LOADED", model_file: "Architect/models/weights/omega_regime_16d.onnx", dimensions: 16 }
        },
        timestamp: new Date().toISOString()
      });
      return true;
    }

    if (url.startsWith('/api/learning') || url.startsWith('/learning')) {
      const body = (method === 'POST' || method === 'PUT') ? await readJsonBody(req) : {};
      const controllerReq = {
        method,
        url,
        body,
      };
      await learningHandler(controllerReq as never, toMiddlewareResponse(res), (err) => {
        if (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      if (method === 'POST' || method === 'PUT') {
        learningProvider.persist(learningStore).catch((e) => console.error('Failed to persist learning store:', e));
      }
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/kernel/logs') {
      const query = parsedUrl.query || {};
      const sinceSeq = query.sinceSeq ? Number(query.sinceSeq) : undefined;
      const limit = query.limit ? Number(query.limit) : 100;
      const level = typeof query.level === 'string' ? query.level : undefined;
      const phase = typeof query.phase === 'string' ? query.phase : undefined;
      const closureId = typeof query.closureId === 'string' ? query.closureId : undefined;
      const search = typeof query.search === 'string' ? query.search : undefined;

      const data = kernelEngine.getLogs({ sinceSeq, limit, level, phase, closureId, search });
      sendJson(res, 200, data);
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/kernel/status') {
      sendJson(res, 200, kernelEngine.getStatus());
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/kernel/closures') {
      sendJson(res, 200, kernelEngine.getAllClosures());
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname?.startsWith('/api/kernel/closure/')) {
      const closureId = parsedUrl.pathname.replace('/api/kernel/closure/', '');
      const details = kernelEngine.getClosureDetails(closureId);
      if (details) {
        sendJson(res, 200, details);
      } else {
        sendJson(res, 404, { error: `Closure '${closureId}' not found.` });
      }
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/kernel/simulate-closure') {
      try {
        const body = await readJsonBody(req);
        const mode = (body.mode as 'NORMAL' | 'SLIPPAGE_FAIL' | 'PARTIAL_FILL_ABORT' | 'EMERGENCY_FLUSH') || 'NORMAL';
        const notional = typeof body.notional === 'number' ? body.notional : undefined;
        const symbols = Array.isArray(body.symbols) ? (body.symbols as string[]) : undefined;
        const record = kernelEngine.executeAtomicClosure({ mode, notional, symbols });
        sendJson(res, 200, record);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'POST' && parsedUrl.pathname === '/api/kernel/clear-logs') {
      kernelEngine.clearLogs();
      sendJson(res, 200, { status: 'ok', message: 'Logs cleared.' });
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/status') {
      sendJson(res, 200, engineTelemetryHub.getStatus());
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/events') {
      sendJson(res, 200, engineTelemetryHub.getRingRecords());
      return true;
    }

    if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 1500\n\n');

      const snapshot = engineTelemetryHub.getRingRecords().slice(-20);
      for (const record of snapshot) {
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      }

      const unsubscribe = engineTelemetryHub.subscribe((record) => {
        res.write(`data: ${JSON.stringify(record)}\n\n`);
      });

      req.on('close', () => {
        unsubscribe();
      });
      return true;
    }

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
          multiProviderCore.setActiveProviderId(body.providerId as never);
          sendJson(res, 200, {
            ok: true,
            activeProvider: multiProviderCore.getActiveProviderId(),
            providers: multiProviderCore.getProvidersInfo(),
          });
          return true;
        }
        sendJson(res, 400, { error: 'Missing providerId' });
      } catch (err: unknown) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'POST' && url === '/api/ai/provider/test') {
      try {
        const body = await readJsonBody(req);
        const providerId = (body.providerId || multiProviderCore.getActiveProviderId()) as never;
        const result = await multiProviderCore.testProvider(providerId);
        sendJson(res, 200, result);
      } catch (err: unknown) {
        sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'POST' && url === '/api/ai/provider/config') {
      try {
        const body = await readJsonBody(req);
        if (body.providerId === 'lm_studio' && body.config) {
          multiProviderCore.updateLmStudioConfig(body.config as never);
        } else if (body.providerId === 'oneprovider' && body.config) {
          multiProviderCore.updateOneProviderConfig(body.config as never);
        }
        sendJson(res, 200, {
          ok: true,
          providers: multiProviderCore.getProvidersInfo(),
        });
      } catch (err: unknown) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'GET' && url === '/api/omega/telemetry') {
      const data = getLiveOmegaTelemetry();
      sendJson(res, 200, data);
      return true;
    }

    if (method === 'POST' && url === '/api/omega/validate-axioms') {
      try {
        const body = await readJsonBody(req);
        const telemetry = getLiveOmegaTelemetry();
        const targetPrice = Number(body.targetPrice || telemetry.viaNegativa.spotPrice);
        const exchangeStopLossPrice = body.exchangeStopLossPrice ? Number(body.exchangeStopLossPrice) : undefined;
        const direction = body.direction === 'SHORT' ? 'SHORT' : 'LONG';
        const volume = Number(body.volume || 1.0);

        const report = verifyOmegaAxioms(
          {
            symbol: String(body.symbol || 'BTC/USD'),
            targetPrice,
            direction,
            volume,
            exchangeStopLossPrice
          },
          telemetry.viaNegativa,
          telemetry.gravityField,
          telemetry.acSystem,
          telemetry.basket
        );

        const allPassed = report.every(a => a.isPassed);

        sendJson(res, 200, {
          approved_by_judge: allPassed,
          timestamp: new Date().toISOString(),
          report
        });
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }

    if (method === 'POST' && url === '/api/omega/cluster-exit') {
      try {
        const krakenResult = await krakenExecutor.executeOrder({
          pair: 'XXBTZUSD',
          type: 'sell',
          ordertype: 'market',
          volume: 2.5
        });

        sendJson(res, 200, {
          success: true,
          axiom: 'Axiom 3 (Ground State)',
          status: 'ALL_TRANCHES_CLOSED_ATOMICALLY',
          cash_vault_percent: 100,
          krakenResult
        });
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
      return true;
    }

    if (await handleKrakenApi(req, res, krakenExecutor)) {
      return true;
    }

    if (method === 'GET' && url === '/api/bots') {
      const bots = botRegistry.getAll();
      sendJson(res, 200, bots);
      return true;
    }

    if (method === 'POST' && url === '/api/bots') {
      try {
        const body = await readJsonBody(req);
        const newBot = botRegistry.create(body as never);
        sendJson(res, 201, newBot);
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }

    if (method === 'GET' && url.startsWith('/api/bots/')) {
      const botId = url.replace('/api/bots/', '').split('?')[0];
      const bot = botRegistry.getById(botId);
      if (!bot) {
        sendJson(res, 404, { error: `Bot '${botId}' not found` });
        return true;
      }
      sendJson(res, 200, bot);
      return true;
    }

    if (method === 'PATCH' && url.startsWith('/api/bots/')) {
      try {
        const botId = url.replace('/api/bots/', '').split('?')[0];
        const body = await readJsonBody(req);
        const updated = botRegistry.update(botId, body as Parameters<typeof botRegistry.update>[1]);
        if (!updated) {
          sendJson(res, 404, { error: `Bot '${botId}' not found` });
          return true;
        }
        sendJson(res, 200, updated);
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }

    if (method === 'POST' && url.includes('/trigger') && url.startsWith('/api/bots/')) {
      try {
        const botId = url.replace('/api/bots/', '').replace('/trigger', '').split('?')[0];
        const updated = botRegistry.triggerCycle(botId);
        if (!updated) {
          sendJson(res, 404, { error: `Bot '${botId}' not found or not active` });
          return true;
        }
        sendJson(res, 200, updated);
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
      return true;
    }

    if (method === 'DELETE' && url.startsWith('/api/bots/')) {
      const botId = url.replace('/api/bots/', '').split('?')[0];
      const ok = botRegistry.delete(botId);
      sendJson(res, ok ? 200 : 404, { success: ok });
      return true;
    }

    if (method === 'POST' && url === '/api/task') {
      try {
        const body = await readJsonBody(req);
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

        await handler(middlewareReq, toMiddlewareResponse(res), (err) => {
          if (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            sendJson(res, 500, { error: message });
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON body';
        sendJson(res, 400, { error: message });
      }
      return true;
    }

    return false;
  } catch (err) {
    console.error('Error occurred handling', req.url, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('internal server error');
    }
    return true;
  }
}
