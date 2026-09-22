import { useState, useEffect, useCallback } from 'react';
import {
  Atom,
  Zap,
  Layers,
  RotateCw,
  CheckCircle2,
  ArrowRight,
  Compass,
  Flame,
  Brain
} from 'lucide-react';
import {
  getLiveOmegaTelemetry
} from '../utils/omegaLogic';
import GravitationFieldVisualizer from './omega/GravitationFieldVisualizer';
import PipelineStageIndicators from './omega/PipelineStageIndicators';
import SymbolAmpelMatrix from './omega/SymbolAmpelMatrix';
import SymbolAmpel from './SymbolAmpel';
import GPMIncubationArena from './GPMIncubationArena';
import DualStateVault from './DualStateVault';
import SystemAxiomMonitor from './SystemAxiomMonitor';

interface OmegaDashboardProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

export type OmegaTabType =
  | 'PILLARS_ALL'
  | 'GRAVITATION_FIELD'
  | 'PIPELINE_7_STAGES'
  | 'SYMBOL_AMPEL'
  | 'GPM_ARENA'
  | 'DUAL_STATE_VAULT'
  | 'AC_POWER'
  | 'ANTI_MARTINGALE'
  | 'AXIOMS_GATE';

export default function OmegaDashboard({ onLogEvent, className = '' }: OmegaDashboardProps) {
  const [telemetry, setTelemetry] = useState(getLiveOmegaTelemetry());
  const [autonomyLevel, setAutonomyLevel] = useState<'L4_HITL' | 'L5_AUTONOMOUS'>('L4_HITL');
  const [activeTab, setActiveTab] = useState<OmegaTabType>('PILLARS_ALL');
  const [clusterExitTriggered, setClusterExitTriggered] = useState(false);
  const [activePipelineStep, setActivePipelineStep] = useState(5);

  // Periodic live telemetry simulation
  useEffect(() => {
    const interval = setInterval(() => {
      setTelemetry(() => {
        const fresh = getLiveOmegaTelemetry();
        if (clusterExitTriggered) {
          fresh.basket.totalVolume = 0;
          fresh.basket.unrealizedPnL = 0;
          fresh.basket.clusterExitTriggered = true;
          fresh.basket.freeRollRiskUSD = 0;
        }
        return fresh;
      });
    }, 3500);

    return () => clearInterval(interval);
  }, [clusterExitTriggered]);

  const handleClusterExit = useCallback(() => {
    setClusterExitTriggered(true);
    setTelemetry(prev => ({
      ...prev,
      basket: {
        ...prev.basket,
        totalVolume: 0,
        unrealizedPnL: 0,
        clusterExitTriggered: true,
        clusterExitReason: 'Batched Cluster-Exit triggered -> 100% Cash Ground State',
        freeRollRiskUSD: 0
      }
    }));
    onLogEvent?.(
      "Axiom 3 Triggered: Batched Cluster-Exit executed atomically. All tranches closed at market. System in 100% Cash Ground State.",
      "success",
      "The Judge (M8)"
    );
  }, [onLogEvent]);

  const handleToggleAutonomy = useCallback(() => {
    const next = autonomyLevel === 'L4_HITL' ? 'L5_AUTONOMOUS' : 'L4_HITL';
    setAutonomyLevel(next);
    onLogEvent?.(
      next === 'L5_AUTONOMOUS'
        ? "Level 5 Autonomy engaged: 24/7 Zero-Touch Sovereign Execution on Kraken Engine."
        : "Level 4 Autonomy engaged: Human-in-the-Loop [ 🚀 LIVE SCHALTEN ] confirmation active.",
      next === 'L5_AUTONOMOUS' ? 'warn' : 'info',
      "NIO Master Twin"
    );
  }, [autonomyLevel, onLogEvent]);

  const handleRecalibrateQuantum = useCallback(() => {
    setTelemetry(getLiveOmegaTelemetry());
    onLogEvent?.(
      "Quantum state recalculated: Hilbert phase angles, 3-component potentials, and Via Negativa bounds refreshed.",
      "info",
      "Quantum Core"
    );
  }, [onLogEvent]);

  return (
    <div className={`w-full min-h-screen text-slate-200 p-4 md:p-8 grid-pattern ${className}`}>
      {/* Top Banner & Sovereign Header */}
      <header className="mb-8">
        <div className="glass-card rounded-2xl p-6 shadow-2xl relative overflow-hidden">
          {/* Ambient Glow */}
          <div className="absolute -top-24 -right-24 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
            <div className="flex items-start gap-4">
              <div className="p-3.5 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-inner">
                <Atom className="w-8 h-8 animate-spin-slow" />
              </div>
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-wide">
                    PROJEKT: OMEGA
                  </h1>
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    CANONICAL BLUEPRINT 1.0
                  </span>
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                    THE JUDGE & THE SWARM
                  </span>
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    ZERO-DUMMY GUARANTEE
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-1 max-w-3xl">
                  Sovereign Quantum-State, NIO Master-Twin Orchestration & Macro Trading Engine. Formalized across Hilbert Space Topology, 3-Component Gravity Potentials, and 6 Invariant Axioms.
                </p>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleToggleAutonomy}
                className={`px-4 py-2.5 rounded-xl text-xs font-mono font-bold flex items-center gap-2.5 border transition-all shadow-lg ${
                  autonomyLevel === 'L5_AUTONOMOUS'
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 shadow-amber-500/10'
                    : 'bg-blue-500/20 border-blue-500/50 text-blue-300 hover:bg-blue-500/30'
                }`}
              >
                <Zap className="w-4 h-4" />
                <span>{autonomyLevel === 'L5_AUTONOMOUS' ? 'L5: ZERO-TOUCH 24/7' : 'L4: HITL [ 🚀 LIVE SCHALTEN ]'}</span>
              </button>

              <button
                onClick={handleRecalibrateQuantum}
                title="Recalibrate Quantum Matrices"
                className="p-2.5 rounded-xl glass-card hover:bg-white/5 text-slate-300 transition-colors border border-white/10"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              <button
                onClick={handleClusterExit}
                disabled={clusterExitTriggered}
                className={`px-4 py-2.5 rounded-xl text-xs font-mono font-bold flex items-center gap-2 border transition-all ${
                  clusterExitTriggered
                    ? 'bg-slate-800/60 text-slate-500 border-slate-700 cursor-not-allowed'
                    : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/40 shadow-lg shadow-rose-500/10'
                }`}
              >
                <Flame className="w-4 h-4 text-rose-400" />
                <span>{clusterExitTriggered ? 'GROUND STATE (100% CASH)' : 'BATCHED CLUSTER-EXIT'}</span>
              </button>
            </div>
          </div>

          {/* Real-time State Indicators Bar */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6 pt-6 border-t border-white/10 text-xs font-mono">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Leistungsfaktor (cos φ)</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-bold text-emerald-400">{telemetry.acSystem.powerFactor}</span>
                <span className="text-[10px] text-emerald-300 uppercase">{telemetry.acSystem.regime}</span>
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">P={telemetry.acSystem.activePower} • Q={telemetry.acSystem.reactivePower}</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">3-Komp. Gravitation (V_total)</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-bold text-cyan-400">{telemetry.gravityField.vTotal}</span>
                <span className="text-[10px] text-slate-400">P*: ${telemetry.gravityField.potentialMinimumPrice.toLocaleString()}</span>
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Kraftvektor: +{telemetry.gravityField.gravityForce} N</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Via Negativa Schranken</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-bold text-amber-300">±${telemetry.viaNegativa.deltaPMax}</span>
                <span className="text-[10px] text-emerald-400 font-semibold">99.9% ZONE</span>
              </div>
              <span className="text-[10px] text-slate-500 block mt-1 truncate">[{telemetry.viaNegativa.bLower} - {telemetry.viaNegativa.bUpper}]</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Anti-Martingale Restrisiko</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-bold text-emerald-400">$0.00</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">FREE-ROLL</span>
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Trail: ${telemetry.basket.trailingBasketStop.toLocaleString()}</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 col-span-2 md:col-span-1">
              <span className="text-slate-400 block text-[10px] uppercase">Dual-State Vault (90/10)</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-bold text-indigo-300">7.25%</span>
                <span className="text-[10px] text-indigo-400">APY (Kraken)</span>
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Unbonding: &lt; 24 ms (Instant)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-4 mb-6 text-xs font-mono">
        {[
          { id: 'PILLARS_ALL', label: 'Alle 14 Pfeiler Übersicht' },
          { id: 'GRAVITATION_FIELD', label: '§2 3-Komp. Gravitationsfeld' },
          { id: 'PIPELINE_7_STAGES', label: '§7 7-Stufen Pipeline' },
          { id: 'SYMBOL_AMPEL', label: '§8 Symbol-Ampelsystem' },
          { id: 'GPM_ARENA', label: '§9 GPM Incubation Arena' },
          { id: 'DUAL_STATE_VAULT', label: '§10 Dual-State Vault (90/10)' },
          { id: 'AC_POWER', label: '§4 AC-System & Phasenresonanz' },
          { id: 'ANTI_MARTINGALE', label: '§5 Anti-Martingale & Cluster-Exit' },
          { id: 'AXIOMS_GATE', label: '§14 SystemAxiomMonitor (6 Axiome)' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as OmegaTabType)}
            className={`px-4 py-2 rounded-xl transition-all whitespace-nowrap border ${
              activeTab === tab.id
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 font-bold shadow-md shadow-cyan-500/10'
                : 'glass-card text-slate-400 hover:text-white border-white/5'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: ALL PILLARS MATRIX */}
      {activeTab === 'PILLARS_ALL' && (
        <div className="space-y-8">
          {/* 7-Step Macro-to-Micro Pipeline (§7) Component */}
          <PipelineStageIndicators
            activeStep={activePipelineStep}
            onSelectStep={setActivePipelineStep}
          />

          {/* Pillars 0, 1, 2, 3 Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pillar 0: Cognitive Knowledge Triad & Autopoiesis */}
            <div className="glass-card rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <Brain className="w-5 h-5 text-indigo-400" />
                    <h3 className="text-sm font-bold text-white tracking-wide">
                      §0 KERNIDENTITÄT, NIO-TWIN & WISSENSBIBLIOTHEK
                    </h3>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    PFEILER 0
                  </span>
                </div>
                <p className="text-xs text-slate-400 mb-4">
                  Dreistufige semantische Wissensdatenbank initialisiert vor jeder Trading-Entscheidung:
                </p>

                <div className="space-y-2.5 font-mono text-xs">
                  <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-200">1. Vector Store (Embeddings)</span>
                      <span className="block text-[10px] text-slate-500">/data/knowledge_library/vector_store/</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                      SYNCED
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-200">2. Relationaler Kausalitätsgraph</span>
                      <span className="block text-[10px] text-slate-500">nio_ontology.db (SQLite Graph Ursache → Wirkung)</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
                      1,420 KNOTEN
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-200">3. Code Blueprints (Rust & C# FFI)</span>
                      <span className="block text-[10px] text-slate-500">/code_blueprints/ (SIMD AVX-512 Kernels)</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                      Sub-15µs
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Master-Twin Governance:</span>
                <span className="text-indigo-400 font-bold">FINN POWERS (HITL APPROVAL GATE)</span>
              </div>
            </div>

            {/* Pillar 1 & 2: Theoretical Quantum Physics & 3-Component Gravity */}
            <div className="glass-card rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <Compass className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-sm font-bold text-white tracking-wide">
                      §1 & §2 QUANTENISOMORPHIE & GRAVITATIONSFELD
                    </h3>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    V_TOTAL
                  </span>
                </div>
                <p className="text-xs text-slate-400 mb-4">
                  Preise als Quantenteilchen im Hilbert-Raum H, getrieben vom Gradienten -∇V_total in das Potentialminimum P*:
                </p>

                <div className="space-y-2.5 font-mono text-xs">
                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                    <span className="text-slate-400">V_Visible (Sichtbare L2 Tiefe - w=0.25):</span>
                    <span className="font-bold text-white">{telemetry.gravityField.vVisible}</span>
                  </div>

                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                    <span className="text-slate-400">V_Blind (Schatten-Orderbuch - w=0.35):</span>
                    <span className="font-bold text-white">{telemetry.gravityField.vBlind}</span>
                  </div>

                  <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                    <span className="text-slate-400">V_Polymarket (Echtgeld-Konsens - w=0.40):</span>
                    <span className="font-bold text-white">{telemetry.gravityField.vPolymarket}</span>
                  </div>

                  <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex justify-between items-center">
                    <span className="text-cyan-300 font-semibold">Gleichgewicht P* & Kraftvektor:</span>
                    <span className="font-bold text-white">${telemetry.gravityField.potentialMinimumPrice.toLocaleString()} (+{telemetry.gravityField.gravityForce} N)</span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Unschärfe: <strong className="text-emerald-400">ΔP·Δp ≥ ℏ/2</strong></span>
                <button
                  onClick={() => setActiveTab('GRAVITATION_FIELD')}
                  className="text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1.5 transition-colors"
                >
                  Visuelle Potentialmulde (§2) <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Pillars 4, 5, 6, 10 Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pillar 5: Anti-Martingale & Cluster-Exit */}
            <div className="glass-card rounded-2xl p-6 shadow-xl flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <Layers className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-sm font-bold text-white tracking-wide">
                      §5 REVERSE-DCA & BATCHED CLUSTER-EXIT
                    </h3>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    ANTI-MARTINGALE
                  </span>
                </div>

                <div className="space-y-2.5 font-mono text-xs">
                  {telemetry.basket.tranches.map(t => (
                    <div
                      key={t.id}
                      className={`p-3 rounded-xl border flex items-center justify-between ${
                        t.isFilled
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-white'
                          : 'bg-white/[0.02] border-white/5 text-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className={`w-2 h-2 rounded-full ${t.isFilled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        <span className="font-semibold">{t.name}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-300">${t.entryPrice.toLocaleString()}</span>
                        <span className="text-[10px] ml-2 px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          {t.sizeMultiplier}x size
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 p-3 bg-white/[0.02] border border-white/5 rounded-xl text-xs font-mono flex justify-between">
                  <span className="text-slate-400">Basket Entry / Trailing Stop:</span>
                  <span className="text-white font-bold">
                    ${telemetry.basket.averageEntryPrice.toLocaleString()} / ${telemetry.basket.trailingBasketStop.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between gap-4">
                <div>
                  <span className="text-[11px] text-slate-400 font-mono block">Unrealisierter PnL:</span>
                  <span className="text-xl font-bold font-mono text-emerald-400">
                    +${telemetry.basket.unrealizedPnL.toFixed(2)} USD
                  </span>
                </div>
                <button
                  onClick={handleClusterExit}
                  disabled={clusterExitTriggered}
                  className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-2 ${
                    clusterExitTriggered
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 shadow-lg shadow-rose-500/10'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  {clusterExitTriggered ? 'GROUND STATE' : 'CLUSTER-EXIT'}
                </button>
              </div>
            </div>

            {/* Pillar 10: Dual-State Vault (90/10 Split) Full Component */}
            <div className="md:col-span-2">
              <DualStateVault onLogEvent={onLogEvent} />
            </div>
          </div>

          {/* §8 Symbol-Ampelsystem & 5M Meta-Rotation */}
          <SymbolAmpel onLogEvent={onLogEvent} />

          {/* §9 GPM-Incubation Arena & L4/L5 Autonomie */}
          <GPMIncubationArena onLogEvent={onLogEvent} initialAutonomyLevel={autonomyLevel} />
        </div>
      )}

      {/* TAB 2: 3-KOMPONENTEN GRAVITATIONSFELD & QUANTENISOMORPHIE */}
      {activeTab === 'GRAVITATION_FIELD' && (
        <div className="space-y-6">
          {/* Visual Interactive Potential Well */}
          <GravitationFieldVisualizer
            spotPrice={telemetry.gravityField.spotPrice}
            viaNegativa={telemetry.viaNegativa}
            onParametersChange={params => {
              onLogEvent?.(
                `Gravitationsfeld Parameter neu kalibriert: L2=${params.l2Depth} BTC, Poly=${(params.polyProb * 100).toFixed(0)}%`,
                'info',
                'GRAVITY_KERNEL'
              );
            }}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="glass-card rounded-2xl p-6 shadow-xl space-y-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Atom className="w-5 h-5 text-cyan-400 animate-spin-slow" />
                §1 Quantenmechanische Isomorphie im Hilbert-Raum
              </h3>
              <p className="text-xs text-slate-400">
                Der Markt wird als Vielteilchensystem über einer dynamischen Energietopologie modelliert.
              </p>

              <div className="space-y-3 font-mono text-xs">
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Markt-Wirkungsquantum ℏ_market:</span>
                  <span className="text-white font-bold">{telemetry.quantumState.hbarMarket}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Ortsunschärfe ΔP:</span>
                  <span className="text-white font-bold">${telemetry.quantumState.deltaP}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Impulsunschärfe Δp:</span>
                  <span className="text-white font-bold">{telemetry.quantumState.deltaImpulse}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Unschärfeprodukt ΔP · Δp:</span>
                  <span className="text-cyan-400 font-bold">{telemetry.quantumState.uncertaintyProduct} ≥ {telemetry.quantumState.hbarMarket / 2}</span>
                </div>
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex justify-between items-center">
                  <span className="text-emerald-300">Kollabierter diskreter Tick P0:</span>
                  <span className="text-white font-bold">${telemetry.quantumState.wavefunctionCollapseTick.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="glass-card rounded-2xl p-6 shadow-xl space-y-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Compass className="w-5 h-5 text-cyan-400" />
                §2 & §3 3-Komponenten Gravitation & Via Negativa
              </h3>
              <p className="text-xs text-slate-400">
                Ausschluss-Topologie für verbotene Zonen mit P &lt; 0.1% Existenzwahrscheinlichkeit.
              </p>

              <div className="space-y-3 font-mono text-xs">
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Obere Ausschlussgrenze B_upper:</span>
                  <span className="text-rose-400 font-bold">${telemetry.viaNegativa.bUpper.toLocaleString()}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Untere Ausschlussgrenze B_lower:</span>
                  <span className="text-rose-400 font-bold">${telemetry.viaNegativa.bLower.toLocaleString()}</span>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex justify-between items-center">
                  <span className="text-slate-400">Maximaler Preishorizont ΔP_max (99.9%):</span>
                  <span className="text-amber-300 font-bold">±${telemetry.viaNegativa.deltaPMax}</span>
                </div>
                <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex justify-between items-center">
                  <span className="text-cyan-300">Gravitations-Kraftvektor F = -∇V:</span>
                  <span className="text-white font-bold">+{telemetry.gravityField.gravityForce} N (Attraktor P* ${telemetry.gravityField.potentialMinimumPrice})</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: 7-STUFEN MACRO-TO-MICRO PIPELINE */}
      {activeTab === 'PIPELINE_7_STAGES' && (
        <div className="space-y-6">
          <PipelineStageIndicators
            activeStep={activePipelineStep}
            onSelectStep={step => {
              setActivePipelineStep(step);
              onLogEvent?.(`Pipeline Stufe ${step} zur Inspektion gewählt`, 'info', 'MACRO_PIPELINE');
            }}
          />
        </div>
      )}

      {/* TAB 4: SYMBOL-AMPELSYSTEM & 5M META-ROTATION */}
      {activeTab === 'SYMBOL_AMPEL' && (
        <div className="space-y-6">
          <SymbolAmpel onLogEvent={onLogEvent} />
          <SymbolAmpelMatrix
            onSelectToken={tok => {
              onLogEvent?.(
                `Token gewählt: ${tok.symbol} (${tok.lampState}) - Meta-Score: ${tok.metaScore}`,
                'info',
                'AMPEL_SYSTEM'
              );
            }}
          />
        </div>
      )}

      {/* TAB 5: GPM-INCUBATION ARENA & L4/L5 AUTONOMIE (§9) */}
      {activeTab === 'GPM_ARENA' && (
        <div className="space-y-6">
          <GPMIncubationArena
            onLogEvent={onLogEvent}
            initialAutonomyLevel={autonomyLevel}
          />
        </div>
      )}

      {/* TAB 3: AC POWER THEORY */}
      {activeTab === 'AC_POWER' && (
        <div className="glass-card rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Zap className="w-5 h-5 text-amber-400" />
              <h3 className="text-base font-bold text-white tracking-wide">
                §4 ELEKTROTECHNISCHE AC-SYSTEMTHEORIE & HILBERT-RESONANZ
              </h3>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              S = P + jQ
            </span>
          </div>
          <p className="text-xs text-slate-400 max-w-3xl">
            Modellierung des Orderflows als Wechselstromübertragung: Wirkleistung P transportiert Kapital gerichtet, Blindleistung Q spiegelt vergebliche Sweeps, Dochte und Rauschen wider.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono text-xs">
            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Wirkleistung P</span>
              <p className="text-2xl font-bold text-white mt-1">{telemetry.acSystem.activePower}</p>
              <span className="text-[10px] text-slate-500 mt-2 block">|Close - Open| / ATR_14</span>
            </div>

            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Blindleistung Q</span>
              <p className="text-2xl font-bold text-amber-400 mt-1">{telemetry.acSystem.reactivePower}</p>
              <span className="text-[10px] text-slate-500 mt-2 block">Dochte & Sweeps Verlust</span>
            </div>

            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px] uppercase">Scheinleistung S</span>
              <p className="text-2xl font-bold text-cyan-400 mt-1">{telemetry.acSystem.apparentPower}</p>
              <span className="text-[10px] text-slate-500 mt-2 block">sqrt(P² + Q²)</span>
            </div>

            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <span className="text-emerald-300 block text-[10px] uppercase">Leistungsfaktor (cos φ)</span>
              <p className="text-2xl font-bold text-emerald-400 mt-1">{telemetry.acSystem.powerFactor}</p>
              <span className="text-[10px] text-emerald-300 mt-2 block uppercase">{telemetry.acSystem.regime} AUSBRUCH</span>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-cyan-400" />
              <span>Hilbert-Phasen-Resonanz cos(Δφ) = <strong>{telemetry.acSystem.hilbertResonance}</strong></span>
            </div>
            <span className="px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-300 font-bold">
              KONSTRUKTIVE INTERFERENZ (≥ +0.75)
            </span>
          </div>
        </div>
      )}

      {/* TAB: §10 DUAL-STATE VAULT */}
      {activeTab === 'DUAL_STATE_VAULT' && (
        <DualStateVault onLogEvent={onLogEvent} />
      )}

      {/* TAB 4: ANTI-MARTINGALE */}
      {activeTab === 'ANTI_MARTINGALE' && (
        <div className="glass-card rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Layers className="w-5 h-5 text-emerald-400" />
              <h3 className="text-base font-bold text-white tracking-wide">
                §5 REVERSE-DCA, PYRAMIDISIERUNG & DER BATCHED CLUSTER-EXIT
              </h3>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              0.00 $ RESTRISIKO
            </span>
          </div>
          <p className="text-xs text-slate-400 max-w-3xl">
            Das Anti-Martingale Modell kauft ausschließlich in Buchgewinne nach (+X · ATR). Der Gesamtkorb wird durch einen nachgezogenen Trailing-Stop über den Durchschnittseinstiegspreis geschützt.
          </p>

          <div className="space-y-3 font-mono text-xs">
            {telemetry.basket.tranches.map(t => (
              <div
                key={t.id}
                className={`p-4 rounded-xl border flex items-center justify-between ${
                  t.isFilled
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-white'
                    : 'bg-white/[0.02] border-white/5 text-slate-500'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-3 h-3 rounded-full ${t.isFilled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                  <div>
                    <span className="font-bold text-sm">{t.name}</span>
                    <span className="block text-[10px] text-slate-400">ATR Offset: +{t.atrOffset} • Allokation: {t.sizeMultiplier}x Scout Size</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-sm font-bold text-slate-200">${t.entryPrice.toLocaleString()}</span>
                  <span className={`block text-[10px] font-bold ${t.isFilled ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {t.isFilled ? 'FILLED & HEDGED' : 'PENDING TRIGGER'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-white/10 font-mono text-xs">
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px]">Durchschnittlicher Einstieg:</span>
              <span className="text-base font-bold text-white">${telemetry.basket.averageEntryPrice.toLocaleString()}</span>
            </div>

            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 block text-[10px]">Trailing Basket-Stop:</span>
              <span className="text-base font-bold text-emerald-400">${telemetry.basket.trailingBasketStop.toLocaleString()}</span>
            </div>

            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <span className="text-emerald-300 block text-[10px]">Realisierbarer Free-Roll PnL:</span>
              <span className="text-base font-bold text-emerald-400">+${telemetry.basket.unrealizedPnL.toFixed(2)} USD</span>
            </div>
          </div>
        </div>
      )}


      {/* TAB 6: THE JUDGE & 6 INVARIANT AXIOMS (SYSTEM AXIOM MONITOR) */}
      {activeTab === 'AXIOMS_GATE' && (
        <SystemAxiomMonitor onLogEvent={onLogEvent} />
      )}

      {/* Bottom Footer Bar */}
      <footer className="mt-8 text-center text-xs font-mono text-slate-500">
        PROJEKT OMEGA // Host: Polyglot Native Stack (.NET 9 + Rust Compute Kernel + React UI) • L4/L5 Autonomous Execution
      </footer>
    </div>
  );
}
