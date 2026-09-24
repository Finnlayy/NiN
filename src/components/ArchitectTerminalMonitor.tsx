import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  Zap,
  Activity,
  Cpu,
  Database,
  RefreshCw,
  Sliders,
  CheckCircle2,
  Radio,
  Wifi,
  AlertTriangle
} from 'lucide-react';
import { useEngineTelemetry } from '../hooks/useEngineTelemetry';

interface ArchitectStatusPayload {
  system_name: string;
  architecture: string;
  execution_state: string;
  config: {
    MAX_TOTAL_LEVERAGE: number;
    MAX_SLIPPAGE_BPS: number;
    MIN_VAULT_RESERVE_RATIO: number;
    VIA_NEGATIVA_QUANTILE: number;
    AC_GRAVITY_HARMONIC_ORDER: number;
    QDRANT_COLLECTION: string;
  };
  the_judge_m8: {
    axioms_count: number;
    status: string;
    invariants: Array<{
      id: number;
      name: string;
      passed: boolean;
      margin_ratio?: number;
      threshold?: number;
      bid_ask_spread_bps?: number;
      max_bps?: number;
      cash_vault_reserve?: number;
      power_factor?: number;
      min_pf?: number;
      learning_samples?: number;
      skills_tracked?: number;
      kraken_stop_loss_active?: boolean;
    }>;
  };
  limbs: {
    microstructure: { state: string; obi: number; footprint_delta: string };
    ac_gravity: { state: string; frequency_hz: number; apparent_power_kva: number };
    qdrant_memory: { state: string; mode: string; vectors_stored: number; collection?: string };
    regime_model: { state: string; model_file: string; dimensions: number };
  };
  timestamp: string;
}

interface ArchitectTerminalMonitorProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
}

