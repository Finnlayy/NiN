import { useState } from 'react';
import {
  Zap,
  Clock,
  Trophy,
  X,
  Play,
  Pause,
  RotateCw,
  Sliders,
  Bot as BotIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { TradingBot } from '../types';

interface BotTelemetryCardProps {
  bot: TradingBot;
  onClose?: (botId: string) => void;
  onToggleStatus?: (botId: string, newStatus: 'ACTIVE' | 'PAUSED' | 'STOPPED') => void;
  onTriggerCycle?: (botId: string) => void;
  compact?: boolean;
  className?: string;
}

export default function BotTelemetryCard({
  bot,
  onClose,
  onToggleStatus,
  onTriggerCycle,
  compact: _compact = false,
  className = ''
}: BotTelemetryCardProps) {
  const [showControls, setShowControls] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);

  const isLong = bot.direction === 'LONG';
  const isPositivePnl = bot.unrealizedPnlUsd >= 0;
  const isPositiveTotal = bot.totalProfitUsd >= 0;
  const isActive = bot.status === 'ACTIVE';
  const isPaused = bot.status === 'PAUSED';

  const handleManualTrigger = async () => {
    if (isTriggering || !onTriggerCycle) return;
    setIsTriggering(true);
    try {
      await onTriggerCycle(bot.id);
    } finally {
      setTimeout(() => setIsTriggering(false), 500);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.25 }}
      className={`w-full max-w-[420px] bg-[#0c101c]/95 border ${
        isActive 
          ? 'border-slate-800/90 shadow-[0_4px_25px_rgba(0,0,0,0.6)] hover:border-slate-700' 
          : isPaused
          ? 'border-amber-500/40 bg-[#14120e]/95'
          : 'border-red-500/30 bg-[#160c10]/95 opacity-70'
      } rounded-2xl p-4 sm:p-5 backdrop-blur-xl relative overflow-hidden font-sans select-none flex flex-col gap-3.5 transition-all ${className}`}
    >
      {/* Top Ambient Glow Gradient */}
      <div 
        className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
          isLong ? 'from-emerald-500 via-cyan-500 to-purple-600' : 'from-rose-500 via-amber-500 to-purple-600'
        }`} 
      />

      {/* 1. Header: Bot Avatar, Name, ID/Venue, Close Button */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-3 min-w-0">
          {/* Bot Avatar Icon */}
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500/20 via-purple-500/25 to-purple-700/30 border border-purple-500/40 flex items-center justify-center text-purple-300 shadow-inner shrink-0 relative">
            <BotIcon className="w-6 h-6 text-purple-300 drop-shadow-[0_0_6px_rgba(168,85,247,0.4)]" />
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#0c101c]" />
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-bold text-white tracking-tight truncate leading-tight flex items-center gap-1.5">
              <span>{bot.name}</span>
            </h3>
            <p className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
              ID: <span className="text-slate-300">{bot.id}</span> · <span className="text-purple-300">{bot.venue}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setShowControls(!showControls)}
            title="Einstellungen & Aktionen"
            className="w-7 h-7 rounded-lg bg-slate-800/60 hover:bg-slate-700/80 border border-slate-700/50 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button
              onClick={() => onClose(bot.id)}
              title="Widget schließen"
              className="w-7 h-7 rounded-lg bg-slate-800/60 hover:bg-slate-700/80 border border-slate-700/50 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Quick Controls Drawer */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-2.5 rounded-xl bg-[#080c14] border border-slate-800 flex items-center justify-between gap-2 text-xs font-mono">
              <span className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Aktionen:</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleManualTrigger}
                  disabled={isTriggering || !isActive}
                  className="px-2.5 py-1 rounded bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/40 flex items-center gap-1 text-[11px] font-bold disabled:opacity-40 transition-colors"
                >
                  <RotateCw className={`w-3 h-3 ${isTriggering ? 'animate-spin' : ''}`} />
                  Order/Zyklus
                </button>
                <button
                  onClick={() => onToggleStatus?.(bot.id, isActive ? 'PAUSED' : 'ACTIVE')}
                  className={`px-2.5 py-1 rounded border flex items-center gap-1 text-[11px] font-bold transition-colors ${
                    isActive 
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                      : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                  }`}
                >
                  {isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {isActive ? 'Pause' : 'Fortsetzen'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 2. Pair / Strategy Banner with Badges */}
      <div className="p-2.5 sm:p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                isActive ? 'bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                isActive ? 'bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-red-400'
              }`} />
            </span>
            <span className="text-sm font-bold text-white font-mono tracking-wide truncate">
              {bot.pair}
            </span>
          </div>
          <p className="text-[9px] font-mono text-slate-400 tracking-wider uppercase mt-0.5 truncate">
            {bot.strategy}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Direction Badge */}
          <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wider font-mono flex items-center gap-1 border ${
            isLong 
              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400' 
              : 'bg-rose-950/60 border-rose-500/40 text-rose-400'
          }`}>
            {isLong ? '▲ LONG' : '▼ SHORT'}
          </span>

          {/* Leverage Badge */}
          <span className="px-2.5 py-1 rounded-md bg-purple-950/60 border border-purple-500/40 text-purple-300 text-[11px] font-bold font-mono tracking-wider">
            {bot.leverage}×
          </span>
        </div>
      </div>

      {/* 3. Hero Unrealized P&L Card */}
      <div className="p-3.5 sm:p-4 rounded-xl bg-[#080c14] border border-slate-800/90 flex items-center justify-between gap-3">
        {/* Left: Unrealized P&L */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-slate-400">
            <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" />
            <span>UNREALIZED P&amp;L</span>
          </div>

          <div className="mt-1 flex items-baseline gap-1.5 flex-wrap">
            <span className={`text-2xl sm:text-3xl font-extrabold font-mono tracking-tight ${
              isPositivePnl 
                ? 'text-[#10b981] drop-shadow-[0_0_12px_rgba(16,185,129,0.35)]' 
                : 'text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.35)]'
            }`}>
              {isPositivePnl ? '+' : ''}{bot.unrealizedPnlUsd.toFixed(2)} $
            </span>
          </div>

          <div className={`flex items-center gap-1 text-xs font-bold font-mono mt-0.5 ${
            isPositivePnl ? 'text-emerald-400' : 'text-rose-400'
          }`}>
            <span>{isPositivePnl ? '▲' : '▼'}</span>
            <span>{isPositivePnl ? '+' : ''}{bot.unrealizedPnlPercent.toFixed(2)}%</span>
          </div>
        </div>

        {/* Right: Einstiegspreis & Aktueller Preis */}
        <div className="text-right shrink-0 font-mono">
          <div>
            <div className="text-[9px] text-slate-400 uppercase font-semibold tracking-wider">
              EINSTIEGSPREIS
            </div>
            <div className="text-xs sm:text-sm font-bold text-slate-200 mt-0.5">
              {bot.entryPrice.toLocaleString('en-US', { minimumFractionDigits: bot.entryPrice > 100 ? 2 : 3 })} $
            </div>
          </div>

          <div className="mt-2">
            <div className="text-[9px] text-slate-400 uppercase font-semibold tracking-wider">
              AKTUELLER PREIS
            </div>
            <div className="text-xs sm:text-sm font-bold text-emerald-400 mt-0.5">
              {bot.currentPrice.toLocaleString('en-US', { minimumFractionDigits: bot.currentPrice > 100 ? 2 : 3 })} $
            </div>
          </div>
        </div>
      </div>

      {/* 4. 6-Box Metrics Grid */}
      <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
        {/* Card 1: Investment */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-amber-400 uppercase tracking-wider font-mono">
            <span>💰</span>
            <span>INVESTMENT</span>
          </div>
          <div className="text-sm font-bold font-mono text-white">
            {bot.investmentUsd.toFixed(2)} $
          </div>
          <div className="text-[10px] font-mono text-slate-400">
            {bot.investmentEur.toFixed(2)} EUR
          </div>
        </div>

        {/* Card 2: Akt. Gewinn */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400 uppercase tracking-wider font-mono">
            <span>📈</span>
            <span>AKT. GEWINN</span>
          </div>
          <div className="text-sm font-bold font-mono text-emerald-400">
            +{bot.realizedProfitUsd.toFixed(2)} $
          </div>
          <div className="text-[10px] font-mono text-slate-400 truncate">
            {bot.realizedProfitLabel || 'Realisiert (Zyklus)'}
          </div>
        </div>

        {/* Card 3: DCA Range */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-rose-400 uppercase tracking-wider font-mono">
            <span>🎯</span>
            <span>DCA RANGE</span>
          </div>
          <div className="text-sm font-bold font-mono text-white">
            {bot.dcaRangeMin} – {bot.dcaRangeMax}
          </div>
          <div className="text-[10px] font-mono text-slate-400 uppercase">
            {bot.dcaLevels} DCA-STUFEN
          </div>
        </div>

        {/* Card 4: DCA Orders */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-cyan-400 uppercase tracking-wider font-mono">
            <span>⚙️</span>
            <span>DCA ORDERS</span>
          </div>
          <div className="text-sm font-bold font-mono text-white">
            {bot.dcaOrdersTriggered}
          </div>
          <div className="text-[10px] font-mono text-slate-400">
            Ausgelöste Käufe
          </div>
        </div>

        {/* Card 5: Funding Fees */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400 uppercase tracking-wider font-mono">
            <span>💸</span>
            <span>FUNDING FEES</span>
          </div>
          <div className="text-sm font-bold font-mono text-amber-400">
            {bot.fundingFeesUsd > 0 ? '+' : ''}{bot.fundingFeesUsd.toFixed(2)} $
          </div>
          <div className="text-[10px] font-mono text-slate-400">
            Kumuliert
          </div>
        </div>

        {/* Card 6: Liquidation */}
        <div className="p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-cyan-400 uppercase tracking-wider font-mono">
            <span>🛡️</span>
            <span>LIQUIDATION</span>
          </div>
          <div className="text-sm font-bold font-mono text-rose-400">
            {bot.liquidationPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })} $
          </div>
          <div className="text-[10px] font-mono text-slate-400">
            {bot.liquidationDistancePercent > 0 ? '+' : ''}{bot.liquidationDistancePercent.toFixed(2)}% vom Einstieg
          </div>
        </div>
      </div>

      {/* 5. Runtime & Cycle Bar */}
      <div className="p-2.5 sm:p-3 rounded-xl bg-[#090d16] border border-slate-800/80 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          <div>
            <div className="text-[9px] font-mono text-slate-400 uppercase tracking-wider">
              LAUFZEIT
            </div>
            <div className="text-xs sm:text-sm font-bold font-mono text-white">
              {bot.runtimeDisplay}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="flex-1 max-w-[120px] sm:max-w-[140px] px-1">
          <div className="w-full h-1.5 bg-slate-800/80 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-500" 
              style={{ width: `${Math.min(100, Math.max(10, bot.cycleProgressPercent))}%` }} 
            />
          </div>
        </div>

        <div className="text-right">
          <div className="text-[9px] font-mono text-slate-400 uppercase tracking-wider">
            Zyklen
          </div>
          <div className="text-xs sm:text-sm font-bold font-mono text-purple-400">
            {bot.cycles}×
          </div>
        </div>
      </div>

      {/* 6. Total Profit Hero Banner */}
      <div className="p-3 sm:p-3.5 rounded-xl bg-gradient-to-r from-[#0d1020] via-[#101428] to-[#120f26] border border-purple-900/40 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-300 font-mono uppercase tracking-wider">
          <Trophy className="w-4 h-4 text-amber-400 shrink-0" />
          <span>TOTAL PROFIT</span>
        </div>

        <div className="text-right font-mono">
          <div className={`text-xl font-bold tracking-tight ${
            isPositiveTotal 
              ? 'text-purple-400 drop-shadow-[0_0_10px_rgba(192,132,252,0.3)]' 
              : 'text-rose-400'
          }`}>
            {isPositiveTotal ? '+' : ''}{bot.totalProfitUsd.toFixed(2)} $
          </div>
          <div className="text-[10px] text-purple-300/80 mt-0.5">
            ROI: <span className="font-bold text-purple-200">+{bot.roiPercent.toFixed(2)}%</span> · APR <span className="font-bold text-purple-200">+{bot.aprPercent.toLocaleString()}%</span>
          </div>
        </div>
      </div>

      {/* 7. Footer Status Bar */}
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${
            isActive ? 'bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-red-400'
          }`} />
          <span className={isActive ? 'text-emerald-400 font-medium' : isPaused ? 'text-amber-400' : 'text-red-400'}>
            {isActive ? 'Bot aktiv · Verbunden' : isPaused ? 'Bot pausiert' : 'Bot gestoppt'}
          </span>
        </div>

        <div className="text-slate-400">
          Aktualisiert: <span className="text-slate-300">{bot.lastUpdated}</span>
        </div>
      </div>
    </motion.div>
  );
}
