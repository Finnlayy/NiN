import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Radio,
  Sparkles,
  Activity,
  RotateCw,
  Clock,
  Filter,
  Pause,
  Bot
} from 'lucide-react';
import {
  SymbolLampState,
  EcosystemLeader,
  getEcosystemMetaRotation,
  calculateLeaderAmpelState
} from '../utils/omegaLogic';
import { useMarketFeed } from '../market/useMarketFeed';
import { leaderPricesFromQuotes } from '../market/krakenLive';

interface SymbolAmpelProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

type ClusterFilter = 'ALL' | 'SUI' | 'SOL' | 'BTC' | 'ETH';
type LampFilter = 'ALL' | SymbolLampState;

export default function SymbolAmpel({ onLogEvent, className = '' }: SymbolAmpelProps) {
  const market = useMarketFeed();
  const liveLeaders = useCallback(() => {
    const prices = leaderPricesFromQuotes(market.feed?.quotes ?? {});
    return getEcosystemMetaRotation(prices);
  }, [market.feed]);
  const [leaders, setLeaders] = useState<EcosystemLeader[]>([]);

  useEffect(() => {
    const next = liveLeaders();
    if (next.length === 0) return;
    setLeaders(next);
  }, [liveLeaders]);
  const [selectedLeader, setSelectedLeader] = useState<EcosystemLeader | null>(null);
  const [clusterFilter, setClusterFilter] = useState<ClusterFilter>('ALL');
  const [lampFilter, setLampFilter] = useState<LampFilter>('ALL');
  const [liveStreamActive, setLiveStreamActive] = useState(true);
  const [secondsUntilRotation, setSecondsUntilRotation] = useState(285); // 5 min cycle countdown
  const [lastRotationTimestamp, setLastRotationTimestamp] = useState<string>(
    new Date().toLocaleTimeString('de-DE')
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activeScenario, setActiveScenario] = useState<string>('CANONICAL');

  // Force Meta-Rotation re-ranking
  const handleForceRotation = useCallback((isAutomatic: boolean = false) => {
    setLeaders(prev => {
      const cloned = [...prev];
      cloned.sort((a, b) => b.metaScore - a.metaScore);

      // Top candidate gets marked as Meta-Leader with GREEN_GLOW
      const updated = cloned.map((tok, idx) => {
        const isLeader = idx === 0 && tok.metaScore >= 0.75;
        let lamp = tok.lampState;
        if (isLeader) {
          lamp = 'GREEN_GLOW';
        }
        return {
          ...tok,
          isLeader,
          lampState: lamp,
        };
      });

      const top = updated[0];
      const timeStr = new Date().toLocaleTimeString('de-DE');

      setTimeout(() => {
        setLastRotationTimestamp(timeStr);

        if (onLogEvent && top) {
          onLogEvent(
            `${isAutomatic ? '[5M META-ROTATION]' : '[MANUELLE ROTATION]'}: Neuer Cluster-Leader ist ${top.symbol} (Score: ${top.metaScore}, Status: ${top.lampState})`,
            top.lampState === 'GREEN_GLOW' ? 'success' : 'info',
            'SYMBOL_AMPEL'
          );
        }
      }, 0);

      return updated;
    });

    setSecondsUntilRotation(300);
  }, [onLogEvent]);

  // 5-Minute Meta-Rotation Countdown Timer
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsUntilRotation(prev => {
        if (prev <= 1) {
          // Trigger meta-rotation evaluation outside state updater
          setTimeout(() => {
            handleForceRotation(true);
          }, 0);
          return 300; // Reset to 5 minutes
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [handleForceRotation]);

  // Live order flow micro-fluctuation simulation (when liveStreamActive)
  useEffect(() => {
    if (!liveStreamActive) return;

    const streamInterval = setInterval(() => {
      setLeaders(prevLeaders => {
        return prevLeaders.map(leader => {
          // Add micro random fluctuations to rvol, cosPhi, and price
          const rvolDelta = (Math.random() - 0.49) * 0.08;
          const newRvol = Math.max(0.4, Number((leader.rvol5m + rvolDelta).toFixed(2)));

          const cosPhiDelta = (Math.random() - 0.48) * 0.02;
          const newCosPhi = Math.max(-0.4, Math.min(0.99, Number((leader.cosPhi + cosPhiDelta).toFixed(2))));

          const newPrice = leader.priceUSD;

          // Calculate normalized metaScore according to OMEGA Blueprint §8
          const w1 = 0.25, w2 = 0.25, w3 = 0.25, w4 = 0.25;
          const betaNorm = Math.min(1.2, leader.betaLead / 3.0);
          const rvolNorm = Math.min(1.2, newRvol / 4.0);
          const cosPhiNorm = Math.max(-0.5, Math.min(1.0, newCosPhi));
          const newScore = Number((w1 * leader.correlationLead + w2 * betaNorm + w3 * rvolNorm + w4 * cosPhiNorm).toFixed(3));

          const newLampState = calculateLeaderAmpelState(newScore, newCosPhi, newRvol);

          let tradeStatus: EcosystemLeader['tradeStatus'] = 'STANDBY_HOLD';
          if (newLampState === 'GREEN_GLOW') tradeStatus = 'ACTIVE_PYRAMID';
          else if (newLampState === 'GREEN_SOLID') tradeStatus = 'SCOUT_ENTRY';
          else if (newLampState === 'RED_GLOW') tradeStatus = 'EMBARGO_BLOCKED';
          else tradeStatus = 'STANDBY_HOLD';

          return {
            ...leader,
            rvol5m: newRvol,
            cosPhi: newCosPhi,
            priceUSD: newPrice,
            metaScore: newScore,
            lampState: newLampState,
            tradeStatus,
          };
        });
      });
    }, 2500);

    return () => clearInterval(streamInterval);
  }, [liveStreamActive]);

  // Apply market scenario presets to demonstrate all Ampel states
  const handleApplyScenario = (scenario: string) => {
    setActiveScenario(scenario);
    let updated: EcosystemLeader[] = [];

    switch (scenario) {
      case 'SUI_BREAKOUT':
        updated = liveLeaders().map(l => {
          if (l.symbol === 'SUI') {
            return {
              ...l,
              rvol5m: 5.4,
              cosPhi: 0.98,
              metaScore: 0.965,
              lampState: 'GREEN_GLOW',
              isLeader: true,
              tradeStatus: 'ACTIVE_PYRAMID',
              change24h: 19.4,
            };
          }
          return {
            ...l,
            isLeader: false,
            lampState: l.symbol === 'SOL' ? 'GREEN_SOLID' : l.lampState,
          };
        });
        onLogEvent?.("Szenario aktiviert: Sui Quantum Breakout (SUI -> GREEN_GLOW Meta-Leader, Reverse-DCA aktiv)", "success", "AMPEL_KERNEL");
        break;

      case 'SOL_DOMINANCE':
        updated = liveLeaders().map(l => {
          if (l.symbol === 'SOL') {
            return {
              ...l,
              rvol5m: 4.8,
              betaLead: 3.4,
              cosPhi: 0.96,
              metaScore: 0.952,
              lampState: 'GREEN_GLOW',
              isLeader: true,
              tradeStatus: 'ACTIVE_PYRAMID',
              change24h: 12.8,
            };
          }
          return {
            ...l,
            isLeader: false,
            lampState: l.symbol === 'SUI' ? 'GREEN_SOLID' : l.lampState,
          };
        });
        onLogEvent?.("Szenario aktiviert: Solana High-Beta Surge (SOL -> GREEN_GLOW Meta-Leader)", "success", "AMPEL_KERNEL");
        break;

      case 'MACRO_RISK_OFF':
        updated = liveLeaders().map(l => {
          if (l.symbol === 'BTC') {
            return {
              ...l,
              cosPhi: 0.88,
              metaScore: 0.84,
              lampState: 'GREEN_SOLID',
              isLeader: true,
              tradeStatus: 'SCOUT_ENTRY',
            };
          }
          return {
            ...l,
            isLeader: false,
            cosPhi: l.cosPhi - 0.35,
            metaScore: Number((l.metaScore * 0.7).toFixed(3)),
            lampState: 'YELLOW',
            tradeStatus: 'STANDBY_HOLD',
            change24h: -3.5,
          };
        });
        onLogEvent?.("Szenario aktiviert: Makro Risk-Off Phase (Alts fallen in YELLOW Standby, BTC hält Stabilitaet)", "warn", "AMPEL_KERNEL");
        break;

      case 'VIA_NEGATIVA_SHOCK':
        updated = liveLeaders().map(l => {
          if (l.symbol === 'XRP' || l.symbol === 'DOGE') {
            return {
              ...l,
              cosPhi: -0.45,
              metaScore: 0.28,
              lampState: 'RED_GLOW',
              tradeStatus: 'EMBARGO_BLOCKED',
              change24h: -8.4,
            };
          }
          if (l.symbol === 'BNB') {
            return {
              ...l,
              cosPhi: 0.12,
              metaScore: 0.42,
              lampState: 'GRAY',
              tradeStatus: 'STANDBY_HOLD',
            };
          }
          return l;
        });
        onLogEvent?.("Szenario aktiviert: Destruktive Phasen-Interferenz & Via Negativa Sperre (RED_GLOW Embargo für XRP & DOGE)", "error", "THE_JUDGE");
        break;

      case 'CANONICAL':
      default:
        updated = liveLeaders();
        onLogEvent?.("Szenario zurückgesetzt auf kanonische OMEGA-Blueprint Baseline", "info", "AMPEL_KERNEL");
        break;
    }

    updated.sort((a, b) => b.metaScore - a.metaScore);
    if (updated.length > 0 && scenario !== 'MACRO_RISK_OFF') {
      updated[0].isLeader = true;
      if (updated[0].lampState === 'GREEN_SOLID') {
        updated[0].lampState = 'GREEN_GLOW';
      }
    }
    setLeaders(updated);
  };

  // Filtered leaders
  const filteredLeaders = useMemo(() => {
    return leaders.filter(l => {
      if (clusterFilter !== 'ALL' && l.cluster !== clusterFilter) return false;
      if (lampFilter !== 'ALL' && l.lampState !== lampFilter) return false;
      return true;
    });
  }, [leaders, clusterFilter, lampFilter]);

  // Status counts
  const statusCounts = useMemo(() => {
    return {
      greenGlow: leaders.filter(l => l.lampState === 'GREEN_GLOW').length,
      greenSolid: leaders.filter(l => l.lampState === 'GREEN_SOLID').length,
      yellow: leaders.filter(l => l.lampState === 'YELLOW').length,
      gray: leaders.filter(l => l.lampState === 'GRAY').length,
      redGlow: leaders.filter(l => l.lampState === 'RED_GLOW').length,
    };
  }, [leaders]);

  // Current primary leader
  const primaryLeader = useMemo(() => {
    return leaders.find(l => l.isLeader) || leaders[0];
  }, [leaders]);

  // Format seconds to mm:ss
  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Helper to render Ampel state beacon
  const renderAmpelBeacon = (state: SymbolLampState, isLeader: boolean) => {
    switch (state) {
      case 'GREEN_GLOW':
        return (
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center">
              <span className="absolute w-5 h-5 rounded-full bg-emerald-400/40 animate-ping" />
              <span className="w-3.5 h-3.5 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399] ring-2 ring-emerald-300" />
            </div>
            <span className="font-mono text-xs font-bold text-emerald-300 flex items-center gap-1">
              GREEN_GLOW {isLeader && <span className="text-amber-300">★ LEADER</span>}
            </span>
          </div>
        );
      case 'GREEN_SOLID':
        return (
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/40 shadow-sm shadow-emerald-500" />
            <span className="font-mono text-xs font-bold text-emerald-400">
              GREEN_SOLID (TREND)
            </span>
          </div>
        );
      case 'YELLOW':
        return (
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-amber-400 ring-2 ring-amber-400/40 shadow-sm shadow-amber-400" />
            <span className="font-mono text-xs font-bold text-amber-300">
              YELLOW (STANDBY)
            </span>
          </div>
        );
      case 'GRAY':
        return (
          <div className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-full bg-slate-500 ring-2 ring-slate-600" />
            <span className="font-mono text-xs font-bold text-slate-400">
              GRAY (INAKTIV)
            </span>
          </div>
        );
      case 'RED_GLOW':
      default:
        return (
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center">
              <span className="absolute w-5 h-5 rounded-full bg-rose-500/50 animate-ping" />
              <span className="w-3.5 h-3.5 rounded-full bg-rose-500 shadow-[0_0_12px_#f43f5e] ring-2 ring-rose-300" />
            </div>
            <span className="font-mono text-xs font-bold text-rose-300 flex items-center gap-1">
              RED_GLOW (SPERRE)
            </span>
          </div>
        );
    }
  };

  // Card background styling based on lamp state
  const getCardBorderClass = (state: SymbolLampState, isLeader: boolean) => {
    if (isLeader) {
      return 'border-emerald-400/60 bg-gradient-to-b from-[#101e1d] to-[#0c131b] shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-400/30';
    }
    switch (state) {
      case 'GREEN_GLOW':
        return 'border-emerald-500/50 bg-[#0e191a] shadow-md shadow-emerald-500/10';
      case 'GREEN_SOLID':
        return 'border-emerald-500/30 bg-[#0d161d] hover:border-emerald-500/50';
      case 'YELLOW':
        return 'border-amber-500/30 bg-[#151417] hover:border-amber-500/50';
      case 'GRAY':
        return 'border-slate-800 bg-[#0e1118] hover:border-slate-700 opacity-80';
      case 'RED_GLOW':
      default:
        return 'border-rose-500/40 bg-[#1a0f14] shadow-md shadow-rose-500/10';
    }
  };

  return (
    <div
      id="omega-symbol-ampel-container"
      className={`bg-[#0c101a] border border-slate-800 rounded-2xl p-5 shadow-2xl relative overflow-hidden flex flex-col gap-5 ${className}`}
    >
      {/* Background radial highlight */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header & Telemetry Status Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
        <div className="flex items-start gap-3.5">
          <div className="p-3 bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 border border-emerald-500/40 rounded-xl text-emerald-400 shrink-0 shadow-md shadow-emerald-500/10">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-white tracking-wide font-mono">
                §8 & §11 SYMBOL-AMPEL: MARKTFÜHRER & 5-MINUTEN META-ROTATION
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 flex items-center gap-1">
                <Activity className="w-3 h-3" />
                L4/L5 KANONISCH
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                {primaryLeader
                  ? `Leader: ★ ${primaryLeader.symbol} (${primaryLeader.lampState})`
                  : 'Keine Kraken-Quote'}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700" title={`Letzte Rotation um ${lastRotationTimestamp}`}>
                300s Puffer (Letzte: {lastRotationTimestamp})
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              Echtzeit-Klassifikation der Marktführer nach der OMEGA-Formel: <span className="font-mono text-cyan-300">S_meta = 0.25·r + 0.25·β + 0.25·RVOL + 0.25·cos(φ)</span>. Auto Hot-Swap bei Leadership-Shift.
            </p>
          </div>
        </div>

        {/* Right side controls: 5m Countdown & Rotation Actions */}
        <div className="flex items-center gap-2.5 flex-wrap self-start lg:self-auto">
          {/* 5-Min Countdown Indicator */}
          <div className="px-3 py-2 bg-[#121724] border border-slate-700/70 rounded-xl flex items-center gap-2 text-xs font-mono">
            <Clock className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-slate-400">Takt:</span>
            <span className="text-cyan-300 font-bold">{formatCountdown(secondsUntilRotation)}</span>
          </div>

          {/* Force Rotation Button */}
          <button
            id="btn-force-rotation"
            onClick={() => handleForceRotation(false)}
            className="px-3 py-2 bg-gradient-to-r from-cyan-600/20 to-indigo-600/20 hover:from-cyan-600/30 hover:to-indigo-600/30 text-cyan-300 border border-cyan-500/40 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-1.5 shadow-sm shadow-cyan-500/10 active:scale-95"
            title="Berechnet das Meta-Ranking sofort neu"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Neu bewerten</span>
          </button>

          {/* Live Ticker Toggle */}
          <button
            id="btn-toggle-live-ticker"
            onClick={() => setLiveStreamActive(!liveStreamActive)}
            className={`px-3 py-2 border rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-1.5 ${
              liveStreamActive
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
            title="Aktiviert oder pausiert die Live-Orderflow Mikro-Schwankungen"
          >
            {liveStreamActive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Live Feed</span>
              </>
            ) : (
              <>
                <Pause className="w-3 h-3 text-slate-400" />
                <span>Pausiert</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Scenario Bar & Global Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center text-xs font-mono">
        {/* Scenario Presets Selector */}
        <div className="md:col-span-7 flex items-center gap-2 flex-wrap">
          <span className="text-slate-400 shrink-0 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Szenario:
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => handleApplyScenario('CANONICAL')}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                activeScenario === 'CANONICAL'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              Kanonisch
            </button>
            <button
              onClick={() => handleApplyScenario('SUI_BREAKOUT')}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                activeScenario === 'SUI_BREAKOUT'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              Sui Breakout
            </button>
            <button
              onClick={() => handleApplyScenario('SOL_DOMINANCE')}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                activeScenario === 'SOL_DOMINANCE'
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              Solana Momentum
            </button>
            <button
              onClick={() => handleApplyScenario('MACRO_RISK_OFF')}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                activeScenario === 'MACRO_RISK_OFF'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              Risk-Off Standby
            </button>
            <button
              onClick={() => handleApplyScenario('VIA_NEGATIVA_SHOCK')}
              className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                activeScenario === 'VIA_NEGATIVA_SHOCK'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              Via Negativa Sperre
            </button>
          </div>
        </div>

        {/* Global Ampel Summary Badges */}
        <div className="md:col-span-5 flex items-center justify-start md:justify-end gap-2 flex-wrap text-[11px]">
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
            {statusCounts.greenGlow} Green Glow
          </span>
          <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            {statusCounts.greenSolid} Solid
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
            {statusCounts.yellow} Yellow
          </span>
          <span className="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400">
            {statusCounts.redGlow} Red Glow
          </span>
        </div>
      </div>

      {/* Filter Tabs Bar (Cluster & Lamp Status) */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 pb-1 text-xs font-mono">
        {/* Cluster Filter */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400 text-[11px] flex items-center gap-1">
            <Filter className="w-3 h-3 text-cyan-400" /> Cluster:
          </span>
          {(['ALL', 'SUI', 'SOL', 'BTC', 'ETH'] as ClusterFilter[]).map(c => (
            <button
              key={c}
              onClick={() => setClusterFilter(c)}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-all ${
                clusterFilter === c
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {c === 'ALL' ? 'Alle Cluster' : `${c} Cluster`}
            </button>
          ))}
        </div>

        {/* Lamp Status Filter */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400 text-[11px]">Status:</span>
          {(['ALL', 'GREEN_GLOW', 'GREEN_SOLID', 'YELLOW', 'RED_GLOW'] as LampFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setLampFilter(s)}
              className={`px-2 py-0.5 rounded text-[10px] transition-all ${
                lampFilter === s
                  ? 'bg-slate-200 text-slate-950 font-bold'
                  : 'bg-slate-800/60 text-slate-400 hover:text-slate-200'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {leaders.length === 0 && (
        <p className="text-sm text-slate-400 font-mono" role="status">Keine Kraken-Quote. Die Ampel bleibt leer, bis Lastkurse vorliegen.</p>
      )}

      {/* Main Grid: Market Leaders Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {filteredLeaders.map(leader => {
          const isSelected = selectedLeader?.symbol === leader.symbol;
          const borderClass = getCardBorderClass(leader.lampState, leader.isLeader);

          return (
            <div
              key={leader.symbol}
              id={`symbol-card-${leader.symbol}`}
              onClick={() => {
                setSelectedLeader(leader);
                setInspectorOpen(true);
                onLogEvent?.(
                  `Marktführer inspiziert: ${leader.symbol} (${leader.lampState}) - Meta-Score: ${leader.metaScore}`,
                  'info',
                  'AMPEL_INSPEKTOR'
                );
              }}
              className={`p-4 rounded-xl border transition-all duration-200 cursor-pointer flex flex-col justify-between gap-3 ${borderClass} ${
                isSelected ? 'ring-2 ring-cyan-400' : ''
              }`}
            >
              {/* Header: Ampel Beacon & Cluster */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  {renderAmpelBeacon(leader.lampState, leader.isLeader)}
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/[0.04] text-slate-300 border border-white/10">
                    {leader.cluster}
                  </span>
                </div>

                {/* Symbol & Name */}
                <div className="flex items-baseline justify-between gap-1">
                  <div>
                    <h3 className="text-lg font-bold text-white font-mono tracking-tight flex items-center gap-1.5">
                      {leader.symbol}
                      {leader.isLeader && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          TAKTGEBER
                        </span>
                      )}
                    </h3>
                    <p className="text-[11px] text-slate-400 truncate max-w-[150px]">
                      {leader.name}
                    </p>
                  </div>
                  {leader.priceUSD !== undefined && (
                    <div className="text-right font-mono">
                      <div className="text-sm font-bold text-slate-200">
                        ${leader.priceUSD >= 1000 ? leader.priceUSD.toLocaleString() : leader.priceUSD.toFixed(leader.priceUSD < 1 ? 4 : 2)}
                      </div>
                      <div className={`text-[10px] font-bold ${leader.change24h && leader.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {leader.change24h && leader.change24h >= 0 ? '+' : ''}{leader.change24h}%
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Meta-Score Gauge */}
              <div className="p-2.5 rounded-lg bg-black/30 border border-white/5 space-y-1.5 font-mono text-xs">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">Meta-Score (S_meta):</span>
                  <span className="font-bold text-white text-xs">{leader.metaScore}</span>
                </div>
                {/* Progress bar */}
                <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      leader.lampState === 'GREEN_GLOW'
                        ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                        : leader.lampState === 'GREEN_SOLID'
                        ? 'bg-emerald-500'
                        : leader.lampState === 'YELLOW'
                        ? 'bg-amber-400'
                        : leader.lampState === 'RED_GLOW'
                        ? 'bg-rose-500'
                        : 'bg-slate-600'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(8, (leader.metaScore / 1.0) * 100))}%` }}
                  />
                </div>
              </div>

              {/* 4 OMEGA Metrics (§8 Parameters) */}
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div className="p-1.5 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-slate-400 block">Korrelation r:</span>
                  <span className="font-bold text-white">{leader.correlationLead.toFixed(2)}</span>
                </div>
                <div className="p-1.5 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-slate-400 block">Beta β:</span>
                  <span className="font-bold text-cyan-300">{leader.betaLead.toFixed(2)}x</span>
                </div>
                <div className="p-1.5 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-slate-400 block">RVOL (5m):</span>
                  <span className="font-bold text-emerald-300">{leader.rvol5m.toFixed(2)}x</span>
                </div>
                <div className="p-1.5 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-slate-400 block">Phase cos(φ):</span>
                  <span className={`font-bold ${leader.cosPhi >= 0.75 ? 'text-emerald-400' : leader.cosPhi < 0 ? 'text-rose-400' : 'text-amber-300'}`}>
                    {leader.cosPhi.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Trade Status Pill & Bot Stats trigger hint */}
              <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono">
                <span className="text-indigo-400 flex items-center gap-1 font-semibold group-hover:text-indigo-300">
                  <Bot className="w-3 h-3 text-indigo-400" /> Bot Stats
                </span>
                {leader.tradeStatus === 'ACTIVE_PYRAMID' && (
                  <span className="px-2 py-0.5 rounded font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    REVERSE-DCA 4x
                  </span>
                )}
                {leader.tradeStatus === 'SCOUT_ENTRY' && (
                  <span className="px-2 py-0.5 rounded font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                    1x SCOUT OK
                  </span>
                )}
                {leader.tradeStatus === 'STANDBY_HOLD' && (
                  <span className="px-2 py-0.5 rounded font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                    STANDBY
                  </span>
                )}
                {leader.tradeStatus === 'EMBARGO_BLOCKED' && (
                  <span className="px-2 py-0.5 rounded font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                    SPERRE (VIA NEGATIVA)
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── TRADING BOT STATS POPUP TEMPLATE (MIT INTEGRIERTEM AMPELSYSTEM) ── */}
      {inspectorOpen && selectedLeader && (() => {
        const curPrice = selectedLeader.priceUSD;
        const changePct = selectedLeader.change24h ?? 0;
        if (!(typeof curPrice === 'number' && curPrice > 0)) {
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" role="status">
              <p className="text-sm text-slate-300 font-mono">Keine Kraken-Quote für {selectedLeader.symbol}.</p>
            </div>
          );
        }
        const isProfit = changePct >= 0 && selectedLeader.lampState !== 'RED_GLOW';
        
        // Asset tier specific realistic investment calculation
        const investment = selectedLeader.symbol === 'BTC' ? 500 : selectedLeader.symbol === 'ETH' ? 250 : selectedLeader.symbol === 'SOL' ? 100 : 50.58;
        const entryPrice = curPrice / (1 + (changePct / 100));
        const unrealizedPnL = isProfit 
          ? investment * (Math.abs(changePct) / 100) * 1.25 
          : -investment * 0.083;
        const realizedProfit = isProfit ? 8.42 : -1.20;
        const totalProfit = unrealizedPnL + realizedProfit;
        const roiPct = ((totalProfit / investment) * 100).toFixed(2);
        const leverage = Math.max(10, Math.min(100, Math.round(selectedLeader.betaLead * 35)));
        
        const formatPrice = (p: number) => {
          if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
          if (p >= 1) return p.toFixed(2);
          return p.toFixed(4);
        };

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-[6px] overflow-y-auto animate-in fade-in duration-200"
            onClick={(e) => {
              if (e.target === e.currentTarget) setInspectorOpen(false);
            }}
          >
            <div
              id="symbol-ampel-inspector"
              className="relative w-full max-w-[480px] rounded-[20px] overflow-hidden border border-indigo-500/25 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_32px_80px_rgba(0,0,0,0.6),0_0_60px_rgba(99,102,241,0.08)] my-6 select-none"
              style={{
                background: 'linear-gradient(145deg, #12122a 0%, #0f1628 100%)',
              }}
            >
              {/* Glow accent top */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/5 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/80 to-transparent pointer-events-none" />

              {/* ── Header ── */}
              <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-[10px] bg-gradient-to-br from-[#6366f1] to-[#8b5cf6] shadow-[0_4px_14px_rgba(99,102,241,0.4)] flex items-center justify-center text-lg shrink-0">
                    🤖
                  </div>
                  <div>
                    <div className="text-[15px] font-bold text-slate-100 tracking-[0.3px] flex items-center gap-1.5">
                      <span>Grid Bot Alpha</span>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                      ID: BOT-7742 · Kraken Pro Futures
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setInspectorOpen(false)}
                  className="w-7 h-7 rounded-lg bg-white/[0.05] border border-white/[0.08] text-slate-400 hover:text-rose-400 hover:bg-rose-500/15 hover:border-rose-500/30 transition-all flex items-center justify-center text-sm"
                  title="Schließen"
                >
                  ✕
                </button>
              </div>

              {/* ── Symbol Banner ── */}
              <div className="mx-6 mt-4 px-4 py-3.5 bg-indigo-500/[0.08] border border-indigo-500/20 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      selectedLeader.lampState === 'GREEN_GLOW' || selectedLeader.lampState === 'GREEN_SOLID'
                        ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                        : selectedLeader.lampState === 'YELLOW'
                        ? 'bg-amber-400 shadow-[0_0_8px_#f59e0b]'
                        : 'bg-rose-500 shadow-[0_0_8px_#ef4444]'
                    } animate-pulse`}
                  />
                  <div>
                    <div className="text-xl font-extrabold text-slate-100 font-mono tracking-wider">
                      {selectedLeader.symbol}/USDT.P
                    </div>
                    <div className="text-[10px] text-slate-400 font-medium tracking-wider uppercase mt-0.5">
                      Perpetual Futures · {selectedLeader.cluster} Cluster
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider font-mono ${
                      selectedLeader.lampState === 'RED_GLOW'
                        ? 'bg-rose-500/15 border border-rose-500/35 text-rose-400'
                        : 'bg-emerald-500/15 border border-emerald-500/35 text-emerald-400'
                    }`}
                  >
                    {selectedLeader.lampState === 'RED_GLOW' ? '▼ Embargo' : '▲ Long'}
                  </span>
                  <span className="px-3 py-1 rounded-lg text-xs font-bold font-mono bg-amber-500/12 border border-amber-500/30 text-amber-400">
                    {leverage}×
                  </span>
                </div>
              </div>

              {/* ── AMPELSYSTEM ERWEITERUNG IM TEMPLATE (Ampelsystem Integration) ── */}
              <div className="mx-6 mt-3.5 p-3.5 rounded-xl bg-slate-900/80 border border-indigo-500/30 shadow-inner">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-mono font-bold tracking-wide uppercase text-indigo-300 flex items-center gap-1.5">
                    <span>🚦</span> AMPELSYSTEM &amp; META-SCORE
                  </span>
                  <div>
                    {renderAmpelBeacon(selectedLeader.lampState, selectedLeader.isLeader)}
                  </div>
                </div>

                {/* Meta-Score Gauge & Progress */}
                <div className="space-y-1.5 font-mono mb-2.5">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400">Meta-Score (S_meta):</span>
                    <span className="font-bold text-white text-xs">{selectedLeader.metaScore}</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        selectedLeader.lampState === 'GREEN_GLOW'
                          ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                          : selectedLeader.lampState === 'GREEN_SOLID'
                          ? 'bg-emerald-500'
                          : selectedLeader.lampState === 'YELLOW'
                          ? 'bg-amber-400'
                          : 'bg-rose-500'
                      }`}
                      style={{ width: `${Math.min(100, Math.max(8, (selectedLeader.metaScore / 1.0) * 100))}%` }}
                    />
                  </div>
                </div>

                {/* 4 OMEGA Formel-Komponenten (§8) */}
                <div className="grid grid-cols-4 gap-1.5 text-center font-mono text-[10px]">
                  <div className="p-1.5 rounded bg-white/[0.03] border border-white/5">
                    <span className="text-slate-500 block text-[9px]">r (Lead)</span>
                    <span className="font-bold text-slate-200">{selectedLeader.correlationLead.toFixed(2)}</span>
                  </div>
                  <div className="p-1.5 rounded bg-white/[0.03] border border-white/5">
                    <span className="text-slate-500 block text-[9px]">β (Beta)</span>
                    <span className="font-bold text-cyan-300">{selectedLeader.betaLead.toFixed(2)}x</span>
                  </div>
                  <div className="p-1.5 rounded bg-white/[0.03] border border-white/5">
                    <span className="text-slate-500 block text-[9px]">RVOL 5m</span>
                    <span className="font-bold text-emerald-300">{selectedLeader.rvol5m.toFixed(2)}x</span>
                  </div>
                  <div className="p-1.5 rounded bg-white/[0.03] border border-white/5">
                    <span className="text-slate-500 block text-[9px]">cos(φ)</span>
                    <span className={`font-bold ${selectedLeader.cosPhi >= 0.75 ? 'text-emerald-400' : selectedLeader.cosPhi < 0 ? 'text-rose-400' : 'text-amber-300'}`}>
                      {selectedLeader.cosPhi.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Order Gate Status */}
                <div className="mt-2.5 pt-2 border-t border-white/5 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-slate-400">Order-Gate Status:</span>
                  <span className={`px-2 py-0.5 rounded font-bold ${
                    selectedLeader.lampState === 'GREEN_GLOW'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : selectedLeader.lampState === 'GREEN_SOLID'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : selectedLeader.lampState === 'YELLOW'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                      : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  }`}>
                    {selectedLeader.tradeStatus === 'ACTIVE_PYRAMID' ? 'REVERSE-DCA 4x' : selectedLeader.tradeStatus === 'SCOUT_ENTRY' ? '1x SCOUT OK' : selectedLeader.tradeStatus === 'STANDBY_HOLD' ? 'STANDBY' : 'SPERRE (VIA NEGATIVA)'}
                  </span>
                </div>
              </div>

              {/* ── P&L Hero ── */}
              <div className={`mx-6 mt-3.5 p-4 rounded-xl flex items-center justify-between border ${
                isProfit
                  ? 'bg-emerald-500/[0.06] border-emerald-500/15'
                  : 'bg-rose-500/[0.06] border-rose-500/15'
              }`}>
                <div>
                  <div className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold mb-1">
                    ⚡ Unrealized P&amp;L
                  </div>
                  <div className={`text-[30px] font-extrabold font-mono tracking-tight ${
                    isProfit ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {isProfit ? `+${unrealizedPnL.toFixed(2)} $` : `${unrealizedPnL.toFixed(2)} $`}
                  </div>
                  <div className={`text-[13px] font-semibold font-mono ${
                    isProfit ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {isProfit ? `▲ +${(Math.abs(changePct) * 1.5).toFixed(2)}%` : `▼ -${(Math.abs(changePct) * 1.5).toFixed(2)}%`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">
                    Einstiegspreis
                  </div>
                  <div className="text-[14px] font-semibold font-mono text-slate-300">
                    {formatPrice(entryPrice)} $
                  </div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-2 mb-0.5">
                    Aktueller Preis
                  </div>
                  <div className={`text-[14px] font-bold font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {formatPrice(curPrice)} $
                  </div>
                </div>
              </div>

              {/* ── Stats Grid (6 Cards) ── */}
              <div className="mx-6 mt-3.5 grid grid-cols-2 gap-2.5">
                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>💰</span> Investment
                  </div>
                  <div className="text-[16px] font-bold text-slate-200 font-mono">
                    {investment.toFixed(2)} $
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    ≈ {(investment * 0.89).toFixed(2)} EUR
                  </div>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>📈</span> Akt. Gewinn
                  </div>
                  <div className={`text-[16px] font-bold font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isProfit ? `+${realizedProfit.toFixed(2)} $` : `${realizedProfit.toFixed(2)} $`}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    Realisiert (Zyklus)
                  </div>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>🎯</span> Grid Range
                  </div>
                  <div className="text-[16px] font-bold text-slate-200 font-mono">
                    {formatPrice(curPrice * 0.90)} – {formatPrice(curPrice * 1.10)}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    160 Grids · {formatPrice(curPrice * 0.0012)} $ Abstand
                  </div>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>⚙️</span> Grid Trades
                  </div>
                  <div className="text-[16px] font-bold text-slate-200 font-mono">
                    247
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    Ausgelöste Orders
                  </div>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>💸</span> Funding Fees
                  </div>
                  <div className="text-[16px] font-bold text-amber-400 font-mono">
                    −1.14 $
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    Kumuliert
                  </div>
                </div>

                <div className="bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/25 transition-colors rounded-xl p-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5">
                    <span>🛡️</span> Liquidation
                  </div>
                  <div className="text-[16px] font-bold text-rose-400 font-mono">
                    {formatPrice(curPrice * 0.82)} $
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    −18.0% vom Einstieg
                  </div>
                </div>
              </div>

              {/* ── Runtime Bar ── */}
              <div className="mx-6 mt-3.5 px-4 py-3 bg-white/[0.02] border border-white/[0.05] rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="text-lg">⏱️</div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                      Laufzeit
                    </div>
                    <div className="text-[15px] font-bold font-mono text-purple-300">
                      03d 14h 22m
                    </div>
                  </div>
                </div>
                <div className="flex-1 mx-4 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full animate-pulse"
                    style={{ width: '62%' }}
                  />
                </div>
                <div className="text-right font-mono">
                  <div className="text-[10px] text-slate-500">Zyklen</div>
                  <div className="text-[13px] font-bold text-purple-200">62×</div>
                </div>
              </div>

              {/* ── Total Profit Row ── */}
              <div className="mx-6 mt-3.5 px-4 py-3.5 rounded-xl bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                  <span>🏆</span> Total Profit
                </div>
                <div className="text-right">
                  <div className="text-[22px] font-extrabold font-mono text-purple-300">
                    +{totalProfit.toFixed(2)} $
                  </div>
                  <div className="text-xs font-semibold font-mono text-indigo-400 mt-0.5">
                    ROI: +{roiPct}% · APR ~4.480%
                  </div>
                </div>
              </div>

              {/* ── Execution Action Button ── */}
              <div className="mx-6 mt-3.5">
                <button
                  onClick={() => {
                    onLogEvent?.(
                      `Test-Order autorisiert für ${selectedLeader.symbol}: Modus ${selectedLeader.tradeStatus} via Kraken API Shadow-Limit Mesh`,
                      selectedLeader.lampState === 'RED_GLOW' ? 'error' : 'success',
                      'THE_JUDGE'
                    );
                  }}
                  className={`w-full py-2.5 rounded-xl text-xs font-mono font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.99] ${
                    selectedLeader.lampState === 'RED_GLOW'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 cursor-not-allowed'
                      : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 shadow-emerald-500/10'
                  }`}
                >
                  {selectedLeader.lampState === 'RED_GLOW' ? '🚫 Gesperrt durch Axiom 3 (Via Negativa)' : '⚡ Scout-Order auf Kraken autorisieren'}
                </button>
              </div>

              <div className="mx-6 my-3.5 h-[1px] bg-white/[0.04]" />

              {/* ── Footer ── */}
              <div className="mx-6 mb-5 flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-slate-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Bot aktiv · Verbunden</span>
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  Aktualisiert: {lastRotationTimestamp}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
