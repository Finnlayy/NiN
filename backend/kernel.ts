import { mergeGravitySnapshots, pairsMatch, type GravitySummary } from '../src/market/krakenLive';

/**
 * Rust Compute Kernel Connector & Real-Time Log Engine
 * 
 * Simulates high-performance native Rust execution logs (via lock-free ring buffer IPC)
 * specifically for debugging Two-Phase Commit (2PC) atomic trade closures,
 * M8-Gate axiom enforcement, and sub-millisecond cluster liquidations.
 */

export type KernelLogLevel = 
  | 'TRACE' 
  | 'DEBUG' 
  | 'INFO' 
  | 'WARN' 
  | 'CRITICAL' 
  | 'ATOMIC_COMMIT' 
  | 'ROLLBACK';

export type KernelPhase = 
  | 'PRE_FLIGHT' 
  | 'LOCK_ACQUISITION' 
  | 'CROSS_MARGIN_RELEASE' 
  | 'PARALLEL_DISPATCH' 
  | 'PARTIAL_FILL_GUARD' 
  | 'VAULT_GROUND_STATE' 
  | 'ATOMIC_COMMIT' 
  | 'COMPENSATING_ROLLBACK' 
  | 'HEARTBEAT';

export interface AtomicClosureLeg {
  legId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice: number;
  fillPrice: number;
  slippageBps: number;
  venue: string;
  latencyMicros: number;
  fillStatus: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'ROLLED_BACK';
}

export interface AxiomVerificationResult {
  axiomId: number;
  name: string;
  passed: boolean;
  metricValue: string;
  threshold: string;
  note?: string;
}

export interface AtomicClosureRecord {
  closureId: string;
  timestampNanos: string;
  status: 'COMMITTED' | 'ROLLED_BACK' | 'PREFLIGHT_ABORTED';
  totalNotionalUsd: number;
  executionTimeMicros: number;
  maxSlippageBps: number;
  realizedSlippageBps: number;
  preTradeMarginRatio: number;
  postTradeMarginRatio: number;
  cashVaultReservePre: number;
  cashVaultReservePost: number;
  legs: AtomicClosureLeg[];
  axiomsVerified: AxiomVerificationResult[];
}

export interface KernelLogEntry {
  seq: number;
  timestamp: string;
  timestampNanos: string;
  level: KernelLogLevel;
  thread: string;
  phase: KernelPhase;
  closureId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface KernelStatus {
  kernelVersion: string;
  buildTarget: string;
  simdAcceleration: string;
  pinnedCore: string;
  numaNode: number;
  uptimeSeconds: number;
  p99LatencyMicros: number;
  p50LatencyMicros: number;
  ringBufferCapacity: number;
  ringBufferOccupancy: number;
  zeroAllocationsVerified: boolean;
  totalClosuresExecuted: number;
  totalRollbacksTriggered: number;
  ipcChannel: string;
}

class RustKernelEngine {
  private seqCounter: number = 10000;
  private logs: KernelLogEntry[] = [];
  private closures: Map<string, AtomicClosureRecord> = new Map();
  private maxLogCapacity: number = 2000;
  private startTime: number = Date.now();
  private totalClosures: number = 0;
  private totalRollbacks: number = 0;
  private intel: GravitySummary[] = [];

  constructor() {
    this.seedInitialHistory();
    this.startPeriodicTick();
  }

  private nextNanos(offsetMicros: number = 0): string {
    const nowMs = BigInt(Date.now());
    const offset = BigInt(offsetMicros * 1000);
    const subMsNanos = BigInt(Math.floor(Math.random() * 999999));
    return ((nowMs * 1000000n) + subMsNanos + offset).toString();
  }