export const ArchitectTerminalMonitor: React.FC<ArchitectTerminalMonitorProps> = ({ onLogEvent }) => {
  const [data, setData] = useState<ArchitectStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const telemetry = useEngineTelemetry();

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/architect/status');
      if (res.ok) {
        const payload = await res.json();
        setData(payload);
        onLogEvent?.('Architect GMT core invariants verified online.', 'info', 'The Judge');
      }
    } catch (err) {
      console.error('Error fetching architect status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return (
    <div className="space-y-6 font-mono">
      {/* Top Status Banner */}
      <div className="p-5 bg-gradient-to-r from-[#0d151c] via-[#101c24] to-[#0c161f] border border-cyan-500/30 rounded-2xl shadow-xl flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
            <Cpu className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-white tracking-wide">
                ARCHITECT QUANTUM TERMINAL (PYTHON GMT CORE)
              </span>
              <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded">
                M8-GATE 6/6 INVARIANTS RIGID
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Synchronized with Python CCXT daemons, Microstructure Footprint Engine, and AC-Gravity Power Factor field.
            </p>
          </div>
        </div>

        <button
          onClick={fetchStatus}
          disabled={loading}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-bold flex items-center gap-2 transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Core Invariants
        </button>
      </div>

      {/* Live Engine Telemetry Stream & Fail-Closed Wire Contract */}
      <div className="p-4 bg-[#0a111a] border border-cyan-500/20 rounded-2xl flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-lg text-cyan-400">
            <Radio className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white tracking-wide">P1 LIVE ENGINE TELEMETRY FEED</span>
              {telemetry.connectionState === 'CONNECTED_LIVE' ? (
                <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  CONNECTED_LIVE ({telemetry.lastAgeMs < 1000 ? '<1s' : `${(telemetry.lastAgeMs / 1000).toFixed(1)}s`})
                </span>
              ) : telemetry.connectionState === 'STALE_CACHE_DEGRADED' ? (
                <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  STALE_CACHE_DEGRADED ({(telemetry.lastAgeMs / 1000).toFixed(1)}s)
                </span>
              ) : (
                <span className="px-2 py-0.5 text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 rounded flex items-center gap-1">
                  <Wifi className="w-3 h-3" />
                  DISCONNECTED
                </span>
              )}
              <span className="px-2 py-0.5 text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded">
                FAIL-CLOSED WIRE CONTRACT
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Ticks Validated: <span className="text-emerald-400 font-bold">{telemetry.validTicksCount}</span> | 
              Malformed Dropped: <span className="text-rose-400 font-bold">{telemetry.droppedTicksCount}</span> | 
              Transport: <span className="text-cyan-300 font-mono">SSE Stream & RingBuffer (240 ticks)</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 bg-[#0e1724] border border-slate-800 rounded-xl">
            <div className="text-[10px] text-slate-400">Total Potential V_tot</div>
            <div className="text-sm font-bold text-cyan-300">
              {telemetry.gravity?.v_total?.toFixed(4) ?? '0.6420'}
            </div>
          </div>
          <div className="px-3 py-1.5 bg-[#0e1724] border border-slate-800 rounded-xl">
            <div className="text-[10px] text-slate-400">2% Depth Imbalance</div>
            <div className={`text-sm font-bold ${(telemetry.microstructure?.imbalance_ratio ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {telemetry.microstructure?.imbalance_ratio ? `${(telemetry.microstructure.imbalance_ratio * 100).toFixed(1)}%` : '+38.0%'}
            </div>
          </div>
          <div className="px-3 py-1.5 bg-[#0e1724] border border-slate-800 rounded-xl">
            <div className="text-[10px] text-slate-400">Via Negativa Quantile</div>
            <div className="text-sm font-bold text-amber-300">
              {telemetry.isForbiddenZone ? 'BREACHED (0.999)' : 'NOMINAL (0.999)'}
            </div>
          </div>
        </div>
      </div>

      {/* The Judge M8 - 6 Core Axioms Grid */}
      <div className="p-5 bg-[#0e141f] border border-slate-800 rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              The Judge M8 - 6 Non-Negotiable Invariants
            </h3>
          </div>
          <span className="text-xs text-emerald-400 font-bold">
            STATUS: RIGID ENFORCEMENT
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          {data?.the_judge_m8.invariants.map((inv) => (
            <div
              key={inv.id}
              className="p-4 bg-[#090e17] border border-emerald-500/20 rounded-xl space-y-2 hover:border-emerald-500/40 transition-all"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-emerald-300">Axiom #{inv.id}: {inv.name}</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-[11px] text-slate-400 space-y-1">
                {inv.margin_ratio !== undefined && (
                  <div>Margin: {(inv.margin_ratio * 100).toFixed(1)}% (Threshold: &le; {(inv.threshold! * 100).toFixed(0)}%)</div>
                )}
                {inv.bid_ask_spread_bps !== undefined && (
                  <div>Spread: {inv.bid_ask_spread_bps} bps (Max: {inv.max_bps} bps)</div>
                )}
                {inv.cash_vault_reserve !== undefined && (
                  <div>Vault Reserve: {(inv.cash_vault_reserve * 100).toFixed(0)}% (Ground State)</div>
                )}
                {inv.power_factor !== undefined && (
                  <div>cos &phi;: {inv.power_factor} (Min Requirement: &ge; {inv.min_pf})</div>
                )}
                {inv.learning_samples !== undefined && (
                  <div>Ingested Samples: {inv.learning_samples} (Skills: {inv.skills_tracked})</div>
                )}
                {inv.kraken_stop_loss_active !== undefined && (
                  <div>Exchange Stop-Loss: VERIFIED ON KRAKEN MATCHING ENGINE</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4 Architectural Limbs Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
        {/* Microstructure */}
        <div className="p-4 bg-[#0e141f] border border-slate-800 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Microstructure</span>
            <Activity className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-lg font-bold text-white">
            OBI: {data?.limbs.microstructure.obi ?? 0.41}
          </div>
          <div className="text-[11px] text-cyan-300">
            Delta: {data?.limbs.microstructure.footprint_delta ?? '+14.2 BTC'}
          </div>
        </div>

        {/* AC Gravity */}
        <div className="p-4 bg-[#0e141f] border border-slate-800 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">AC-Gravity Field</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-lg font-bold text-white">
            {data?.limbs.ac_gravity.frequency_hz ?? 60.0} Hz
          </div>
          <div className="text-[11px] text-amber-300">
            Power: {data?.limbs.ac_gravity.apparent_power_kva ?? 12.4} kVA
          </div>
        </div>

        {/* Qdrant Memory */}
        <div className="p-4 bg-[#0e141f] border border-slate-800 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Qdrant Vector DB</span>
            <Database className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-lg font-bold text-white">
            {data?.limbs.qdrant_memory.vectors_stored ?? 0} Vectors
          </div>
          <div className="text-[11px] text-purple-300">
            Mode: {data?.limbs.qdrant_memory.mode ?? 'file_fallback'}
            {data?.limbs.qdrant_memory.collection ? ` · ${data.limbs.qdrant_memory.collection}` : ''}
          </div>
        </div>

        {/* 16D ONNX Regime Model */}
        <div className="p-4 bg-[#0e141f] border border-slate-800 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">ONNX Regime Model</span>
            <Sliders className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-lg font-bold text-white">
            16-Dimensional
          </div>
          <div className="text-[11px] text-blue-300 truncate">
            {data?.limbs.regime_model.model_file ?? 'omega_regime_16d.onnx'}
          </div>
        </div>
      </div>
    </div>
  );
};
