import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

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
  /** Paper ledger that filled the order (absent for real Kraken Pro fills). */
  workspace?: string;
}

type CliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

const CLI_TIMEOUT_MS = 20_000;

const CLI_RELEASE = 'v0.4.1';

/**
 * Paper workspaces used when the real account has no funds: the CLI routes
 * `order buy/sell` to a simulated ledger whenever KRAKEN_WORKSPACE points at
 * a paper workspace (live Kraken prices, virtual balance, no real money).
 * Every bot/limb gets its OWN workspace so strategies never share a ledger.
 */
const PAPER_WORKSPACE_PREFIX = 'nin-paper';

const PAPER_STARTING_USD = 10000;

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

function extractKrakenBinary(gzipBuffer: Buffer, dest: string): boolean {
  const tar = zlib.gunzipSync(gzipBuffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156]);
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if ((typeflag === '0' || typeflag === '\0') && name.endsWith('/kraken') && !name.includes('..')) {
      fs.writeFileSync(dest, data);
      fs.chmodSync(dest, 0o755);
      return true;
    }
  }
  return false;
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
  return text.slice(0, 2000);
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

/**
 * Deep-search a parsed Kraken CLI response for the first `txid` value
 * (string or array) — the authoritative "Kraken accepted the order" signal.
 */
