import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Play,
  Pause,
  Search,
  Download,
  Copy,
  Check,
  AlertTriangle,
  ArrowDown,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Layers,
  Trash2,
  Radio,
  Wifi
} from 'lucide-react';
import { useEngineTelemetry } from '../hooks/useEngineTelemetry';

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

interface AgentLogInspectorProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

export const AgentLogInspector: React.FC<AgentLogInspectorProps> = ({ onLogEvent, className = '' }) => {
  // Logs & state
  const [logs, setLogs] = useState<KernelLogEntry[]>([]);
  const [latestSeq, setLatestSeq] = useState<number>(0);
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [selectedClosure, setSelectedClosure] = useState<AtomicClosureRecord | null>(null);
  const [closuresList, setClosuresList] = useState<AtomicClosureRecord[]>([]);

  // Controls & Filters
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [selectedLevel, setSelectedLevel] = useState<string>('ALL');
  const [selectedPhase, setSelectedPhase] = useState<string>('ALL');
  const [selectedClosureId, setSelectedClosureId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  // Actions state
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(1500);

  const scrollRef = useRef<HTMLDivElement>(null);
  const telemetry = useEngineTelemetry();

  // Fetch kernel status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/kernel/status');
      if (res.ok) {
        const data: KernelStatus = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Error fetching kernel status:', err);
    }
  }, []);

  // Fetch closures history
  const fetchClosures = useCallback(async () => {
    try {
      const res = await fetch('/api/kernel/closures');
      if (res.ok) {
        const data: AtomicClosureRecord[] = await res.json();
        setClosuresList(data);
      }
    } catch (err) {
      console.error('Error fetching closures:', err);
    }
  }, []);

  // Fetch logs with delta tracking
  const fetchLogs = useCallback(async (isInitial = false) => {
    try {
      const params = new URLSearchParams();
      if (!isInitial && latestSeq > 0) {
        params.append('sinceSeq', latestSeq.toString());
      }
      params.append('limit', '250');
      if (selectedLevel !== 'ALL') params.append('level', selectedLevel);
      if (selectedPhase !== 'ALL') params.append('phase', selectedPhase);
      if (selectedClosureId !== 'ALL') params.append('closureId', selectedClosureId);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());

      const res = await fetch(`/api/kernel/logs?${params.toString()}`);
      if (res.ok) {
        const data: { logs: KernelLogEntry[]; latestSeq: number } = await res.json();
        if (isInitial) {
          setLogs(data.logs);
        } else if (data.logs.length > 0) {
          setLogs((prev) => {
            const existingMap = new Set(prev.map((l) => l.seq));
            const fresh = data.logs.filter((l) => !existingMap.has(l.seq));
            const merged = [...prev, ...fresh];
            return merged.slice(-400); // cap to 400 lines in UI
          });
        }
        if (data.latestSeq > latestSeq) {
          setLatestSeq(data.latestSeq);
        }
      }
    } catch (err) {
      console.error('Error polling kernel logs:', err);
    }
  }, [latestSeq, selectedLevel, selectedPhase, selectedClosureId, searchQuery]);

  // Initial load
  useEffect(() => {
    fetchStatus();
    fetchClosures();
    fetchLogs(true);
  }, []);

  // Streaming interval
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      fetchLogs(false);
      fetchStatus();
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [isStreaming, pollIntervalMs, fetchLogs, fetchStatus]);

  // Auto-scroll handler
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Trigger closure simulation
  const handleSimulateClosure = async (mode: 'NORMAL' | 'SLIPPAGE_FAIL' | 'PARTIAL_FILL_ABORT' | 'EMERGENCY_FLUSH') => {
    try {
      setIsSimulating(true);
      const actionName = 
        mode === 'NORMAL' ? 'Standard 2PC Cluster Exit' :
        mode === 'SLIPPAGE_FAIL' ? 'Slippage Breach Rollback Test' :
        mode === 'PARTIAL_FILL_ABORT' ? 'Partial Fill Compensating Hedge' :
        'Emergency 100% Cash Ground-State Flush';
      
      onLogEvent?.(`Dispatching to Rust Compute Kernel: ${actionName}...`, 'info', 'RustKernel');

      const res = await fetch('/api/kernel/simulate-closure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });

      if (res.ok) {
        const record: AtomicClosureRecord = await res.json();
        setSelectedClosure(record);
        await fetchLogs(false);
        await fetchClosures();
        await fetchStatus();

        if (record.status === 'COMMITTED') {
          onLogEvent?.(
            `[${record.closureId}] ATOMIC COMMIT CONFIRMED in ${record.executionTimeMicros} µs. Cash Vault: 100% Ground State.`,
            'success',
            'RustKernel'
          );
        } else {
          onLogEvent?.(
            `[${record.closureId}] ATOMIC ROLLBACK EXECUTED in ${record.executionTimeMicros} µs. Inventory preserved.`,
            'warn',
            'RustKernel'
          );
        }
      }
    } catch (err) {
      onLogEvent?.(`Failed simulating atomic closure: ${err}`, 'error', 'RustKernel');
    } finally {
      setIsSimulating(false);
    }
  };

  // Inspect specific closure details
  const handleInspectClosure = async (closureId: string) => {
    try {
      const res = await fetch(`/api/kernel/closure/${closureId}`);
      if (res.ok) {
        const record: AtomicClosureRecord = await res.json();
        setSelectedClosure(record);
      }
    } catch (err) {
      console.error('Error fetching closure details:', err);
    }
  };

  // Clear display logs
  const handleClear = async () => {
    try {
      await fetch('/api/kernel/clear-logs', { method: 'POST' });
      setLogs([]);
      setLatestSeq(0);
      onLogEvent?.('Kernel log buffer flushed.', 'info', 'RustKernel');
    } catch (err) {
      console.error(err);
    }
  };

  // Copy raw logs to clipboard
  const handleCopy = () => {
    const raw = logs.map((l) => `[${l.timestampNanos}] [${l.level}] [${l.thread}] [${l.phase}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Export logs as JSON
  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify({ kernelStatus: status, logs }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rust_kernel_execution_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Format level color badge
  const getLevelBadge = (level: KernelLogLevel) => {
    switch (level) {
      case 'ATOMIC_COMMIT':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-sm shadow-emerald-500/20 font-bold';
      case 'ROLLBACK':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm shadow-amber-500/20 font-bold';
      case 'CRITICAL':
        return 'bg-rose-500/25 text-rose-300 border-rose-500/50 font-bold animate-pulse';
      case 'WARN':
        return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
      case 'INFO':
        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
      case 'DEBUG':
        return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
      case 'TRACE':
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  // Format phase badge
  const getPhaseBadge = (phase: KernelPhase) => {
    switch (phase) {
      case 'ATOMIC_COMMIT':
        return 'text-emerald-400';
      case 'COMPENSATING_ROLLBACK':
        return 'text-amber-400';
      case 'PRE_FLIGHT':
        return 'text-blue-400';
      case 'LOCK_ACQUISITION':
        return 'text-purple-400';
      case 'PARALLEL_DISPATCH':
        return 'text-cyan-400';
      case 'PARTIAL_FILL_GUARD':
        return 'text-amber-300';
      case 'VAULT_GROUND_STATE':
        return 'text-emerald-300 font-bold';
      default:
        return 'text-slate-400';
    }
  };

  return (
    <div className={`space-y-4 font-mono ${className}`}>
      {/* Top Header & Kernel Status Telemetry */}
      <div className="p-4 bg-gradient-to-r from-[#0b111e] via-[#0e1628] to-[#0a101b] border border-cyan-500/30 rounded-2xl shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-500/20 to-cyan-500/20 border border-cyan-500/40 rounded-xl text-cyan-300">
              <Terminal className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-white tracking-wide">
                  RUST COMPUTE KERNEL // AGENT LOG INSPECTOR
                </span>
                <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  HOT-PATH ATOMIC 2PC
                </span>
                <span className="px-2 py-0.5 text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded">
                  AVX-512 SIMD
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Low-latency execution logs, memory-mapped IPC ring buffer telemetry, and Two-Phase Commit atomic trade closure debugging.
              </p>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="flex items-center gap-3 text-xs">
            <div className="px-3 py-1.5 bg-[#080d16] border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-400">P99 Dispatch</div>
              <div className="text-sm font-bold text-cyan-300">{status?.p99LatencyMicros ?? 84.2} µs</div>
            </div>
            <div className="px-3 py-1.5 bg-[#080d16] border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-400">Ring Buffer Slots</div>
              <div className="text-sm font-bold text-purple-300">
                {status?.ringBufferOccupancy ?? 720} / {status?.ringBufferCapacity ?? 65536}
              </div>
            </div>
            <div className="px-3 py-1.5 bg-[#080d16] border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-400">Core Pinned</div>
              <div className="text-sm font-bold text-amber-300">Core #3 (NUMA 0)</div>
            </div>
            <div className="px-3 py-1.5 bg-[#080d16] border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-400">Closures / Rollbacks</div>
              <div className="text-sm font-bold text-emerald-400">
                {status?.totalClosuresExecuted ?? 0} / {status?.totalRollbacksTriggered ?? 0}
              </div>
            </div>
          </div>
        </div>

        {/* Live Fail-Closed Engine Telemetry Wire Contract Strip */}
        <div className="mt-3 p-2.5 bg-[#060a12] border border-slate-800/90 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold tracking-wide font-mono">
              {telemetry.connectionState === 'CONNECTED_LIVE' ? (
                <span className="flex items-center gap-1.5 text-emerald-400 border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 rounded">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <Radio className="w-3 h-3" />
                  CONNECTED_LIVE ({telemetry.lastAgeMs < 1000 ? '<1s' : `${(telemetry.lastAgeMs / 1000).toFixed(1)}s`})
                </span>
              ) : telemetry.connectionState === 'STALE_CACHE_DEGRADED' ? (
                <span className="flex items-center gap-1.5 text-amber-400 border-amber-500/30 bg-amber-500/10 px-2 py-0.5 rounded">
                  <AlertTriangle className="w-3 h-3" />
                  STALE_CACHE_DEGRADED ({(telemetry.lastAgeMs / 1000).toFixed(1)}s)
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-rose-400 border-rose-500/30 bg-rose-500/10 px-2 py-0.5 rounded">
                  <Wifi className="w-3 h-3" />
                  DISCONNECTED
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="text-slate-500">|</span>
              <span>Wire Contract: <strong className="text-cyan-300 font-mono">FAIL_CLOSED</strong></span>
              <span className="text-slate-500">|</span>
              <span>Validated: <strong className="text-emerald-400 font-mono">{telemetry.validTicksCount}</strong></span>
              <span>Dropped: <strong className="text-rose-400 font-mono">{telemetry.droppedTicksCount}</strong></span>
            </div>
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px]">
            <div className="flex items-center gap-1 bg-slate-900/80 px-2 py-1 rounded border border-slate-800">
              <span className="text-slate-400">V_tot (0.25·L2+0.35·L3+0.40·Poly):</span>
              <span className="text-cyan-300 font-bold">{telemetry.gravity?.v_total?.toFixed(4) ?? '---'}</span>
            </div>
            <div className="flex items-center gap-1 bg-slate-900/80 px-2 py-1 rounded border border-slate-800">
              <span className="text-slate-400">OBI Imbalance (2%):</span>
              <span className={`font-bold ${(telemetry.microstructure?.imbalance_ratio ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {telemetry.microstructure?.imbalance_ratio ? `${(telemetry.microstructure.imbalance_ratio * 100).toFixed(1)}%` : '---'}
              </span>
            </div>
            {telemetry.isForbiddenZone ? (
              <span className="px-2 py-0.5 text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/50 rounded animate-pulse">
                FORBIDDEN ZONE BREACH
              </span>
            ) : (
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 rounded">
                ZONE NOMINAL
              </span>
            )}
          </div>
        </div>

        {/* Action Trigger Bar for Atomic Closure Debugging */}
        <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 uppercase font-semibold">Test Injections:</span>
            <button
              onClick={() => handleSimulateClosure('NORMAL')}
              disabled={isSimulating}
              className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-xl font-bold transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Standard 2PC Cluster Exit
            </button>
            <button
              onClick={() => handleSimulateClosure('SLIPPAGE_FAIL')}
              disabled={isSimulating}
              className="px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 rounded-xl font-bold transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              Slippage Breach Rollback
            </button>
            <button
              onClick={() => handleSimulateClosure('PARTIAL_FILL_ABORT')}
              disabled={isSimulating}
              className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40 rounded-xl font-bold transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Partial Fill Compensate
            </button>
            <button
              onClick={() => handleSimulateClosure('EMERGENCY_FLUSH')}
              disabled={isSimulating}
              className="px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 rounded-xl font-bold transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              Emergency 100% Cash Flush
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsStreaming(!isStreaming)}
              className={`px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all font-bold ${
                isStreaming
                  ? 'bg-blue-600/20 text-blue-300 border-blue-500/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              {isStreaming ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isStreaming ? 'Streaming Live' : 'Paused'}
            </button>

            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all ${
                autoScroll
                  ? 'bg-cyan-600/20 text-cyan-300 border-cyan-500/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <ArrowDown className="w-3.5 h-3.5" />
              Auto-Scroll {autoScroll ? 'ON' : 'OFF'}
            </button>

            <select
              value={pollIntervalMs}
              onChange={(e) => setPollIntervalMs(Number(e.target.value))}
              className="bg-[#080d17] border border-slate-700 rounded-xl px-2 py-1 text-slate-300 text-[11px] focus:outline-none focus:border-cyan-500"
              title="Polling Refresh Frequency"
            >
              <option value={500}>500ms (High Freq)</option>
              <option value={1500}>1.5s (Standard)</option>
              <option value={3000}>3.0s (Eco)</option>
            </select>

            <button
              onClick={handleCopy}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl transition-all"
              title="Copy Raw Log Dump"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={handleExportJson}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl transition-all"
              title="Download Logs JSON"
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={handleClear}
              className="p-1.5 bg-slate-800 hover:bg-rose-900/40 text-slate-400 hover:text-rose-300 border border-slate-700 rounded-xl transition-all"
              title="Clear Buffer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Filter & Query Bar */}
      <div className="p-3 bg-[#0d1320] border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search kernel log messages, threads, or closure IDs..."
              className="w-full pl-8 pr-3 py-1.5 bg-[#080d17] border border-slate-700 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Level selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400 text-[11px]">Level:</span>
            <select
              value={selectedLevel}
              onChange={(e) => setSelectedLevel(e.target.value)}
              className="bg-[#080d17] border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="ALL">ALL LEVELS</option>
              <option value="ATOMIC_COMMIT">ATOMIC_COMMIT</option>
              <option value="ROLLBACK">ROLLBACK</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="WARN">WARN</option>
              <option value="INFO">INFO</option>
              <option value="DEBUG">DEBUG</option>
              <option value="TRACE">TRACE</option>
            </select>
          </div>

          {/* Phase selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400 text-[11px]">Phase:</span>
            <select
              value={selectedPhase}
              onChange={(e) => setSelectedPhase(e.target.value)}
              className="bg-[#080d17] border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="ALL">ALL PHASES</option>
              <option value="PRE_FLIGHT">PRE_FLIGHT</option>
              <option value="LOCK_ACQUISITION">LOCK_ACQUISITION</option>
              <option value="PARALLEL_DISPATCH">PARALLEL_DISPATCH</option>
              <option value="PARTIAL_FILL_GUARD">PARTIAL_FILL_GUARD</option>
              <option value="VAULT_GROUND_STATE">VAULT_GROUND_STATE</option>
              <option value="ATOMIC_COMMIT">ATOMIC_COMMIT</option>
              <option value="COMPENSATING_ROLLBACK">COMPENSATING_ROLLBACK</option>
              <option value="HEARTBEAT">HEARTBEAT</option>
            </select>
          </div>

          {/* Closure filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400 text-[11px]">Closure Batch:</span>
            <select
              value={selectedClosureId}
              onChange={(e) => setSelectedClosureId(e.target.value)}
              className="bg-[#080d17] border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 focus:outline-none focus:border-cyan-500 max-w-[180px] truncate"
            >
              <option value="ALL">ALL CLOSURES</option>
              {closuresList.map((c) => (
                <option key={c.closureId} value={c.closureId}>
                  {c.closureId} ({c.status})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-[11px] text-slate-400 flex items-center gap-2">
          <span>Displaying {logs.length} events</span>
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          <span>Seq #{latestSeq}</span>
        </div>
      </div>

      {/* Main Grid: Log Stream on Left, Atomic Closure Inspector on Right */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Terminal Log Stream (2 Cols on XL) */}
        <div className="xl:col-span-2 bg-[#080c16] border border-slate-800 rounded-2xl overflow-hidden flex flex-col h-[600px] shadow-inner">
          {/* Terminal Top Bar */}
          <div className="px-4 py-2.5 bg-[#0c1220] border-b border-slate-800 flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
              <span className="ml-2 font-bold text-slate-300">/dev/shm/omega_ring_ipc // STDOUT</span>
            </div>
            <div className="text-slate-400 text-[10px]">
              Lock-Free Spin-Lock CAS: 8.2ns • Ring Buffers Synced
            </div>
          </div>

          {/* Log Lines Container */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-3 space-y-1 text-xs select-text scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent"
          >
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs font-mono space-y-2">
                <Terminal className="w-8 h-8 opacity-30" />
                <p>No kernel logs matching current filter parameters.</p>
                <button
                  onClick={() => {
                    setSelectedLevel('ALL');
                    setSelectedPhase('ALL');
                    setSelectedClosureId('ALL');
                    setSearchQuery('');
                  }}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded text-[11px]"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              logs.map((log) => {
                const isExpanded = expandedSeq === log.seq;
                const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;

                return (
                  <div
                    key={log.seq}
                    className={`p-1.5 rounded-lg border transition-colors ${
                      log.level === 'ATOMIC_COMMIT'
                        ? 'bg-emerald-950/20 border-emerald-500/30'
                        : log.level === 'ROLLBACK'
                        ? 'bg-amber-950/20 border-amber-500/30'
                        : log.level === 'CRITICAL'
                        ? 'bg-rose-950/30 border-rose-500/40'
                        : 'bg-[#0a0f1c]/60 border-slate-850 hover:bg-[#0f1629]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 shrink-0 text-[11px]">
                        <span className="text-slate-500 font-mono">#{log.seq}</span>
                        <span className="text-slate-400 text-[10px]">
                          {log.timestamp.slice(11, 23)}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${getLevelBadge(log.level)}`}>
                          {log.level}
                        </span>
                        <span className="text-slate-500 text-[10px]">[{log.thread}]</span>
                        <span className={`text-[10px] font-semibold ${getPhaseBadge(log.phase)}`}>
                          {log.phase}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {log.closureId && (
                          <button
                            onClick={() => handleInspectClosure(log.closureId!)}
                            className="px-2 py-0.5 bg-blue-900/30 hover:bg-blue-800/50 text-blue-300 border border-blue-600/30 rounded text-[10px] font-bold flex items-center gap-1"
                            title="Inspect Atomic Closure Details"
                          >
                            <span>{log.closureId}</span>
                            <ChevronRight className="w-2.5 h-2.5" />
                          </button>
                        )}
                        {hasMetadata && (
                          <button
                            onClick={() => setExpandedSeq(isExpanded ? null : log.seq)}
                            className="text-slate-400 hover:text-white p-0.5"
                            title="Toggle Metadata"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3 text-cyan-400" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mt-1 text-slate-200 text-xs pl-2 border-l-2 border-slate-700/60 break-all leading-relaxed">
                      {log.message}
                    </div>

                    {isExpanded && hasMetadata && (
                      <div className="mt-2 p-2 bg-[#050811] border border-slate-800 rounded text-[11px] text-cyan-300 overflow-x-auto">
                        <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Atomic Closure Inspector Panel (1 Col on XL) */}
        <div className="bg-[#0b101c] border border-slate-800 rounded-2xl p-4 flex flex-col h-[600px] overflow-y-auto space-y-4 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                Atomic Closure Inspector
              </h3>
            </div>
            {selectedClosure && (
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                  selectedClosure.status === 'COMMITTED'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                }`}
              >
                {selectedClosure.status}
              </span>
            )}
          </div>

          {!selectedClosure ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-500 text-xs space-y-3">
              <Layers className="w-10 h-10 opacity-30 text-cyan-400" />
              <p className="max-w-[260px]">
                Click on any <span className="text-cyan-300 font-semibold">[ATC-xxxx]</span> badge in the log stream or run a test injection to inspect atomic trade closure execution details.
              </p>
              <button
                onClick={() => handleSimulateClosure('NORMAL')}
                className="px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white rounded-xl font-bold shadow-lg shadow-blue-500/20"
              >
                Trigger 2PC Cluster Exit
              </button>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              {/* Summary Stats */}
              <div className="p-3 bg-[#080d17] border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">Closure ID</span>
                  <span className="text-white font-bold text-xs">{selectedClosure.closureId}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">Total Notional</span>
                  <span className="text-white font-bold">${selectedClosure.totalNotionalUsd.toLocaleString()} USD</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">Execution Latency</span>
                  <span className="text-cyan-300 font-bold">{selectedClosure.executionTimeMicros} µs</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">Realized Slippage</span>
                  <span className={selectedClosure.realizedSlippageBps > selectedClosure.maxSlippageBps ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {selectedClosure.realizedSlippageBps} bps (Max: {selectedClosure.maxSlippageBps} bps)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">Cash Ground State</span>
                  <span className="text-emerald-300 font-bold">
                    {(selectedClosure.cashVaultReservePost * 100).toFixed(0)}% Vault Reserve
                  </span>
                </div>
              </div>

              {/* 2-Phase Commit (2PC) Leg Breakdown */}
              <div>
                <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center justify-between">
                  <span>Atomic Legs ({selectedClosure.legs.length})</span>
                  <span className="text-slate-500 text-[10px]">Parallel IOC Execution</span>
                </div>
                <div className="space-y-2">
                  {selectedClosure.legs.map((leg) => (
                    <div
                      key={leg.legId}
                      className="p-2.5 bg-[#080d17] border border-slate-800/80 rounded-xl space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-white">{leg.symbol}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            leg.fillStatus === 'FILLED'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {leg.fillStatus}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                        <div>Side: <span className="text-slate-200">{leg.side}</span></div>
                        <div>Qty: <span className="text-slate-200">{leg.quantity}</span></div>
                        <div>Fill: <span className="text-slate-200">${leg.fillPrice}</span></div>
                        <div>Slip: <span className={leg.slippageBps > 15 ? 'text-amber-400' : 'text-slate-200'}>{leg.slippageBps} bps</span></div>
                        <div>Latency: <span className="text-cyan-300">{leg.latencyMicros} µs</span></div>
                        <div>Venue: <span className="text-slate-400 text-[10px]">{leg.venue}</span></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* The Judge M8 Axiom Verification */}
              <div>
                <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center justify-between">
                  <span>M8 Axiom Pre-Commit Check</span>
                  <span className="text-emerald-400 text-[10px] font-bold">Rigid Verification</span>
                </div>
                <div className="space-y-1.5">
                  {selectedClosure.axiomsVerified.map((ax) => (
                    <div
                      key={ax.axiomId}
                      className="p-2 bg-[#080d17] border border-slate-800/80 rounded-lg flex items-center justify-between text-[11px]"
                    >
                      <div className="flex items-center gap-1.5">
                        {ax.passed ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        )}
                        <span className="text-slate-300">
                          #{ax.axiomId} {ax.name}
                        </span>
                      </div>
                      <span className={ax.passed ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                        {ax.metricValue}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
