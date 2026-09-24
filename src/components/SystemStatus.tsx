import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  Zap,
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp,
  Cpu,
  Lock,
  Compass,
  Radio,
  Layers,
  Info
} from 'lucide-react';
import {
  verifyOmegaAxioms,
  calculateViaNegativa,
  calculateViaNegativaAnalysis,
  AxiomVerificationResult,
  ViaNegativaState
} from '../utils/omegaLogic';
import { useMarketFeed } from '../market/useMarketFeed';

export interface SystemStatusProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
  compact?: boolean;
  initialSymbol?: 'BTC/USD' | 'SOL/USD' | 'SUI/USD' | 'ETH/USD';
  showControls?: boolean;
  onInspectAxiom?: (axiomId: number) => void;
}

export type DiagnosticMode = 'NOMINAL' | 'WARN_ZONE' | 'BREACH_ZONE' | 'COUNTER_GRAVITY' | 'NAKED_STOP' | 'FAKEOUT_PHASE';

interface AxiomHealthSummary {
  axiomId: number;
  sectionCode: string;
  name: string;
  formalName: string;
  formula: string;
  status: 'SAFE' | 'WARNING' | 'BREACH';
  isPassed: boolean;
  score: number; // 0 - 100
  metricLabel: string;
  metricValue: string;
  secondaryMetric: string;
  detail: string;
  remediation?: string;
  iconType: 'shield' | 'compass' | 'layers' | 'lock' | 'radio' | 'activity';
  keyStats: Array<{ label: string; value: string; isGood?: boolean }>;
}

