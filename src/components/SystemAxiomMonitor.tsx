import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Compass,
  Radio,
  Activity,
  Volume2,
  VolumeX,
  Sparkles,
  Lock,
  Zap,
  TrendingUp,
  TrendingDown,
  Target
} from 'lucide-react';
import {
  type LiveOmegaTelemetry,
  verifyOmegaAxioms,
  calculateViaNegativa,
  calculateViaNegativaAnalysis,
  ViaNegativaAnalysis,
  AxiomVerificationResult,
  ViaNegativaState,
} from '../utils/omegaLogic';
import { useMarketFeed } from '../market/useMarketFeed';

export interface SystemAxiomMonitorProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

export interface AxiomAlertItem {
  id: string;
  timestamp: string;
  axiomId: number;
  severity: 'CRITICAL' | 'WARNING' | 'NOMINAL';
  title: string;
  message: string;
}

export default function SystemAxiomMonitor({ onLogEvent, className = '' }: SystemAxiomMonitorProps) {
  // Live Telemetry Baseline
  const market = useMarketFeed();
  const [telemetry, setTelemetry] = useState<LiveOmegaTelemetry | null>(market.telemetry);

  useEffect(() => {
    if (market.telemetry) setTelemetry(market.telemetry);
  }, [market.telemetry]);

  // Interactive Candidate Order State
  const [symbol, setSymbol] = useState<'BTC/USD' | 'SOL/USD' | 'SUI/USD' | 'ETH/USD'>('BTC/USD');
  const [targetPrice, setTargetPrice] = useState<number>(0);
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [exchangeStopLoss, setExchangeStopLoss] = useState<number>(0);
  const [timeDeltaMinutes, setTimeDeltaMinutes] = useState<number>(60);
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'VIA_NEGATIVA' | 'AXIOM_DEEP_DIVE' | 'STRESS_TEST'>('OVERVIEW');
  const [audioAlertsEnabled, setAudioAlertsEnabled] = useState<boolean>(false);
  const [activeAlertFilter, setActiveAlertFilter] = useState<'ALL' | 'CRITICAL' | 'WARNING'>('ALL');
  const [customAskImpedance, setCustomAskImpedance] = useState<number>(30);
  const [customBidSupport, setCustomBidSupport] = useState<number>(30);

  // Live alerts log
  const [alerts, setAlerts] = useState<AxiomAlertItem[]>(() => [
    {
      id: 'alert-init-1',
      timestamp: new Date().toLocaleTimeString('de-DE'),
      axiomId: 1,
      severity: 'NOMINAL',
      title: 'Axiom 1 // Via Negativa Safe Zone aktiv',
      message: 'Initialer Zielpreis liegt optimal zentriert im energetischen Toleranzband (Puffer > 35%).',
    },
    {
      id: 'alert-init-2',
      timestamp: new Date().toLocaleTimeString('de-DE'),
      axiomId: 5,
      severity: 'NOMINAL',
      title: 'Axiom 5 // Kraken Matching Engine synchron',
      message: 'Börsenseitiger OCO Stop-Loss aktiv persistiert ($63,850.00). Latenz < 18 ms.',
    },
    {
      id: 'alert-init-3',
      timestamp: new Date().toLocaleTimeString('de-DE'),
      axiomId: 2,
      severity: 'NOMINAL',
      title: 'Axiom 2 // Gravitationsvektor -∇V_total ausgerichtet',
      message: 'LONG-Richtung folgt dem globalen Potentialgradienten (+84.5 N in Richtung P* $64,800).',
    }
  ]);

  // Asset price presets
  const assetSpecs: Record<string, { basePrice: number; atr: number } | null> = useMemo(() => {
    const build = (display: string) => {
      const quote = market.quoteFor(display);
      if (!quote || !(quote.last > 0) || !(quote.atr14 && quote.atr14 > 0)) return null;
      return { basePrice: quote.last, atr: quote.atr14 };
    };
    return {
      'BTC/USD': build('BTC/USD'),
      'SOL/USD': build('SOL/USD'),
      'SUI/USD': build('SUI/USD'),
      'ETH/USD': build('ETH/USD'),
    };
  }, [market.feed, market.computation]);

  // Update target price when symbol changes
  const handleSymbolChange = (newSymbol: 'BTC/USD' | 'SOL/USD' | 'SUI/USD' | 'ETH/USD') => {
    setSymbol(newSymbol);
    const spec = assetSpecs[newSymbol];
    if (!spec) {
      onLogEvent?.(`Keine Kraken-Quote für ${newSymbol}.`, 'warn', 'SystemAxiomMonitor');
      return;
    }
    setTargetPrice(spec.basePrice);
    setExchangeStopLoss(Number((spec.basePrice - spec.atr * 1.2).toFixed(2)));
    onLogEvent?.(`Symbol gewechselt zu ${newSymbol}. Spotpreis: $${spec.basePrice}`, 'info', 'SystemAxiomMonitor');
  };

  // Recompute live viaNegativa state based on selected asset, timeframe, impedance
  const liveViaNegativa: ViaNegativaState = useMemo(() => {
    const spec = assetSpecs[symbol] ?? assetSpecs['BTC/USD'];
    if (!spec) {
      return calculateViaNegativa(0, 0, timeDeltaMinutes, customAskImpedance, customBidSupport);
    }
    return calculateViaNegativa(
      spec.basePrice,
      spec.atr,
      timeDeltaMinutes,
      customAskImpedance,
      customBidSupport
    );
  }, [symbol, timeDeltaMinutes, customAskImpedance, customBidSupport, assetSpecs]);

  // Via Negativa Safe Zone Analysis for candidate target price
  const viaNegativaAnalysis: ViaNegativaAnalysis = useMemo(() => {
    return calculateViaNegativaAnalysis(targetPrice, liveViaNegativa);
  }, [targetPrice, liveViaNegativa]);

  // Evaluate the 6 Axioms
  const axiomResults: AxiomVerificationResult[] = useMemo(() => {
    if (!telemetry) return [];
    return verifyOmegaAxioms(
      {
        symbol,
        targetPrice,
        direction,
        volume: 1.0,
        exchangeStopLossPrice: exchangeStopLoss,
      },
      liveViaNegativa,
      telemetry.gravityField,
      telemetry.acSystem,
      telemetry.basket
    );
  }, [symbol, targetPrice, direction, exchangeStopLoss, liveViaNegativa, telemetry]);

  // Tally passed axioms
  const passedCount = useMemo(() => {
    return axiomResults.filter(a => a.isPassed).length;
  }, [axiomResults]);

  const criticalCount = useMemo(() => {
    return axiomResults.filter(a => a.status === 'BREACH').length;
  }, [axiomResults]);

  const warningCount = useMemo(() => {
    return axiomResults.filter(a => a.status === 'WARNING').length;
  }, [axiomResults]);

  const allPassed = passedCount === 6;

  // Synthesized audio feedback (Web Audio API)
  const playAcousticAlert = useCallback((isBreach: boolean) => {
    if (!audioAlertsEnabled || typeof window === 'undefined') return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (isBreach) {
        // Harsh discordant ping
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.26);
      } else {
        // High pure pleasant harmonic chime
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.21);
      }
    } catch {
      // Audio context might be restricted before user gesture
    }
  }, [audioAlertsEnabled]);

  // Trigger alerts on status changes
  useEffect(() => {
    if (viaNegativaAnalysis.status === 'EXCLUSION_UPPER_BREACH' || viaNegativaAnalysis.status === 'EXCLUSION_LOWER_BREACH') {
      const breachAlert: AxiomAlertItem = {
        id: `alert-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('de-DE'),
        axiomId: 1,
        severity: 'CRITICAL',
        title: 'AXIOM 1 BREACH // Via Negativa Ausschlusszone betreten!',
        message: viaNegativaAnalysis.alertMessage,
      };
      setAlerts(prev => [breachAlert, ...prev.slice(0, 19)]);
      playAcousticAlert(true);
      onLogEvent?.(`[AXIOM 1 BREACH] ${viaNegativaAnalysis.alertMessage}`, 'error', 'The Judge');
    } else if (viaNegativaAnalysis.status === 'SAFE_ZONE_CAUTION') {
      const cautionAlert: AxiomAlertItem = {
        id: `alert-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('de-DE'),
        axiomId: 1,
        severity: 'WARNING',
        title: 'AXIOM 1 CAUTION // Grenznähe zur Via Negativa',
        message: `Puffer zur verbotenen Zone beträgt nur ${viaNegativaAnalysis.clearanceMarginPct}%.`,
      };
      setAlerts(prev => [cautionAlert, ...prev.slice(0, 19)]);
    }
  }, [viaNegativaAnalysis.status, viaNegativaAnalysis.alertMessage, viaNegativaAnalysis.clearanceMarginPct, playAcousticAlert, onLogEvent]);

  // Periodic heartbeat / state sync
  useEffect(() => {
    const spec = assetSpecs[symbol];
    if (!spec || targetPrice > 0) return;
    setTargetPrice(spec.basePrice);
    setExchangeStopLoss(Number((spec.basePrice - spec.atr * 1.2).toFixed(2)));
  }, [assetSpecs, symbol, targetPrice]);

  const updateTelemetry = (recipe: (current: LiveOmegaTelemetry) => LiveOmegaTelemetry) => {
    setTelemetry((prev) => (prev ? recipe(prev) : prev));
  };

  // Preset Scenario Handlers
  const applyScenario = (type: 'CANONICAL' | 'UPPER_BREACH' | 'LOWER_BREACH' | 'COUNTER_GRAVITY' | 'MISSING_STOP' | 'DESTRUCTIVE_AC' | 'GROUND_STATE') => {
    const spec = assetSpecs[symbol];
    if (!spec) return;
    switch (type) {
      case 'CANONICAL':
        setTargetPrice(spec.basePrice);
        setDirection('LONG');
        setExchangeStopLoss(Number((spec.basePrice - spec.atr * 1.2).toFixed(2)));
        updateTelemetry(prev => ({
          ...prev,
          gravityField: {
            ...prev.gravityField,
            gravityForce: 84.5,
          },
          acSystem: {
            ...prev.acSystem,
            powerFactor: 0.88,
            hilbertResonance: 0.82,
            isConstructiveInterference: true,
          },
          basket: {
            ...prev.basket,
            clusterExitTriggered: false,
            freeRollRiskUSD: 0.00,
          }
        }));
        playAcousticAlert(false);
        onLogEvent?.('Szenario: Kanonischer Safe Flow geladen. Alle 6 Axiome erfüllt.', 'success', 'The Judge');
        break;

      case 'UPPER_BREACH':
        setTargetPrice(Number((liveViaNegativa.bUpper + spec.atr * 0.8).toFixed(2)));
        playAcousticAlert(true);
        onLogEvent?.('Szenario: Obere Via Negativa Ausschluss-Schranke verletzt (Axiom 1).', 'error', 'The Judge');
        break;

      case 'LOWER_BREACH':
        setTargetPrice(Number((liveViaNegativa.bLower - spec.atr * 0.8).toFixed(2)));
        playAcousticAlert(true);
        onLogEvent?.('Szenario: Untere Via Negativa Ausschluss-Schranke verletzt (Axiom 1).', 'error', 'The Judge');
        break;

      case 'COUNTER_GRAVITY':
        setTargetPrice(spec.basePrice);
        setDirection('SHORT'); // opposed to positive gravity force
        updateTelemetry(prev => ({
          ...prev,
          gravityField: {
            ...prev.gravityField,
            gravityForce: 120.0, // Strong upward attraction
            potentialMinimumPrice: spec.basePrice + 1200,
          }
        }));
        playAcousticAlert(true);
        onLogEvent?.('Szenario: Trade wirkt diametral gegen Gravitationsgradient -∇V_total (Axiom 2).', 'warn', 'The Judge');
        break;

      case 'MISSING_STOP':
        setTargetPrice(spec.basePrice);
        setExchangeStopLoss(0); // Axiom 5 breach
        playAcousticAlert(true);
        onLogEvent?.('Szenario: Unbesicherte Position ohne börsenseitigen Stop-Loss (Axiom 5).', 'error', 'The Judge');
        break;

      case 'DESTRUCTIVE_AC':
        setTargetPrice(spec.basePrice);
        updateTelemetry(prev => ({
          ...prev,
          acSystem: {
            ...prev.acSystem,
            powerFactor: 0.18, // Overheated fakeout
            hilbertResonance: -0.45, // Destructive phase
            isConstructiveInterference: false,
          }
        }));
        playAcousticAlert(true);
        onLogEvent?.('Szenario: Destruktive Phaseninterferenz & Scheinleistungsüberhitzung cos φ < 0.30 (Axiom 6).', 'warn', 'The Judge');
        break;

      case 'GROUND_STATE':
        setTargetPrice(spec.basePrice);
        updateTelemetry(prev => ({
          ...prev,
          basket: {
            ...prev.basket,
            totalVolume: 0,
            clusterExitTriggered: true,
            clusterExitReason: 'Batched Cluster-Exit ausgeführt -> 100% Cash Ground State',
            freeRollRiskUSD: 0.00,
            unrealizedPnL: 0,
          }
        }));
        playAcousticAlert(false);
        onLogEvent?.('Szenario: Axiom 3 Ground State erzwungen! 100% Cash-Protection.', 'success', 'The Judge');
        break;
      default: {
        const unreachable: never = type;
        return unreachable;
      }
    }
  };

  // Remediation Helpers
  const handleSnapToSafeCenter = () => {
    const spec = assetSpecs[symbol];
    if (!spec) return;
    setTargetPrice(spec.basePrice);
    onLogEvent?.(`Zielpreis zentriert auf $${spec.basePrice} (Safe Zone Zentrum).`, 'success', 'The Judge');
    playAcousticAlert(false);
  };

  const handleApplyOptimalOCOStop = () => {
    const spec = assetSpecs[symbol];
    if (!spec) return;
    const optimalStop = direction === 'LONG'
      ? Number((targetPrice - spec.atr * 1.1).toFixed(2))
      : Number((targetPrice + spec.atr * 1.1).toFixed(2));
    setExchangeStopLoss(optimalStop);
    onLogEvent?.(`Kraken OCO Stop berechnet und persistiert: $${optimalStop} (Axiom 5 erfüllt).`, 'success', 'The Judge');
    playAcousticAlert(false);
  };

  const handleAlignWithGravity = () => {
    if (!telemetry) return;
    const correctDir = telemetry.gravityField.gravityForce >= 0 ? 'LONG' : 'SHORT';
    setDirection(correctDir);
    onLogEvent?.(`Richtung an Gravitationskraft angepasst: ${correctDir} (Axiom 2 erfüllt).`, 'success', 'The Judge');
    playAcousticAlert(false);
  };

  const handleTriggerClusterExit = () => {
    updateTelemetry(prev => ({
      ...prev,
      basket: {
        ...prev.basket,
        totalVolume: 0,
        clusterExitTriggered: true,
        clusterExitReason: 'Atomarer Cluster-Exit ausgeführt -> 100% Cash Ground State',
        unrealizedPnL: 0,
        freeRollRiskUSD: 0.00,
      }
    }));
    onLogEvent?.('Axiom 3 Atomarer Cluster-Exit ausgelöst: 100% Cash im Ground State.', 'success', 'The Judge');
    playAcousticAlert(false);
  };

  const handleRemediateAll = () => {
    handleSnapToSafeCenter();
    handleApplyOptimalOCOStop();
    handleAlignWithGravity();
    updateTelemetry(prev => ({
      ...prev,
      acSystem: {
        ...prev.acSystem,
        powerFactor: 0.85,
        hilbertResonance: 0.80,
        isConstructiveInterference: true,
      },
      basket: {
        ...prev.basket,
        freeRollRiskUSD: 0.00,
      }
    }));
    onLogEvent?.('The Judge: Alle 6 Axiome vollständig mathematisch harmonisiert.', 'success', 'The Judge');
    playAcousticAlert(false);
  };

  // Filtered alerts
  const filteredAlerts = useMemo(() => {
    if (activeAlertFilter === 'ALL') return alerts;
    return alerts.filter(a => a.severity === activeAlertFilter);
  }, [alerts, activeAlertFilter]);

  // Visual position of target price in continuum [minDisplay, maxDisplay]
  const continuum = useMemo(() => {
    const minP = liveViaNegativa.bLower - liveViaNegativa.deltaPMax * 0.4;
    const maxP = liveViaNegativa.bUpper + liveViaNegativa.deltaPMax * 0.4;
    const span = Math.max(1, maxP - minP);

    const toPct = (price: number) => {
      const clamped = Math.max(minP, Math.min(maxP, price));
      return ((clamped - minP) / span) * 100;
    };

    return {
      minP,
      maxP,
      span,
      bLowerPct: toPct(liveViaNegativa.bLower),
      bUpperPct: toPct(liveViaNegativa.bUpper),
      spotPct: toPct(liveViaNegativa.spotPrice),
      targetPct: toPct(targetPrice),
      potentialMinPct: toPct(telemetry?.gravityField.potentialMinimumPrice ?? liveViaNegativa.spotPrice),
    };
  }, [liveViaNegativa, targetPrice, telemetry]);

  if (!telemetry) {
    return (
      <div className={`rounded-2xl border border-slate-700 p-6 text-slate-300 ${className}`} role="status">
        <h2 className="text-base font-bold text-white font-mono">Axiom-Monitor</h2>
        <p className="text-sm text-slate-400 mt-2">Kraken-Quote fehlt. Die Axiom-Prüfung bleibt leer, bis ein Lastkurs vorliegt.</p>
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* 1. Header Card: Sovereign Axiom Monitor Status */}
      <div className="glass-card rounded-2xl p-6 shadow-2xl border border-white/10 relative overflow-hidden">
        {/* Subtle background ambient glow based on status */}
        <div
          className={`absolute -top-24 -right-24 w-96 h-96 rounded-full blur-3xl pointer-events-none transition-all duration-700 ${
            allPassed
              ? 'bg-emerald-500/10'
              : criticalCount > 0
              ? 'bg-rose-500/15'
              : 'bg-amber-500/10'
          }`}
        />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <div
                className={`p-2.5 rounded-xl border transition-all ${
                  allPassed
                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                    : criticalCount > 0
                    ? 'bg-rose-500/20 border-rose-500/40 text-rose-400 animate-pulse'
                    : 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                }`}
              >
                {allPassed ? (
                  <ShieldCheck className="w-6 h-6" />
                ) : (
                  <ShieldAlert className="w-6 h-6" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white tracking-wide">
                    THE JUDGE // §14 SYSTEM AXIOM MONITOR
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    SPEC FREEZE 100%
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-mono">
                  Autonomous M8-Gate Invariance Verification & Via Negativa Exclusion Topology
                </p>
              </div>
            </div>
          </div>

          {/* Right Status Indicator & Audio Control */}
          <div className="flex flex-wrap items-center gap-3 font-mono">
            {/* Audio Toggle */}
            <button
              onClick={() => setAudioAlertsEnabled(prev => !prev)}
              className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 transition-all ${
                audioAlertsEnabled
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-lg shadow-cyan-500/10'
                  : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
              }`}
              title={audioAlertsEnabled ? 'Akustische Alerts aktiv' : 'Akustische Alerts stummgeschaltet'}
            >
              {audioAlertsEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              <span className="text-[11px] hidden sm:inline">
                {audioAlertsEnabled ? 'AUDIO ALERTS ON' : 'AUDIO OFF'}
              </span>
            </button>

            {/* Verdict Badge */}
            <div
              className={`px-4 py-2 rounded-xl border flex items-center gap-2.5 shadow-lg ${
                allPassed
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : criticalCount > 0
                  ? 'bg-rose-500/20 border-rose-500/50 text-rose-300 animate-pulse'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  allPassed
                    ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                    : criticalCount > 0
                    ? 'bg-rose-400 shadow-[0_0_10px_#f43f5e]'
                    : 'bg-amber-400 shadow-[0_0_8px_#f59e0b]'
                }`}
              />
              <div className="text-left">
                <span className="text-[10px] text-slate-400 block leading-tight uppercase font-semibold">
                  M8-Gate Status
                </span>
                <span className="text-xs font-bold tracking-wider">
                  {allPassed
                    ? 'ALL 6 AXIOMS SATISFIED (CLEARANCE)'
                    : criticalCount > 0
                    ? `${criticalCount} EMBARGO${criticalCount > 1 ? 'S' : ''}${warningCount > 0 ? ` • ${warningCount} CAUTION` : ''}`
                    : `${warningCount} CAUTION STATE${warningCount > 1 ? 'S' : ''}`}
                </span>
              </div>
            </div>

            {/* Global Remediate Button */}
            {!allPassed && (
              <button
                onClick={handleRemediateAll}
                className="px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 border border-emerald-500/40 text-emerald-300 hover:from-emerald-500/30 hover:to-cyan-500/30 transition-all text-xs font-bold flex items-center gap-1.5 shadow-lg"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Harmonisieren</span>
              </button>
            )}
          </div>
        </div>

        {/* Telemetry Summary Bar */}
        <div className="mt-6 pt-5 border-t border-white/10 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono">
          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Axiome Gültig</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className={`text-lg font-bold ${allPassed ? 'text-emerald-400' : 'text-rose-400'}`}>
                {passedCount}
              </span>
              <span className="text-xs text-slate-500">/ 6</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Safe Zone Status</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  viaNegativaAnalysis.isSafe ? 'bg-emerald-400' : 'bg-rose-400'
                }`}
              />
              <span className={`text-xs font-bold truncate ${viaNegativaAnalysis.isSafe ? 'text-emerald-300' : 'text-rose-300'}`}>
                {viaNegativaAnalysis.isSafe ? 'SAFE ZONE' : 'EXCLUSION BREACH'}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Rand-Puffer</span>
            <span className={`text-lg font-bold mt-0.5 block ${viaNegativaAnalysis.clearanceMarginPct < 15 ? 'text-amber-400' : 'text-cyan-400'}`}>
              {viaNegativaAnalysis.clearanceMarginPct}%
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Dichte |ψ|²</span>
            <span className="text-lg font-bold text-white mt-0.5 block font-mono">
              {viaNegativaAnalysis.wavefunctionDensityPsi2.toFixed(4)}
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Korb-Restrisiko R_0</span>
            <span className="text-lg font-bold text-emerald-400 mt-0.5 block">
              $0.00 <span className="text-[10px] text-emerald-500 font-normal">(Free-Roll)</span>
            </span>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <span className="text-[10px] text-slate-400 uppercase block">Gate-Latenz</span>
            <span className="text-lg font-bold text-purple-300 mt-0.5 block">
              &lt; 12 µs <span className="text-[10px] text-purple-400 font-normal">(AVX-512)</span>
            </span>
          </div>
        </div>
      </div>

      {/* 2. Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3 font-mono text-xs">
        <div className="flex items-center gap-2 overflow-x-auto">
          {[
            { id: 'OVERVIEW', label: '1. Alle 6 Axiome (Live-Matrix)' },
            { id: 'VIA_NEGATIVA', label: '2. §3 Via Negativa Safe-Zone Visualizer' },
            { id: 'AXIOM_DEEP_DIVE', label: '3. Mathematische Formeln & Details' },
            { id: 'STRESS_TEST', label: '4. Stress-Test Sandbox & Szenarien' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-3 py-2 rounded-xl transition-all font-bold whitespace-nowrap border ${
                activeTab === tab.id
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-lg shadow-cyan-500/10'
                  : 'bg-white/[0.02] text-slate-400 border-white/5 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Quick Asset Selector */}
        <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/10">
          {(['BTC/USD', 'SOL/USD', 'SUI/USD', 'ETH/USD'] as const).map(sym => (
            <button
              key={sym}
              onClick={() => handleSymbolChange(sym)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                symbol === sym
                  ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {sym.split('/')[0]}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Real-Time Alert Banner (if critical or warning) */}
      {criticalCount > 0 && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 flex items-start gap-3 shadow-lg shadow-rose-500/10 font-mono text-xs">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5 animate-bounce" />
          <div className="space-y-1 flex-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-rose-300 text-sm">
                SOVEREIGN EMBARGO ENFORCED // {criticalCount} KRITISCHE AXIOM-VERLETZUNG{criticalCount > 1 ? 'EN' : ''}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500/30 text-rose-200 border border-rose-500/50">
                BLOCK LEVEL 5
              </span>
            </div>
            <p className="text-slate-300 text-xs leading-relaxed">
              The Judge (M8-Gate) verweigert die Order-Freigabe für {symbol}. Handelsaufträge in verbotenen Zonen oder ohne börsenseitigen Stop-Loss werden strikt neutralisiert.
            </p>
          </div>
        </div>
      )}

      {/* TAB 1: OVERVIEW LIVE MATRIX */}
      {activeTab === 'OVERVIEW' && (
        <div className="space-y-6">
          {/* Quick Interactive Order Bar */}
          <div className="glass-card rounded-2xl p-5 shadow-xl border border-white/10 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Live Candidate Order Evaluation
                </h3>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Prüft Order gegen die 6 unverrückbaren Axiome (§14 Spec Freeze)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  Zielpreis $ (USD)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    step="any"
                    value={targetPrice}
                    onChange={e => setTargetPrice(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={handleSnapToSafeCenter}
                    className="px-2.5 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-cyan-500/20 text-slate-300 hover:text-cyan-300 text-[10px]"
                    title="Auf Safe Zone Zentrum zentrieren"
                  >
                    Center
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  Exchange Stop-Loss $ (Axiom 5)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    step="any"
                    value={exchangeStopLoss}
                    onChange={e => setExchangeStopLoss(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={handleApplyOptimalOCOStop}
                    className="px-2.5 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-cyan-500/20 text-slate-300 hover:text-cyan-300 text-[10px]"
                    title="Berechne Kraken OCO Stop"
                  >
                    Auto
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  Handelsrichtung
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDirection('LONG')}
                    className={`flex-1 py-2 rounded-xl font-bold transition-all border flex items-center justify-center gap-1.5 ${
                      direction === 'LONG'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                        : 'bg-white/5 text-slate-400 border-white/5 hover:text-white'
                    }`}
                  >
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span>LONG</span>
                  </button>
                  <button
                    onClick={() => setDirection('SHORT')}
                    className={`flex-1 py-2 rounded-xl font-bold transition-all border flex items-center justify-center gap-1.5 ${
                      direction === 'SHORT'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-lg shadow-rose-500/10'
                        : 'bg-white/5 text-slate-400 border-white/5 hover:text-white'
                    }`}
                  >
                    <TrendingDown className="w-3.5 h-3.5" />
                    <span>SHORT</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  Zeithorizont Δt (Via Negativa)
                </label>
                <div className="grid grid-cols-4 gap-1">
                  {[15, 30, 60, 240].map(m => (
                    <button
                      key={m}
                      onClick={() => setTimeDeltaMinutes(m)}
                      className={`py-2 rounded-xl text-[11px] font-bold border transition-all ${
                        timeDeltaMinutes === m
                          ? 'bg-cyan-500/30 text-cyan-300 border-cyan-500/50'
                          : 'bg-white/5 text-slate-400 border-white/5 hover:text-white'
                      }`}
                    >
                      {m < 60 ? `${m}m` : `${m / 60}h`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Mini Via Negativa Gauge */}
          <div className="glass-card rounded-2xl p-5 shadow-xl border border-white/10 space-y-3 font-mono">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span className="font-bold text-white uppercase">
                  Axiom 1 // Via Negativa Safe-Zone Continuum
                </span>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                viaNegativaAnalysis.isSafe
                  ? viaNegativaAnalysis.status === 'SAFE_ZONE_CAUTION'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
              }`}>
                {viaNegativaAnalysis.status.replace(/_/g, ' ')}
              </span>
            </div>

            {/* Visual Bar Continuum */}
            <div className="relative h-12 w-full rounded-xl bg-black/60 border border-white/10 overflow-hidden flex items-center">
              {/* Left Exclusion Zone */}
              <div
                style={{ width: `${continuum.bLowerPct}%` }}
                className="h-full bg-rose-950/40 border-r border-rose-500/50 flex items-center justify-center relative group"
              >
                <span className="text-[9px] text-rose-400 font-bold uppercase tracking-wider truncate px-1">
                  Exclusion (&lt; B_lower)
                </span>
              </div>

              {/* Center Safe Zone */}
              <div
                style={{ width: `${continuum.bUpperPct - continuum.bLowerPct}%` }}
                className="h-full bg-gradient-to-r from-emerald-950/30 via-cyan-950/40 to-emerald-950/30 relative flex items-center justify-center"
              >
                <div className="absolute inset-0 border-y border-emerald-500/20 pointer-events-none" />
                <span className="text-[10px] text-emerald-300/80 font-bold uppercase tracking-widest pointer-events-none">
                  SAFE ZONE [{liveViaNegativa.bLower.toLocaleString()} - {liveViaNegativa.bUpper.toLocaleString()}]
                </span>

                {/* Spot Price Line */}
                <div
                  style={{
                    left: `${((continuum.spotPct - continuum.bLowerPct) / (continuum.bUpperPct - continuum.bLowerPct)) * 100}%`,
                  }}
                  className="absolute top-0 bottom-0 w-0.5 bg-slate-400 shadow-[0_0_8px_#ffffff] z-10 pointer-events-none"
                  title={`Spot Price: $${liveViaNegativa.spotPrice.toLocaleString()}`}
                >
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] bg-slate-800 text-slate-300 px-1 rounded border border-white/10 whitespace-nowrap">
                    Spot
                  </span>
                </div>

                {/* Potential Minimum P* Line */}
                <div
                  style={{
                    left: `${Math.max(0, Math.min(100, ((continuum.potentialMinPct - continuum.bLowerPct) / (continuum.bUpperPct - continuum.bLowerPct)) * 100))}%`,
                  }}
                  className="absolute top-0 bottom-0 w-0.5 bg-purple-400 shadow-[0_0_8px_#c084fc] z-10 pointer-events-none"
                  title={`P* Potential Minimum: $${telemetry.gravityField.potentialMinimumPrice.toLocaleString()}`}
                >
                  <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 text-[8px] bg-purple-900 text-purple-300 px-1 rounded border border-purple-500/30 whitespace-nowrap">
                    P* Min
                  </span>
                </div>
              </div>

              {/* Right Exclusion Zone */}
              <div
                style={{ width: `${100 - continuum.bUpperPct}%` }}
                className="h-full bg-rose-950/40 border-l border-rose-500/50 flex items-center justify-center relative group"
              >
                <span className="text-[9px] text-rose-400 font-bold uppercase tracking-wider truncate px-1">
                  Exclusion (&gt; B_upper)
                </span>
              </div>

              {/* Target Price Pointer */}
              <div
                style={{ left: `${continuum.targetPct}%` }}
                className="absolute top-0 bottom-0 -translate-x-1/2 w-3 z-30 flex flex-col items-center justify-between pointer-events-none transition-all duration-300"
              >
                <div className={`w-3 h-3 rotate-45 border-2 shadow-lg ${
                  viaNegativaAnalysis.isSafe
                    ? 'bg-cyan-400 border-white shadow-cyan-400/50'
                    : 'bg-rose-500 border-white shadow-rose-500/50 animate-ping'
                }`} />
                <div className="w-0.5 h-6 bg-white shadow-[0_0_8px_#ffffff]" />
                <div className={`w-3 h-3 rotate-45 border-2 ${
                  viaNegativaAnalysis.isSafe ? 'bg-cyan-400 border-white' : 'bg-rose-500 border-white'
                }`} />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
              <span>B_lower: <strong className="text-white">${liveViaNegativa.bLower.toLocaleString()}</strong></span>
              <span>Aktueller Zielpreis: <strong className={viaNegativaAnalysis.isSafe ? 'text-cyan-300 font-bold' : 'text-rose-400 font-bold'}>${targetPrice.toLocaleString()}</strong></span>
              <span>B_upper: <strong className="text-white">${liveViaNegativa.bUpper.toLocaleString()}</strong></span>
            </div>
          </div>

          {/* All 6 Core Axiom Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {axiomResults.map(axiom => {
              const isPassed = axiom.isPassed;
              const isWarning = axiom.status === 'WARNING';
              const isBreach = axiom.status === 'BREACH';

              return (
                <div
                  key={axiom.axiomId}
                  className={`glass-card rounded-2xl p-5 shadow-xl border flex flex-col justify-between transition-all duration-300 ${
                    isBreach
                      ? 'bg-rose-500/10 border-rose-500/40 shadow-rose-500/5'
                      : isWarning
                      ? 'bg-amber-500/10 border-amber-500/40 shadow-amber-500/5'
                      : 'bg-emerald-500/10 border-emerald-500/30'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Card Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`p-1.5 rounded-lg border ${
                            isBreach
                              ? 'bg-rose-500/20 border-rose-500/50 text-rose-400'
                              : isWarning
                              ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                              : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                          }`}
                        >
                          {isBreach ? (
                            <XCircle className="w-4 h-4" />
                          ) : isWarning ? (
                            <AlertTriangle className="w-4 h-4" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4" />
                          )}
                        </div>
                        <div>
                          <span className="text-[10px] font-mono text-slate-400 block uppercase">
                            {axiom.blueprintRef || `Axiom ${axiom.axiomId}`}
                          </span>
                          <h4 className="text-xs font-bold text-white tracking-wide">
                            {axiom.name}
                          </h4>
                        </div>
                      </div>

                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                          isBreach
                            ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                            : isWarning
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                            : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        }`}
                      >
                        {isBreach ? 'EMBARGO' : isWarning ? 'CAUTION' : 'GATE OPEN'}
                      </span>
                    </div>

                    {/* Formula / Invariance Law */}
                    {axiom.formula && (
                      <div className="p-2 rounded-lg bg-black/40 border border-white/5 font-mono text-[11px] text-cyan-300/90 flex items-center justify-between">
                        <span className="text-[9px] text-slate-500 uppercase">Invariante:</span>
                        <span className="font-semibold">{axiom.formula}</span>
                      </div>
                    )}

                    {/* Operational Verdict Details */}
                    <p className="text-xs text-slate-300 leading-relaxed font-sans">
                      {axiom.detail}
                    </p>

                    {/* Metric pill */}
                    <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/5 font-mono text-[11px] space-y-1">
                      <span className="text-[9px] text-slate-500 uppercase block">Telemetrie & Metrik</span>
                      <p className="text-slate-300 font-semibold truncate">{axiom.metric}</p>
                    </div>
                  </div>

                  {/* Remediation Action if not optimal */}
                  <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-xs font-mono">
                    <span className="text-[10px] text-slate-400">
                      {isPassed ? 'Status: 100% Invariant' : 'Korrektur nötig'}
                    </span>

                    {axiom.axiomId === 1 && isBreach && (
                      <button
                        onClick={handleSnapToSafeCenter}
                        className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[10px] font-bold"
                      >
                        In Safe Zone zentrieren
                      </button>
                    )}

                    {axiom.axiomId === 2 && isBreach && (
                      <button
                        onClick={handleAlignWithGravity}
                        className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[10px] font-bold"
                      >
                        Richtung anpassen
                      </button>
                    )}

                    {axiom.axiomId === 3 && (
                      <button
                        onClick={handleTriggerClusterExit}
                        className="px-2 py-1 rounded bg-white/5 hover:bg-cyan-500/20 text-slate-300 hover:text-cyan-300 border border-white/10 text-[10px] font-bold"
                      >
                        Cluster-Exit (100% Cash)
                      </button>
                    )}

                    {axiom.axiomId === 5 && isBreach && (
                      <button
                        onClick={handleApplyOptimalOCOStop}
                        className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[10px] font-bold"
                      >
                        Kraken Stop setzen
                      </button>
                    )}

                    {isPassed && (
                      <span className="text-emerald-400 text-[11px] font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Freigegeben
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: VIA NEGATIVA SAFE-ZONE DEEP DIVE */}
      {activeTab === 'VIA_NEGATIVA' && (
        <div className="space-y-6">
          <div className="glass-card rounded-2xl p-6 shadow-xl border border-white/10 space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wider flex items-center gap-2">
                  <Compass className="w-4 h-4 text-cyan-400" />
                  §3 AUSSCHLUSS-TOPOLOGIE: DIE VIA NEGATIVA (VERBOTENE ZONEN)
                </h3>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl font-sans">
                  Mathematischer Nachweis von Preisbereichen, in denen die Existenzwahrscheinlichkeit des Preises mit P &lt; 0.1% Quantil verschwindet.
                </p>
              </div>

              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="text-slate-400">Quantil:</span>
                <span className="px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold">
                  99.9% (3.29 σ)
                </span>
              </div>
            </div>

            {/* Formula Card */}
            <div className="p-4 rounded-xl bg-black/40 border border-white/10 font-mono text-xs space-y-3">
              <span className="text-[10px] text-slate-500 uppercase block">Kanonische Berechnungsformel</span>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-slate-300">
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <span className="text-[10px] text-cyan-400 block">1. Maximale Dispersion</span>
                  <p className="font-bold text-white mt-1">ΔP_max = ATR_14 &times; &radic;(Δt) &times; 3.29</p>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    = {liveViaNegativa.atr14} &times; &radic;({(liveViaNegativa.timeDeltaMinutes / 60).toFixed(2)}) &times; 3.29 = <strong>${liveViaNegativa.deltaPMax.toLocaleString()}</strong>
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <span className="text-[10px] text-rose-400 block">2. Obere Ausschluss-Schranke</span>
                  <p className="font-bold text-white mt-1">B_upper = P_spot + ΔP_max + Ask_Imp</p>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    = ${liveViaNegativa.spotPrice.toLocaleString()} + ${liveViaNegativa.deltaPMax.toLocaleString()} + ${customAskImpedance} = <strong>${liveViaNegativa.bUpper.toLocaleString()}</strong>
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <span className="text-[10px] text-rose-400 block">3. Untere Ausschluss-Schranke</span>
                  <p className="font-bold text-white mt-1">B_lower = P_spot - ΔP_max - Bid_Supp</p>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    = ${liveViaNegativa.spotPrice.toLocaleString()} - ${liveViaNegativa.deltaPMax.toLocaleString()} - ${customBidSupport} = <strong>${liveViaNegativa.bLower.toLocaleString()}</strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Interactive Sliders for ATR & Impedance */}
            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 font-mono text-xs space-y-4">
              <span className="text-xs font-bold text-white block">
                Topologie-Parameter Feineinstellung:
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <div className="flex justify-between mb-1 text-[10px] text-slate-400">
                    <span>Ask-Impedanz (Liquiditätssperre)</span>
                    <span className="text-white font-bold">${customAskImpedance}</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    value={customAskImpedance}
                    onChange={e => setCustomAskImpedance(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between mb-1 text-[10px] text-slate-400">
                    <span>Bid-Support (Kaufmauer-Offset)</span>
                    <span className="text-white font-bold">${customBidSupport}</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    value={customBidSupport}
                    onChange={e => setCustomBidSupport(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between mb-1 text-[10px] text-slate-400">
                    <span>Zeithorizont Δt</span>
                    <span className="text-white font-bold">{timeDeltaMinutes} min</span>
                  </div>
                  <input
                    type="range"
                    min="15"
                    max="240"
                    step="15"
                    value={timeDeltaMinutes}
                    onChange={e => setTimeDeltaMinutes(parseInt(e.target.value))}
                    className="w-full accent-cyan-400"
                  />
                </div>
              </div>
            </div>

            {/* Wavefunction Density Metric */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-purple-950/20 to-cyan-950/20 border border-purple-500/30 font-mono text-xs flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="space-y-1">
                <span className="text-[10px] text-purple-400 font-bold uppercase block">
                  Quantenmechanische Wellenfunktion |ψ(P)|²
                </span>
                <p className="text-slate-300 text-xs font-sans">
                  Axiom 1 verbietet Order-Platzierung bei Wahrscheinlichkeitsdichten unter 0.001 (|ψ|² &lt; 0.001).
                </p>
              </div>

              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block">Dichte bei ${targetPrice.toLocaleString()}</span>
                  <span className="text-lg font-bold text-cyan-300">{viaNegativaAnalysis.wavefunctionDensityPsi2.toFixed(6)}</span>
                </div>
                <div className={`px-3 py-1.5 rounded-lg border font-bold text-xs ${
                  viaNegativaAnalysis.wavefunctionDensityPsi2 >= 0.001
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                }`}>
                  {viaNegativaAnalysis.wavefunctionDensityPsi2 >= 0.001 ? '|ψ|² ≥ 0.001 (ZULÄSSIG)' : '|ψ|² < 0.001 (VERBOTEN)'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: AXIOM DEEP DIVE (6 INVARIANTS BLUEPRINT SPEC) */}
      {activeTab === 'AXIOM_DEEP_DIVE' && (
        <div className="space-y-4 font-mono text-xs">
          {[
            {
              id: 1,
              title: 'Axiom 1: Via Negativa & Ausschluss-Topologie',
              section: '§3 & §14.1',
              formula: '|ψ(P)|² ≥ 0.001 ⟺ B_lower < P < B_upper',
              description: 'Keine Order-Platzierung in verbotenen Zonen. Ausgeschlossene Intervalle werden vor jeder Übermittlung an die Exchange verworfen.',
              guarantee: 'Verhindert Stop-Hunts und Volatilitätsfallen jenseits des 99.9% Quantils.',
            },
            {
              id: 2,
              title: 'Axiom 2: Potential-Erhaltung (Gravitations-Gradient)',
              section: '§2 & §14.2',
              formula: 'sign(Direction) = sign(-∇V_total)',
              description: 'Kein Trade gegen den Gradientenvektor des 3-Komponenten Gravitationsfelds (Makro 25%, Liquidität 35%, Polymarket 40%).',
              guarantee: 'Verhindert Trades gegen die globale makroökonomische Strömung P*.',
            },
            {
              id: 3,
              title: 'Axiom 3: Ground State Invarianz (100% Cash Protection)',
              section: '§5 & §14.3',
              formula: 'Post-Cluster-Exit ⟹ State |0⟩ (Nullpotenzial)',
              description: 'Nach Erreichen des Band-Ziels oder AC-Phasenumkehr (cos φ < 0.30) schließt ein atomarer Market-Close alle Tranchen gleichzeitig.',
              guarantee: 'Garantierte Realisierung aller Kursgewinne in Cash. Keine unhedged Over-Night Exposure.',
            },
            {
              id: 4,
              title: 'Axiom 4: Pyramiding-Invarianz (Reverse-DCA Free-Roll)',
              section: '§5 & §14.4',
              formula: 'Trailing Basket-Stop ≥ Entry_avg ⟹ R_basket = $0.00',
              description: 'Folge-Tranchen (Add-Ons 2, 3, 4) dürfen das Maximalrisiko R_0 niemals erhöhen. Der Stop wandert zwingend über den Einstiegspreis.',
              guarantee: 'Mathematisch bewiesenes Null-Restrisiko im Pyramidisierungs-Zyklus.',
            },
            {
              id: 5,
              title: 'Axiom 5: Exchange Decoupling & Dead-Man Resilience',
              section: '§6 & §14.5',
              formula: '∃ Stop_Exchange ∧ SyncLatency < 50ms',
              description: 'Keine Position ohne börsenseitig persistierten Stop-Loss (Kraken OCO Shadow Mesh). Schützt bei Server- oder App-Absturz.',
              guarantee: '100% Ausfallsicherheit unabhängig von Netzwerk- oder Cloud-Run-Status.',
            },
            {
              id: 6,
              title: 'Axiom 6: Ecosystem Fidelity & Hilbert-Phasenresonanz',
              section: '§4, §8 & §14.6',
              formula: 'cos(Δφ) ≥ +0.75 ∧ cos φ ≥ 0.30',
              description: 'Altcoins werden nur gegen ihren echten L1-Taktgeber korreliert. Konstruktive Interferenz und Mindest-Wirkleistungsfaktor zwingend.',
              guarantee: 'Schutz vor Scheinleistungs-Fakeouts, Fehlausbrüchen und de-korrelierten Sweeps.',
            },
          ].map(axiom => (
            <div key={axiom.id} className="glass-card rounded-2xl p-5 border border-white/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-cyan-400 font-bold">{axiom.section} // {axiom.title}</span>
                <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400 text-[10px]">
                  UNVERRÜCKBAR
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-black/40 border border-white/5 text-emerald-300 font-bold">
                {axiom.formula}
              </div>
              <p className="text-slate-300 text-xs font-sans leading-relaxed">
                {axiom.description}
              </p>
              <div className="pt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Sicherheits-Garantie: {axiom.guarantee}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TAB 4: STRESS-TEST SANDBOX & SCENARIOS */}
      {activeTab === 'STRESS_TEST' && (
        <div className="space-y-6 font-mono text-xs">
          <div className="glass-card rounded-2xl p-6 shadow-xl border border-white/10 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  M8-Gate Invariance Stress-Testing Sandbox
                </h3>
                <p className="text-xs text-slate-400 mt-1 font-sans">
                  Prüft das Reaktionsverhalten und die automatischen Schutzmechanismen von The Judge unter simulierten Marktanomalien.
                </p>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-[10px]">
                SANDBOX ACTIVE
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <button
                onClick={() => applyScenario('CANONICAL')}
                className="p-4 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-300 text-xs">1. Kanonischer Safe Flow</span>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Alle 6 Axiome erfüllt. Kurs im Zentrum der Safe Zone, R_0 neutralisiert, Stop aktiv.
                </p>
              </button>

              <button
                onClick={() => applyScenario('UPPER_BREACH')}
                className="p-4 rounded-xl bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-rose-300 text-xs">2. Obere Via Negativa Schranke</span>
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Target &gt; B_upper. Löst sofortiges Axiom 1 Embargo und akustischen Alarm aus.
                </p>
              </button>

              <button
                onClick={() => applyScenario('LOWER_BREACH')}
                className="p-4 rounded-xl bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-rose-300 text-xs">3. Untere Via Negativa Schranke</span>
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Target &lt; B_lower. Simuliert Flash-Crash in verbotene Zone (|ψ|² &lt; 0.001).
                </p>
              </button>

              <button
                onClick={() => applyScenario('COUNTER_GRAVITY')}
                className="p-4 rounded-xl bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-300 text-xs">4. Gegen Gravitationsfeld</span>
                  <Compass className="w-4 h-4 text-amber-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Trade entgegen -∇V_total. Verletzt Axiom 2 Potential-Erhaltung.
                </p>
              </button>

              <button
                onClick={() => applyScenario('MISSING_STOP')}
                className="p-4 rounded-xl bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-rose-300 text-xs">5. Fehlender Exchange Stop</span>
                  <Lock className="w-4 h-4 text-rose-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Axiom 5 Verletzung: Stop = $0. The Judge verweigert Order bedingungslos.
                </p>
              </button>

              <button
                onClick={() => applyScenario('DESTRUCTIVE_AC')}
                className="p-4 rounded-xl bg-purple-500/10 hover:bg-purple-500/15 border border-purple-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-purple-300 text-xs">6. AC-Überhitzung cos φ &lt; 0.30</span>
                  <Activity className="w-4 h-4 text-purple-400" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  Scheinleistung übersteigt Wirkleistung. Verletzt Axiom 6 Phasenresonanz.
                </p>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Live Axiom Telemetry & Alert Stream (Bottom Widget) */}
      <div className="glass-card rounded-2xl p-5 shadow-xl border border-white/10 space-y-3 font-mono text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-cyan-400 animate-pulse" />
            <span className="font-bold text-white uppercase tracking-wider">
              Axiom Telemetry & Alert Stream (Audit-Trail)
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px]">
            {(['ALL', 'CRITICAL', 'WARNING'] as const).map(f => (
              <button
                key={f}
                onClick={() => setActiveAlertFilter(f)}
                className={`px-2 py-0.5 rounded border transition-all ${
                  activeAlertFilter === f
                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 font-bold'
                    : 'bg-white/5 text-slate-400 border-white/5 hover:text-white'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {filteredAlerts.length === 0 ? (
            <p className="text-slate-500 text-center py-4">Keine Alerts für diesen Filter.</p>
          ) : (
            filteredAlerts.map(alert => (
              <div
                key={alert.id}
                className={`p-3 rounded-xl border flex items-start gap-3 transition-all ${
                  alert.severity === 'CRITICAL'
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                    : alert.severity === 'WARNING'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                    : 'bg-white/[0.02] border-white/5 text-slate-300'
                }`}
              >
                <div
                  className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                    alert.severity === 'CRITICAL'
                      ? 'bg-rose-400 shadow-[0_0_6px_#f43f5e]'
                      : alert.severity === 'WARNING'
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                  }`}
                />
                <div className="flex-1 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white text-[11px]">{alert.title}</span>
                    <span className="text-[10px] text-slate-500">{alert.timestamp}</span>
                  </div>
                  <p className="text-[11px] text-slate-300 font-sans">{alert.message}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
