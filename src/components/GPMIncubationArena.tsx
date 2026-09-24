import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Trophy,
  Rocket,
  Flame,
  Clock,
  Activity,
  ShieldCheck,
  RotateCw,
  Sliders,
  CheckCircle,
  Pause,
  Info
} from 'lucide-react';
import {
  GPMCandidate,
  calculateGPM,
  getGPMIncubationCandidates
} from '../utils/omegaLogic';

interface GPMIncubationArenaProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
  initialAutonomyLevel?: 'L4_HITL' | 'L5_AUTONOMOUS';
}

export default function GPMIncubationArena({
  onLogEvent,
  className = '',
  initialAutonomyLevel = 'L4_HITL'
}: GPMIncubationArenaProps) {
  // Delta T timeframe selection (§9: 15 / 30 / 60 Min)
  const [selectedDeltaT, setSelectedDeltaT] = useState<15 | 30 | 60>(30);
  const [candidates, setCandidates] = useState<GPMCandidate[]>(() =>
    getGPMIncubationCandidates(30)
  );
  const [selectedCandidate, setSelectedCandidate] = useState<GPMCandidate | null>(null);
  const [autonomyLevel, setAutonomyLevel] = useState<'L4_HITL' | 'L5_AUTONOMOUS'>(
    initialAutonomyLevel
  );
  const [isLiveStreamActive, setIsLiveStreamActive] = useState(true);
  const [countdownSeconds, setCountdownSeconds] = useState(180); // Incubation countdown
  const [lastPromotionTime, setLastPromotionTime] = useState<string>(
    new Date().toLocaleTimeString('de-DE')
  );
  const [deployedLiveSymbols, setDeployedLiveSymbols] = useState<string[]>(['SUI', 'SOL']);
  const [deploymentSuccessNotice, setDeploymentSuccessNotice] = useState<string | null>(null);
  const [activeScenario, setActiveScenario] = useState<string>('CANONICAL');

  const isInitialMount = useRef(true);

  // Evaluate & Promote Winners
  const handleEvaluateAndPromote = useCallback(
    (isAutomatic: boolean = false) => {
      setCandidates(prev => {
        const sorted = [...prev].sort((a, b) => b.gpm - a.gpm);
        const top2 = sorted.slice(0, 2);
        const topSymbols = top2.map(c => c.symbol);
        const gpm0 = top2[0]?.gpm ?? 0;
        const gpm1 = top2[1]?.gpm ?? 0;

        setTimeout(() => {
          setDeployedLiveSymbols(topSymbols);
          const timeStr = new Date().toLocaleTimeString('de-DE');
          setLastPromotionTime(timeStr);

          if (autonomyLevel === 'L5_AUTONOMOUS' || !isAutomatic) {
            setDeploymentSuccessNotice(
              `Top-2 Sieger [${topSymbols.join(' & ')}] erfolgreich für den Live-Handel bereitgestellt!`
            );
            setTimeout(() => setDeploymentSuccessNotice(null), 5000);
          }

          onLogEvent?.(
            `[GPM-INCUBATION §9] ${isAutomatic ? 'Automatischer Rundenabschluss' : 'Manuelle Auswertung'} (Δt = ${selectedDeltaT}m): Top-2 Gewinner sind ${topSymbols.join(` (GPM ${gpm0} $/m) & `)} (GPM ${gpm1} $/m). Promotion für Live-Deployment initiiert.`,
            'success',
            'THE_JUDGE'
          );
        }, 0);

        return sorted.map((c, idx) => ({
          ...c,
          rank: idx + 1,
          isPromotedToLive: idx < 2,
          liveStatus: idx < 2 ? 'PROMOTED_LIVE' : 'STANDBY_INCUBATION',
        }));
      });
      setCountdownSeconds(selectedDeltaT * 60);
    },
    [selectedDeltaT, autonomyLevel, onLogEvent]
  );

  // Sync candidate generation on deltaT timeframe change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const updated = getGPMIncubationCandidates(selectedDeltaT);
    setCandidates(updated);
    onLogEvent?.(
      `GPM Incubation Arena: Zeitfenster Δt auf ${selectedDeltaT} Min umgeschaltet. Shadow-PnL skaliert.`,
      'info',
      'GPM_ARENA'
    );
  }, [selectedDeltaT, onLogEvent]);

  // Countdown timer for next incubation evaluation round
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdownSeconds(prev => {
        if (prev <= 1) {
          // Defer evaluation outside state updater
          setTimeout(() => {
            handleEvaluateAndPromote(true);
          }, 0);
          return selectedDeltaT * 60; // Reset
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [selectedDeltaT, handleEvaluateAndPromote]);

  // Real-time Shadow Orderflow Simulation (PnL micro-fluctuations)
  useEffect(() => {
    if (!isLiveStreamActive) return;

    const stream = setInterval(() => {
      setCandidates(prev => {
        const updated = prev.map(cand => {
          // Micro fluctuations in shadow market fills
          const pnlDelta = (Math.random() - 0.48) * (selectedDeltaT === 15 ? 12 : selectedDeltaT === 30 ? 25 : 45);
          const newUnrealized = Number(
            Math.max(10, cand.unrealizedPnLUSD + pnlDelta).toFixed(2)
          );
          
          // Occasional realized trade booking
          let newRealized = cand.realizedPnLShadowUSD;
          let newTrades = cand.shadowTradesCount;
          if (Math.random() > 0.7) {
            newRealized = Number((newRealized + Math.abs(pnlDelta * 0.4)).toFixed(2));
            newTrades += 1;
          }

          const newGpm = calculateGPM(newRealized, newUnrealized, selectedDeltaT);

          return {
            ...cand,
            realizedPnLShadowUSD: newRealized,
            unrealizedPnLUSD: newUnrealized,
            gpm: newGpm,
            shadowTradesCount: newTrades,
          };
        });

        // Re-sort strictly by GPM
        updated.sort((a, b) => b.gpm - a.gpm);

        return updated.map((c, idx) => {
          const rank = idx + 1;
          const isPromoted = rank <= 2;
          return {
            ...c,
            rank,
            isPromotedToLive: isPromoted,
            liveStatus: isPromoted ? 'PROMOTED_LIVE' : 'STANDBY_INCUBATION',
          };
        });
      });
    }, 2800);

    return () => clearInterval(stream);
  }, [isLiveStreamActive, selectedDeltaT]);

  // Manual L4 Deploy Button Click: [ 🚀 LIVE SCHALTEN ]
  const handleManualLiveDeployment = () => {
    const top2 = candidates.slice(0, 2);
    const topSymbols = top2.map(c => c.symbol);
    setDeployedLiveSymbols(topSymbols);
    setDeploymentSuccessNotice(
      `Autonomie Level 4 freigegeben: [ 🚀 LIVE SCHALTEN ] autorisiert für ${topSymbols.join(' & ')}.`
    );
    setTimeout(() => setDeploymentSuccessNotice(null), 5000);

    onLogEvent?.(
      `[USER-FREIGABE L4] 🚀 LIVE GESCHALTET: Top-2 Symbole ${topSymbols.join(', ')} wurden börsenseitig in die Kraken Live Execution Engine überführt.`,
      'success',
      'THE_JUDGE'
    );
  };

  // Scenario Switcher to demonstrate rank flipping
  const handleSelectScenario = (scenario: string) => {
    setActiveScenario(scenario);

    if (scenario === 'SOL_FLIP') {
      onLogEvent?.("Szenario aktiviert: Solana Flipping (SOL klettert auf Rang 1 mit Rekord-GPM)", "warn", "GPM_ARENA");
    } else if (scenario === 'ETH_COMEBACK') {
      onLogEvent?.("Szenario aktiviert: Ethereum Lead-Lag Surge (ETH steigt in Top-2 auf)", "success", "GPM_ARENA");
    } else {
      onLogEvent?.("Szenario zurückgesetzt auf kanonische GPM-Baseline", "info", "GPM_ARENA");
    }

    setCandidates(prev => {
      let next = [...prev];
      if (scenario === 'SOL_FLIP') {
        // SOL moves to Rank 1 with high burst GPM
        next = next.map(c => {
          if (c.symbol === 'SOL') {
            const rel = 5800;
            const unrel = 2100;
            return {
              ...c,
              realizedPnLShadowUSD: rel,
              unrealizedPnLUSD: unrel,
              gpm: calculateGPM(rel, unrel, selectedDeltaT),
            };
          }
          if (c.symbol === 'SUI') {
            const rel = 3400;
            const unrel = 900;
            return {
              ...c,
              realizedPnLShadowUSD: rel,
              unrealizedPnLUSD: unrel,
              gpm: calculateGPM(rel, unrel, selectedDeltaT),
            };
          }
          return c;
        });
      } else if (scenario === 'ETH_COMEBACK') {
        // ETH rises to Rank 2
        next = next.map(c => {
          if (c.symbol === 'ETH') {
            const rel = 4400;
            const unrel = 1800;
            return {
              ...c,
              realizedPnLShadowUSD: rel,
              unrealizedPnLUSD: unrel,
              gpm: calculateGPM(rel, unrel, selectedDeltaT),
            };
          }
          return c;
        });
      } else {
        // Reset to canonical
        next = getGPMIncubationCandidates(selectedDeltaT);
      }

      next.sort((a, b) => b.gpm - a.gpm);
      return next.map((c, idx) => ({
        ...c,
        rank: idx + 1,
        isPromotedToLive: idx < 2,
        liveStatus: idx < 2 ? 'PROMOTED_LIVE' : 'STANDBY_INCUBATION',
      }));
    });
  };

  const top2Candidates = useMemo(() => candidates.slice(0, 2), [candidates]);
  const standbyCandidates = useMemo(() => candidates.slice(2, 4), [candidates]);

  // Format seconds to mm:ss
  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      id="gpm-incubation-arena-container"
      className={`bg-[#0b0f19] border border-slate-800 rounded-2xl p-5 shadow-2xl relative overflow-hidden flex flex-col gap-5 ${className}`}
    >
      {/* Background Radial Glow */}
      <div className="absolute top-0 right-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Banner Notice (Live Promotion Trigger Feedback) */}
      {candidates.length === 0 && (
        <p className="text-xs font-mono text-slate-400" role="status">
          Keine private Trade-Historie. GPM bleibt leer, statt erfundene Schatten-PnL zu zeigen.
        </p>
      )}
      {deploymentSuccessNotice && (
        <div className="p-3 bg-emerald-500/20 border border-emerald-500/50 rounded-xl text-emerald-300 font-mono text-xs flex items-center justify-between animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-bold">{deploymentSuccessNotice}</span>
          </div>
          <span className="text-[10px] text-emerald-400/80">KRAKEN SPOT & MARGIN ENGINE</span>
        </div>
      )}

      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
        <div className="flex items-start gap-3.5">
          <div className="p-3 bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/40 rounded-xl text-amber-400 shrink-0 shadow-md shadow-amber-500/10">
            <Trophy className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-white tracking-wide font-mono flex items-center gap-2">
                §9 GPM-INCUBATION ARENA &amp; L4/L5 AUTONOMIE
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1">
                <Flame className="w-3 h-3" />
                TOP-4 DUEL
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                Top-2 Promotion
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl font-sans">
              Vor dem Echtgeld-Handel duellieren die Top-4 Symbole in einer Shadow-Arena. Nur die zwei stärksten steigen auf Basis des Growth-Per-Minute-Wertes (GPM) in den Live-Handel auf:
              <span className="font-mono text-cyan-300 ml-1">
                GPM = (PnL_Shadow_realisiert + PnL_unrealisiert) / Δt
              </span>.
            </p>
          </div>
        </div>

        {/* Right Controls: Timeframe (Δt), Autonomy Switch & Live Stream */}
        <div className="flex items-center gap-2.5 flex-wrap self-start lg:self-auto">
          {/* Delta T Timeframe Selector */}
          <div className="flex items-center gap-1 bg-[#121624] p-1 rounded-xl border border-slate-700/60 text-xs font-mono">
            <span className="text-slate-400 text-[10px] px-2 flex items-center gap-1">
              <Clock className="w-3 h-3 text-cyan-400" /> Δt:
            </span>
            {([15, 30, 60] as const).map(dt => (
              <button
                key={dt}
                id={`btn-timeframe-${dt}`}
                onClick={() => setSelectedDeltaT(dt)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                  selectedDeltaT === dt
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {dt}m
              </button>
            ))}
          </div>

          {/* Autonomy Level Toggle */}
          <button
            id="btn-toggle-autonomy-mode"
            onClick={() => {
              const next = autonomyLevel === 'L4_HITL' ? 'L5_AUTONOMOUS' : 'L4_HITL';
              setAutonomyLevel(next);
              onLogEvent?.(
                next === 'L5_AUTONOMOUS'
                  ? 'GPM Arena: Autonomie Level 5 aktiviert (24/7 Zero-Touch Dauerbetrieb, automatische Hot-Promotion).'
                  : 'GPM Arena: Autonomie Level 4 aktiviert (Human-in-the-Loop [ 🚀 LIVE SCHALTEN ] Klick-Freigabe aktiv).',
                next === 'L5_AUTONOMOUS' ? 'warn' : 'info',
                'AUTONOMY_ENGINE'
              );
            }}
            className={`px-3 py-2 rounded-xl text-xs font-mono font-bold border transition-all flex items-center gap-1.5 ${
              autonomyLevel === 'L5_AUTONOMOUS'
                ? 'bg-purple-500/20 text-purple-300 border-purple-500/40 shadow-sm shadow-purple-500/10'
                : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
            }`}
            title="Umschalten zwischen Level 4 (HITL) und Level 5 (Vollautonom)"
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>{autonomyLevel === 'L5_AUTONOMOUS' ? 'L5: ZERO-TOUCH' : 'L4: HITL GATED'}</span>
          </button>

          {/* Live Feed Toggle */}
          <button
            id="btn-toggle-arena-stream"
            onClick={() => setIsLiveStreamActive(!isLiveStreamActive)}
            className={`px-2.5 py-2 border rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-1.5 ${
              isLiveStreamActive
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
            title="Pausiert oder reaktiviert die Simulation der Shadow-Ausführungen"
          >
            {isLiveStreamActive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span className="hidden sm:inline">Shadow Feed</span>
              </>
            ) : (
              <>
                <Pause className="w-3 h-3" />
                <span className="hidden sm:inline">Pausiert</span>
              </>
            )}
          </button>

          {/* Re-evaluate Button */}
          <button
            id="btn-reevaluate-gpm"
            onClick={() => handleEvaluateAndPromote(false)}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-mono transition-all"
            title="Jetzt neu auswerten und Top-2 befördern"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Arena Subheader: Round Countdown, Scenarios, and Primary [ 🚀 LIVE SCHALTEN ] Action */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center text-xs font-mono bg-black/25 p-3 rounded-xl border border-white/5">
        {/* Countdown & Round Info */}
        <div className="md:col-span-4 flex items-center gap-3">
          <div className="flex items-center gap-2 text-slate-300">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="text-slate-400">Rundenschluss in:</span>
            <span className="font-bold text-amber-300 text-sm tracking-wider">
              {formatCountdown(countdownSeconds)}
            </span>
          </div>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            (Letzte: {lastPromotionTime})
          </span>
        </div>

        {/* Scenario Switcher */}
        <div className="md:col-span-4 flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400 text-[10px] shrink-0">Szenario:</span>
          <button
            onClick={() => handleSelectScenario('CANONICAL')}
            className={`px-2 py-0.5 rounded text-[10px] transition-all ${
              activeScenario === 'CANONICAL'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            Kanonisch
          </button>
          <button
            onClick={() => handleSelectScenario('SOL_FLIP')}
            className={`px-2 py-0.5 rounded text-[10px] transition-all ${
              activeScenario === 'SOL_FLIP'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            SOL Flip #1
          </button>
          <button
            onClick={() => handleSelectScenario('ETH_COMEBACK')}
            className={`px-2 py-0.5 rounded text-[10px] transition-all ${
              activeScenario === 'ETH_COMEBACK'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            ETH Aufstieg
          </button>
        </div>

        {/* Level 4 Deployment Trigger Button: [ 🚀 LIVE SCHALTEN ] */}
        <div className="md:col-span-4 flex justify-start md:justify-end">
          {autonomyLevel === 'L4_HITL' ? (
            <button
              id="btn-deploy-live-l4"
              onClick={handleManualLiveDeployment}
              className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold font-mono text-xs rounded-xl shadow-lg shadow-emerald-500/20 flex items-center gap-2 transition-all active:scale-95 group"
            >
              <Rocket className="w-4 h-4 group-hover:-translate-y-0.5 transition-transform" />
              <span>[ 🚀 LIVE SCHALTEN ]</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs font-mono">
              <Activity className="w-3.5 h-3.5 animate-spin" />
              <span className="font-bold">L5: Zero-Touch 24/7 Auto-Live</span>
            </div>
          )}
        </div>
      </div>

      {/* SECTION A: TOP-2 WINNERS (PROMOTED FOR LIVE DEPLOYMENT) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse" />
            <h3 className="text-xs font-mono font-bold text-emerald-400 tracking-wider uppercase flex items-center gap-2">
              Top-2 Sieger: Befördert für Live-Deployment ({top2Candidates.map(c => c.symbol).join(' &amp; ')})
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Aktive Kraken Shadow-Limits &amp; Pyramiding aktiv
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {top2Candidates.map(candidate => {
            const isLive = deployedLiveSymbols.includes(candidate.symbol);
            const isSelected = selectedCandidate?.symbol === candidate.symbol;

            return (
              <div
                key={candidate.symbol}
                id={`gpm-winner-card-${candidate.symbol}`}
                onClick={() => setSelectedCandidate(candidate)}
                className={`p-4 rounded-xl border transition-all duration-200 cursor-pointer relative overflow-hidden bg-gradient-to-b from-[#0e1f1e] to-[#0a141b] border-emerald-500/50 shadow-lg shadow-emerald-500/10 hover:border-emerald-400 ${
                  isSelected ? 'ring-2 ring-emerald-400' : ''
                }`}
              >
                {/* Winner Ribbon Glow */}
                <div className="absolute top-0 right-0 px-3 py-1 bg-emerald-500 text-slate-950 font-mono font-extrabold text-[10px] rounded-bl-xl shadow-md flex items-center gap-1">
                  <Trophy className="w-3 h-3" />
                  <span>RANG #{candidate.rank} • LIVE BEFÖRDERT</span>
                </div>

                {/* Candidate Header */}
                <div className="flex items-start justify-between pr-24 mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-xl font-extrabold text-white font-mono flex items-center gap-1.5">
                        {candidate.symbol}
                        <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-white/[0.05] text-slate-300 border border-white/10">
                          {candidate.cluster}
                        </span>
                      </h4>
                    </div>
                    <p className="text-xs text-slate-400 font-sans">{candidate.name}</p>
                  </div>
                </div>

                {/* Main Metric: GPM Rate Highlight */}
                <div className="p-3 rounded-xl bg-black/40 border border-emerald-500/20 mb-3 flex items-center justify-between font-mono">
                  <div>
                    <span className="text-[10px] uppercase text-slate-400 block">
                      Growth Per Minute (GPM):
                    </span>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span className="text-2xl font-black text-emerald-300">
                        +${candidate.gpm.toFixed(2)}
                      </span>
                      <span className="text-xs font-bold text-emerald-400">/ min</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block">Δt Zeitfenster:</span>
                    <span className="text-xs font-bold text-white">{candidate.deltaTMinutes} Minuten</span>
                    <span className="text-[10px] text-emerald-400 block font-bold mt-0.5">
                      Rate: ${(candidate.gpm * 60).toLocaleString(undefined, { maximumFractionDigits: 0 })} / Std
                    </span>
                  </div>
                </div>

                {/* Formula Components Grid */}
                <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-3">
                  <div className="p-2 rounded-lg bg-white/[0.02] border border-white/5">
                    <span className="text-slate-400 text-[10px] block">Realisierter PnL_Shadow:</span>
                    <span className="font-bold text-white text-sm">
                      +${candidate.realizedPnLShadowUSD.toLocaleString()}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-white/[0.02] border border-white/5">
                    <span className="text-slate-400 text-[10px] block">Unrealisierter PnL:</span>
                    <span className="font-bold text-cyan-300 text-sm">
                      +${candidate.unrealizedPnLUSD.toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Supporting Performance Stats */}
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <span>Trades: <strong className="text-white">{candidate.shadowTradesCount}</strong></span>
                    <span>•</span>
                    <span>Win: <strong className="text-emerald-400">{candidate.winRateShadowPercent}%</strong></span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isLive ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        LIVE GESTARTET
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold">
                        BEREIT FÜR DEPLOY
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION B: STANDBY CANDIDATES (#3 & #4) */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-500" />
            <h3 className="text-xs font-mono font-bold text-slate-400 tracking-wider uppercase">
              Incubation Standby Kandidaten (Rang #3 &amp; #4)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            Bleiben in der Shadow-Arena bis GPM &gt; Platz #2
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {standbyCandidates.map(candidate => {
            const isSelected = selectedCandidate?.symbol === candidate.symbol;

            return (
              <div
                key={candidate.symbol}
                id={`gpm-standby-card-${candidate.symbol}`}
                onClick={() => setSelectedCandidate(candidate)}
                className={`p-4 rounded-xl border transition-all duration-200 cursor-pointer bg-[#0e121a] border-slate-800 hover:border-slate-700 opacity-90 ${
                  isSelected ? 'ring-2 ring-slate-500' : ''
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-mono font-bold">
                        RANG #{candidate.rank}
                      </span>
                      <h4 className="text-base font-bold text-slate-200 font-mono">
                        {candidate.symbol}
                      </h4>
                      <span className="text-[10px] text-slate-500 font-mono">
                        ({candidate.cluster})
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 font-sans mt-0.5">{candidate.name}</p>
                  </div>
                  <div className="text-right font-mono">
                    <span className="text-[10px] text-slate-500 block">GPM Rate:</span>
                    <span className="text-base font-bold text-slate-300">
                      +${candidate.gpm.toFixed(2)}
                      <span className="text-xs text-slate-500 font-normal">/m</span>
                    </span>
                  </div>
                </div>

                {/* Quick Stats Grid */}
                <div className="grid grid-cols-3 gap-2 text-[11px] font-mono p-2 rounded-lg bg-black/30 border border-white/5">
                  <div>
                    <span className="text-slate-500 block text-[10px]">Realisiert:</span>
                    <span className="font-semibold text-slate-300">
                      ${candidate.realizedPnLShadowUSD.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px]">Unrealisiert:</span>
                    <span className="font-semibold text-slate-300">
                      ${candidate.unrealizedPnLUSD.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px]">Win-Rate:</span>
                    <span className="font-semibold text-slate-300">
                      {candidate.winRateShadowPercent}%
                    </span>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>Delta zur Beförderung:</span>
                  <span className="text-amber-400 font-bold">
                    -${(top2Candidates[1].gpm - candidate.gpm).toFixed(2)} $/min benötigt
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION C: CANDIDATE MATHEMATICAL INSPECTOR (DRAWER) */}
      {selectedCandidate && (
        <div
          id="gpm-candidate-inspector"
          className="p-4 rounded-xl bg-[#090d16] border border-cyan-500/30 shadow-2xl animate-in fade-in duration-200 mt-2 font-mono text-xs"
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                <Info className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  Formel-Verifikation OMEGA §9: {selectedCandidate.symbol} ({selectedCandidate.name})
                </h4>
                <p className="text-[11px] text-slate-400">
                  Rang: #{selectedCandidate.rank} • Status: {selectedCandidate.liveStatus} • Cluster: {selectedCandidate.cluster}
                </p>
              </div>
            </div>
            <button
              onClick={() => setSelectedCandidate(null)}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
            >
              Schließen
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
            <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 text-[10px] block">1. Realisierter Shadow-PnL:</span>
              <span className="text-base font-bold text-white block mt-0.5">
                ${selectedCandidate.realizedPnLShadowUSD.toFixed(2)}
              </span>
              <span className="text-[10px] text-slate-500">Aus {selectedCandidate.shadowTradesCount} Shadow-Fills</span>
            </div>

            <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 text-[10px] block">2. Unrealisierter PnL:</span>
              <span className="text-base font-bold text-cyan-300 block mt-0.5">
                ${selectedCandidate.unrealizedPnLUSD.toFixed(2)}
              </span>
              <span className="text-[10px] text-slate-500">Offene Tranchen im Buch</span>
            </div>

            <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 text-[10px] block">3. Zeitfenster Δt:</span>
              <span className="text-base font-bold text-amber-300 block mt-0.5">
                {selectedCandidate.deltaTMinutes} Minuten
              </span>
              <span className="text-[10px] text-slate-500">Evaluation Horizon</span>
            </div>

            <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
              <span className="text-slate-400 text-[10px] block">4. Berechneter GPM:</span>
              <span className="text-base font-bold text-emerald-400 block mt-0.5">
                ${selectedCandidate.gpm.toFixed(3)} / min
              </span>
              <span className="text-[10px] text-slate-500">
                ({(selectedCandidate.realizedPnLShadowUSD + selectedCandidate.unrealizedPnLUSD).toFixed(1)} / {selectedCandidate.deltaTMinutes})
              </span>
            </div>
          </div>

          <div className="mt-3 p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-slate-300">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>
                {selectedCandidate.isPromotedToLive
                  ? 'Beförderungskriterien nach §9 erfüllt: Automatische Allokation im 90% Margin-Pool zugewiesen.'
                  : 'Incubation Standby: Verbleibt im Simulator bis zum nächsten 15/30/60m Schnitt.'}
              </span>
            </div>
            {selectedCandidate.isPromotedToLive && (
              <button
                onClick={() => {
                  onLogEvent?.(
                    `Manuelle Order-Freigabe für ${selectedCandidate.symbol}: Tranche 1 (Scout) auf Kraken Exchange gesendet.`,
                    'success',
                    'THE_JUDGE'
                  );
                }}
                className="px-3 py-1 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/40 rounded-lg text-xs font-bold transition-all"
              >
                Sofort Scout-Order absetzen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
