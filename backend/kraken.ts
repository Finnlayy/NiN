import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { mergeGravitySnapshots, pairsMatch, type GravitySummary } from '../src/market/krakenLive';

const execAsync = promisify(exec);

export type KrakenOrderRequest = {
  pair: string;
  type: 'buy' | 'sell';
  ordertype: 'market' | 'limit';
  volume: number;
  price?: number;
};

export interface KrakenLimbStatus {
  name: string;
  pair: string;
  mode: string;
  status: 'ONLINE' | 'ACTIVE' | 'STANDBY' | 'DISCONNECTED';
  filledCount: number;
  interval?: string;
  lastExecution?: string;
  last?: number;
  bLower?: number;
  bUpper?: number;
}

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

export class KrakenOrderExecutor {
  private cliPath: string;
  private recentOrdersList: KrakenRecentOrder[] = [];
  private intel: GravitySummary[] = [];

  constructor() {
    this.cliPath = process.env.KRAKEN_CLI_PATH || '/root/.cargo/bin/kraken';
  }

  /**
   * Checks whether the native Kraken CLI binary exists in the current environment.
   */
  public hasNativeCli(): boolean {
    try {
      return fs.existsSync(this.cliPath);
    } catch {
      return false;
    }
  }

  /**
   * Checks whether Kraken API credentials are configured in environment.
   */
  public hasApiCredentials(): boolean {
    return Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
  }

  /**
   * Returns true only if a real connection method is available.
   */
  public isConnected(): boolean {
    return this.hasNativeCli() || this.hasApiCredentials();
  }

  /**
   * Execute an order.
   * ZERO-DUMMY GUARANTEE:
   * If there is no real Kraken connection, NO order is simulated or invented.
   * The order is strictly rejected (Fail-Closed, Via Negativa).
   */
  async executeOrder(
    req: KrakenOrderRequest,
    limbContext?: { limb: 4 | 5; name: string }
  ): Promise<any> {
    if (!this.isConnected()) {
      const limbName = limbContext ? limbContext.name : 'Unknown Limb';
      const errorMsg = `NO_KRAKEN_CONNECTION: Keine aktive Verbindung zu Kraken gefunden (weder CLI unter '${this.cliPath}' noch API-Credentials konfiguriert). Zero-Dummy Guarantee: Es werden keine Schein-Orders simuliert. Ausführung abgebrochen (Fail-Closed).`;
      
      return {
        success: false,
        connected: false,
        error: errorMsg,
        status: 'REJECTED',
        pair: req.pair,
        type: req.type,
        volume: req.volume,
        limb: limbName,
        timestamp: new Date().toISOString()
      };
    }

    // Real execution via Kraken CLI binary
    if (this.hasNativeCli()) {
      let cmd = `${this.cliPath} order create ${req.pair} ${req.type} ${req.ordertype} ${req.volume}`;
      if (req.price) {
        cmd += ` --price ${req.price}`;
      }
      try {
        const { stdout, stderr } = await execAsync(cmd);
        if (stderr) {
          console.warn('[Kraken CLI] STDERR:', stderr);
        }
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = { raw: stdout };
        }
        return {
          success: true,
          connected: true,
          ...parsed
        };
      } catch (err: any) {
        return {
          success: false,
          connected: true,
          error: `Kraken CLI Execution Error: ${err?.message || String(err)}`
        };
      }
    }

