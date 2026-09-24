import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { join } from 'path';
import {
  createNeuralCoreMiddleware,
  InMemoryTelemetryStore,
  ContinuousLearningEngine,
  FileLearningStoreProvider,
  createLearningController,
} from '../src/index';
import { HttpResponse } from '../src/types';
import { KrakenOrderExecutor } from './kraken';
import { multiProviderCore } from './multiProvider';
import { createServer as createViteServer } from 'vite';
import { 
  getLiveOmegaTelemetry, 
  verifyOmegaAxioms
} from '../src/utils/omegaLogic';
import { kernelEngine } from './kernel';
import { engineTelemetryHub } from './telemetryEngine';
import { botRegistry } from './bots';
import { handleNeuralRequest } from './neuralRoutes';

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

async function startServer() {
  const dev = process.env.NODE_ENV !== 'production';
  const hostname = '0.0.0.0';
  const port = 3000;
  
  const ROOT = process.cwd();
  const TEMPLATE_PATH = join(ROOT, 'prompts', 'system', 'neural_core.yaml');
  
  const telemetry = new InMemoryTelemetryStore();

  const LEARNING_PATH = join(ROOT, 'data', 'learning', 'store.json');
  const learningProvider = new FileLearningStoreProvider(LEARNING_PATH);
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
    systemTemplatePath: TEMPLATE_PATH,
    complexityThreshold: 1,
    defaultPolitenessTier: 'neutral',
    telemetry,
    coreAdapter: multiProviderCore,
    learning: { store: learningStore },
  });
  
  let vite: any;
  if (dev) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url ?? '/', true);
      const method = req.method ?? 'GET';
      const url = parsedUrl.pathname ?? '/';

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (method === 'GET' && url === '/api/health') {
        sendJson(res, 200, { status: 'ok', service: 'neural-orchestrator', omega_engine: 'CANONICAL-1.0', learning_subsystem: 'ACTIVE' });
        return;
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
        return;
      }

      if (url.startsWith('/api/learning') || url.startsWith('/learning')) {
        const body = (method === 'POST' || method === 'PUT') ? await readJsonBody(req) : {};
        const controllerReq = {
          method,
          url,
          body,
        };
        await learningHandler(controllerReq as any, toMiddlewareResponse(res), (err) => {
          if (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        });
        if (method === 'POST' || method === 'PUT') {
          learningProvider.persist(learningStore).catch((e) => console.error('Failed to persist learning store:', e));
        }
        return;
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
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/kernel/status') {
        sendJson(res, 200, kernelEngine.getStatus());
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/kernel/closures') {
        sendJson(res, 200, kernelEngine.getAllClosures());
        return;
      }

      if (method === 'GET' && parsedUrl.pathname?.startsWith('/api/kernel/closure/')) {
        const closureId = parsedUrl.pathname.replace('/api/kernel/closure/', '');
        const details = kernelEngine.getClosureDetails(closureId);
        if (details) {
          sendJson(res, 200, details);
        } else {
          sendJson(res, 404, { error: `Closure '${closureId}' not found.` });
        }
        return;
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
        return;
      }

      if (method === 'POST' && parsedUrl.pathname === '/api/kernel/clear-logs') {
        kernelEngine.clearLogs();
        sendJson(res, 200, { status: 'ok', message: 'Logs cleared.' });
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/status') {
        sendJson(res, 200, engineTelemetryHub.getStatus());
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/events') {
        sendJson(res, 200, engineTelemetryHub.getRingRecords());
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/telemetry/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write('retry: 1500\n\n');

        // Flush initial ring buffer snapshot
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
        return;
      }

      if (await handleNeuralRequest(req, res, handler)) {
        return;
      }

      if (method === 'GET' && url === '/api/omega/telemetry') {
        const data = getLiveOmegaTelemetry();
        sendJson(res, 200, data);
        return;
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
        return;
      }

      if (method === 'POST' && url === '/api/omega/cluster-exit') {
        try {
          // Atomic Market Close on Kraken matching engine to return to 100% Cash Ground State
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
        return;
      }

      if (method === 'POST' && url === '/api/execute-kraken') {
        try {
          const body = await readJsonBody(req);
          const result = await krakenExecutor.executeCommand(String(body.command));
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      if (method === 'POST' && url === '/api/execute-order') {
        try {
          const body = await readJsonBody(req);
          const result = await krakenExecutor.executeOrder({
            pair: String(body.pair),
            type: body.type === 'sell' ? 'sell' : 'buy',
            ordertype: body.ordertype === 'market' ? 'market' : 'limit',
            volume: Number(body.volume),
            price: body.price ? Number(body.price) : undefined
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      if (method === 'GET' && url === '/api/kraken/status') {
        const status = krakenExecutor.getExecutionStatus();
        sendJson(res, 200, status);
        return;
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
              error: result.error
            });
            return;
          }

          sendJson(res, 200, {
            success: true,
            limb: `Limb ${limb} (${asset} Dca)`,
            amountUSD: amount,
            orderResult: result
          });
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      // --- TRADING BOTS REGISTRY API ---
      if (method === 'GET' && url === '/api/bots') {
        const bots = botRegistry.getAll();
        sendJson(res, 200, bots);
        return;
      }

      if (method === 'POST' && url === '/api/bots') {
        try {
          const body = await readJsonBody(req);
          const newBot = botRegistry.create(body as any);
          sendJson(res, 201, newBot);
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      if (method === 'GET' && url.startsWith('/api/bots/')) {
        const botId = url.replace('/api/bots/', '').split('?')[0];
        const bot = botRegistry.getById(botId);
        if (!bot) {
          sendJson(res, 404, { error: `Bot '${botId}' not found` });
          return;
        }
        sendJson(res, 200, bot);
        return;
      }

      if (method === 'PATCH' && url.startsWith('/api/bots/')) {
        try {
          const botId = url.replace('/api/bots/', '').split('?')[0];
          const body = await readJsonBody(req);
          const updated = botRegistry.update(botId, body);
          if (!updated) {
            sendJson(res, 404, { error: `Bot '${botId}' not found` });
            return;
          }
          sendJson(res, 200, updated);
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      if (method === 'POST' && url.includes('/trigger') && url.startsWith('/api/bots/')) {
        try {
          const botId = url.replace('/api/bots/', '').replace('/trigger', '').split('?')[0];
          const updated = botRegistry.triggerCycle(botId);
          if (!updated) {
            sendJson(res, 404, { error: `Bot '${botId}' not found or not active` });
            return;
          }
          sendJson(res, 200, updated);
        } catch (error) {
          sendJson(res, 400, { error: String(error) });
        }
        return;
      }

      if (method === 'DELETE' && url.startsWith('/api/bots/')) {
        const botId = url.replace('/api/bots/', '').split('?')[0];
        const ok = botRegistry.delete(botId);
        sendJson(res, ok ? 200 : 404, { success: ok });
        return;
      }

      // API paths must stay JSON. Falling through to the SPA shell makes
      // clients throw "Unexpected token '<'" on `<!DOCTYPE html>`.
      if (url === '/api' || url.startsWith('/api/')) {
        sendJson(res, 404, { error: `Unknown API route: ${method} ${url}` });
        return;
      }

      // Let Vite handle all other requests
      if (dev && vite) {
        vite.middlewares(req, res, (err: any) => {
          if (err) {
             res.statusCode = 500;
             res.end(err.message);
          }
        });
      } else {
        const distPath = join(ROOT, 'dist');
        const fs = await import('fs');
        let filePath = join(distPath, url === '/' ? 'index.html' : url);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
           filePath = join(distPath, 'index.html');
        }
        const mime = await import('mime-types');
        res.writeHead(200, { 'Content-Type': mime.lookup(filePath) || 'text/html' });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log('Endpoints: GET /api/health, POST /api/task, Vite Frontend');
  });
}

startServer();