  private pushLog(entry: Omit<KernelLogEntry, 'seq' | 'timestamp' | 'timestampNanos'>, offsetMicros: number = 0): KernelLogEntry {
    this.seqCounter++;
    const fullEntry: KernelLogEntry = {
      seq: this.seqCounter,
      timestamp: new Date().toISOString(),
      timestampNanos: this.nextNanos(offsetMicros),
      ...entry,
    };
    this.logs.push(fullEntry);
    if (this.logs.length > this.maxLogCapacity) {
      this.logs.shift();
    }
    return fullEntry;
  }

  private seedInitialHistory() {
    // Seed initial boot logs
    this.pushLog({
      level: 'INFO',
      thread: 'core-03:main',
      phase: 'HEARTBEAT',
      message: 'omega_compute_kernel v2.4.1 initialized. AVX-512 vector extensions enabled. SIMD lane width: 64 bytes.',
      metadata: { simd: 'AVX-512', cache_line_size: 64, numa_node: 0 }
    });
    this.pushLog({
      level: 'INFO',
      thread: 'core-03:main',
      phase: 'LOCK_ACQUISITION',
      message: 'Lock-free ring buffer allocated at mmap(0x7f9e8000, 4194304). Spin-lock CAS overhead verified: 8.2ns.',
      metadata: { mmap_addr: '0x7f9e8000', size_mb: 4, cas_latency_ns: 8.2 }
    });

  }

  public applyIntel(snapshots: GravitySummary[]): void {
    this.intel = mergeGravitySnapshots(this.intel, snapshots);
  }

  private lastFor(symbol: string): number | null {
    const snap = this.intel.find((row) => pairsMatch(row.display, symbol) || pairsMatch(row.pair, symbol));
    return snap && snap.last > 0 ? snap.last : null;
  }