function findTxid(payload: unknown, depth = 0): string | null {
  if (!payload || typeof payload !== 'object' || depth > 6) {
    return null;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findTxid(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.txid;
  if (typeof direct === 'string' && direct) {
    return direct;
  }
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string') {
    return direct[0];
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = findTxid(value, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Deep-search for an error message (`error` / `errors` fields, string or
 * array of strings). Kraken answers rejections both via non-zero exit codes
 * and in-band error payloads.
 */
function findErrorMessage(payload: unknown, depth = 0): string | null {
  if (!payload || typeof payload !== 'object' || depth > 6) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'errors']) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      return value.slice(0, 300);
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return value.slice(0, 3).join(' | ').slice(0, 300);
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findErrorMessage(value, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Extract the human-readable order description ("buy 0.00100000 BTCUSD @
 * market") from a Kraken CLI order response when present.
 */
function findDescription(payload: unknown, depth = 0): string | null {
  if (!payload || typeof payload !== 'object' || depth > 6) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['descr', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      return value.slice(0, 200);
    }
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).order;
      if (typeof nested === 'string' && nested) {
        return nested.slice(0, 200);
      }
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findDescription(value, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
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
  // One Kraken paper workspace per bot/limb (key = workspace name) so each
  // strategy keeps its own isolated virtual ledger.
  private paperWorkspaces = new Map<string, Promise<boolean>>();

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
    const dest = '/tmp/kraken';
    const url = `https://github.com/krakenfx/kraken-cli/releases/download/${CLI_RELEASE}/${asset}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const wrote = extractKrakenBinary(Buffer.from(await response.arrayBuffer()), dest);
      return wrote && isExecutableFile(dest) ? dest : null;
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

  private async runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
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
      // Trim credentials: values pasted into hosting dashboards frequently
      // carry a trailing newline, which breaks the API-Key HTTP header
      // ("failed to parse header value").
      const env: NodeJS.ProcessEnv = { ...process.env, KRAKEN_LOG_FORMAT: 'compact', ...extraEnv };
      if (typeof env.KRAKEN_API_KEY === 'string') {
        env.KRAKEN_API_KEY = env.KRAKEN_API_KEY.trim();
      }
      if (typeof env.KRAKEN_API_SECRET === 'string') {
        env.KRAKEN_API_SECRET = env.KRAKEN_API_SECRET.trim();
      }
      if (env.VERCEL === '1') {
        // Vercel's filesystem is read-only outside /tmp; the CLI journals
        // live trades under $HOME, which would fail with "Read-only file
        // system (os error 30)".
        env.HOME = '/tmp';
      }
      const { stdout, stderr } = await execFileAsync(cliPath, args, {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        env,
      });
      return { ok: true, stdout, stderr, code: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string; code?: number | string; signal?: string };
      const detail = [
        error.stderr,
        error.signal ? `signal=${error.signal}` : null,
        typeof error.code === 'number' ? `exit=${error.code}` : error.code ? `code=${error.code}` : null,
        error.message,
      ]
        .filter(Boolean)
        .join(' | ');
      return {
        ok: false,
        stdout: error.stdout || '',
        stderr: detail || String(err),
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
    const [versionRun, statusRun, tickerRun, paper, balanceRun] = await Promise.all([
      this.cliVersion ? Promise.resolve(null) : this.runCli(['--version']),
      this.runCli(['status', '-o', 'json']),
      this.runCli(['ticker', 'BTCUSD', 'SOLUSD', '-o', 'json']),
      // Per-bot paper ledger balances — each workspace is created on first
      // contact; failures degrade to available:false and never fail status.
      this.paperLedgerStatus(),
      // Real-account balance (no KRAKEN_WORKSPACE) so callers can tell
      // whether the next fill will be real or paper. Never fails status.
      this.runCli(['balance', '-o', 'json']),
    ]);
    const latencyMs = Date.now() - started;

    let realBalance: Record<string, unknown>;
    if (balanceRun.ok) {
      let parsed: unknown = null;
      try {
        parsed = parseJson(balanceRun.stdout);
      } catch {
        parsed = null;
      }
      realBalance = { available: true, balances: parsed };
    } else {
      realBalance = { available: false };
    }

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
      paper,
      realBalance,
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

  public getRecentOrders(): KrakenRecentOrder[] {
    return this.recentOrdersList.slice();
  }

  /**
   * Live last-trade prices straight from the Kraken ticker stream for every
   * dashboard symbol Kraken lists. Symbols Kraken does not list are simply
   * absent from the map, so the caller can fall back to another feed for
   * those. This is the SAME stream the Kraken terminal panel shows, which
   * keeps every panel quoting the identical venue price.
   */
  async getSymbolTickers(): Promise<{ source: string; prices: Record<string, number> }> {
    const SYMBOL_PAIR_HINTS: Record<string, string[]> = {
      BTC: ['XXBTZUSD', 'XBTUSD', 'BTCUSD'],
      ETH: ['XETHZUSD', 'ETHUSD'],
      SOL: ['SOLUSD'],
      SUI: ['SUIUSD'],
      DOGE: ['XDGUSD', 'DOGEUSD'],
      XRP: ['XXRPZUSD', 'XRPUSD'],
      AVAX: ['AVAXUSD'],
    };
    const prices: Record<string, number> = {};
    await this.ensureCli();
    if (!this.hasNativeCli() || !this.cliPath) {
      return { source: 'kraken', prices };
    }
    const pairs = [...new Set(Object.values(SYMBOL_PAIR_HINTS).flat())];
    const run = await this.runCli(['ticker', ...pairs, '-o', 'json']);
    if (!run.ok) {
      return { source: 'kraken', prices };
    }
    let parsed: unknown;
    try {
      parsed = parseJson(run.stdout);
    } catch {
      return { source: 'kraken', prices };
    }
    for (const [symbol, hints] of Object.entries(SYMBOL_PAIR_HINTS)) {
      for (const hint of hints) {
        const value =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)[hint]
            : undefined;
        const quote = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
        const last = priceOf(quote);
        if (last) {
          prices[symbol] = last;
          break;
        }
      }
    }
    return { source: 'kraken', prices };
  }

  private recordOrder(entry: KrakenRecentOrder): void {
    this.recentOrdersList.unshift(entry);
    if (this.recentOrdersList.length > 25) {
      this.recentOrdersList.length = 25;
    }
  }

  /**
   * Create (once) a paper workspace that backs the no-funds fallback.
   * Re-running against an existing workspace is tolerated, so warm instances
   * simply re-attach to the ledger persisted under the CLI config dir.
   * Each bot/limb uses its own workspace name for an isolated ledger.
   */
  private ensurePaperWorkspace(workspace: string): Promise<boolean> {
    let ready = this.paperWorkspaces.get(workspace);
    if (!ready) {
      ready = (async () => {
        await this.ensureCli();
        if (!this.hasNativeCli()) {
          return false;
        }
        const create = await this.runCli([
          'workspace',
          'create',
          workspace,
          '--capital',
          String(PAPER_STARTING_USD),
          '--mode',
          'paper',
          '-o',
          'json',
        ]);
        // Any failure other than "already exists" is retried next time by
        // dropping the memoized promise.
        if (!create.ok && !/exists/i.test(create.stderr + create.stdout)) {
          this.paperWorkspaces.delete(workspace);
          return false;
        }
        return true;
      })();
      this.paperWorkspaces.set(workspace, ready);
    }
    return ready;
  }

  /**
   * Which paper ledger a limb trades on. Limbs 4/5 (the DCA bots) get their
   * own dedicated workspaces; anything else falls back to a slug of the limb
   * name, and unknown/manual orders share a default ledger.
   */
  private paperWorkspaceFor(limbContext?: { limb: number; name: string }, limbName = ''): string {
    if (limbContext && (limbContext.limb === 4 || limbContext.limb === 5)) {
      return `${PAPER_WORKSPACE_PREFIX}-limb-${limbContext.limb}`;
    }
    const raw = (limbContext?.name || limbName || '').trim();
    // Manual/unknown dispatches are not a bot — they share the default ledger.
    if (!raw || /unknown/i.test(raw)) {
      return `${PAPER_WORKSPACE_PREFIX}-default`;
    }
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
    return slug ? `${PAPER_WORKSPACE_PREFIX}-${slug}` : `${PAPER_WORKSPACE_PREFIX}-default`;
  }

  /**
   * Balances of every known paper ledger (per-bot virtual accounts). Creates
   * the standard set on first contact; failures degrade to available:false
   * and never fail the whole status call.
   */
  private async paperLedgerStatus(): Promise<Record<string, unknown>> {
    const targets = new Set<string>([
      `${PAPER_WORKSPACE_PREFIX}-limb-4`,
      `${PAPER_WORKSPACE_PREFIX}-limb-5`,
      `${PAPER_WORKSPACE_PREFIX}-default`,
      ...this.paperWorkspaces.keys(),
    ]);
    const entries = await Promise.all(
      [...targets].map(async (workspace) => {
        const ok = await this.ensurePaperWorkspace(workspace);
        if (!ok) {
          return [workspace, { available: false }] as const;
        }
        const run = await this.runCli(['balance', '-o', 'json'], { KRAKEN_WORKSPACE: workspace });
        if (!run.ok) {
          return [workspace, { available: false }] as const;
        }
        let balances: unknown = null;
        try {
          balances = parseJson(run.stdout);
        } catch {
          balances = null;
        }
        return [workspace, { available: true, balances }] as const;
      })
    );
    return { workspaces: Object.fromEntries(entries) };
  }

  /**
   * Execute an order against the paper ledger (same args as a live order —
   * the CLI routes it because KRAKEN_WORKSPACE scopes the invocation to the
   * paper workspace).
   */
  private async executePaperOrder(
    args: string[],
    req: KrakenOrderRequest,
    limbName: string,
    limbContext?: { limb: 4 | 5; name: string }
  ): Promise<Record<string, unknown>> {
    const timestamp = new Date().toISOString();
    // Every bot gets its own paper sub-account so ledgers stay isolated.
    const workspace = this.paperWorkspaceFor(limbContext, limbName);
    const ready = await this.ensurePaperWorkspace(workspace);
    if (!ready) {
      return {
        success: false,
        connected: false,
        paper: true,
        workspace,
        error: `PAPER_UNAVAILABLE: paper workspace ${workspace} could not be initialized.`,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp,
      };
    }

    const result = await this.runCli(args, { KRAKEN_WORKSPACE: workspace });
    let parsed: unknown;
    try {
      parsed = parseJson(result.stdout);
    } catch {
      parsed = { raw: result.stdout };
    }

    if (!result.ok) {
      return {
        success: false,
        connected: true,
        paper: true,
        workspace,
        error: `Paper ledger rejected the order. ${[
          (result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null,
          quoteError(result.stderr, '') || null,
        ].filter(Boolean).join(' | stderr: ') || 'No CLI output.'}`,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp,
        kraken: parsed,
      };
    }

    const paperTxid = findTxid(parsed) ?? `paper-${Date.now()}`;
    this.recordOrder({
      id: paperTxid,
      time: timestamp,
      limb: limbName,
      type: req.type === 'sell' ? 'SELL' : 'BUY',
      pair: req.pair,
      volume: String(req.volume),
      price: req.price !== undefined ? String(req.price) : 'market',
      status: 'FILLED',
      venue: 'Kraken Paper',
      workspace,
    });

    return {
      success: true,
      connected: true,
      paper: true,
      venue: 'Kraken Paper',
      workspace,
      limb: limbName,
      status: 'FILLED',
      txid: paperTxid,
      descr: findDescription(parsed),
      pair: req.pair,
      type: req.type,
      volume: req.volume,
      timestamp,
      kraken: parsed,
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
    const timestamp = new Date().toISOString();

    if (!result.ok) {
      const channels = `${result.stdout} ${result.stderr}`;
      // No funds on the real account: degrade to the Kraken paper ledger so
      // the DCA strategy keeps executing against live prices (virtual money,
      // honestly tagged as PAPER in the UI).
      if (/insufficient funds/i.test(channels)) {
        const paperResult = await this.executePaperOrder(args, req, limbName, limbContext);
        return {
          ...paperResult,
          realAccountError: 'EOrder:Insufficient funds',
          note: 'Real account underfunded — order executed on the limb\'s Kraken paper ledger instead.',
        };
      }
      this.recordOrder({
        id: `rejected-${Date.now()}`,
        time: timestamp,
        limb: limbName,
        type: side === 'sell' ? 'SELL' : 'BUY',
        pair: req.pair,
        volume: String(req.volume),
        price: req.price !== undefined ? String(req.price) : 'market',
        status: 'REJECTED',
        venue: 'Kraken Pro',
      });
      return {
        success: false,
        connected: true,
        // Kraken's error envelope is JSON on STDOUT; stderr may only carry the
        // "live: this goes to the real Kraken account" warning. Surface both.
        error: `Kraken CLI rejected the order. ${[
          (result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null,
          quoteError(result.stderr, '') || null,
        ].filter(Boolean).join(' | stderr: ') || 'No CLI output.'}`,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp,
      };
    }

    let parsed: unknown;
    try {
      parsed = parseJson(result.stdout);
    } catch {
      parsed = { raw: result.stdout };
    }

    // A zero exit code alone does NOT mean Kraken accepted the order — the
    // authoritative acceptance signal is a txid in the response payload.
    const txid = findTxid(parsed);
    const inBandError = findErrorMessage(parsed);
    const descr = findDescription(parsed);

    if (!txid) {
      const reason = inBandError || 'Kraken response contained no txid; order was NOT accepted.';
      this.recordOrder({
        id: `rejected-${Date.now()}`,
        time: timestamp,
        limb: limbName,
        type: side === 'sell' ? 'SELL' : 'BUY',
        pair: req.pair,
        volume: String(req.volume),
        price: req.price !== undefined ? String(req.price) : 'market',
        status: 'REJECTED',
        venue: 'Kraken Pro',
      });
      return {
        success: false,
        connected: true,
        error: reason,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp,
        kraken: parsed,
      };
    }

    this.recordOrder({
      id: txid,
      time: timestamp,
      limb: limbName,
      type: side === 'sell' ? 'SELL' : 'BUY',
      pair: req.pair,
      volume: String(req.volume),
      price: req.price !== undefined ? String(req.price) : 'market',
      // Market orders on Kraken either fill immediately or report the open
      // state; without a follow-up query-orders round-trip, PENDING is the
      // honest label until proven filled.
      status: req.ordertype === 'market' ? 'FILLED' : 'PENDING',
      venue: 'Kraken Pro',
    });

    return {
      success: true,
      connected: true,
      limb: limbName,
      status: req.ordertype === 'market' ? 'FILLED' : 'PENDING',
      txid,
      descr,
      pair: req.pair,
      type: req.type,
      volume: req.volume,
      timestamp,
      kraken: parsed,
    };
  }

  /**
   * Dry-run an order against Kraken (`kraken order ... --validate`): Kraken
   * authenticates the request, checks permissions, balance and order
   * parameters, and returns its real answer WITHOUT placing the order.
   */
  async validateOrder(req: KrakenOrderRequest): Promise<Record<string, unknown>> {
    await this.ensureCli();
    if (!this.hasNativeCli() || !this.cliPath) {
      return {
        validated: false,
        connected: false,
        error: 'NO_KRAKEN_CONNECTION: Kraken CLI binary not found.',
      };
    }
    if (!this.hasApiCredentials()) {
      return {
        validated: false,
        connected: true,
        error: 'NO_CREDENTIALS: KRAKEN_API_KEY / KRAKEN_API_SECRET missing.',
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
      '--validate',
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
        validated: false,
        connected: true,
        error: quoteError(result.stderr, 'Kraken CLI rejected the validation request.'),
        stderrTail: quoteError(result.stderr, ''),
        timestamp: new Date().toISOString(),
      };
    }

    let parsed: unknown;
    try {
      parsed = parseJson(result.stdout);
    } catch {
      parsed = { raw: result.stdout };
    }
    const txid = findTxid(parsed);
    const errorMessage = findErrorMessage(parsed);
    // Kraken signals a successful --validate with status "validated" and no
    // txid (no order is placed); a live placement signals with a txid.
    const statusField =
      parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).status === 'string'
        ? ((parsed as Record<string, unknown>).status as string)
        : null;
    const validated = !errorMessage && (statusField === 'validated' || Boolean(txid));
    return {
      validated,
      connected: true,
      txid,
      krakenStatus: statusField,
      descr: findDescription(parsed),
      error: errorMessage ?? (validated ? null : 'Kraken neither validated the order nor returned a txid.'),
      kraken: parsed,
      timestamp: new Date().toISOString(),
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
      // Kraken answers errors as JSON on STDOUT with a non-zero exit code —
      // stderr may only carry the debug request line. Surface both channels.
      const stderrText = quoteError(result.stderr, '');
      const stdoutText = (result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
      const detail = stdoutText
        ? stdoutText + (stderrText ? ` || stderr: ${stderrText}` : '')
        : stderrText || 'command failed';
      return {
        success: false,
        connected: true,
        command: trimmed,
        error: `Kraken CLI Error: ${detail}`,
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
   * Last traded price for a pair via the Kraken CLI, or null when the
   * ticker is unavailable. Used by the automatic DCA worker.
   */
  async getSpotPrice(pair: string): Promise<number | null> {
    await this.ensureCli();
    if (!this.hasNativeCli()) {
      return null;
    }
    const tickerRun = await this.runCli(['ticker', pair, '-o', 'json']);
    if (!tickerRun.ok) {
      return null;
    }
    try {
      const parsed = parseJson(tickerRun.stdout);
      const hints = pair.includes('BTC') ? ['XXBTZUSD', 'XBTUSD', 'BTCUSD'] : [pair];
      return priceOf(tickerQuote(parsed, hints));
    } catch {
      return null;
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
