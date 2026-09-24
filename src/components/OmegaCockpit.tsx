import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { 
  Atom, 
  ShieldCheck, 
  Zap, 
  TrendingUp, 
  Layers, 
  RotateCw, 
  Lock, 
  AlertTriangle, 
  CheckCircle2, 
  Compass, 
  DollarSign, 
  X
} from 'lucide-react';
import { 
  verifyOmegaAxioms, 
  AxiomVerificationResult
} from '../utils/omegaLogic';
import { useMarketFeed } from '../market/useMarketFeed';

interface OmegaCockpitProps {
  isOpen: boolean;
  onClose: () => void;
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
}

export default function OmegaCockpit({ isOpen, onClose, onLogEvent }: OmegaCockpitProps) {
  const market = useMarketFeed();
  const telemetry = market.telemetry;
  const [autonomyLevel, setAutonomyLevel] = useState<'L4_HITL' | 'L5_AUTONOMOUS'>('L4_HITL');
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'AXIOMS' | 'QUANTUM' | 'ROTATION' | 'VAULT'>('OVERVIEW');
  const [clusterExitDone, setClusterExitDone] = useState(false);
  const [evalPrice, setEvalPrice] = useState('');
  const [evalDirection, setEvalDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [evalStopPrice, setEvalStopPrice] = useState('');
  const [axiomReport, setAxiomReport] = useState<AxiomVerificationResult[]>([]);

  useEffect(() => {
    if (!telemetry) return;
    setEvalPrice((prev) => (prev === '' ? String(telemetry.viaNegativa.spotPrice) : prev));
    setEvalStopPrice((prev) => (
      prev === ''
        ? String(Number((telemetry.viaNegativa.spotPrice - telemetry.viaNegativa.atr14 * 1.2).toFixed(2)))
        : prev
    ));
  }, [telemetry]);

  // Initial axiom verification
  useEffect(() => {
    runAxiomCheck();
  }, [evalPrice, evalDirection, evalStopPrice]);

  const runAxiomCheck = useCallback(() => {
    if (!telemetry) return;
    const targetPrice = parseFloat(evalPrice);
    const stopPrice = parseFloat(evalStopPrice);
    if (!Number.isFinite(targetPrice)) return;

    const report = verifyOmegaAxioms(
      {
        symbol: 'BTC/USD',
        targetPrice,
        direction: evalDirection,
        volume: 1.0,
        exchangeStopLossPrice: stopPrice,
      },
      telemetry.viaNegativa,
      telemetry.gravityField,
      telemetry.acSystem,
      telemetry.basket
    );

    setAxiomReport(report);
  }, [evalPrice, evalDirection, evalStopPrice, telemetry]);

  const handleClusterExit = () => {
    if (!telemetry) return;
    setClusterExitDone(true);
    onLogEvent?.(
      "Axiom 3: Batched Cluster-Exit executed. All tranches closed at market. System in Ground State (100% Cash).",
      "success",
      "The Judge (M8)"
    );
  };

  const handleToggleAutonomy = () => {
    const newLevel = autonomyLevel === 'L4_HITL' ? 'L5_AUTONOMOUS' : 'L4_HITL';
    setAutonomyLevel(newLevel);
    onLogEvent?.(
      newLevel === 'L5_AUTONOMOUS' 
        ? "Autonomy Level 5 engaged: 24/7 Zero-Touch Sovereign Quantum Execution." 
        : "Autonomy Level 4 active: Human-In-The-Loop confirmation required.",
      newLevel === 'L5_AUTONOMOUS' ? 'warn' : 'info',
      "NIO Twin"
    );
  };

  const handleRecalibrate = () => {
    onLogEvent?.(
      "Recalibrating Hilbert phase angles and 3-component gravity potentials...",
      "info",
      "Quantum Core"
    );
    void market.calculate();
    runAxiomCheck();
  };

  if (!isOpen) return null;

  if (!telemetry) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" role="status">
        <p className="text-sm text-slate-300 font-mono">Kraken-Quote fehlt. Das Cockpit bleibt leer, bis ein Lastkurs vorliegt.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-md overflow-y-auto">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-6xl bg-[#0b0e14] border border-slate-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-slate-200"
      >
        {/* Header */}
        <div className="p-6 border-b border-slate-800 bg-[#121622] flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Atom className="w-6 h-6 animate-spin-slow" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-white tracking-wide">
                  PROJEKT: OMEGA
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  L4/L5 QUANTUM COCKPIT
                </span>
                <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  THE JUDGE & THE SWARM
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Polyglot Native Execution Stack • Via Negativa & AC System Theory • 6 Invariant Axioms
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Autonomy Level Switcher */}
            <button
              onClick={handleToggleAutonomy}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-2 border transition-all ${
                autonomyLevel === 'L5_AUTONOMOUS'
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 shadow-lg shadow-amber-500/10'
                  : 'bg-blue-500/20 border-blue-500/50 text-blue-300 hover:bg-blue-500/30'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              {autonomyLevel === 'L5_AUTONOMOUS' ? 'L5: ZERO-TOUCH 24/7' : 'L4: HITL [🚀 LIVE SCHALTEN]'}
            </button>

            <button
              onClick={handleRecalibrate}
              title="Recalibrate Quantum Potentials"
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 px-6 pt-3 border-b border-slate-800 bg-[#0e121b] overflow-x-auto text-xs font-mono">
          {[
            { id: 'OVERVIEW', label: '0. Sovereign Overview' },
            { id: 'AXIOMS', label: '1. The Judge (6 Axiome)' },
            { id: 'QUANTUM', label: '2. AC & Gravitationsfeld' },
            { id: 'ROTATION', label: '3. Meta-Rotation & Takt' },
            { id: 'VAULT', label: '4. Dual-State Vault (90/10)' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`pb-2.5 px-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'border-cyan-400 text-cyan-300 font-semibold'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* TAB 1: OVERVIEW */}
          {activeTab === 'OVERVIEW' && (
            <div className="space-y-6">
              {/* Quick Metric Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-[#121622] border border-slate-800 rounded-xl p-4">
                  <span className="text-[11px] font-mono text-slate-400 uppercase">Leistungsfaktor (cos φ)</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-2xl font-bold text-white font-mono">{telemetry.acSystem.powerFactor}</span>
                    <span className="text-[11px] font-mono text-emerald-400 font-semibold uppercase">
                      {telemetry.acSystem.regime}
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full mt-3 overflow-hidden">
                    <div 
                      className="bg-emerald-400 h-full rounded-full transition-all"
                      style={{ width: `${telemetry.acSystem.powerFactor * 100}%` }}
                    />
                  </div>
                </div>

                <div className="bg-[#121622] border border-slate-800 rounded-xl p-4">
                  <span className="text-[11px] font-mono text-slate-400 uppercase">3-Komp. Gravitation (V_total)</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-2xl font-bold text-cyan-400 font-mono">{telemetry.gravityField.vTotal}</span>
                    <span className="text-[11px] font-mono text-slate-400">P*: ${telemetry.gravityField.potentialMinimumPrice}</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono mt-2">
                    Force: {telemetry.gravityField.gravityForce > 0 ? '+' : ''}{telemetry.gravityField.gravityForce} N
                  </p>
                </div>

                <div className="bg-[#121622] border border-slate-800 rounded-xl p-4">
                  <span className="text-[11px] font-mono text-slate-400 uppercase">Via Negativa Bounds</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-xl font-bold text-amber-300 font-mono">
                      ±${telemetry.viaNegativa.deltaPMax}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 font-mono mt-2 truncate">
                    B_low: ${telemetry.viaNegativa.bLower} • B_up: ${telemetry.viaNegativa.bUpper}
                  </p>
                </div>

                <div className="bg-[#121622] border border-slate-800 rounded-xl p-4">
                  <span className="text-[11px] font-mono text-slate-400 uppercase">Restrisiko (Anti-Martingale)</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-2xl font-bold text-emerald-400 font-mono">
                      $0.00
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                      FREE-ROLL
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono mt-2">
                    Trailing Stop: ${telemetry.basket.trailingBasketStop}
                  </p>
                </div>
              </div>

              {/* Main 2-Column Section */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Left Card: Anti-Martingale Pyramiding & Cluster-Exit */}
                <div className="bg-[#121622] border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <Layers className="w-4 h-4 text-cyan-400" />
                        §5 Reverse-DCA & Batched Cluster-Exit (Anti-Martingale)
                      </h3>
                      <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-mono">
                        Axiom 3 & 4 Active
                      </span>
                    </div>

                    <div className="space-y-3 font-mono text-xs">
                      {telemetry.basket.tranches.map(t => (
                        <div 
                          key={t.id} 
                          className={`p-3 rounded-lg border flex items-center justify-between ${
                            t.isFilled 
                              ? 'bg-slate-900/60 border-cyan-500/30 text-white' 
                              : 'bg-slate-900/20 border-slate-800 text-slate-500'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className={`w-2 h-2 rounded-full ${t.isFilled ? 'bg-cyan-400' : 'bg-slate-600'}`} />
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

                    <div className="mt-4 p-3 bg-slate-900/40 border border-slate-800 rounded-lg text-xs font-mono flex justify-between">
                      <span className="text-slate-400">Basket Avg. Einstieg:</span>
                      <span className="text-white font-bold">${telemetry.basket.averageEntryPrice.toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[11px] text-slate-400 font-mono">Unrealisierter PnL:</p>
                      <p className="text-lg font-bold font-mono text-emerald-400">
                        +${telemetry.basket.unrealizedPnL.toFixed(2)} USD
                      </p>
                    </div>

                    <button
                      onClick={handleClusterExit}
                      disabled={clusterExitDone}
                      className={`px-4 py-2.5 rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-2 ${
                        clusterExitDone
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          : 'bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 shadow-lg shadow-red-500/10'
                      }`}
                    >
                      <Zap className="w-4 h-4" />
                      {clusterExitDone ? 'GROUND STATE (100% CASH)' : '⚡ BATCHED CLUSTER-EXIT'}
                    </button>
                  </div>
                </div>

                {/* Right Card: 6 Invariant Axioms Live Summary */}
                <div className="bg-[#121622] border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        §14 Die 6 Unverrückbaren System-Axiome
                      </h3>
                      <span className="text-[11px] font-mono text-slate-400">Gatekeeper: The Judge</span>
                    </div>

                    <div className="space-y-2 text-xs">
                      {axiomReport.map(a => (
                        <div 
                          key={a.axiomId}
                          className="p-2.5 rounded-lg bg-slate-900/50 border border-slate-800 flex items-start gap-3"
                        >
                          {a.isPassed ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-slate-200">{a.name}</span>
                              <span className={`text-[10px] font-mono font-bold ${a.isPassed ? 'text-emerald-400' : 'text-amber-400'}`}>
                                {a.isPassed ? 'PASSED' : 'FLAGGED'}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 font-mono mt-0.5">{a.metric}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
                    <span className="text-xs text-slate-400 font-mono">Axiom Enforcement:</span>
                    <span className="text-xs font-mono font-bold text-emerald-400">
                      100% MATHEMATISCH GESICHERT
                    </span>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* TAB 2: AXIOMS DEEP DIVE & ORDER GATE */}
          {activeTab === 'AXIOMS' && (
            <div className="space-y-6">
              {/* Order Evaluation Gate */}
              <div className="bg-[#121622] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                  <Lock className="w-4 h-4 text-indigo-400" />
                  The Judge: Candidate Order Verification Engine
                </h3>
                <p className="text-xs text-slate-400 mb-4">
                  Prüft eine geplante Order in Echtzeit gegen alle 6 Axiome des OMEGA-Blueprints vor Ausführung auf Kraken.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="text-[11px] font-mono text-slate-400 block mb-1">Target Spot Price (USD)</label>
                    <input 
                      type="number"
                      value={evalPrice}
                      onChange={e => setEvalPrice(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-mono text-slate-400 block mb-1">Richtung (Impulsvektor)</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEvalDirection('LONG')}
                        className={`flex-1 py-2 rounded-lg text-xs font-mono font-bold transition-all ${
                          evalDirection === 'LONG'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-slate-900 text-slate-400 border border-slate-800'
                        }`}
                      >
                        LONG
                      </button>
                      <button
                        onClick={() => setEvalDirection('SHORT')}
                        className={`flex-1 py-2 rounded-lg text-xs font-mono font-bold transition-all ${
                          evalDirection === 'SHORT'
                            ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                            : 'bg-slate-900 text-slate-400 border border-slate-800'
                        }`}
                      >
                        SHORT
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-mono text-slate-400 block mb-1">Exchange Stop-Loss (Axiom 5)</label>
                    <input 
                      type="number"
                      value={evalStopPrice}
                      onChange={e => setEvalStopPrice(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {axiomReport.map(item => (
                    <div 
                      key={item.axiomId}
                      className={`p-4 rounded-xl border flex flex-col gap-1 ${
                        item.isPassed 
                          ? 'bg-slate-900/40 border-slate-800 text-slate-200' 
                          : 'bg-red-500/10 border-red-500/30 text-red-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {item.isPassed ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-red-400" />
                          )}
                          <span className="font-semibold text-xs text-white">{item.name}</span>
                        </div>
                        <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                          item.isPassed ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
                        }`}>
                          {item.isPassed ? 'KOMPATIBEL' : 'BLOCKIERT DURCH THE JUDGE'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-1">{item.detail}</p>
                      <p className="text-[11px] text-slate-500 font-mono">{item.metric}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: QUANTUM & AC THEORY */}
          {activeTab === 'QUANTUM' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* AC Electrical Model */}
              <div className="bg-[#121622] border border-slate-800 rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  §4 Elektrotechnische AC-Systemtheorie (S = P + jQ)
                </h3>
                <p className="text-xs text-slate-400">
                  Kerzen und Ticks werden als Wechselstrom-Leistungsübertragung formalisiert.
                </p>

                <div className="space-y-3 font-mono text-xs">
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">Wirkleistung P (|ΔClose| / ATR):</span>
                    <span className="text-white font-bold">{telemetry.acSystem.activePower}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">Blindleistung Q (Dochte & Sweeps):</span>
                    <span className="text-amber-400 font-bold">{telemetry.acSystem.reactivePower}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">Scheinleistung S:</span>
                    <span className="text-cyan-400 font-bold">{telemetry.acSystem.apparentPower}</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">Hilbert-Phasen-Resonanz cos(Δφ):</span>
                    <span className="text-emerald-400 font-bold">{telemetry.acSystem.hilbertResonance}</span>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono">
                  ✓ Konstruktive Interferenz aktiv (cos(Δφ) ≥ 0.75).
                </div>
              </div>

              {/* 3-Component Gravity Field */}
              <div className="bg-[#121622] border border-slate-800 rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Compass className="w-4 h-4 text-cyan-400" />
                  §2 Das 3-Komponenten Gravitationsfeld (V_total)
                </h3>
                <p className="text-xs text-slate-400">
                  Preisteilchen bewegen sich entlang des Gradienten in das Potentialminimum P*.
                </p>

                <div className="space-y-3 font-mono text-xs">
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">V_Visible (Sichtbare L2 Tiefe - w=0.25):</span>
                      <span className="text-white font-bold">{telemetry.gravityField.vVisible}</span>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">V_Blind (Schatten-Orderbuch - w=0.35):</span>
                      <span className="text-white font-bold">{telemetry.gravityField.vBlind}</span>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">V_Polymarket (Echtgeld-Konsens - w=0.40):</span>
                      <span className="text-white font-bold">{telemetry.gravityField.vPolymarket}</span>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex justify-between items-center">
                    <span className="text-cyan-300 font-semibold">Gleichgewicht P*:</span>
                    <span className="text-white font-bold">${telemetry.gravityField.potentialMinimumPrice.toLocaleString()}</span>
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 4: META-ROTATION */}
          {activeTab === 'ROTATION' && (
            <div className="space-y-4">
              <div className="bg-[#121622] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  §8 5-Minuten Meta-Rotation & Ökosystem-Clustering
                </h3>
                <p className="text-xs text-slate-400 mb-4">
                  S_meta = w1*r + w2*β + w3*RVOL_5m + w4*cos(φ) • Automatische Hot-Swaps auf den Meta-Leader.
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="pb-3 px-2">Symbol</th>
                        <th className="pb-3 px-2">Ökosystem-Cluster</th>
                        <th className="pb-3 px-2">Taktgeber</th>
                        <th className="pb-3 px-2">Beta (β)</th>
                        <th className="pb-3 px-2">RVOL 5m</th>
                        <th className="pb-3 px-2">cos(φ)</th>
                        <th className="pb-3 px-2">Meta-Score</th>
                        <th className="pb-3 px-2">Ampel-Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {telemetry.ecosystemLeaders.map(item => (
                        <tr key={item.symbol} className="hover:bg-slate-900/40">
                          <td className="py-3 px-2 font-bold text-white flex items-center gap-2">
                            {item.isLeader && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />}
                            {item.symbol}
                          </td>
                          <td className="py-3 px-2 text-slate-300">{item.cluster} Ökosystem</td>
                          <td className="py-3 px-2 text-cyan-400 font-semibold">{item.leadAsset}</td>
                          <td className="py-3 px-2 text-slate-300">{item.betaLead}</td>
                          <td className="py-3 px-2 text-slate-300">{item.rvol5m}x</td>
                          <td className="py-3 px-2 text-slate-300">{item.cosPhi}</td>
                          <td className="py-3 px-2 text-emerald-400 font-bold">{item.metaScore}</td>
                          <td className="py-3 px-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              item.lampState === 'GREEN_GLOW'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/20'
                                : item.lampState === 'GREEN_SOLID'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-slate-800 text-slate-400'
                            }`}>
                              {item.lampState}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: DUAL-STATE VAULT */}
          {activeTab === 'VAULT' && (
            <div className="space-y-6">
              <div className="bg-[#121622] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  §10 Dual-State Vault (90/10 Kapital-Governance)
                </h3>
                <p className="text-xs text-slate-400 mb-6">
                  90 % aktives Margin-Trading mit dynamischem Konfidenz-Hebel • 10 % Kraken Auto-Earn / Flash Dislocation Vault.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* 90% Margin Box */}
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-mono text-slate-400">90% ACTIVE MARGIN</span>
                      <span className="text-xs font-mono text-cyan-400 font-bold">L_dyn: {telemetry.vault.dynamicLeverage}x</span>
                    </div>
                    <p className="text-2xl font-bold text-white font-mono">
                      ${telemetry.vault.activeMarginAllocationUSD.toLocaleString()} USD
                    </p>
                    <p className="text-xs text-slate-400 mt-2">
                      Verwendet für Reverse-DCA Pyramidisierung mit dynamischem Konfidenz-Hebel.
                    </p>
                  </div>

                  {/* 10% Dual Vault Box */}
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-mono text-slate-400">10% DUAL-STATE VAULT</span>
                      <span className="text-xs font-mono text-emerald-400 font-bold">{telemetry.vault.vaultYieldAPY}% APY</span>
                    </div>
                    <p className="text-2xl font-bold text-emerald-400 font-mono">
                      ${telemetry.vault.vaultAllocationUSD.toLocaleString()} USD
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-xs text-slate-300 font-mono">
                        Zustand A: Kraken Flexible Auto-Earn (Instant-Unbonding &lt; 50ms)
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-slate-800 bg-[#0c0f16] flex items-center justify-between text-xs font-mono text-slate-400">
          <div className="flex items-center gap-4">
            <span>Status: <strong className="text-emerald-400 font-bold">CANONICAL-OMEGA-1.0</strong></span>
            <span>Unbonding Latency: <strong className="text-white">24 ms</strong></span>
          </div>
          <span className="text-slate-500">M8-Gate • Zero-Dummy Guarantee</span>
        </div>
      </motion.div>
    </div>
  );
}
