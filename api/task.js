const fs = require('fs');
const path = require('path');

const AGENT = 'antigravity-preview-05-2026';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function systemInstruction() {
  const filePath = path.join(process.cwd(), 'prompts', 'system', 'neural_core.yaml');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parts = [];
    for (const key of ['preamble', 'instruction', 'closing']) {
      const match = raw.match(new RegExp(`${key}: \\|\\n([\\s\\S]*?)(?:\\n  \\w|$)`));
      if (match) parts.push(match[1].replace(/^ {4}/gm, '').trim());
    }
    if (parts.length > 0) return parts.join('\n\n');
  } catch {
    // The function still answers if the template file is not in the bundle.
  }
  return 'You are the central reasoning node of the Neural Intelligence Network.';
}

function userText(taskDescription) {
  if (typeof taskDescription !== 'string' || taskDescription.trim().length === 0) return '';
  try {
    const history = JSON.parse(taskDescription);
    if (Array.isArray(history) && history.length > 0) {
      const last = history[history.length - 1];
      if (last && typeof last.content === 'string') return last.content;
    }
  } catch {
    // Plain task text, not a chat transcript.
  }
  return taskDescription;
}

function liveEnv(name) {
  const proc = globalThis['process'];
  const env = proc && proc['env'];
  if (!env) return undefined;
  return env[name];
}

function envState(name) {
  const proc = globalThis['process'];
  const env = proc && proc['env'];
  if (!env || !Object.prototype.hasOwnProperty.call(env, name)) return 'missing';
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  return 'set';
}

function outputText(interaction) {
  let text = '';
  for (const step of interaction.steps || []) {
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (part && part.type === 'text' && part.text) text += String(part.text);
    }
  }
  return text;
}

async function waitForInteraction(ai, interaction) {
  let current = interaction;
  while (current.status === 'in_progress') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    current = await ai.interactions.get(current.id);
  }
  if (current.status === 'failed' || current.status === 'cancelled') {
    throw new Error(`Agent interaction ${current.status}`);
  }
  return current;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST /api/task.' });
    return;
  }

  const started = Date.now();
  const apiKey = liveEnv('GEMINI_API_KEY');
  if (!apiKey) {
    const namedButEmpty = envState('GEMINI_API_KEY') === 'empty';
    sendJson(res, 200, {
      coreNodeId: 'antigravity-orchestrator',
      output: namedButEmpty
        ? 'GEMINI_API_KEY is present on this deployment but the saved value is empty. Edit that variable in the Vercel project settings and save the key again.'
        : 'Gemini API key is not configured. Set GEMINI_API_KEY, or switch the Neural Konsole engine to LM Studio.',
      latencyMs: 0,
      metadata: { error: true },
    });
    return;
  }

  try {
    const body = await readBody(req);
    const input = userText(body.taskDescription);
    if (!input) {
      sendJson(res, 400, { error: 'taskDescription is required.' });
      return;
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    let interaction = await ai.interactions.create({
      agent: AGENT,
      environment: 'remote',
      background: true,
      input,
      previous_interaction_id: typeof body.previousInteractionId === 'string' ? body.previousInteractionId : undefined,
      config: { systemInstruction: systemInstruction() },
    });
    interaction = await waitForInteraction(ai, interaction);

    sendJson(res, 200, {
      coreNodeId: 'antigravity-orchestrator',
      output: outputText(interaction) || 'Directive executed successfully.',
      latencyMs: Date.now() - started,
      metadata: {
        model: AGENT,
        interactionId: interaction.id,
        provider: 'gemini',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendJson(res, 200, {
        coreNodeId: 'antigravity-orchestrator',
        output: `Execution Error: ${message}`,
        latencyMs: Date.now() - started,
        metadata: { error: true },
      });
    }
  }
};
