import { useState, useMemo } from 'react';
import { Compass, Sliders, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { ViaNegativaState } from '../../utils/omegaLogic';

interface GravitationFieldVisualizerProps {
  spotPrice?: number;
  viaNegativa?: ViaNegativaState;
  onParametersChange?: (params: { l2Depth: number; icebergDepth: number; polyProb: number }) => void;
}

export default function GravitationFieldVisualizer({
  spotPrice = 64280,
  viaNegativa,
  onParametersChange,
}: GravitationFieldVisualizerProps) {
  // Interactive Simulation Controls
  const [polyProb, setPolyProb] = useState<number>(0.78);
  const [l2DepthImbalance, setL2DepthImbalance] = useState<number>(1450); // Bids vs Asks in BTC
  const [icebergDepth, setIcebergDepth] = useState<number>(2200); // Hidden shadow volume
  const [simulatedPrice, setSimulatedPrice] = useState<number>(spotPrice);

  // Weights according to OMEGA-BLUEPRINT §2
  const wVis = 0.25;
  const wBlind = 0.35;
  const wPoly = 0.40;

  // Potential Minimum Target P* and Force calculation
  const attractorPrice = useMemo(() => {
    const shift = (polyProb - 0.5) * 800 + (l2DepthImbalance - 1400) * 0.25;
    return Math.round(spotPrice + shift);
  }, [spotPrice, polyProb, l2DepthImbalance]);

  // Force vector F = -∇V (in arb. N units)
  const forceVector = useMemo(() => {
    const delta = attractorPrice - simulatedPrice;
    return Math.round(delta * 0.14);
  }, [attractorPrice, simulatedPrice]);

  // Forbidden zones
  const bLower = viaNegativa?.bLower ?? spotPrice - 1800;
  const bUpper = viaNegativa?.bUpper ?? spotPrice + 1800;
  const isForbidden = simulatedPrice <= bLower || simulatedPrice >= bUpper;

  // Generate curves for SVG potential well
  const points = useMemo(() => {
    const numSteps = 50;
    const priceRange = 2400; // ±1200 from center
    const stepSize = (priceRange * 2) / numSteps;
    const startP = spotPrice - priceRange;

    const data: Array<{
      price: number;
      vVis: number;
      vBlind: number;
      vPoly: number;
      vTotal: number;
    }> = [];

    for (let i = 0; i <= numSteps; i++) {
      const p = startP + i * stepSize;
      const distFromAttractor = (p - attractorPrice) / 600;

      // Parabolic well + periodic harmonics
      const baseWell = Math.pow(distFromAttractor, 2) * 22;
      const vVis = Math.min(95, Math.max(10, baseWell + Math.sin(p / 140) * 8 + 35));
      const vBlind = Math.min(95, Math.max(10, baseWell + Math.cos(p / 190) * 12 + 40));
      const vPoly = Math.min(95, Math.max(10, baseWell * 1.2 + (1 - polyProb) * 30 + 20));

      const vTotal = Number((wVis * vVis + wBlind * vBlind + wPoly * vPoly).toFixed(2));

      data.push({ price: Math.round(p), vVis, vBlind, vPoly, vTotal });
    }

    return data;
  }, [spotPrice, attractorPrice, polyProb, wVis, wBlind, wPoly]);

  // SVG dimensions
  const svgWidth = 720;
  const svgHeight = 240;
  const paddingX = 40;
  const paddingY = 30;

  const minPrice = spotPrice - 2400;
  const maxPrice = spotPrice + 2400;

  const scaleX = (p: number) => {
    return paddingX + ((p - minPrice) / (maxPrice - minPrice)) * (svgWidth - 2 * paddingX);
  };

  const scaleY = (v: number) => {
    // 0 is bottom (svgHeight - paddingY), 100 is top (paddingY)
    return svgHeight - paddingY - (v / 100) * (svgHeight - 2 * paddingY);
  };

  // SVG paths
  const totalPath = points
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleY(pt.vTotal).toFixed(1)}`)
    .join(' ');

  const visPath = points
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleY(pt.vVis).toFixed(1)}`)
    .join(' ');

  const blindPath = points
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleY(pt.vBlind).toFixed(1)}`)
    .join(' ');

  const polyPath = points
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleY(pt.vPoly).toFixed(1)}`)
    .join(' ');

  // Current price position on the total curve
  const currentTotalPt = useMemo(() => {
    const closest = points.reduce((prev, curr) =>
      Math.abs(curr.price - simulatedPrice) < Math.abs(prev.price - simulatedPrice) ? curr : prev
    );
    return {
      x: scaleX(simulatedPrice),
      y: scaleY(closest.vTotal),
    };
  }, [points, simulatedPrice]);

  return (
    <div className="glass-card rounded-2xl p-6 shadow-2xl border border-white/10 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
            <Compass className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-wide">
                §2 DREI-KOMPONENTEN-GRAVITATIONSFELD
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                F = -∇V_total
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Composite Potential Function: V_total(P) = 0.25·V_vis + 0.35·V_blind + 0.40·V_poly
            </p>
          </div>
        </div>

        {/* Current State Indicator */}
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-slate-400">Status:</span>
          {isForbidden ? (
            <span className="px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1 font-bold">
              <ShieldAlert className="w-3.5 h-3.5" />
              VERBOTENE ZONE (AXIOM 1)
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1 font-bold">
              <CheckCircle2 className="w-3.5 h-3.5" />
              POTENTIAL-WELL STABIL
            </span>
          )}
        </div>
      </div>

      {/* SVG Canvas for Potential Field */}
      <div className="relative w-full overflow-hidden rounded-xl bg-[#0a0d16] border border-white/10 p-2">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-auto select-none"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            {/* Gradient for Total Potential Fill */}
            <linearGradient id="totalGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
            </linearGradient>

            {/* Pattern for Forbidden Zones */}
            <pattern id="forbiddenHatch" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="10" stroke="#f43f5e" strokeWidth="2" strokeOpacity="0.25" />
            </pattern>
          </defs>

          {/* Grid lines */}
          <line x1={paddingX} y1={svgHeight - paddingY} x2={svgWidth - paddingX} y2={svgHeight - paddingY} stroke="#334155" strokeWidth="1" />
          <line x1={paddingX} y1={paddingY} x2={svgWidth - paddingX} y2={paddingY} stroke="#1e293b" strokeDasharray="4 4" />
          <line x1={paddingX} y1={(svgHeight - paddingY + paddingY) / 2} x2={svgWidth - paddingX} y2={(svgHeight - paddingY + paddingY) / 2} stroke="#1e293b" strokeDasharray="4 4" />

          {/* Forbidden Zone Shading (Via Negativa) */}
          {scaleX(bLower) > paddingX && (
            <rect
              x={paddingX}
              y={paddingY}
              width={Math.max(0, scaleX(bLower) - paddingX)}
              height={svgHeight - 2 * paddingY}
              fill="url(#forbiddenHatch)"
            />
          )}
          {scaleX(bUpper) < svgWidth - paddingX && (
            <rect
              x={scaleX(bUpper)}
              y={paddingY}
              width={Math.max(0, svgWidth - paddingX - scaleX(bUpper))}
              height={svgHeight - 2 * paddingY}
              fill="url(#forbiddenHatch)"
            />
          )}

          {/* Forbidden Boundary Lines */}
          <line
            x1={scaleX(bLower)}
            y1={paddingY}
            x2={scaleX(bLower)}
            y2={svgHeight - paddingY}
            stroke="#f43f5e"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text x={scaleX(bLower) - 6} y={paddingY + 12} fill="#f43f5e" fontSize="9" textAnchor="end" fontFamily="monospace">
            B_lower (${bLower})
          </text>

          <line
            x1={scaleX(bUpper)}
            y1={paddingY}
            x2={scaleX(bUpper)}
            y2={svgHeight - paddingY}
            stroke="#f43f5e"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text x={scaleX(bUpper) + 6} y={paddingY + 12} fill="#f43f5e" fontSize="9" textAnchor="start" fontFamily="monospace">
            B_upper (${bUpper})
          </text>

          {/* Sub-potential curves */}
          {/* V_vis (Cyan dash) */}
          <path d={visPath} fill="none" stroke="#22d3ee" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.6" />

          {/* V_blind (Purple dash) */}
          <path d={blindPath} fill="none" stroke="#a855f7" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.6" />

          {/* V_poly (Amber dash) */}
          <path d={polyPath} fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.6" />

          {/* Total Potential Well (Solid Cyan with Fill) */}
          <path d={`${totalPath} L ${scaleX(maxPrice)} ${svgHeight - paddingY} L ${scaleX(minPrice)} ${svgHeight - paddingY} Z`} fill="url(#totalGradient)" />
          <path d={totalPath} fill="none" stroke="#06b6d4" strokeWidth="2.5" />

          {/* Attractor P* Target (Vertical Marker) */}
          <line
            x1={scaleX(attractorPrice)}
            y1={paddingY}
            x2={scaleX(attractorPrice)}
            y2={svgHeight - paddingY}
            stroke="#10b981"
            strokeWidth="1.5"
            strokeDasharray="2 2"
          />
          <circle cx={scaleX(attractorPrice)} cy={scaleY(20)} r="4" fill="#10b981" />
          <text x={scaleX(attractorPrice)} y={paddingY + 12} fill="#10b981" fontSize="10" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
            Attraktor P* (${attractorPrice})
          </text>

          {/* Current Spot Particle & Force Arrow */}
          <circle
            cx={currentTotalPt.x}
            cy={currentTotalPt.y}
            r="6"
            fill={isForbidden ? '#f43f5e' : '#38bdf8'}
            className="animate-pulse"
          />
          <circle
            cx={currentTotalPt.x}
            cy={currentTotalPt.y}
            r="10"
            fill="none"
            stroke={isForbidden ? '#f43f5e' : '#38bdf8'}
            strokeWidth="1.5"
            strokeOpacity="0.5"
          />

          {/* Force Vector Arrow pointing toward attractor */}
          {Math.abs(forceVector) > 10 && (
            <line
              x1={currentTotalPt.x}
              y1={currentTotalPt.y}
              x2={currentTotalPt.x + (forceVector > 0 ? 30 : -30)}
              y2={currentTotalPt.y}
              stroke="#e2e8f0"
              strokeWidth="2"
              markerEnd="url(#arrow)"
            />
          )}
        </svg>

        {/* Legend */}
        <div className="flex items-center justify-between gap-4 mt-2 px-3 py-1.5 bg-black/40 rounded-lg text-[10px] font-mono text-slate-400 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="w-3 h-0.5 bg-cyan-400 rounded-full" />
            <span className="text-white font-semibold">V_total (Effektives Potential)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-0.5 bg-cyan-400 border-b border-dashed" />
            <span>V_vis (L2 Tiefe - 25%)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-0.5 bg-purple-400 border-b border-dashed" />
            <span>V_blind (Schattenbuch - 35%)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-0.5 bg-amber-400 border-b border-dashed" />
            <span>V_poly (Polymarket - 40%)</span>
          </div>
        </div>
      </div>

      {/* Physics Metrics Breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
        <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
          <span className="text-slate-400 text-[10px] uppercase block">Aktueller Spot-Kurs (P)</span>
          <span className="text-lg font-bold text-white block mt-0.5">${simulatedPrice.toLocaleString()}</span>
          <span className="text-[10px] text-slate-500">Basis: Kraken L2 Feed</span>
        </div>

        <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
          <span className="text-slate-400 text-[10px] uppercase block">Potentialminimum (P*)</span>
          <span className="text-lg font-bold text-emerald-400 block mt-0.5">${attractorPrice.toLocaleString()}</span>
          <span className="text-[10px] text-slate-500">∇V_total = 0 (Gleichgewicht)</span>
        </div>

        <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
          <span className="text-slate-400 text-[10px] uppercase block">Gravitationskraft (F)</span>
          <span className={`text-lg font-bold block mt-0.5 ${forceVector >= 0 ? 'text-cyan-400' : 'text-rose-400'}`}>
            {forceVector >= 0 ? `+${forceVector}` : forceVector} N
          </span>
          <span className="text-[10px] text-slate-500">Richtung: {forceVector >= 0 ? 'BULLISH (UP)' : 'BEARISH (DOWN)'}</span>
        </div>

        <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30">
          <span className="text-cyan-300 text-[10px] uppercase block">Polymarket Bias</span>
          <span className="text-lg font-bold text-white block mt-0.5">{(polyProb * 100).toFixed(0)}% Up</span>
          <span className="text-[10px] text-cyan-400">Gewichtung: 40% (Höchste)</span>
        </div>
      </div>

      {/* Interactive Simulation Sliders */}
      <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 space-y-4 font-mono text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white font-bold text-xs">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <span>Gravitations-Feld Parameter Kalibrierung:</span>
          </div>
          <button
            onClick={() => {
              setPolyProb(0.78);
              setL2DepthImbalance(1450);
              setIcebergDepth(2200);
              setSimulatedPrice(spotPrice);
            }}
            className="text-[10px] text-slate-400 hover:text-white underline"
          >
            Auf Default zurücksetzen
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Polymarket Prob */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px]">
              <span className="text-slate-400">Polymarket Wahrscheinlichkeit:</span>
              <span className="text-amber-400 font-bold">{(polyProb * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.10"
              max="0.95"
              step="0.01"
              value={polyProb}
              onChange={e => {
                const val = parseFloat(e.target.value);
                setPolyProb(val);
                onParametersChange?.({ l2Depth: l2DepthImbalance, icebergDepth, polyProb: val });
              }}
              className="w-full accent-amber-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
          </div>

          {/* L2 Depth */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px]">
              <span className="text-slate-400">L2 Visible Depth:</span>
              <span className="text-cyan-400 font-bold">{l2DepthImbalance} BTC</span>
            </div>
            <input
              type="range"
              min="800"
              max="2400"
              step="50"
              value={l2DepthImbalance}
              onChange={e => {
                const val = parseInt(e.target.value, 10);
                setL2DepthImbalance(val);
                onParametersChange?.({ l2Depth: val, icebergDepth, polyProb });
              }}
              className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
          </div>

          {/* Simulated Spot Price */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px]">
              <span className="text-slate-400">Simulierter Spot-Preis:</span>
              <span className="text-white font-bold">${simulatedPrice}</span>
            </div>
            <input
              type="range"
              min={spotPrice - 2000}
              max={spotPrice + 2000}
              step="20"
              value={simulatedPrice}
              onChange={e => setSimulatedPrice(parseInt(e.target.value, 10))}
              className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
