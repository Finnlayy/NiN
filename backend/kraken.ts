import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

export type KrakenOrderRequest = {
  pair: string;
  type: 'buy' | 'sell';
  ordertype: 'market' | 'limit';
  volume: number;
  price?: number;
};

export interface KrakenRecentOrder {
  id: string;
  time: string;
  limb: string;
  type: 'BUY' | 'SELL';
  pair: string;
  volume: string;
  price: string;
  status: 'FILLED' | 'PENDING' | 'CANCELLED' | 'REJECTED';
  venue: string;
}

type CliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

const CLI_TIMEOUT_MS = 20_000;

const CLI_RELEASE = 'v0.4.1';

function releaseAssetName(): string {
  return process.arch === 'arm64'
    ? 'kraken-cli-aarch64-unknown-linux-gnu.tar.gz'
    : 'kraken-cli-x86_64-unknown-linux-gnu.tar.gz';
}

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.KRAKEN_CLI_PATH) {
    paths.push(process.env.KRAKEN_CLI_PATH);
  }
  paths.push(
    path.join(process.cwd(), 'bin', 'kraken'),
    '/var/task/bin/kraken',
    '/tmp/kraken',
    '/usr/local/bin/kraken',
    '/root/.cargo/bin/kraken'
  );
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) {
      paths.push(path.join(dir, 'kraken'));
    }
  }
  return paths;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function quoteError(stderr: string, fallback: string): string {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, 500);
}

