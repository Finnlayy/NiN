import { useState, useMemo } from 'react';
import { useMarketFeed } from '../../market/useMarketFeed';
import { leaderPricesFromQuotes } from '../../market/krakenLive';
import {
  TrendingUp,
  Search,
  Zap
} from 'lucide-react';
import { SymbolLampState } from '../../utils/omegaLogic';

export interface EcosystemToken {
  symbol: string;
  name: string;
  cluster: 'SUI' | 'SOL' | 'BTC' | 'ETH';
  leadAsset: string;
  correlationLead: number;
  betaLead: number;
  rvol5m: number;
  cosPhi: number;
  metaScore: number;
  lampState: SymbolLampState;
  isLeader: boolean;
  priceUSD: number;
  change24h: number;
  tradeStatus: 'ACTIVE_PYRAMID' | 'SCOUT_ENTRY' | 'STANDBY_HOLD' | 'EMBARGO_BLOCKED';
}

interface SymbolAmpelMatrixProps {
  onSelectToken?: (token: EcosystemToken) => void;
  className?: string;
}

export default function SymbolAmpelMatrix({
  onSelectToken,
  className = '',
}: SymbolAmpelMatrixProps) {
  const [selectedCluster, setSelectedCluster] = useState<'ALL' | 'SUI' | 'SOL' | 'BTC'>('ALL');
  const [selectedLampFilter, setSelectedLampFilter] = useState<'ALL' | SymbolLampState>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [inspectToken, setInspectToken] = useState<EcosystemToken | null>(null);
  const market = useMarketFeed();

  // Canonical token list based on OMEGA-BLUEPRINT §8
  const tokens: EcosystemToken[] = useMemo(() => [
    {
      symbol: 'SUI',
      name: 'Sui Network',
      cluster: 'SUI',
      leadAsset: 'SUI (SELF)',
      correlationLead: 1.0,
      betaLead: 1.0,
      rvol5m: 4.8,
      cosPhi: 0.94,
      metaScore: 2.85,
      lampState: 'GREEN_GLOW',
      isLeader: true,
      priceUSD: 3.42,
      change24h: 14.8,
      tradeStatus: 'ACTIVE_PYRAMID',
    },
    {
      symbol: 'CETUS',
      name: 'Cetus Protocol',
      cluster: 'SUI',
      leadAsset: 'SUI',
      correlationLead: 0.89,
      betaLead: 2.8,
      rvol5m: 3.6,
      cosPhi: 0.88,
      metaScore: 2.45,
      lampState: 'GREEN_GLOW',
      isLeader: false,
      priceUSD: 0.38,
      change24h: 18.2,
      tradeStatus: 'ACTIVE_PYRAMID',
    },
    {
      symbol: 'NAVX',
      name: 'NAVI Protocol',
      cluster: 'SUI',
      leadAsset: 'SUI',
      correlationLead: 0.82,
      betaLead: 2.2,
      rvol5m: 2.4,
      cosPhi: 0.74,
      metaScore: 1.95,
      lampState: 'GREEN_SOLID',
      isLeader: false,
      priceUSD: 0.165,
      change24h: 6.4,
      tradeStatus: 'SCOUT_ENTRY',
    },
    {
      symbol: 'SCA',
      name: 'Scallop',
      cluster: 'SUI',
      leadAsset: 'SUI',
      correlationLead: 0.64,
      betaLead: 1.5,
      rvol5m: 1.2,
      cosPhi: 0.48,
      metaScore: 1.22,
      lampState: 'YELLOW',
      isLeader: false,
      priceUSD: 0.44,
      change24h: -1.2,
      tradeStatus: 'STANDBY_HOLD',
    },
    {
      symbol: 'SOL',
      name: 'Solana',
      cluster: 'SOL',
      leadAsset: 'SOL (SELF)',
      correlationLead: 1.0,
      betaLead: 1.0,
      rvol5m: 3.9,
      cosPhi: 0.91,
      metaScore: 2.68,
      lampState: 'GREEN_GLOW',
      isLeader: true,
      priceUSD: 182.4,
      change24h: 8.5,
      tradeStatus: 'ACTIVE_PYRAMID',
    },
    {
      symbol: 'JUP',
      name: 'Jupiter',
      cluster: 'SOL',
      leadAsset: 'SOL',
      correlationLead: 0.84,
      betaLead: 2.4,
      rvol5m: 3.1,
      cosPhi: 0.82,
      metaScore: 2.24,
      lampState: 'GREEN_SOLID',
      isLeader: false,
      priceUSD: 1.18,
      change24h: 9.1,
      tradeStatus: 'SCOUT_ENTRY',
    },
    {
      symbol: 'RAY',
      name: 'Raydium',
      cluster: 'SOL',
      leadAsset: 'SOL',
      correlationLead: 0.78,
      betaLead: 2.1,
      rvol5m: 2.2,
      cosPhi: 0.68,
      metaScore: 1.84,
      lampState: 'GREEN_SOLID',
      isLeader: false,
      priceUSD: 4.85,
      change24h: 5.4,
      tradeStatus: 'SCOUT_ENTRY',
    },
    {
      symbol: 'JTO',
      name: 'Jito',
      cluster: 'SOL',
      leadAsset: 'SOL',
      correlationLead: 0.58,
      betaLead: 1.6,
      rvol5m: 1.4,
      cosPhi: 0.42,
      metaScore: 1.18,
      lampState: 'YELLOW',
      isLeader: false,
      priceUSD: 2.92,
      change24h: 0.8,
      tradeStatus: 'STANDBY_HOLD',
    },
    {
      symbol: 'BTC',
      name: 'Bitcoin',
      cluster: 'BTC',
      leadAsset: 'GLOBAL MACRO',
      correlationLead: 1.0,
      betaLead: 1.0,
      rvol5m: 2.8,
      cosPhi: 0.89,
      metaScore: 2.40,
      lampState: 'GREEN_SOLID',
      isLeader: true,
      priceUSD: 0,
      change24h: 3.8,
      tradeStatus: 'ACTIVE_PYRAMID',
    },
    {
      symbol: 'ETH',
      name: 'Ethereum',
      cluster: 'BTC',
      leadAsset: 'BTC',
      correlationLead: 0.94,
      betaLead: 1.2,
      rvol5m: 2.1,
      cosPhi: 0.85,
      metaScore: 2.15,
      lampState: 'GREEN_SOLID',
      isLeader: false,
      priceUSD: 2780.0,
      change24h: 4.2,
      tradeStatus: 'SCOUT_ENTRY',
    },
    {
      symbol: 'DOGE',
      name: 'Dogecoin',
      cluster: 'BTC',
      leadAsset: 'BTC',
      correlationLead: 0.42,
      betaLead: 1.8,
      rvol5m: 1.1,
      cosPhi: 0.28,
      metaScore: 0.84,
      lampState: 'YELLOW',
      isLeader: false,
      priceUSD: 0.142,
      change24h: -2.4,
      tradeStatus: 'STANDBY_HOLD',
    },
    {
      symbol: 'XRP',
      name: 'Ripple',
      cluster: 'BTC',
      leadAsset: 'BTC',
      correlationLead: 0.31,
      betaLead: 0.7,
      rvol5m: 0.8,
      cosPhi: -0.22,
      metaScore: 0.41,
      lampState: 'RED_GLOW',
      isLeader: false,
      priceUSD: 0.58,
      change24h: -5.1,
      tradeStatus: 'EMBARGO_BLOCKED',
    },
  ], []);

  const pricedTokens = useMemo(() => {
    const live = new Map(leaderPricesFromQuotes(market.feed?.quotes ?? {}).map((row) => [row.symbol, row]));
    return tokens.map((token) => {
      const quote = live.get(token.symbol);
      if (!quote || !(quote.priceUSD > 0)) {
        return { ...token, priceUSD: Number.NaN, change24h: Number.NaN };
      }
      return { ...token, priceUSD: quote.priceUSD, change24h: quote.change24h };
    });
  }, [tokens, market.feed]);

  // Filtered tokens
  const filteredTokens = useMemo(() => {
    return pricedTokens.filter(t => {
      if (selectedCluster !== 'ALL' && t.cluster !== selectedCluster) return false;
      if (selectedLampFilter !== 'ALL' && t.lampState !== selectedLampFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [pricedTokens, selectedCluster, selectedLampFilter, searchQuery]);

  // Lamp Badge Renderer
  const renderLampBadge = (state: SymbolLampState, isLeader: boolean) => {
    switch (state) {
      case 'GREEN_GLOW':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-lg shadow-emerald-500/20 animate-pulse">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400" />
            GREEN_GLOW {isLeader && '★ LEADER'}
          </span>
        );
      case 'GREEN_SOLID':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            GREEN_SOLID
          </span>
        );
      case 'YELLOW':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            YELLOW (STANDBY)
          </span>
        );
      case 'RED_GLOW':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-md shadow-rose-500/10">
            <span className="w-2 h-2 rounded-full bg-rose-400 animate-ping" />
            RED_GLOW (FORBIDDEN)
          </span>
        );
    }
  };

  const renderTradeStatusBadge = (status: EcosystemToken['tradeStatus']) => {
    switch (status) {
      case 'ACTIVE_PYRAMID':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
            REVERSE-DCA AKTIV
          </span>
        );
      case 'SCOUT_ENTRY':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
            1x SCOUT FREIGEGEBEN
          </span>
        );
      case 'STANDBY_HOLD':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            HOLD (KEINE PYRAMIDE)
          </span>
        );
      case 'EMBARGO_BLOCKED':
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
            AXIOM 1 EMBARGO
          </span>
        );
    }
  };

  return (
    <div className={`glass-card rounded-2xl p-6 shadow-2xl border border-white/10 space-y-6 ${className}`}>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-wide">
                §8 5-MINUTEN META-ROTATION & SYMBOL-AMPELSYSTEM
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                QUADRANT-1 SELECTION
              </span>
            </div>
            <p className="text-xs text-slate-400">
              S_meta = 0.35·r + 0.30·β + 0.20·RVOL_5m + 0.15·cos(φ) relativ zum echten L1-Taktgeber
            </p>
          </div>
        </div>

        {/* Legend Pills */}
        <div className="flex items-center gap-2 font-mono text-[10px] flex-wrap">
          <span className="flex items-center gap-1 text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Green Glow (Leader)
          </span>
          <span className="text-slate-600">•</span>
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Green Solid (Follower)
          </span>
          <span className="text-slate-600">•</span>
          <span className="flex items-center gap-1 text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Yellow (Standby)
          </span>
          <span className="text-slate-600">•</span>
          <span className="flex items-center gap-1 text-rose-400">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            Red Glow (Verboten)
          </span>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono text-xs">
        {/* Cluster Filter Buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400 text-[10px] uppercase mr-1">Cluster:</span>
          {[
            { id: 'ALL', label: 'Alle Ökosysteme' },
            { id: 'SUI', label: 'Sui-Cluster' },
            { id: 'SOL', label: 'Solana-Cluster' },
            { id: 'BTC', label: 'Makro/BTC-Cluster' },
          ].map(c => (
            <button
              key={c.id}
              onClick={() => setSelectedCluster(c.id as any)}
              className={`px-3 py-1.5 rounded-lg border transition-all ${
                selectedCluster === c.id
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 font-bold shadow-sm'
                  : 'bg-white/[0.02] text-slate-400 border-white/5 hover:text-white'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div className="relative w-full sm:w-60">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Symbol suchen..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-cyan-400 placeholder:text-slate-600"
          />
        </div>
      </div>

      {/* Secondary Status Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs font-mono">
        <span className="text-slate-400 text-[10px] uppercase mr-1">Ampel:</span>
        {[
          { id: 'ALL', label: `Alle (${tokens.length})` },
          { id: 'GREEN_GLOW', label: `🟢 Green Glow (${tokens.filter(t => t.lampState === 'GREEN_GLOW').length})` },
          { id: 'GREEN_SOLID', label: `🟢 Green Solid (${tokens.filter(t => t.lampState === 'GREEN_SOLID').length})` },
          { id: 'YELLOW', label: `🟡 Yellow (${tokens.filter(t => t.lampState === 'YELLOW').length})` },
          { id: 'RED_GLOW', label: `🔴 Red Glow (${tokens.filter(t => t.lampState === 'RED_GLOW').length})` },
        ].map(filter => (
          <button
            key={filter.id}
            onClick={() => setSelectedLampFilter(filter.id as any)}
            className={`px-2.5 py-1 rounded-md transition-all whitespace-nowrap text-[11px] ${
              selectedLampFilter === filter.id
                ? 'bg-white/10 text-white font-bold border border-white/20'
                : 'text-slate-400 hover:text-white border border-transparent'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Market Status Table */}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#0a0d16]">
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400">
              <th className="py-3 px-4">Symbol / Name</th>
              <th className="py-3 px-3">Cluster Taktgeber</th>
              <th className="py-3 px-3">Kurs (USD)</th>
              <th className="py-3 px-3">Korrelation (r)</th>
              <th className="py-3 px-3">Beta (β)</th>
              <th className="py-3 px-3">RVOL 5m</th>
              <th className="py-3 px-3">cos(φ)</th>
              <th className="py-3 px-3">S_meta Score</th>
              <th className="py-3 px-3">Ampel-Status</th>
              <th className="py-3 px-4 text-right">The Judge Freigabe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredTokens.map(tok => (
              <tr
                key={tok.symbol}
                onClick={() => {
                  setInspectToken(tok);
                  onSelectToken?.(tok);
                }}
                className="hover:bg-white/[0.04] transition-colors cursor-pointer group"
              >
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white group-hover:text-cyan-300 transition-colors">
                      {tok.symbol}
                    </span>
                    <span className="text-[10px] text-slate-400">({tok.name})</span>
                  </div>
                </td>
                <td className="py-3 px-3">
                  <span className="px-2 py-0.5 rounded bg-white/[0.03] border border-white/5 text-slate-300 text-[11px]">
                    {tok.leadAsset}
                  </span>
                </td>
                <td className="py-3 px-3 font-semibold text-slate-200">
                  {Number.isFinite(tok.priceUSD) ? (tok.priceUSD < 1 ? tok.priceUSD.toFixed(3) : tok.priceUSD.toLocaleString()) : '—'}
                  {Number.isFinite(tok.change24h) && (
                    <span className={`text-[10px] ml-1.5 ${tok.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {tok.change24h >= 0 ? `+${tok.change24h.toFixed(2)}%` : `${tok.change24h.toFixed(2)}%`}
                    </span>
                  )}
                </td>
                <td className="py-3 px-3 font-semibold text-slate-300">
                  {tok.correlationLead.toFixed(2)}
                </td>
                <td className="py-3 px-3 font-semibold text-slate-300">
                  {tok.betaLead.toFixed(1)}x
                </td>
                <td className="py-3 px-3 font-semibold text-slate-300">
                  {tok.rvol5m.toFixed(1)}x
                </td>
                <td className="py-3 px-3 font-semibold text-slate-300">
                  {tok.cosPhi.toFixed(2)}
                </td>
                <td className="py-3 px-3">
                  <span className={`font-bold ${tok.metaScore >= 2.0 ? 'text-emerald-400' : 'text-slate-300'}`}>
                    {tok.metaScore.toFixed(2)}
                  </span>
                </td>
                <td className="py-3 px-3">
                  {renderLampBadge(tok.lampState, tok.isLeader)}
                </td>
                <td className="py-3 px-4 text-right">
                  {renderTradeStatusBadge(tok.tradeStatus)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Interactive Inspection Drawer for selected token */}
      {inspectToken && (
        <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex flex-col md:flex-row md:items-center justify-between gap-4 font-mono text-xs">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">Inspektion: {inspectToken.symbol}</span>
                {renderLampBadge(inspectToken.lampState, inspectToken.isLeader)}
              </div>
              <p className="text-[11px] text-slate-300 mt-0.5">
                Cluster-Taktgeber: <strong className="text-cyan-400">{inspectToken.leadAsset}</strong> • Meta-Score: <strong className="text-emerald-400">{inspectToken.metaScore}</strong> • RVOL 5m: <strong className="text-white">{inspectToken.rvol5m}x</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {renderTradeStatusBadge(inspectToken.tradeStatus)}
            <button
              onClick={() => setInspectToken(null)}
              className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 text-slate-400 hover:text-white border border-white/10 text-[11px]"
            >
              Schließen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