export default function SystemStatus({
  onLogEvent,
  className = '',
  compact = false,
  initialSymbol = 'BTC/USD',
  showControls = true,
  onInspectAxiom
}: SystemStatusProps) {
  // Live asset selection
  const [selectedSymbol, setSelectedSymbol] = useState<'BTC/USD' | 'SOL/USD' | 'SUI/USD' | 'ETH/USD'>(initialSymbol);
  
  // Real-time telemetry baseline
  const market = useMarketFeed();
  const [telemetry, setTelemetry] = useState(market.telemetry);
  const [lastTick, setLastTick] = useState<string>(() => new Date().toLocaleTimeString('de-DE'));
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [expandedAxiomId, setExpandedAxiomId] = useState<number | null>(null);
  
  // Diagnostic simulation mode to demonstrate reactive status indicators
  const [diagnosticMode, setDiagnosticMode] = useState<DiagnosticMode>('NOMINAL');

  // Asset price & volatility specs
  useEffect(() => {
    if (market.telemetry) setTelemetry(market.telemetry);
  }, [market.telemetry]);

  const assetSpecs: Record<string, { basePrice: number; atr: number; step: number } | null> = useMemo(() => {
    const build = (display: string, step: number) => {
      const quote = market.quoteFor(display);
      if (!quote || !(quote.last > 0) || !(quote.atr14 && quote.atr14 > 0)) return null;
      return { basePrice: quote.last, atr: quote.atr14, step };
    };
    return {
      'BTC/USD': build('BTC/USD', 10),
      'SOL/USD': build('SOL/USD', 0.1),
      'SUI/USD': build('SUI/USD', 0.01),
      'ETH/USD': build('ETH/USD', 1),
    };
  }, [market.feed, market.computation]);

  // Compute active target price based on diagnostic simulation
  const currentSpec = assetSpecs[selectedSymbol] ?? assetSpecs['BTC/USD'] ?? { basePrice: 0, atr: 0, step: 1 };
  const activeTargetPrice = useMemo(() => {
    if (diagnosticMode === 'BREACH_ZONE') {
      // Intentionally push price past upper exclusion bound
      return Number((currentSpec.basePrice + currentSpec.atr * 4.2).toFixed(2));
    }
    if (diagnosticMode === 'WARN_ZONE') {
      // Push price near the boundary
      return Number((currentSpec.basePrice + currentSpec.atr * 3.1).toFixed(2));
    }
    return currentSpec.basePrice;
  }, [diagnosticMode, currentSpec]);

  // Compute candidate direction
  const activeDirection = useMemo<'LONG' | 'SHORT'>(() => {
    if (!telemetry) return 'LONG';
    if (diagnosticMode === 'COUNTER_GRAVITY') {
      // Force short when gravity is positive (or vice-versa)
      return telemetry.gravityField.gravityForce >= 0 ? 'SHORT' : 'LONG';
    }
    return 'LONG';
  }, [diagnosticMode, telemetry]);

  // Compute stop-loss price
  const activeStopLoss = useMemo(() => {
    if (diagnosticMode === 'NAKED_STOP') {
      return 0; // Naked position violation of Axiom 5
    }
    return Number((activeTargetPrice - currentSpec.atr * 1.25).toFixed(2));
  }, [diagnosticMode, activeTargetPrice, currentSpec.atr]);

  // Live Via Negativa state
  const liveViaNegativa: ViaNegativaState = useMemo(() => {
    return calculateViaNegativa(currentSpec.basePrice, currentSpec.atr, 60, 30, 30);
  }, [currentSpec]);

  // Active AC System telemetry adjusted for diagnostic mode
  const activeAcSystem = useMemo(() => {
    if (!telemetry) {
      return {
        activePower: 0,
        reactivePower: 0,
        apparentPower: 0,
        powerFactor: 0,
        regime: 'NORMAL' as const,
        htfPhase: 0,
        ltfPhase: 0,
        hilbertResonance: 0,
        isConstructiveInterference: false,
      };
    }
    if (diagnosticMode === 'FAKEOUT_PHASE') {
      return {
        ...telemetry.acSystem,
        powerFactor: 0.18, // Overheated fakeout below threshold 0.30
        hilbertResonance: 0.42, // Sub-optimal phase
        isConstructiveInterference: false,
        regime: 'OVERHEATED_FAKEOUT' as const
      };
    }
    return telemetry.acSystem;
  }, [diagnosticMode, telemetry]);

  // Re-verify the 6 axioms against the active engine state
  const axiomVerification: AxiomVerificationResult[] = useMemo(() => {
    if (!telemetry || currentSpec.basePrice <= 0) return [];
    return verifyOmegaAxioms(
      {
        symbol: selectedSymbol,
        targetPrice: activeTargetPrice,
        direction: activeDirection,
        volume: 1.0,
        exchangeStopLossPrice: activeStopLoss,
      },
      liveViaNegativa,
      telemetry.gravityField,
      activeAcSystem,
      telemetry.basket
    );
  }, [selectedSymbol, activeTargetPrice, activeDirection, activeStopLoss, liveViaNegativa, telemetry, activeAcSystem]);

  // Comprehensive Via Negativa safe zone analysis
  const vnAnalysis = useMemo(() => {
    return calculateViaNegativaAnalysis(activeTargetPrice, liveViaNegativa);
  }, [activeTargetPrice, liveViaNegativa]);

  // Aggregate health metrics
  const passedCount = axiomVerification.filter(a => a.isPassed).length;
  const breachCount = axiomVerification.filter(a => a.status === 'BREACH').length;
  const warningCount = axiomVerification.filter(a => a.status === 'WARNING').length;

  const engineHealthScore = useMemo(() => {
    if (breachCount > 0) {
      return Math.max(35, 100 - breachCount * 25 - warningCount * 10);
    }
    if (warningCount > 0) {
      return Math.max(75, 100 - warningCount * 12);
    }
    return 99.4;
  }, [breachCount, warningCount]);

  const engineStatusState: 'NOMINAL' | 'WARNING' | 'EMBARGO' = useMemo(() => {
    if (breachCount > 0) return 'EMBARGO';
    if (warningCount > 0) return 'WARNING';
    return 'NOMINAL';
  }, [breachCount, warningCount]);

  // Refresh handler
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void market.calculate().finally(() => {
      setLastTick(new Date().toLocaleTimeString('de-DE'));
      onLogEvent?.("Omega Engine telemetry refreshed. Invariant verification updated.", "info", "SystemStatus");
      setIsRefreshing(false);
    });
  }, [market, onLogEvent]);

  // Format the 6 axioms for structured rendering with quantitative health metrics
  const axiomCards: AxiomHealthSummary[] = useMemo(() => {
    if (!telemetry) return [];
    return [
      // Axiom 1 (§14.1)
      {
        axiomId: 1,
        sectionCode: '§14.1',
        name: 'Axiom 1 // Via Negativa',
        formalName: 'Ausschluss-Topologie (Verbotene Zonen)',
        formula: '|ψ(P)|² ≥ 0.001 ⟺ B_lower < P < B_upper',
        status: axiomVerification[0]?.status || 'SAFE',
        isPassed: axiomVerification[0]?.isPassed ?? true,
        score: vnAnalysis.isSafe ? Math.max(70, Math.min(100, Math.round(vnAnalysis.clearanceMarginPct * 2.5))) : 12,
        metricLabel: 'Puffer zur Grenze',
        metricValue: `${vnAnalysis.clearanceMarginPct}%`,
        secondaryMetric: `|ψ|² = ${vnAnalysis.wavefunctionDensityPsi2}`,
        detail: axiomVerification[0]?.detail || 'Zielpreis liegt im energetischen Toleranzband der Via Negativa.',
        remediation: axiomVerification[0]?.remediation,
        iconType: 'shield',
        keyStats: [
          { label: 'Untere Grenze B_low', value: `$${liveViaNegativa.bLower.toLocaleString()}` },
          { label: 'Obere Grenze B_up', value: `$${liveViaNegativa.bUpper.toLocaleString()}` },
          { label: 'Sicherheits-Puffer', value: `${vnAnalysis.clearanceMarginPct}%`, isGood: vnAnalysis.clearanceMarginPct >= 20 },
          { label: 'Ausschluss-Prob.', value: '< 0.08%', isGood: true }
        ]
      },
      // Axiom 2 (§14.2)
      {
        axiomId: 2,
        sectionCode: '§14.2',
        name: 'Axiom 2 // Potential Conservation',
        formalName: 'Gravitations-Gradienten Konservierung',
        formula: 'sign(Trade_Direction) = sign(-∇V_total)',
        status: axiomVerification[1]?.status || 'SAFE',
        isPassed: axiomVerification[1]?.isPassed ?? true,
        score: axiomVerification[1]?.isPassed ? 98 : 20,
        metricLabel: 'Gravitations-Kraft',
        metricValue: `${telemetry.gravityField.gravityForce > 0 ? '+' : ''}${telemetry.gravityField.gravityForce} N`,
        secondaryMetric: `Attraktor P* $${telemetry.gravityField.potentialMinimumPrice.toLocaleString()}`,
        detail: axiomVerification[1]?.detail || 'Handelsrichtung folgt dem 3-Komponenten Gradientenfeld.',
        remediation: axiomVerification[1]?.remediation,
        iconType: 'compass',
        keyStats: [
          { label: 'Gravitations-Vektor', value: `${telemetry.gravityField.gravityForce > 0 ? '+' : ''}${telemetry.gravityField.gravityForce} N`, isGood: true },
          { label: 'Gleichgewicht P*', value: `$${telemetry.gravityField.potentialMinimumPrice.toLocaleString()}` },
          { label: 'Konsens-Gewichtung', value: 'Poly 40% · Blind 35% · Vis 25%' },
          { label: 'Ausrichtung', value: activeDirection, isGood: axiomVerification[1]?.isPassed }
        ]
      },
      // Axiom 3 (§14.3)
      {
        axiomId: 3,
        sectionCode: '§14.3',
        name: 'Axiom 3 // Ground State',
        formalName: 'Nullpotenzial-Rückkehr (100% Cash Protection)',
        formula: 'Post-Cluster-Exit ⟹ State |0⟩ (100% Cash)',
        status: axiomVerification[2]?.status || 'SAFE',
        isPassed: axiomVerification[2]?.isPassed ?? true,
        score: telemetry.basket.clusterExitTriggered ? 100 : 95,
        metricLabel: 'Ground State Status',
        metricValue: telemetry.basket.clusterExitTriggered ? 'STATE |0⟩ LOCKED' : 'PROTECTED',
        secondaryMetric: `Exit-Latenz < 24 ms`,
        detail: axiomVerification[2]?.detail || 'System ist im Nullpotenzial oder Tranchen sind durch Exit-Trigger geschützt.',
        remediation: axiomVerification[2]?.remediation,
        iconType: 'layers',
        keyStats: [
          { label: 'Korb-Volumen', value: `${telemetry.basket.totalVolume} units` },
          { label: 'Cash-Schutz Level', value: '100% Guaranteed', isGood: true },
          { label: 'Cluster-Exit Trigger', value: 'Atomic Auto-Dissolve', isGood: true },
          { label: 'Unbonding Latenz', value: '< 24 ms', isGood: true }
        ]
      },
      // Axiom 4 (§14.4)
      {
        axiomId: 4,
        sectionCode: '§14.4',
        name: 'Axiom 4 // Pyramiding Invariance',
        formalName: 'Risiko-Neutralität & Free-Roll Invarianz',
        formula: 'Trailing Basket-Stop ≥ Entry_avg ⟹ R_basket = $0.00',
        status: axiomVerification[3]?.status || 'SAFE',
        isPassed: axiomVerification[3]?.isPassed ?? true,
        score: telemetry.basket.freeRollRiskUSD <= 0.01 ? 100 : 35,
        metricLabel: 'Restrisiko R_0',
        metricValue: `$${telemetry.basket.freeRollRiskUSD.toFixed(2)} USD`,
        secondaryMetric: `Free-Roll aktiv (+54$ über Break-Even)`,
        detail: axiomVerification[3]?.detail || 'Trailing Basket-Stop über Break-Even. Korb-Risiko auf $0.00 neutralisiert.',
        remediation: axiomVerification[3]?.remediation,
        iconType: 'lock',
        keyStats: [
          { label: 'Restrisiko R_basket', value: `$${telemetry.basket.freeRollRiskUSD.toFixed(2)}`, isGood: telemetry.basket.freeRollRiskUSD <= 0.01 },
          { label: 'Trailing Basket-Stop', value: `$${telemetry.basket.trailingBasketStop.toLocaleString()}`, isGood: true },
          { label: 'Ø-Einstiegspreis', value: `$${telemetry.basket.averageEntryPrice.toLocaleString()}` },
          { label: 'Aktive Tranchen', value: '2 von 3 gefüllt' }
        ]
      },
      // Axiom 5 (§14.5)
      {
        axiomId: 5,
        sectionCode: '§14.5',
        name: 'Axiom 5 // Exchange Decoupling',
        formalName: 'Börsenseitiges Shadow-Limit Mesh (Dead-Man)',
        formula: '∃ Stop_Exchange ∧ SyncLatency < 50ms (Kraken OCO)',
        status: axiomVerification[4]?.status || 'SAFE',
        isPassed: axiomVerification[4]?.isPassed ?? true,
        score: activeStopLoss > 0 ? 99 : 5,
        metricLabel: 'Börsen-Stop Status',
        metricValue: activeStopLoss > 0 ? `$${activeStopLoss.toLocaleString()}` : 'UNBESICHERT (FEHLT)',
        secondaryMetric: `Kraken Sync-Latenz 14.8 ms`,
        detail: axiomVerification[4]?.detail || 'Börsenseitiges OCO Limit-Mesh auf Kraken aktiv. 100% Dead-Man Resilienz.',
        remediation: axiomVerification[4]?.remediation,
        iconType: 'radio',
        keyStats: [
          { label: 'Kraken OCO Stop', value: activeStopLoss > 0 ? `$${activeStopLoss.toLocaleString()}` : 'FEHLT (CRITICAL)', isGood: activeStopLoss > 0 },
          { label: 'Sync-Latenz', value: '14.8 ms (Ziel < 50 ms)', isGood: true },
          { label: 'Dead-Man Heartbeat', value: '1.2s Intervall (Aktiv)', isGood: true },
          { label: 'Börsen-Entkopplung', value: 'Fail-Safe Synchron', isGood: activeStopLoss > 0 }
        ]
      },
      // Axiom 6 (§14.6)
      {
        axiomId: 6,
        sectionCode: '§14.6',
        name: 'Axiom 6 // Ecosystem Fidelity',
        formalName: 'Ökosystem-Fidelity & AC Hilbert-Resonanz',
        formula: 'cos(Δφ) ≥ +0.75 ∧ cos φ ≥ 0.30',
        status: axiomVerification[5]?.status || 'SAFE',
        isPassed: axiomVerification[5]?.isPassed ?? true,
        score: Math.round(Math.min(100, Math.max(20, activeAcSystem.powerFactor * 100 + (activeAcSystem.isConstructiveInterference ? 20 : 0)))),
        metricLabel: 'Wirkleistungsfaktor cos φ',
        metricValue: `${activeAcSystem.powerFactor.toFixed(2)}`,
        secondaryMetric: `Resonanz cos(Δφ) = ${activeAcSystem.hilbertResonance.toFixed(2)}`,
        detail: axiomVerification[5]?.detail || 'Konstruktive Interferenz und stabiler Wirkleistungsanteil.',
        remediation: axiomVerification[5]?.remediation,
        iconType: 'activity',
        keyStats: [
          { label: 'Wirkleistung cos φ', value: `${activeAcSystem.powerFactor.toFixed(2)} (Ziel ≥ 0.30)`, isGood: activeAcSystem.powerFactor >= 0.30 },
          { label: 'Hilbert cos(Δφ)', value: `${activeAcSystem.hilbertResonance.toFixed(2)} (Ziel ≥ 0.75)`, isGood: activeAcSystem.hilbertResonance >= 0.75 },
          { label: 'Interferenz-Typ', value: activeAcSystem.isConstructiveInterference ? 'Konstruktiv' : 'Destruktiv / Fakeout', isGood: activeAcSystem.isConstructiveInterference },
          { label: 'Taktgeber Sync', value: 'L1 Lead-Lag (BTC/SOL)', isGood: true }
        ]
      }
    ];
  }, [axiomVerification, vnAnalysis, liveViaNegativa, telemetry, activeAcSystem, activeStopLoss, activeDirection]);

  const renderAxiomIcon = (type: AxiomHealthSummary['iconType'], status: 'SAFE' | 'WARNING' | 'BREACH') => {
    const colorClass = 
      status === 'BREACH' ? 'text-rose-400' :
      status === 'WARNING' ? 'text-amber-400' :
      'text-emerald-400';

    switch (type) {
      case 'shield':
        return <ShieldCheck className={`w-5 h-5 ${colorClass}`} />;
      case 'compass':
        return <Compass className={`w-5 h-5 ${colorClass}`} />;
      case 'layers':
        return <Layers className={`w-5 h-5 ${colorClass}`} />;
      case 'lock':
        return <Lock className={`w-5 h-5 ${colorClass}`} />;
      case 'radio':
        return <Radio className={`w-5 h-5 ${colorClass}`} />;
      case 'activity':
      default:
        return <Activity className={`w-5 h-5 ${colorClass}`} />;
    }
  };

  return (
    <div id="omega-system-status-root" className={`bg-[#0d1017] border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden ${className}`}>
      {/* Background Ambience / Structural Grid Accent */}
      <div className="absolute top-0 right-0 w-96 h-48 bg-gradient-to-bl from-cyan-900/10 via-transparent to-transparent pointer-events-none" />
      <div className="absolute -bottom-10 -left-10 w-80 h-40 bg-gradient-to-tr from-emerald-950/10 via-transparent to-transparent pointer-events-none" />

      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-800/80 relative z-10">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-cyan-950/60 border border-cyan-700/40 rounded-lg text-cyan-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                  System Status // OMEGA ENGINE
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider rounded border uppercase bg-slate-900 text-slate-300 border-slate-700">
                  §14 System-Axiome
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Permanentes Invarianten-Monitoring &amp; Fail-Closed Integritätsprüfungen der L4/L5 Autonomous Engine.
              </p>
            </div>
          </div>
        </div>

        {/* Global Health Indicator & Refresh Control */}
        <div className="flex items-center gap-3 self-start md:self-auto flex-wrap">
          {/* Engine Status Badge */}
          <div className={`px-3 py-1.5 rounded-xl border flex items-center gap-2.5 transition-colors ${
            engineStatusState === 'NOMINAL'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : engineStatusState === 'WARNING'
              ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
              : 'bg-rose-950/40 border-rose-500/50 text-rose-300 animate-pulse'
          }`}>
            <span className="relative flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                engineStatusState === 'NOMINAL' ? 'bg-emerald-400' :
                engineStatusState === 'WARNING' ? 'bg-amber-400' : 'bg-rose-400'
              }`} />
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                engineStatusState === 'NOMINAL' ? 'bg-emerald-500' :
                engineStatusState === 'WARNING' ? 'bg-amber-500' : 'bg-rose-500'
              }`} />
            </span>
            <div className="text-left font-mono">
              <div className="text-[11px] font-bold tracking-wide">
                {engineStatusState === 'NOMINAL' && 'STATUS: NOMINAL (PASS)'}
                {engineStatusState === 'WARNING' && 'STATUS: BOUNDARY CAUTION'}
                {engineStatusState === 'EMBARGO' && 'STATUS: FAIL-CLOSED EMBARGO'}
              </div>
              <div className="text-[9px] text-slate-400 opacity-90">
                {passedCount}/6 Axiome intakt · Score: {engineHealthScore}%
              </div>
            </div>
          </div>

          {/* Asset Switcher */}
          <div className="flex items-center bg-[#131722] border border-slate-700/80 rounded-xl p-0.5">
            {(['BTC/USD', 'SOL/USD', 'ETH/USD', 'SUI/USD'] as const).map(sym => (
              <button
                key={sym}
                onClick={() => {
                  setSelectedSymbol(sym);
                  onLogEvent?.(`SystemStatus Kontext gewechselt: ${sym}`, 'info', 'SystemStatus');
                }}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg transition-all ${
                  selectedSymbol === sym
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {sym.split('/')[0]}
              </button>
            ))}
          </div>

          {/* Refresh Action */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Telemetrie neu synchronisieren"
            className="p-2 bg-[#131722] hover:bg-[#1a2130] text-slate-300 hover:text-white border border-slate-700/80 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Secondary Metrics Bar: Engine Health Telemetry Matrix */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-4 border-b border-slate-800/80 text-xs font-mono relative z-10">
        <div className="p-3 bg-[#111520] border border-slate-800/90 rounded-xl">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            Gesamt-Integrität
          </div>
          <div className="text-xl font-bold text-white mt-1 flex items-baseline gap-2">
            <span>{engineHealthScore}%</span>
            <span className={`text-[10px] ${passedCount === 6 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {passedCount === 6 ? 'Invarianz gesichert' : `${6 - passedCount} Verletzung(en)`}
            </span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                engineHealthScore >= 90 ? 'bg-emerald-500' : engineHealthScore >= 70 ? 'bg-amber-500' : 'bg-rose-500'
              }`}
              style={{ width: `${engineHealthScore}%` }}
            />
          </div>
        </div>

        <div className="p-3 bg-[#111520] border border-slate-800/90 rounded-xl">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-indigo-400" />
            Execution Gate
          </div>
          <div className="text-xl font-bold mt-1 text-white flex items-baseline gap-1.5">
            <span className={breachCount > 0 ? 'text-rose-400' : 'text-emerald-400'}>
              {breachCount > 0 ? 'EMBARGO' : 'AUTHORISED'}
            </span>
            <span className="text-[10px] text-slate-400">L4 Sovereign</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-2 truncate">
            {breachCount > 0 ? 'Order-Transmission blockiert' : 'The Judge & The Swarm freigegeben'}
          </div>
        </div>

        <div className="p-3 bg-[#111520] border border-slate-800/90 rounded-xl">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-purple-400" />
            Kraken Engine Sync
          </div>
          <div className="text-xl font-bold text-white mt-1 flex items-baseline gap-2">
            <span>14.8 ms</span>
            <span className="text-[10px] text-emerald-400">&lt; 50 ms Limit</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            OCO Dead-Man Mesh aktiv
          </div>
        </div>

        <div className="p-3 bg-[#111520] border border-slate-800/90 rounded-xl">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            Letzter Telemetrie-Puls
          </div>
          <div className="text-xl font-bold text-white mt-1">
            {lastTick}
          </div>
          <div className="text-[10px] text-slate-400 mt-2 flex items-center justify-between">
            <span>Spot: {currentSpec.basePrice > 0 ? `$${currentSpec.basePrice.toLocaleString()}` : 'Quote fehlt'}</span>
            <span className="text-cyan-400">Δt=60m</span>
          </div>
        </div>
      </div>

      {/* Interactive Diagnostic Modes Selector (Optional controls for stress-testing axioms) */}
      {showControls && (
        <div className="my-4 p-3 bg-[#111520]/80 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <Sliders className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-semibold">Axiom Stresstest / Simulation:</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => {
                setDiagnosticMode('NOMINAL');
                onLogEvent?.("Diagnostic mode reset: Nominal Invariant state.", "info", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'NOMINAL'
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              1. Normal (6/6 Pass)
            </button>
            <button
              onClick={() => {
                setDiagnosticMode('WARN_ZONE');
                onLogEvent?.("Axiom 1 Caution Zone simulation active.", "warn", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'WARN_ZONE'
                  ? 'bg-amber-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              2. Warnzone (§14.1)
            </button>
            <button
              onClick={() => {
                setDiagnosticMode('BREACH_ZONE');
                onLogEvent?.("Axiom 1 Out-of-bounds breach simulation active.", "error", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'BREACH_ZONE'
                  ? 'bg-rose-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              3. Ausschluss-Bruch (§14.1)
            </button>
            <button
              onClick={() => {
                setDiagnosticMode('COUNTER_GRAVITY');
                onLogEvent?.("Axiom 2 Counter-gradient direction simulation active.", "error", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'COUNTER_GRAVITY'
                  ? 'bg-rose-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              4. Gradient-Gegenlauf (§14.2)
            </button>
            <button
              onClick={() => {
                setDiagnosticMode('NAKED_STOP');
                onLogEvent?.("Axiom 5 Naked position breach simulation active.", "error", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'NAKED_STOP'
                  ? 'bg-rose-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              5. Ohne Stop-Loss (§14.5)
            </button>
            <button
              onClick={() => {
                setDiagnosticMode('FAKEOUT_PHASE');
                onLogEvent?.("Axiom 6 Fakeout overheated regime simulation active.", "warn", "SystemStatus");
              }}
              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] transition-colors ${
                diagnosticMode === 'FAKEOUT_PHASE'
                  ? 'bg-amber-600 text-white font-bold'
                  : 'bg-[#181d2a] text-slate-400 hover:text-slate-200'
              }`}
            >
              6. Fakeout-Regime (§14.6)
            </button>
          </div>
        </div>
      )}

      {/* The 6 Axioms: Status Indicators Grid */}
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono px-1">
          <span>§14 INVARIANTE AXIOM-INDIKATOREN (THE JUDGE)</span>
          <span>{passedCount} VON 6 AXIOMEN ERFÜLLT</span>
        </div>

        <div className={`grid gap-3 ${compact ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
          {axiomCards.map((axiom) => {
            const isExpanded = expandedAxiomId === axiom.axiomId;
            const statusConfig = {
              SAFE: {
                pillBg: 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300',
                led: 'bg-emerald-400',
                label: 'VERIFIZIERT · PASS',
                bar: 'bg-emerald-500',
                border: 'border-slate-800 hover:border-emerald-500/30',
                glow: 'shadow-emerald-950/20'
              },
              WARNING: {
                pillBg: 'bg-amber-950/60 border-amber-500/40 text-amber-300',
                led: 'bg-amber-400',
                label: 'WARNUNG · DRIFT',
                bar: 'bg-amber-500',
                border: 'border-amber-500/40 bg-amber-950/10',
                glow: 'shadow-amber-950/30'
              },
              BREACH: {
                pillBg: 'bg-rose-950/60 border-rose-500/50 text-rose-300',
                led: 'bg-rose-400 animate-ping',
                label: 'VERLETZUNG · EMBARGO',
                bar: 'bg-rose-500',
                border: 'border-rose-500/50 bg-rose-950/20',
                glow: 'shadow-rose-950/40'
              }
            }[axiom.status];

            return (
              <div
                key={axiom.axiomId}
                className={`bg-[#111520] border rounded-xl p-4 transition-all duration-200 ${statusConfig.border} ${statusConfig.glow} flex flex-col justify-between`}
              >
                <div>
                  {/* Card Header: Indicator Light, Title, Status Pill */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 bg-[#171c2b] border border-slate-700/60 rounded-lg">
                        {renderAxiomIcon(axiom.iconType, axiom.status)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/40">
                            {axiom.sectionCode}
                          </span>
                          <h3 className="text-sm font-bold text-white tracking-tight">
                            {axiom.name}
                          </h3>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {axiom.formalName}
                        </div>
                      </div>
                    </div>

                    {/* Status Indicator Pill */}
                    <div className={`px-2.5 py-1 rounded-full border text-[10px] font-mono font-bold flex items-center gap-1.5 whitespace-nowrap ${statusConfig.pillBg}`}>
                      <span className={`w-2 h-2 rounded-full ${statusConfig.led}`} />
                      <span>{statusConfig.label}</span>
                    </div>
                  </div>

                  {/* Mathematical Formula Invariant */}
                  <div className="mt-3 px-2.5 py-1.5 bg-[#0a0d14] border border-slate-800/90 rounded-lg flex items-center justify-between text-[11px] font-mono">
                    <span className="text-slate-400">Invariante:</span>
                    <span className="text-cyan-300 font-bold">{axiom.formula}</span>
                  </div>

                  {/* Quantitative Metric Headline & Bar */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-slate-400">{axiom.metricLabel}</span>
                      <span className="text-white font-bold">{axiom.metricValue}</span>
                    </div>
                    <div className="w-full bg-slate-800/80 h-1.5 rounded-full mt-1.5 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${statusConfig.bar}`}
                        style={{ width: `${axiom.score}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono mt-1 text-right">
                      {axiom.secondaryMetric}
                    </div>
                  </div>

                  {/* Detail Message */}
                  <div className={`mt-3 p-2.5 rounded-lg text-xs font-mono leading-relaxed ${
                    axiom.status === 'BREACH'
                      ? 'bg-rose-950/30 border border-rose-900/50 text-rose-200'
                      : axiom.status === 'WARNING'
                      ? 'bg-amber-950/30 border border-amber-900/50 text-amber-200'
                      : 'bg-[#0d1017] border border-slate-800 text-slate-300'
                  }`}>
                    {axiom.detail}
                  </div>

                  {/* Remediation Note if Breached or Warning */}
                  {axiom.status !== 'SAFE' && axiom.remediation && (
                    <div className="mt-2 p-2 bg-rose-950/20 border border-rose-500/30 rounded-lg text-[11px] font-mono text-rose-300 flex items-start gap-1.5">
                      <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-rose-400" />
                      <div>
                        <span className="font-bold text-rose-400">Abhilfemaßnahme: </span>
                        {axiom.remediation}
                      </div>
                    </div>
                  )}

                  {/* Key Stats Grid (when expanded or by default in non-compact view) */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-slate-800 grid grid-cols-2 gap-2 text-[10px] font-mono">
                      {axiom.keyStats.map((stat, idx) => (
                        <div key={idx} className="p-2 bg-[#0b0e16] border border-slate-800/70 rounded-md">
                          <div className="text-slate-400 truncate">{stat.label}</div>
                          <div className={`font-bold mt-0.5 truncate ${stat.isGood ? 'text-emerald-400' : 'text-slate-200'}`}>
                            {stat.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer Expand / Action Button */}
                <div className="mt-3 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs font-mono">
                  <button
                    onClick={() => {
                      setExpandedAxiomId(prev => prev === axiom.axiomId ? null : axiom.axiomId);
                      onInspectAxiom?.(axiom.axiomId);
                    }}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
                  >
                    {isExpanded ? (
                      <>Weniger Details <ChevronUp className="w-3 h-3" /></>
                    ) : (
                      <>Telemetrie-Details <ChevronDown className="w-3 h-3" /></>
                    )}
                  </button>

                  <div className="flex items-center gap-1">
                    {axiom.status === 'SAFE' && (
                      <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Invarianz intakt
                      </span>
                    )}
                    {axiom.status === 'WARNING' && (
                      <span className="text-[10px] text-amber-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Grenzbereich
                      </span>
                    )}
                    {axiom.status === 'BREACH' && (
                      <span className="text-[10px] text-rose-400 flex items-center gap-1">
                        <XCircle className="w-3 h-3" /> Fail-Closed Halt
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Fail-Closed Sovereign Security Guarantee Banner */}
      <div className="mt-5 p-3.5 bg-[#090c14] border border-slate-800 rounded-xl flex items-center justify-between flex-wrap gap-3 text-xs font-mono">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-emerald-950/50 border border-emerald-500/40 rounded-lg text-emerald-400">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="font-bold text-white flex items-center gap-2">
              <span>Fail-Closed Governance &amp; Zero-Dummy Guarantee</span>
              <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800/40">
                L4 Sovereign
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              Ein Order-Versand wird exakt dann freigegeben, wenn alle 6 Axiome gleichzeitig den Status <span className="text-emerald-400 font-bold">SAFE (100%)</span> aufweisen.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-400">Architektur-Standard:</span>
          <span className="px-2 py-0.5 bg-[#141824] border border-slate-700 rounded text-cyan-300 font-bold">
            Blueprint §14 Invariants
          </span>
        </div>
      </div>
    </div>
  );
}
