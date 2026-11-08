'use client';

import { useState } from 'react';
import { Activity, Flame } from 'lucide-react';
import ShadowQueueRadar from './widgets/ShadowQueueRadar';
import VolumeProfileChart from './widgets/VolumeProfileChart';
import OrderflowCVD from './widgets/OrderflowCVD';
import ProbabilityRidge from './widgets/ProbabilityRidge';

interface KPI {
  label: string;
  value: string;
  sub: string;
  positive: boolean;
}

const KPIS: KPI[] = [
  { label: 'system', value: 'ONLINE', sub: 'all nodes nominal', positive: true },
  { label: 'feed latency', value: '1.2 ms', sub: 'kraken FIX tape', positive: true },
  { label: 'net p&l', value: '+$124,450.00', sub: 'session realized', positive: true },
  { label: 'max drawdown', value: '-8.2%', sub: 'equity curve DD', positive: false },
];

function KPIPill({ label, value, sub, positive }: KPI) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider">{label}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${positive ? 'bg-emerald-400' : 'bg-crimson-400'} ${positive ? 'animate-ping' : ''}`} />
      </div>
      <span className={`font-mono font-bold text-sm ${positive ? 'text-emerald-300' : 'text-crimson-300'}`}>{value}</span>
      <span className="text-[10px] text-slate-500 font-mono">{sub}</span>
    </div>
  );
}

function WidgetHeader({ title, icon, sub }: { title: string; icon: React.ReactNode; sub: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 shrink-0">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-mono font-bold text-white tracking-wider uppercase">{title}</h3>
        <span className="ml-auto px-2 py-0.5 rounded border text-[10px] font-mono"></span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
        {sub}
      </div>
    </div>
  );
}

// WidgetHeader is used by the widgets themselves; kept here for layout helpers if needed.
export { WidgetHeader };

export default function ApolloTerminal() {
  const [activeView, setActiveView] = useState<'TERMINAL' | 'BACKTEST'>('TERMINAL');

  return (
    <div className="min-h-screen bg-obsidian text-slate-200 selection:bg-violet-500/30 selection:text-white grid-pattern">
      <header className="sticky top-0 z-20 px-6 py-4 bg-[#060709]/60 backdrop-blur-md border-b border-white/5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-sm font-mono font-bold text-white tracking-wider uppercase">Apollo</h1>
              <p className="text-[10px] text-slate-500 font-mono">Obsidian Galaxy Trading Terminal · Quant &amp; Backtest</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 border border-white/5 bg-[#0e121a]/60 p-2 rounded-xl">
              <button
                onClick={() => setActiveView('TERMINAL')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                  activeView === 'TERMINAL'
                    ? 'bg-violet-500/20 text-violet-200 border-violet-500/40 shadow-lg shadow-violet-500/15'
                    : 'text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                Terminal
              </button>
              <button
                onClick={() => setActiveView('BACKTEST')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                  activeView === 'BACKTEST'
                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40 shadow-lg shadow-emerald-500/15'
                    : 'text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                Backtest
              </button>
            </div>

            <div className="flex gap-2">
              {KPIS.map((kpi) => (
                <KPIPill key={kpi.label} {...kpi} />
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="px-6 py-8">
        <div className="mx-auto max-w-[1640px]">
          <div
            className={`grid gap-4 min-h-[720px] lg:min-h-[840px] lg:grid-cols-4 lg:grid-rows-[1fr,1fr,1fr,0.85fr]`}
          >
            {/* 1. Top-left: Shadow Queue radar (tall left column) */}
            <div className="col-span-1 md:col-span-2 lg:col-span-2 lg:row-span-3">
              <ShadowQueueRadar />
            </div>

            {/* 2. Center-right: candlestick + volume profile (tall right column) */}
            <div className="col-span-1 md:col-span-2 lg:col-span-2 lg:row-span-3">
              <VolumeProfileChart heightPx={700} />
            </div>

            {/* 3. Bottom-left: Orderflow CVD + P&L calendar */}
            <div className="col-span-1 md:col-span-1 lg:col-span-2">
              <OrderflowCVD />
            </div>

            {/* 4. Bottom-right: Probability ridge + equity curve */}
            <div className="col-span-1 md:col-span-1 lg:col-span-2">
              <ProbabilityRidge />
            </div>
          </div>

          <div className="mt-6 px-3 text-[10px] text-slate-600 font-mono border-t border-white/5 py-3 flex items-center justify-between">
            <span>
              <Activity className="w-3 h-3 text-slate-500 mr-2" /> apollo engine · deterministic render(t) loop · 60fps canvas · prefers-reduced-motion aware
            </span>
            <span>obsidian galaxy design system · oklch-ready tokens</span>
          </div>
        </div>
      </main>
    </div>
  );
}
