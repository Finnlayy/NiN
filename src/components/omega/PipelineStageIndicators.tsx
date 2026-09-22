import { useState } from 'react';
import {
  Workflow,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Zap
} from 'lucide-react';

export interface PipelineStage {
  step: number;
  name: string;
  tagline: string;
  status: 'ACTIVE' | 'PASSED' | 'EVALUATING' | 'LOCKED' | 'ARMED';
  latencyMs: number;
  telemetryMetrics: Array<{ label: string; value: string; isHighlighted?: boolean }>;
  invariants: string[];
  description: string;
}

interface PipelineStageIndicatorsProps {
  activeStep?: number;
  onSelectStep?: (step: number) => void;
  className?: string;
}

export default function PipelineStageIndicators({
  activeStep: controlledStep,
  onSelectStep,
  className = '',
}: PipelineStageIndicatorsProps) {
  const [internalStep, setInternalStep] = useState<number>(5);
  const activeStep = controlledStep !== undefined ? controlledStep : internalStep;

  const handleStepClick = (step: number) => {
    setInternalStep(step);
    onSelectStep?.(step);
  };

  const stages: PipelineStage[] = [
    {
      step: 1,
      name: 'Trigger & News',
      tagline: 'Glint.trade / OFAC Sanctions',
      status: 'PASSED',
      latencyMs: 1.2,
      telemetryMetrics: [
        { label: 'Feed Status', value: 'WEBSOCKET CONNECTED', isHighlighted: true },
        { label: 'OFAC Sanctions Filter', value: '100% CLEAN' },
        { label: 'NLP Polarity Score', value: '+0.74 (BULLISH)' },
      ],
      invariants: ['Zero OFAC sanctioned address interaction', 'Sub-5ms NLP sentiment extraction latency'],
      description: 'Echtzeit-Aufnahme von Makro-News, Glint.trade Events und strikte OFAC-Prüfung vor jeder Signalverarbeitung.',
    },
    {
      step: 2,
      name: 'Makro-Kontext',
      tagline: 'DXY, Yields, Global M2, Gold',
      status: 'PASSED',
      latencyMs: 3.4,
      telemetryMetrics: [
        { label: 'DXY Dollar Index', value: '104.18 (-0.28%)' },
        { label: 'US 10Y Treasury', value: '4.12% (STABIL)' },
        { label: 'Global M2 Liquidity', value: '$104.8T (+1.4σ)', isHighlighted: true },
        { label: 'Gold (XAU/USD)', value: '$2,742 (+0.8%)' },
      ],
      invariants: ['Regime-Erkennung vor Allokation', 'Kein Einstieg gegen akute Liquiditätsabflüsse (M2 Drain)'],
      description: 'Filterung der übergeordneten Makro-Großwetterlage zur Bestimmung der globalen Risiko-Bereitschaft (Risk-On / Risk-Off).',
    },
    {
      step: 3,
      name: 'OG-8 Filter',
      tagline: 'BTC, ETH, SOL, XRP, DOGE...',
      status: 'PASSED',
      latencyMs: 2.1,
      telemetryMetrics: [
        { label: 'Überwachte Assets', value: '8/8 Bluechips', isHighlighted: true },
        { label: 'Maximaler Spread', value: '1.4 bps (< 2 bps)' },
        { label: '24h Handelsvolumen', value: '> $50M/Paar' },
      ],
      invariants: ['Ausschließlich liquide OG-8 Instrumente', 'Spread-Impedance unter Schwellenwert'],
      description: 'Eingrenzung des Trading-Universums auf die 8 kapitalstärksten und liquidesten Bluechip-Kryptowährungen.',
    },
    {
      step: 4,
      name: 'ETH Lead-Lag',
      tagline: '3-15 min Phasenversatz',
      status: 'LOCKED',
      latencyMs: 4.8,
      telemetryMetrics: [
        { label: 'Phasenversatz Δτ', value: '-8.5 Minuten', isHighlighted: true },
        { label: 'Directional Lead Score', value: '0.91 (HIGH)' },
        { label: 'Cross-Correlation', value: 'r = 0.94 (L1 Base)' },
      ],
      invariants: ['ETH eilt Altcoins 3 bis 15 Minuten voraus', 'Phasengleicher Eintritt verhindert Whipsaws'],
      description: 'Mathematische Auswertung der Zeitverzögerung (Lead-Lag Cross-Correlation) zwischen Leitwährungen und Follower-Tokens.',
    },
    {
      step: 5,
      name: 'Schrödinger-Bänder',
      tagline: 'Leitwährungs-Baseline',
      status: 'ACTIVE',
      latencyMs: 8.2,
      telemetryMetrics: [
        { label: 'Baseline Mittelwert', value: '$64,280 USD', isHighlighted: true },
        { label: 'Oberes Band (+2.5σ)', value: '$66,400 USD' },
        { label: 'Unteres Band (-2.5σ)', value: '$62,150 USD' },
        { label: 'Gaußscher Kernel', value: 'N(μ, σ²) Satisfied' },
      ],
      invariants: ['Ortswahrscheinlichkeitsdichte im Hilbert-Raum', 'Mean-Reversion Attraktor P*'],
      description: 'Dynamische Quanten-Bänder um den Leitwährungskurs zur Ermittlung statistischer Ausreißer und Mean-Reversion Potenziale.',
    },
    {
      step: 6,
      name: 'Quadrant-1 Meta',
      tagline: 'r ≥ 0.85, β ≥ 2.5, RVOL ≥ 3.0',
      status: 'EVALUATING',
      latencyMs: 11.5,
      telemetryMetrics: [
        { label: 'SUI Meta-Score', value: '2.45 (LEADER)', isHighlighted: true },
        { label: 'SOL Meta-Score', value: '2.28 (STRONG)' },
        { label: 'RVOL 5-Minuten', value: '4.2x Baseline' },
      ],
      invariants: ['Strengste Quadrant-1 Kriterien für Alpha-Tokens', 'Meta-Score Gewichtung w1..w4'],
      description: 'Selektion der stärksten Altcoin-Outperformer im aktuellen 5-Minuten-Zeitfenster basierend auf Korrelation, Beta und relativem Volumen.',
    },
    {
      step: 7,
      name: 'Shadow-Limit Mesh',
      tagline: 'Kraken Matching Engine',
      status: 'ARMED',
      latencyMs: 0.015, // 15µs
      telemetryMetrics: [
        { label: 'Ausführungs-Kernel', value: 'RUST FFI (SIMD AVX-512)', isHighlighted: true },
        { label: 'Iceberg Order Slices', value: '8 Tranchen aktiv' },
        { label: 'Engine Latenz', value: '12.4 µs (Sub-15µs)' },
      ],
      invariants: ['Post-Only Shadow-Limit Orders', 'Kein Frontrunning durch Iceberg-Splitting'],
      description: 'Sub-15 Mikrosekunden Ausführung direkt im Kraken Matching Engine Mesh via nativer Rust/C# FFI Anbindung.',
    },
  ];

  const currentStage = stages.find(s => s.step === activeStep) || stages[4];

  const getStatusBadge = (status: PipelineStage['status']) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            LÄUFT (ACTIVE)
          </span>
        );
      case 'PASSED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            PASSED
          </span>
        );
      case 'EVALUATING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
            <Clock className="w-3 h-3 text-amber-400 animate-spin" />
            EVALUATION
          </span>
        );
      case 'LOCKED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
            <ShieldCheck className="w-3 h-3 text-indigo-400" />
            LOCKED
          </span>
        );
      case 'ARMED':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
            <Zap className="w-3 h-3 text-purple-400" />
            ARMED (READY)
          </span>
        );
    }
  };

  return (
    <div className={`glass-card rounded-2xl p-6 shadow-2xl border border-white/10 space-y-6 ${className}`}>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
            <Workflow className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-wide">
                §7 DIE 7-STUFEN MACRO-TO-MICRO PIPELINE
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                L4/L5 KASKADE
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Vom globalen Makro-Impuls bis zum Sub-15µs Shadow-Limit Mesh auf Kraken
            </p>
          </div>
        </div>

        {/* Global Pipeline Health Status */}
        <div className="flex items-center gap-3 font-mono text-xs">
          <div className="px-3 py-1.5 rounded-xl bg-white/[0.02] border border-white/5 flex items-center gap-2">
            <span className="text-slate-400">Gesamtlatenz:</span>
            <span className="text-emerald-400 font-bold">29.3 ms</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-center gap-1.5 font-bold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            PIPELINE 100% OPERATIONAL
          </div>
        </div>
      </div>

      {/* 7-Step Progression Ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {stages.map(st => {
          const isSelected = st.step === activeStep;
          const isFinished = st.step < activeStep;

          return (
            <div
              key={st.step}
              onClick={() => handleStepClick(st.step)}
              className={`p-3.5 rounded-xl border transition-all cursor-pointer font-mono flex flex-col justify-between relative overflow-hidden ${
                isSelected
                  ? 'bg-cyan-500/20 border-cyan-500/60 shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/40'
                  : isFinished
                  ? 'bg-emerald-500/5 border-emerald-500/20 hover:border-emerald-500/40 text-slate-300'
                  : 'bg-white/[0.02] border-white/5 hover:border-white/20 text-slate-400'
              }`}
            >
              {isSelected && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-indigo-500 animate-pulse" />
              )}

              <div>
                <div className="flex items-center justify-between text-[10px] mb-1.5">
                  <span className={`font-bold ${isSelected ? 'text-cyan-300' : 'text-slate-400'}`}>
                    STUFE 0{st.step}
                  </span>
                  {isFinished ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : isSelected ? (
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                  ) : (
                    <span className="text-[9px] text-slate-500">{st.latencyMs < 1 ? `${st.latencyMs * 1000}µs` : `${st.latencyMs}ms`}</span>
                  )}
                </div>

                <div className="font-bold text-xs text-white truncate">{st.name}</div>
                <div className="text-[10px] text-slate-400 mt-1 truncate">{st.tagline}</div>
              </div>

              <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between">
                {getStatusBadge(st.status)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Deep Stage Inspection Card */}
      <div className="p-5 rounded-2xl bg-[#0d111d] border border-white/10 space-y-4 font-mono text-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">
              STUFE {currentStage.step}/7
            </span>
            <span className="text-sm font-bold text-white">{currentStage.name}</span>
            <span className="text-slate-400 text-xs">— {currentStage.tagline}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-slate-400 text-[11px]">
              Stufen-Latenz: <strong className="text-emerald-400">{currentStage.latencyMs} ms</strong>
            </span>
            {getStatusBadge(currentStage.status)}
          </div>
        </div>

        <p className="text-slate-300 text-xs leading-relaxed">
          {currentStage.description}
        </p>

        {/* Live Telemetry Metrics */}
        <div>
          <span className="text-[10px] uppercase text-slate-400 font-bold block mb-2">
            Live Telemetrie-Werte der Stufe:
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            {currentStage.telemetryMetrics.map((met, idx) => (
              <div
                key={idx}
                className={`p-3 rounded-xl border ${
                  met.isHighlighted
                    ? 'bg-cyan-500/10 border-cyan-500/30 text-white'
                    : 'bg-white/[0.02] border-white/5 text-slate-300'
                }`}
              >
                <span className="text-[10px] text-slate-400 block">{met.label}</span>
                <span className={`text-sm font-bold mt-1 block ${met.isHighlighted ? 'text-cyan-300' : 'text-white'}`}>
                  {met.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Invariants Checked */}
        <div className="pt-2 border-t border-white/5">
          <span className="text-[10px] uppercase text-slate-400 font-bold block mb-1.5">
            System-Invarianten & The Judge Gates:
          </span>
          <div className="flex flex-wrap gap-2">
            {currentStage.invariants.map((inv, idx) => (
              <span
                key={idx}
                className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                {inv}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
