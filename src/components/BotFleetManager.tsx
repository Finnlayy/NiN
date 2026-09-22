import { useState, useEffect, useCallback } from 'react';
import {
  Bot as BotIcon,
  Plus,
  RefreshCw,
  Search
} from 'lucide-react';
import { TradingBot } from '../types';
import BotTelemetryCard from './BotTelemetryCard';
import CreateBotModal from './CreateBotModal';

interface BotFleetManagerProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

export default function BotFleetManager({ onLogEvent, className = '' }: BotFleetManagerProps) {
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'PAUSED' | 'STOPPED'>('ALL');

  // Fetch Bots from Backend
  const fetchBots = useCallback(async (showIndicator = false) => {
    if (showIndicator) setIsRefreshing(true);
    try {
      const res = await fetch('/api/bots');
      if (res.ok) {
        const data: TradingBot[] = await res.json();
        setBots(data);
      }
    } catch (e) {
      console.error('Failed to fetch bots:', e);
    } finally {
      setIsLoading(false);
      if (showIndicator) setIsRefreshing(false);
    }
  }, []);

  // Initial fetch and 4-second live cycle polling
  useEffect(() => {
    fetchBots();
    const interval = setInterval(() => {
      fetchBots(false);
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchBots]);

  // Create Bot
  const handleCreateBot = async (botData: Partial<TradingBot> & { name: string; pair: string }) => {
    try {
      const res = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botData),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Fehler beim Erstellen des Bots.');
      }

      const newBot: TradingBot = await res.json();
      setBots(prev => [newBot, ...prev]);
      onLogEvent?.(
        `[BOT-FLEET] Neuer Bot '${newBot.name}' (${newBot.pair}, ${newBot.leverage}x ${newBot.direction}) initialisiert. Telemetrie-Widget aktiv.`,
        'success',
        'Bot Manager'
      );
    } catch (error) {
      onLogEvent?.(
        `[BOT-FLEET] Fehler bei Bot-Initialisierung: ${String(error)}`,
        'error',
        'Bot Manager'
      );
      throw error;
    }
  };

  // Toggle Bot Status
  const handleToggleStatus = async (botId: string, newStatus: 'ACTIVE' | 'PAUSED' | 'STOPPED') => {
    try {
      const res = await fetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        const updated: TradingBot = await res.json();
        setBots(prev => prev.map(b => b.id === botId ? updated : b));
        onLogEvent?.(
          `[BOT-FLEET] Bot '${updated.name}' Status auf '${newStatus}' gesetzt.`,
          newStatus === 'ACTIVE' ? 'success' : 'warn',
          'Bot Manager'
        );
      }
    } catch (e) {
      console.error('Failed to toggle bot status:', e);
    }
  };

  // Trigger Cycle
  const handleTriggerCycle = async (botId: string) => {
    try {
      const res = await fetch(`/api/bots/${botId}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) {
        const updated: TradingBot = await res.json();
        setBots(prev => prev.map(b => b.id === botId ? updated : b));
        onLogEvent?.(
          `[BOT-FLEET] Manueller DCA-Zyklus für '${updated.name}' ausgeführt. P&L: +${updated.unrealizedPnlUsd}$ (${updated.unrealizedPnlPercent}%).`,
          'info',
          'Bot Manager'
        );
      }
    } catch (e) {
      console.error('Failed to trigger bot cycle:', e);
    }
  };

  // Close/Delete Bot
  const handleDeleteBot = async (botId: string) => {
    const target = bots.find(b => b.id === botId);
    if (!target) return;

    try {
      const res = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
      if (res.ok) {
        setBots(prev => prev.filter(b => b.id !== botId));
        onLogEvent?.(
          `[BOT-FLEET] Bot-Widget '${target.name}' (${target.id}) geschlossen/beendet.`,
          'warn',
          'Bot Manager'
        );
      }
    } catch (e) {
      console.error('Failed to delete bot:', e);
    }
  };

  // Calculations for Fleet Header
  const activeBots = bots.filter(b => b.status === 'ACTIVE');
  const totalInvestment = bots.reduce((acc, b) => acc + b.investmentUsd, 0);
  const totalProfit = bots.reduce((acc, b) => acc + b.totalProfitUsd, 0);
  const totalUnrealized = bots.reduce((acc, b) => acc + b.unrealizedPnlUsd, 0);
  const avgRoi = bots.length > 0 ? (bots.reduce((acc, b) => acc + b.roiPercent, 0) / bots.length).toFixed(1) : '0.0';

  // Filtered bots
  const filteredBots = bots.filter(bot => {
    const matchesSearch = bot.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          bot.pair.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          bot.venue.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          bot.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || bot.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className={`space-y-6 ${className}`}>
      {/* 1. Fleet Stats & Action Header */}
      <div className="bg-[#0e1222] border border-slate-800/80 rounded-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-slate-800/70">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500/20 via-indigo-500/25 to-purple-600/30 border border-purple-500/30 flex items-center justify-center text-purple-300 shadow-inner">
              <BotIcon className="w-6 h-6 drop-shadow-[0_0_8px_rgba(168,85,247,0.4)]" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-bold text-white tracking-tight">
                  Aktive Bot-Flotte &amp; Telemetrie-Widgets
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-md">
                  {activeBots.length} AKTIV
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Echtzeit-Telemetrie, DCA-Stufen, Liquidation &amp; P&amp;L-Visualisierung für alle erstellten Bots.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={() => fetchBots(true)}
              disabled={isRefreshing}
              className="px-3.5 py-2 rounded-xl bg-slate-800/70 hover:bg-slate-700 text-slate-300 text-xs font-mono font-bold flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              Aktualisieren
            </button>

            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold font-sans shadow-lg shadow-purple-600/20 flex items-center gap-2 transition-all"
            >
              <Plus className="w-4 h-4" />
              Neuen Bot erstellen
            </button>
          </div>
        </div>

        {/* Aggregate Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-4">
          <div className="p-3 bg-[#090d16] border border-slate-800/80 rounded-xl">
            <div className="text-[10px] font-mono uppercase text-slate-400">Aktive Bots</div>
            <div className="text-xl font-bold font-mono text-white mt-0.5">
              {activeBots.length} <span className="text-xs text-slate-500">/ {bots.length} Gesamt</span>
            </div>
          </div>

          <div className="p-3 bg-[#090d16] border border-slate-800/80 rounded-xl">
            <div className="text-[10px] font-mono uppercase text-slate-400">Gesamt-Investition</div>
            <div className="text-xl font-bold font-mono text-white mt-0.5">
              {totalInvestment.toFixed(2)} $
            </div>
          </div>

          <div className="p-3 bg-[#090d16] border border-slate-800/80 rounded-xl">
            <div className="text-[10px] font-mono uppercase text-slate-400">Total Profit</div>
            <div className="text-xl font-bold font-mono text-purple-400 mt-0.5">
              +{totalProfit.toFixed(2)} $
            </div>
          </div>

          <div className="p-3 bg-[#090d16] border border-slate-800/80 rounded-xl">
            <div className="text-[10px] font-mono uppercase text-slate-400">Unrealized P&amp;L</div>
            <div className={`text-xl font-bold font-mono mt-0.5 ${totalUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {totalUnrealized >= 0 ? '+' : ''}{totalUnrealized.toFixed(2)} $
            </div>
          </div>

          <div className="p-3 bg-[#090d16] border border-slate-800/80 rounded-xl">
            <div className="text-[10px] font-mono uppercase text-slate-400">Durchschnittl. ROI</div>
            <div className="text-xl font-bold font-mono text-cyan-400 mt-0.5">
              +{avgRoi}%
            </div>
          </div>
        </div>
      </div>

      {/* 2. Filter & Search Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <div className="relative w-full">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Bot suchen nach Name, Pair, Börse..."
              className="w-full pl-9 pr-3 py-1.5 bg-[#0e1222] border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 bg-[#0e1222] p-1 border border-slate-800 rounded-xl text-xs font-mono">
          {(['ALL', 'ACTIVE', 'PAUSED', 'STOPPED'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === status
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {status === 'ALL' ? 'Alle' : status === 'ACTIVE' ? 'Aktiv' : status === 'PAUSED' ? 'Pausiert' : 'Gestoppt'}
            </button>
          ))}
        </div>
      </div>

      {/* 3. The Responsive Grid of Bot Widgets */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-400 font-mono text-sm bg-[#0e1222] border border-slate-800 rounded-2xl flex flex-col items-center justify-center gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-purple-400" />
          <span>Lade Bot-Telemetrie &amp; Widgets...</span>
        </div>
      ) : filteredBots.length === 0 ? (
        <div className="p-12 text-center text-slate-400 font-mono text-sm bg-[#0e1222] border border-slate-800 rounded-2xl flex flex-col items-center justify-center gap-3">
          <BotIcon className="w-8 h-8 text-slate-600" />
          <span>Keine Bots gefunden, die den Suchkriterien entsprechen.</span>
          <button
            onClick={() => setIsModalOpen(true)}
            className="mt-2 px-4 py-2 rounded-xl bg-purple-600/30 border border-purple-500/40 text-purple-300 text-xs font-bold hover:bg-purple-600/50 transition-colors"
          >
            + Ersten Bot anlegen
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 justify-items-center">
          {filteredBots.map((bot) => (
            <BotTelemetryCard
              key={bot.id}
              bot={bot}
              onClose={handleDeleteBot}
              onToggleStatus={handleToggleStatus}
              onTriggerCycle={handleTriggerCycle}
            />
          ))}
        </div>
      )}

      {/* Create Bot Modal */}
      <CreateBotModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreateBot={handleCreateBot}
      />
    </div>
  );
}