    return {
      success: false,
      connected: false,
      error: 'NO_KRAKEN_CONNECTION: Exchange gateway offline.'
    };
  }

  /**
   * Execute CLI command directly.
   * ZERO-DUMMY GUARANTEE:
   * Returns genuine output from the CLI if available.
   * If not available, returns an honest DISCONNECTED status instead of fake JSON.
   */
  async executeCommand(args: string): Promise<any> {
    const trimmed = (args || '').trim();

    if (!this.hasNativeCli()) {
      return {
        success: false,
        connected: false,
        command: trimmed,
        error: `NO_KRAKEN_CONNECTION: Kraken CLI binary '${this.cliPath}' existiert nicht in dieser Umgebung. Zero-Dummy Guarantee: Es werden keine Schein-Antworten oder Fake-Balances generiert.`
      };
    }

    try {
      const cmd = `${this.cliPath} ${trimmed} --output json`;
      const { stdout, stderr } = await execAsync(cmd);
      if (stderr) {
        console.warn('[Kraken CLI] STDERR:', stderr);
      }
      try {
        return JSON.parse(stdout);
      } catch {
        return { raw: stdout, success: true };
      }
    } catch (err: any) {
      return {
        success: false,
        connected: true,
        command: trimmed,
        error: `Kraken CLI Error: ${err?.message || String(err)}`
      };
    }
  }

  /**
   * Return the live state of the Kraken Execution Mesh.
   * ZERO-DUMMY GUARANTEE:
   * If there is no connection, connected is strictly false,
   * filledCount is 0, and recentOrders is empty.
   */
  applyIntel(snapshots: GravitySummary[]): void {
    this.intel = mergeGravitySnapshots(this.intel, snapshots);
  }

  lookupLast(pair: string): number | null {
    const snap = this.intel.find((row) => pairsMatch(row.pair, pair) || pairsMatch(row.display, pair));
    return snap && snap.last > 0 ? snap.last : null;
  }

  private withIntel(limb: KrakenLimbStatus): KrakenLimbStatus {
    if (limb.status !== 'ONLINE' && limb.status !== 'ACTIVE') return limb;
    const snap = this.intel.find((row) => pairsMatch(row.pair, limb.pair) || pairsMatch(row.display, limb.pair));
    if (!snap) return limb;
    return { ...limb, last: snap.last, bLower: snap.bLower, bUpper: snap.bUpper };
  }

  getExecutionStatus(): any {
    const connected = this.isConnected();

    if (!connected) {
      return {
        connected: false,
        exchange: 'Kraken Pro',
        engine: 'OFFLINE',
        status: 'DISCONNECTED',
        latencyMs: null,
        tier: null,
        ocoShadowMeshActive: false,
        autoEarnFlexibleApy: null,
        reason: `Keine Verbindung zu Kraken. Weder '${this.cliPath}' noch KRAKEN_API_KEY/KRAKEN_API_SECRET vorhanden. Keine Schein-Simulation aktiv.`,
        limbs: {
          limb_1: this.withIntel({ name: 'Swarm Limb 1 (Scout Node)', pair: 'XXBTZUSD', mode: 'Trigger Scout Tranche', status: 'DISCONNECTED', filledCount: 0 }),
          limb_2: this.withIntel({ name: 'Swarm Limb 2 (Pyramid Node)', pair: 'XXBTZUSD', mode: 'ATR Trailing Tranches', status: 'DISCONNECTED', filledCount: 0 }),
          limb_3: this.withIntel({ name: 'Swarm Limb 3 (Cluster Exit)', pair: 'XXBTZUSD', mode: 'Atomic Market Ground State', status: 'DISCONNECTED', filledCount: 0 }),
          limb_4: this.withIntel({ name: 'Swarm Limb 4 (Btc Dca)', pair: 'XXBTZUSD', mode: 'Dynamic Dip-DCA ($150)', status: 'DISCONNECTED', interval: 'Inactive (No Connection)', lastExecution: 'Never', filledCount: 0 }),
          limb_5: this.withIntel({ name: 'Swarm Limb 5 (Sol Dca)', pair: 'SOLUSD', mode: 'High-Beta Dip Accumulation ($75)', status: 'DISCONNECTED', interval: 'Inactive (No Connection)', lastExecution: 'Never', filledCount: 0 })
        },
        recentOrders: []
      };
    }

    return {
      connected: true,
      exchange: 'Kraken Pro',
      engine: 'Kraken CLI Gateway',
      status: 'ONLINE',
      limbs: {
        limb_1: this.withIntel({ name: 'Swarm Limb 1 (Scout Node)', pair: 'XXBTZUSD', mode: 'Trigger Scout Tranche', status: 'ONLINE', filledCount: 0 }),
        limb_2: this.withIntel({ name: 'Swarm Limb 2 (Pyramid Node)', pair: 'XXBTZUSD', mode: 'ATR Trailing Tranches', status: 'ONLINE', filledCount: 0 }),
        limb_3: this.withIntel({ name: 'Swarm Limb 3 (Cluster Exit)', pair: 'XXBTZUSD', mode: 'Atomic Market Ground State', status: 'ONLINE', filledCount: 0 }),
        limb_4: this.withIntel({ name: 'Swarm Limb 4 (Btc Dca)', pair: 'XXBTZUSD', mode: 'Dynamic Dip-DCA ($150)', status: 'ACTIVE', interval: 'Every 4h or Dip > -2.5%', lastExecution: 'Idle', filledCount: 0 }),
        limb_5: this.withIntel({ name: 'Swarm Limb 5 (Sol Dca)', pair: 'SOLUSD', mode: 'High-Beta Dip Accumulation ($75)', status: 'ACTIVE', interval: 'Every 4h or Dip > -4.0%', lastExecution: 'Idle', filledCount: 0 })
      },
      recentOrders: this.recentOrdersList
    };
  }

  /**
   * Execute DCA tranche. Strictly fails closed if no connection is present.
   */
  async executeDca(limb: 4 | 5, asset: 'BTC' | 'SOL', amountUSD: number): Promise<any> {
    const pair = asset === 'BTC' ? 'XXBTZUSD' : 'SOLUSD';
    const last = this.lookupLast(pair);
    if (!last) {
      return {
        success: false,
        connected: this.isConnected(),
        error: `Kein Kraken-Lastkurs für ${pair}. DCA legt keine Order mit einem Ersatzpreis an.`,
      };
    }
    const volume = Number((amountUSD / last).toFixed(asset === 'BTC' ? 6 : 4));

    return this.executeOrder(
      {
        pair,
        type: 'buy',
        ordertype: 'market',
        volume
      },
      {
        limb,
        name: `Limb ${limb} (${asset} Dca)`
      }
    );
  }
}
