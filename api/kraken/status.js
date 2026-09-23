const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RELEASE = 'v0.4.1';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function exists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function candidates() {
  const list = [];
  if (process.env.KRAKEN_CLI_PATH) list.push(process.env.KRAKEN_CLI_PATH);
  list.push(path.join(process.cwd(), 'bin', 'kraken'), '/var/task/bin/kraken', '/tmp/kraken', '/usr/local/bin/kraken', '/root/.cargo/bin/kraken');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'kraken'));
  }
  return list;
}

function findCli() {
  return candidates().find((filePath) => exists(filePath)) || null;
}

function run(cli, args) {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, KRAKEN_LOG_FORMAT: 'compact' } }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || error.message });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

async function ensureCli() {
  const found = findCli();
  if (found) return found;
  const asset = process.arch === 'arm64'
    ? 'kraken-cli-aarch64-unknown-linux-gnu.tar.gz'
    : 'kraken-cli-x86_64-unknown-linux-gnu.tar.gz';
  const url = `https://github.com/krakenfx/kraken-cli/releases/download/${RELEASE}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const tarPath = '/tmp/kraken-cli.tar.gz';
  fs.writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tarPath, '-C', '/tmp'], { timeout: 20000 }, (error) => (error ? reject(error) : resolve()));
  });
  const extracted = path.join('/tmp', asset.replace(/\.tar\.gz$/, ''), 'kraken');
  fs.copyFileSync(extracted, '/tmp/kraken');
  fs.chmodSync('/tmp/kraken', 0o755);
  return exists('/tmp/kraken') ? '/tmp/kraken' : null;
}

function priceOf(quote) {
  const price = Number(quote && quote.last_price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function pick(payload, hints) {
  if (!payload || typeof payload !== 'object') return null;
  for (const hint of hints) {
    if (payload[hint]) return payload[hint];
  }
  const key = Object.keys(payload)[0];
  return key ? payload[key] : null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    res.end();
    return;
  }
  if (req.method && req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const cliPath = await ensureCli();
    if (!cliPath) {
      sendJson(res, 200, {
        connected: false,
        exchange: 'Kraken Pro',
        engine: 'OFFLINE',
        status: 'DISCONNECTED',
        reason: 'Kraken CLI binary not found and the release download failed.',
      });
      return;
    }

    const started = Date.now();
    const [versionRun, statusRun, tickerRun] = await Promise.all([
      run(cliPath, ['--version']),
      run(cliPath, ['status', '-o', 'json']),
      run(cliPath, ['ticker', 'BTCUSD', 'SOLUSD', '-o', 'json']),
    ]);
    const latencyMs = Date.now() - started;

    if (!statusRun.ok) {
      sendJson(res, 200, {
        connected: false,
        engine: 'OFFLINE',
        status: 'DISCONNECTED',
        cliPath,
        latencyMs,
        reason: String(statusRun.stderr || 'kraken status failed').slice(0, 500),
      });
      return;
    }

    const system = JSON.parse(statusRun.stdout);
    const tickerPayload = tickerRun.ok ? JSON.parse(tickerRun.stdout) : null;
    const btc = pick(tickerPayload, ['XXBTZUSD', 'XBTUSD', 'BTCUSD']);
    const sol = pick(tickerPayload, ['SOLUSD']);
    const online = system.status === 'online';
    sendJson(res, 200, {
      connected: online,
      exchange: 'Kraken Pro',
      engine: online ? 'Kraken CLI' : 'OFFLINE',
      status: online ? 'ONLINE' : 'DISCONNECTED',
      latencyMs,
      cliPath,
      cliVersion: versionRun.ok ? String(versionRun.stdout).trim() : null,
      system,
      ticker: {
        BTCUSD: priceOf(btc) ? { last: priceOf(btc), bid: Number(btc.bid_price), ask: Number(btc.ask_price) } : null,
        SOLUSD: priceOf(sol) ? { last: priceOf(sol), bid: Number(sol.bid_price), ask: Number(sol.ask_price) } : null,
      },
      reason: online ? null : `Kraken system status is ${system.status}`,
    });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};