function tickerQuote(payload: unknown, hints: string[]): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const hint of hints) {
    const value = record[hint];
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>;
    }
  }
  const firstKey = Object.keys(record)[0];
  if (!firstKey) {
    return null;
  }
  const value = record[firstKey];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function priceOf(quote: Record<string, unknown> | null): number | null {
  const raw = quote?.last_price;
  const price = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function limb(name: string, pair: string, mode: string, online: boolean, interval?: string) {
  return {
    name,
    pair,
    mode,
    status: online ? (interval ? 'ACTIVE' : 'ONLINE') : 'DISCONNECTED',
    filledCount: 0,
    ...(interval
      ? { interval: online ? interval : 'Inactive (No Connection)', lastExecution: online ? 'Idle' : 'Never' }
      : {}),
  };
}

export class KrakenOrderExecutor {
  private cliPath: string | null;
  private recentOrdersList: KrakenRecentOrder[] = [];
  private cliVersion: string | null = null;
  private preparing: Promise<string | null> | null = null;

  constructor() {
    this.cliPath = this.resolveCliPath();
  }

  /**
   * Use a binary already on disk. On a host that does not have one, download
   * the official Linux release into /tmp and use that.
   */
  private async ensureCli(): Promise<string | null> {
    const found = this.resolveCliPath();
    if (found) {
      this.cliPath = found;
      return found;
    }
    if (!this.preparing) {
      this.preparing = this.downloadCli().finally(() => {
        this.preparing = null;
      });
    }
    const downloaded = await this.preparing;
    this.cliPath = downloaded;
    return downloaded;
  }

  private async downloadCli(): Promise<string | null> {
    const asset = releaseAssetName();
    const tarPath = '/tmp/kraken-cli.tar.gz';
    const dest = '/tmp/kraken';
    const url = `https://github.com/krakenfx/kraken-cli/releases/download/${CLI_RELEASE}/${asset}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      fs.writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
      await execFileAsync('tar', ['-xzf', tarPath, '-C', '/tmp'], { timeout: CLI_TIMEOUT_MS });
      const extracted = path.join('/tmp', asset.replace(/\.tar\.gz$/, ''), 'kraken');
      fs.copyFileSync(extracted, dest);
      fs.chmodSync(dest, 0o755);
      return isExecutableFile(dest) ? dest : null;
    } catch {
      return null;
    }
  }

  /**
   * Prefer KRAKEN_CLI_PATH, then the binary shipped at bin/kraken, then PATH.
   */
  public resolveCliPath(): string | null {
    for (const candidate of candidatePaths()) {
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  public hasNativeCli(): boolean {
    this.cliPath = this.cliPath && isExecutableFile(this.cliPath) ? this.cliPath : this.resolveCliPath();
    return Boolean(this.cliPath);
  }

  public hasApiCredentials(): boolean {
    return Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
  }

  private async runCli(args: string[]): Promise<CliResult> {
    const cliPath = this.hasNativeCli() ? this.cliPath : null;
    if (!cliPath) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Kraken CLI binary was not found.',
        code: null,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(cliPath, args, {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, KRAKEN_LOG_FORMAT: 'compact' },
      });
      return { ok: true, stdout, stderr, code: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string; code?: number | string };
      return {
        ok: false,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || String(err),
        code: typeof error.code === 'number' ? error.code : null,
      };
    }
  }

  private disconnected(reason: string) {
    return {
      connected: false,
      exchange: 'Kraken Pro',
      engine: 'OFFLINE',
      status: 'DISCONNECTED',
      latencyMs: null,
      cliPath: this.cliPath,
      cliVersion: this.cliVersion,
      tier: null,
      ticker: null,
      system: null,
      reason,
      limbs: {
        limb_1: limb('Swarm Limb 1 (Scout Node)', 'BTCUSD', 'Trigger Scout Tranche', false),
        limb_2: limb('Swarm Limb 2 (Pyramid Node)', 'BTCUSD', 'ATR Trailing Tranches', false),
        limb_3: limb('Swarm Limb 3 (Cluster Exit)', 'BTCUSD', 'Atomic Market Ground State', false),
        limb_4: limb('Swarm Limb 4 (Btc Dca)', 'BTCUSD', 'Dynamic Dip-DCA ($150)', false, 'Every 4h or Dip > -2.5%'),
        limb_5: limb('Swarm Limb 5 (Sol Dca)', 'SOLUSD', 'High-Beta Dip Accumulation ($75)', false, 'Every 4h or Dip > -4.0%'),
      },
      recentOrders: [] as KrakenRecentOrder[],
    };
  }

  /**
   * Live status from the Kraken CLI. connected is true only after `kraken status` reports online.
   */
  async getExecutionStatus(): Promise<Record<string, unknown>> {
    await this.ensureCli();
    if (!this.hasNativeCli() || !this.cliPath) {
      return this.disconnected(
        'Kraken CLI binary not found. Set KRAKEN_CLI_PATH or install the kraken binary on PATH. Looked for bin/kraken, /usr/local/bin/kraken, and /root/.cargo/bin/kraken.'
      );
    }

    const started = Date.now();
    const [versionRun, statusRun, tickerRun] = await Promise.all([
      this.cliVersion ? Promise.resolve(null) : this.runCli(['--version']),
      this.runCli(['status', '-o', 'json']),
      this.runCli(['ticker', 'BTCUSD', 'SOLUSD', '-o', 'json']),
    ]);
    const latencyMs = Date.now() - started;

    if (versionRun?.ok) {
      this.cliVersion = versionRun.stdout.trim() || this.cliVersion;
    }

    if (!statusRun.ok) {
      return {
        ...this.disconnected(
          `Kraken CLI at ${this.cliPath} did not return status. ${quoteError(statusRun.stderr, 'No stderr.')}`
        ),
        latencyMs,
        cliPath: this.cliPath,
        cliVersion: this.cliVersion,
      };
    }

    let system: Record<string, unknown> | null = null;
    try {
      const parsed = parseJson(statusRun.stdout);
      system = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return {
        ...this.disconnected(`Kraken CLI status was not JSON: ${statusRun.stdout.slice(0, 180)}`),
        latencyMs,
        cliPath: this.cliPath,
      };
    }

    let ticker: { BTCUSD: { last: number; bid: number | null; ask: number | null } | null; SOLUSD: { last: number; bid: number | null; ask: number | null } | null } | null = null;
    if (tickerRun.ok) {
      try {
        const parsed = parseJson(tickerRun.stdout);
        const btc = tickerQuote(parsed, ['XXBTZUSD', 'XBTUSD', 'BTCUSD']);
        const sol = tickerQuote(parsed, ['SOLUSD']);
        const btcLast = priceOf(btc);
        const solLast = priceOf(sol);
        ticker = {
          BTCUSD: btcLast
            ? { last: btcLast, bid: priceOf(btc ? { last_price: btc.bid_price } : null), ask: priceOf(btc ? { last_price: btc.ask_price } : null) }
            : null,
          SOLUSD: solLast
            ? { last: solLast, bid: priceOf(sol ? { last_price: sol.bid_price } : null), ask: priceOf(sol ? { last_price: sol.ask_price } : null) }
            : null,
        };
      } catch {
        ticker = null;
      }
    }

    const online = system?.status === 'online';
    if (!online) {
      return {
        ...this.disconnected(`Kraken system status is ${String(system?.status ?? 'unknown')}.`),
        latencyMs,
        cliPath: this.cliPath,
        cliVersion: this.cliVersion,
        system,
        ticker,
      };
    }

    return {
      connected: true,
      exchange: 'Kraken Pro',
      engine: 'Kraken CLI',
      status: 'ONLINE',
      latencyMs,
      cliPath: this.cliPath,
      cliVersion: this.cliVersion,
      system,
      ticker,
      limbs: {
        limb_1: limb('Swarm Limb 1 (Scout Node)', 'BTCUSD', 'Trigger Scout Tranche', true),
        limb_2: limb('Swarm Limb 2 (Pyramid Node)', 'BTCUSD', 'ATR Trailing Tranches', true),
        limb_3: limb('Swarm Limb 3 (Cluster Exit)', 'BTCUSD', 'Atomic Market Ground State', true),
        limb_4: limb('Swarm Limb 4 (Btc Dca)', 'BTCUSD', 'Dynamic Dip-DCA ($150)', true, 'Every 4h or Dip > -2.5%'),
        limb_5: limb('Swarm Limb 5 (Sol Dca)', 'SOLUSD', 'High-Beta Dip Accumulation ($75)', true, 'Every 4h or Dip > -4.0%'),
      },
      recentOrders: this.recentOrdersList,
    };
  }

  async executeOrder(
    req: KrakenOrderRequest,
    limbContext?: { limb: 4 | 5; name: string }
  ): Promise<Record<string, unknown>> {
    const limbName = limbContext ? limbContext.name : 'Unknown Limb';
    await this.ensureCli();
    if (!this.hasNativeCli() || !this.cliPath) {
      return {
        success: false,
        connected: false,
        error: 'NO_KRAKEN_CONNECTION: Kraken CLI binary not found. Order was not sent.',
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp: new Date().toISOString(),
      };
    }

    const side = req.type === 'sell' ? 'sell' : 'buy';
    const args = [
      'order',
      side,
      req.pair,
      String(req.volume),
      '--type',
      req.ordertype,
      '-o',
      'json',
      '--yes',
    ];
    if (req.price !== undefined) {
      args.push('--price', String(req.price));
    }

    const result = await this.runCli(args);
    if (!result.ok) {
      return {
        success: false,
        connected: true,
        error: `Kraken CLI rejected the order. ${quoteError(result.stderr, result.stdout || 'No CLI output.')}`,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp: new Date().toISOString(),
      };
    }

    let parsed: unknown;
    try {
      parsed = parseJson(result.stdout);
    } catch {
      parsed = { raw: result.stdout };
    }

    return {
      success: true,
      connected: true,
      limb: limbName,
      ...(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw: result.stdout }),
    };
  }

  async executeCommand(args: string): Promise<Record<string, unknown>> {
    const trimmed = (args || '').trim().replace(/^kraken\s+/, '');
    await this.ensureCli();
    if (!this.hasNativeCli() || !this.cliPath) {
      return {
        success: false,
        connected: false,
        command: trimmed,
        error: 'NO_KRAKEN_CONNECTION: Kraken CLI binary not found.',
      };
    }

    const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : ['status'];
    if (!parts.includes('-o') && !parts.includes('--output')) {
      parts.push('-o', 'json');
    }

    const result = await this.runCli(parts);
    if (!result.ok) {
      return {
        success: false,
        connected: true,
        command: trimmed,
        error: `Kraken CLI Error: ${quoteError(result.stderr, result.stdout || 'command failed')}`,
      };
    }

    try {
      const parsed = parseJson(result.stdout);
      return {
        success: true,
        connected: true,
        command: trimmed,
        ...(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw: result.stdout }),
      };
    } catch {
      return { success: true, connected: true, command: trimmed, raw: result.stdout };
    }
  }

  /**
   * Size a market buy from the live ticker, then send it through the CLI.
   * No order is sent when the ticker price is missing.
   */
  async executeDca(limb: 4 | 5, asset: 'BTC' | 'SOL', amountUSD: number): Promise<Record<string, unknown>> {
    const pair = asset === 'BTC' ? 'BTCUSD' : 'SOLUSD';
    await this.ensureCli();
    if (!this.hasNativeCli()) {
      return {
        success: false,
        connected: false,
        error: 'NO_KRAKEN_CONNECTION: Kraken CLI binary not found. DCA order was not sent.',
      };
    }

    const tickerRun = await this.runCli(['ticker', pair, '-o', 'json']);
    if (!tickerRun.ok) {
      return {
        success: false,
        connected: true,
        error: `DCA aborted. Ticker for ${pair} failed. ${quoteError(tickerRun.stderr, 'No ticker.')}`,
      };
    }

    let last: number | null = null;
    try {
      const parsed = parseJson(tickerRun.stdout);
      const hints = asset === 'BTC' ? ['XXBTZUSD', 'XBTUSD', 'BTCUSD'] : ['SOLUSD'];
      last = priceOf(tickerQuote(parsed, hints));
    } catch {
      last = null;
    }

    if (!last) {
      return {
        success: false,
        connected: true,
        error: `DCA aborted. Kraken ticker for ${pair} did not include a last price.`,
      };
    }

    const decimals = asset === 'BTC' ? 8 : 4;
    const volume = Number((amountUSD / last).toFixed(decimals));
    return this.executeOrder(
      { pair, type: 'buy', ordertype: 'market', volume },
      { limb, name: `Limb ${limb} (${asset} Dca)` }
    );
  }
}