  public executeAtomicClosure(options: {
    mode: 'NORMAL' | 'SLIPPAGE_FAIL' | 'PARTIAL_FILL_ABORT' | 'EMERGENCY_FLUSH';
    closureId?: string;
    symbols?: string[];
    notional?: number;
  }): AtomicClosureRecord {
    const closureId = options.closureId || `ATC-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 899 + 100)}`;
    const isRollback = options.mode === 'SLIPPAGE_FAIL' || options.mode === 'PARTIAL_FILL_ABORT';
    const isEmergency = options.mode === 'EMERGENCY_FLUSH';
    const notional = options.notional || (isEmergency ? 820000 : 250000 + Math.floor(Math.random() * 200000));
    const targetSymbols = options.symbols || (isEmergency ? ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD'] : ['BTC/USD', 'ETH/USD']);

    let clockOffset = 0;

    // 1. PRE-FLIGHT
    this.pushLog({
      level: 'INFO',
      thread: 'core-03:hot-path',
      phase: 'PRE_FLIGHT',
      closureId,
      message: `[${closureId}] Initializing 2-Phase Commit (2PC) atomic trade closure. Target notional: $${notional.toLocaleString()}. Mode: ${options.mode}`,
      metadata: { target_symbols: targetSymbols, notional, mode: options.mode }
    }, clockOffset);
    clockOffset += 12;

    // Axiom verifications
    const axioms: AxiomVerificationResult[] = [
      { axiomId: 1, name: 'Via Negativa Tail-Risk', passed: true, metricValue: '4.2% margin', threshold: '<= 10.0%' },
      { 
        axiomId: 2, 
        name: 'Liquidity Drain & Spread', 
        passed: options.mode !== 'SLIPPAGE_FAIL', 
        metricValue: options.mode === 'SLIPPAGE_FAIL' ? '18.4 bps' : '2.8 bps', 
        threshold: '<= 15.0 bps',
        note: options.mode === 'SLIPPAGE_FAIL' ? 'Exceeded allowable book depth slippage' : undefined
      },
      { axiomId: 3, name: 'Atomic Ground State', passed: true, metricValue: '100% Cash Target', threshold: 'Target: 1.00 reserve' },
      { axiomId: 4, name: 'AC Phase Coherence', passed: true, metricValue: 'cos phi = 0.94', threshold: '>= 0.85' },
      { axiomId: 5, name: 'Continuous Learning Guard', passed: true, metricValue: '0 anti-patterns', threshold: 'Risk < 0.30' },
      { axiomId: 6, name: 'Exchange Hard-Stop Presence', passed: true, metricValue: 'Verified', threshold: 'Required' },
    ];

    for (const ax of axioms) {
      clockOffset += 6;
      this.pushLog({
        level: ax.passed ? 'DEBUG' : 'WARN',
        thread: 'core-03:m8-guard',
        phase: 'PRE_FLIGHT',
        closureId,
        message: `[${closureId}] Axiom #${ax.axiomId} (${ax.name}): ${ax.passed ? 'PASSED' : 'VIOLATION'} - Value: ${ax.metricValue} (Threshold: ${ax.threshold})`,
        metadata: { axiomId: ax.axiomId, passed: ax.passed }
      }, clockOffset);
    }

    // 2. LOCK ACQUISITION
    clockOffset += 15;
    this.pushLog({
      level: 'INFO',
      thread: 'core-03:hot-path',
      phase: 'LOCK_ACQUISITION',
      closureId,
      message: `[${closureId}] Atomic CAS mutex acquired on vault balance registers at mem:0x7ffcd3e200. Zero lock contention detected.`,
      metadata: { mutex_spin_cycles: 3, hold_core: 3 }
    }, clockOffset);

    // 3. PARALLEL DISPATCH
    clockOffset += 24;
    this.pushLog({
      level: 'INFO',
      thread: 'core-04:order-bus',
      phase: 'PARALLEL_DISPATCH',
      closureId,
      message: `[${closureId}] FOK/IOC cluster exit orders dispatched across ${targetSymbols.length} legs via high-speed IPC sockets.`,
      metadata: { dispatched_legs: targetSymbols.length }
    }, clockOffset);

    // Legs generation
    const legs: AtomicClosureLeg[] = targetSymbols.flatMap((sym, idx) => {
      const basePrice = this.lastFor(sym);
      if (!basePrice) {
        this.pushLog({
          level: 'WARN',
          thread: 'core-04:order-bus',
          phase: 'PARTIAL_FILL_GUARD',
          closureId,
          message: `[${closureId}] Leg ${sym} übersprungen: kein Intel-Lastkurs. Kein Demo-Fill.`,
          metadata: { symbol: sym }
        }, clockOffset);
        return [];
      }
      clockOffset += 18;
      const legNotional = Math.round(notional / targetSymbols.length);
      const qty = Number((legNotional / basePrice).toFixed(4));
      
      const isFailedLeg = isRollback && idx === targetSymbols.length - 1;
      const slippage = isFailedLeg ? 21.4 : Number((Math.random() * 3.2 - 0.8).toFixed(1));
      const fillPrice = Number((basePrice * (1 - slippage / 10000)).toFixed(2));
      const status = isFailedLeg 
        ? (options.mode === 'PARTIAL_FILL_ABORT' ? 'PARTIAL' : 'REJECTED')
        : 'FILLED';

      this.pushLog({
        level: status === 'FILLED' ? 'DEBUG' : 'WARN',
        thread: `core-0${4 + (idx % 3)}:order-bus`,
        phase: 'PARTIAL_FILL_GUARD',
        closureId,
        message: `[${closureId}] Leg #${idx + 1} (${sym}) ${status}: Qty=${qty}, Fill=$${fillPrice}, Slip=${slippage} bps. Venue: KRAKEN_WS_CORE`,
        metadata: { symbol: sym, qty, fillPrice, slippage, status }
      }, clockOffset);

      return [{
        legId: `LEG-${idx + 1}`,
        symbol: sym,
        side: 'SELL' as const,
        quantity: qty,
        limitPrice: basePrice,
        fillPrice,
        slippageBps: slippage,
        venue: 'KRAKEN_WS_NATIVE',
        latencyMicros: 34 + Math.floor(Math.random() * 25),
        fillStatus: status,
      }];
    });

    if (legs.length === 0) {
      const aborted: AtomicClosureRecord = {
        closureId,
        timestampNanos: this.nextNanos(clockOffset),
        status: 'PREFLIGHT_ABORTED',
        totalNotionalUsd: 0,
        executionTimeMicros: clockOffset,
        maxSlippageBps: 0,
        realizedSlippageBps: 0,
        preTradeMarginRatio: 0,
        postTradeMarginRatio: 0,
        cashVaultReservePre: 0,
        cashVaultReservePost: 0,
        legs: [],
        axiomsVerified: axioms,
      };
      this.closures.set(closureId, aborted);
      return aborted;
    }

    // 4. ATOMIC COMMIT OR ROLLBACK
    clockOffset += 28;
    let closureRecord: AtomicClosureRecord;

    if (isRollback) {
      this.totalRollbacks++;
      this.pushLog({
        level: 'ROLLBACK',
        thread: 'core-03:hot-path',
        phase: 'COMPENSATING_ROLLBACK',
        closureId,
        message: `[${closureId}] ⚠️ ATOMIC ROLLBACK INITIATED: Slippage/fill criteria breached on Leg #${legs.length}. Zero-loss delta compensating hedge injected.`,
        metadata: { reason: 'Slippage > 15 bps threshold', rollback_action: 'CANCEL_AND_REBALANCE' }
      }, clockOffset);

      clockOffset += 20;
      this.pushLog({
        level: 'INFO',
        thread: 'core-03:hot-path',
        phase: 'VAULT_GROUND_STATE',
        closureId,
        message: `[${closureId}] Compensating rollback confirmed in ${clockOffset} µs. Portfolio inventory remains balanced. Vault lock released.`,
        metadata: { restored_state: 'INVENTORY_PRESERVED', lock_released: true }
      }, clockOffset);

      closureRecord = {
        closureId,
        timestampNanos: this.nextNanos(clockOffset),
        status: 'ROLLED_BACK',
        totalNotionalUsd: notional,
        executionTimeMicros: clockOffset,
        maxSlippageBps: 15.0,
        realizedSlippageBps: 21.4,
        preTradeMarginRatio: 0.048,
        postTradeMarginRatio: 0.048,
        cashVaultReservePre: 0.72,
        cashVaultReservePost: 0.72,
        legs,
        axiomsVerified: axioms,
      };
    } else {
      this.totalClosures++;
      this.pushLog({
        level: 'ATOMIC_COMMIT',
        thread: 'core-03:hot-path',
        phase: 'ATOMIC_COMMIT',
        closureId,
        message: `[${closureId}] ⚡ ATOMIC COMMIT CONFIRMED: All ${legs.length} legs filled within allowable bound. Average slippage: +1.4 bps. Total latency: ${clockOffset} µs.`,
        metadata: { legs_count: legs.length, total_notional: notional, commit_latency_micros: clockOffset }
      }, clockOffset);

      clockOffset += 14;
      this.pushLog({
        level: 'INFO',
        thread: 'core-03:hot-path',
        phase: 'VAULT_GROUND_STATE',
        closureId,
        message: `[${closureId}] Axiom 3 Complete: System transitioned to 100% Cash Ground State ($${notional.toLocaleString()} credited to reserve vault).`,
        metadata: { ground_state: '100% CASH', reserve_ratio: 1.00 }
      }, clockOffset);

      closureRecord = {
        closureId,
        timestampNanos: this.nextNanos(clockOffset),
        status: 'COMMITTED',
        totalNotionalUsd: notional,
        executionTimeMicros: clockOffset,
        maxSlippageBps: 15.0,
        realizedSlippageBps: 1.4,
        preTradeMarginRatio: 0.042,
        postTradeMarginRatio: 0.000,
        cashVaultReservePre: 0.78,
        cashVaultReservePost: 1.00,
        legs,
        axiomsVerified: axioms,
      };
    }

    this.closures.set(closureId, closureRecord);
    return closureRecord;
  }

  private startPeriodicTick() {
    setInterval(() => {
      // Occasional low-overhead kernel telemetry tick
      const r = Math.random();
      if (r < 0.4) {
        this.pushLog({
          level: 'TRACE',
          thread: 'core-04:ring-drain',
          phase: 'HEARTBEAT',
          message: `Memory ring-buffer flush: drained 42 events. Ring occupancy: ${Math.floor(Math.random() * 15 + 5)}%. CAS cycles: 0 collisions.`,
          metadata: { drained: 42, occupancy_pct: 8 }
        });
      } else if (r < 0.6) {
        this.pushLog({
          level: 'DEBUG',
          thread: 'core-07:microstructure',
          phase: 'HEARTBEAT',
          message: `Order book sweep: BTC/USD L2 depth 40 levels parsed via AVX-512 SIMD. Spread: 1.8 bps. OBI: +0.38.`,
          metadata: { symbol: 'BTC/USD', spread_bps: 1.8, obi: 0.38 }
        });
      }
    }, 4000);
  }

  public getLogs(options: {
    sinceSeq?: number;
    limit?: number;
    level?: string;
    phase?: string;
    closureId?: string;
    search?: string;
  }): { logs: KernelLogEntry[]; latestSeq: number } {
    let result = this.logs;

    if (options.sinceSeq !== undefined && options.sinceSeq > 0) {
      result = result.filter((l) => l.seq > options.sinceSeq!);
    }

    if (options.level && options.level !== 'ALL') {
      result = result.filter((l) => l.level === options.level);
    }

    if (options.phase && options.phase !== 'ALL') {
      result = result.filter((l) => l.phase === options.phase);
    }

    if (options.closureId) {
      result = result.filter((l) => l.closureId === options.closureId);
    }

    if (options.search) {
      const q = options.search.toLowerCase();
      result = result.filter(
        (l) =>
          l.message.toLowerCase().includes(q) ||
          l.thread.toLowerCase().includes(q) ||
          (l.closureId && l.closureId.toLowerCase().includes(q)),
      );
    }

    const limit = options.limit || 150;
    if (result.length > limit) {
      result = result.slice(result.length - limit);
    }

    return {
      logs: result,
      latestSeq: this.seqCounter,
    };
  }

  public getClosureDetails(closureId: string): AtomicClosureRecord | undefined {
    return this.closures.get(closureId);
  }

  public getAllClosures(): AtomicClosureRecord[] {
    return Array.from(this.closures.values()).reverse();
  }

  public getStatus(): KernelStatus {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    return {
      kernelVersion: 'omega-compute-kernel v2.4.1-release',
      buildTarget: 'x86_64-unknown-linux-gnu (native opt-level=3)',
      simdAcceleration: 'AVX-512F / AVX-512BW (64-byte vector lanes)',
      pinnedCore: 'Core #3 (isolcpus, nohz_full)',
      numaNode: 0,
      uptimeSeconds: uptime,
      p99LatencyMicros: 84.2,
      p50LatencyMicros: 38.6,
      ringBufferCapacity: 65536,
      ringBufferOccupancy: Math.floor(Math.random() * 250 + 640),
      zeroAllocationsVerified: true,
      totalClosuresExecuted: this.totalClosures,
      totalRollbacksTriggered: this.totalRollbacks,
      ipcChannel: 'POSIX shared memory (/dev/shm/omega_ring_ipc) + Unix Domain Socket',
    };
  }

  public clearLogs() {
    this.logs = [];
    this.pushLog({
      level: 'INFO',
      thread: 'core-03:main',
      phase: 'HEARTBEAT',
      message: 'Kernel execution log buffer flushed by operator request.',
    });
  }
}

export const kernelEngine = new RustKernelEngine();
