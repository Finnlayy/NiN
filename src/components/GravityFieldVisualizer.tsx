import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Compass,
  Sliders,
  ShieldAlert,
  CheckCircle2,
  Activity,
  Eye,
  EyeOff,
  RotateCcw,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Info,
  Sparkles,
  Zap,
  TrendingUp,
  Target
} from 'lucide-react';
import { ViaNegativaState, GravityFieldState } from '../utils/omegaLogic';

export interface GravityFieldVisualizerProps {
  spotPrice?: number;
  gravityField?: GravityFieldState;
  viaNegativa?: ViaNegativaState;
  onParametersChange?: (params: { l2Depth: number; icebergDepth: number; polyProb: number; pStar: number }) => void;
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
  initialMode?: 'POTENTIAL_WELL' | 'FORCE_GRADIENT' | 'SPLIT_VIEW';
}

interface PotentialPoint {
  price: number;
  vVis: number;
  vBlind: number;
  vPoly: number;
  vTotal: number;
  forceNet: number;
  forceVis: number;
  forceBlind: number;
  forcePoly: number;
}

export default function GravityFieldVisualizer({
  spotPrice = 64280,
  gravityField,
  viaNegativa,
  onParametersChange,
  onLogEvent,
  className = '',
  initialMode = 'POTENTIAL_WELL'
}: GravityFieldVisualizerProps) {
  // Chart Display Mode: Potential Well V(P), Force Gradient F(P), or Dual Split
  const [chartMode, setChartMode] = useState<'POTENTIAL_WELL' | 'FORCE_GRADIENT' | 'SPLIT_VIEW'>(initialMode);
  const [isLiveDrift, setIsLiveDrift] = useState<boolean>(true);

  // Component Visibilities
  const [showTotal, setShowTotal] = useState<boolean>(true);
  const [showVisible, setShowVisible] = useState<boolean>(true);
  const [showBlind, setShowBlind] = useState<boolean>(true);
  const [showPolymarket, setShowPolymarket] = useState<boolean>(true);

  // Field Weights (Blueprint §2: 25% Visible, 35% Blind, 40% Polymarket)
  const wVis = 0.25;
  const wBlind = 0.35;
  const wPoly = 0.40;

  // Interactive Calibrated Parameters
  const [polyProb, setPolyProb] = useState<number>(0.78);
  const [l2Depth, setL2Depth] = useState<number>(1450); // Visible Bids/Asks depth
  const [icebergDepth, setIcebergDepth] = useState<number>(2200); // Shadow hidden depth
  const [simulatedPrice, setSimulatedPrice] = useState<number>(spotPrice);

  // Synchronize with external prop changes
  useEffect(() => {
    if (gravityField?.spotPrice && gravityField.spotPrice !== simulatedPrice) {
      setSimulatedPrice(gravityField.spotPrice);
    }
  }, [gravityField?.spotPrice]);

  // Hover Inspection State
  const [hoveredPoint, setHoveredPoint] = useState<PotentialPoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Organic micro-fluctuation live drift simulation
  useEffect(() => {
    if (!isLiveDrift) return;

    const interval = setInterval(() => {
      const driftVis = (Math.random() - 0.49) * 14;
      const driftIce = (Math.random() - 0.49) * 18;
      const driftPoly = (Math.random() - 0.49) * 0.004;

      setL2Depth(prev => Math.max(600, Math.min(2800, Math.round(prev + driftVis))));
      setIcebergDepth(prev => Math.max(1000, Math.min(4200, Math.round(prev + driftIce))));
      setPolyProb(prev => Math.max(0.15, Math.min(0.95, Number((prev + driftPoly).toFixed(3)))));
    }, 1800);

    return () => clearInterval(interval);
  }, [isLiveDrift]);

  // Sub-component individual potential minima
  const pStarVis = useMemo(() => {
    return Math.round(simulatedPrice + (l2Depth - 1400) * 0.42);
  }, [simulatedPrice, l2Depth]);

  const pStarBlind = useMemo(() => {
    return Math.round(simulatedPrice + (icebergDepth - 2000) * 0.32);
  }, [simulatedPrice, icebergDepth]);

  const pStarPoly = useMemo(() => {
    return Math.round(simulatedPrice + (polyProb - 0.5) * 1050);
  }, [simulatedPrice, polyProb]);

  // Exact composite potential minimum P* (where ∇V_total = 0)
  const pStar = useMemo(() => {
    return Math.round(wVis * pStarVis + wBlind * pStarBlind + wPoly * pStarPoly);
  }, [wVis, wBlind, wPoly, pStarVis, pStarBlind, pStarPoly]);

  // Notify parent component of state change
  useEffect(() => {
    onParametersChange?.({
      l2Depth,
      icebergDepth,
      polyProb,
      pStar
    });
  }, [l2Depth, icebergDepth, polyProb, pStar, onParametersChange]);

  // Delta to Attractor & Gravitational Restoring Force F = -∇V
  const deltaP = useMemo(() => pStar - simulatedPrice, [pStar, simulatedPrice]);
  const forceNetAtSpot = useMemo(() => Number((deltaP * 0.14).toFixed(2)), [deltaP]);

  // Via Negativa Exclusion Boundaries
  const bLower = viaNegativa?.bLower ?? spotPrice - 1800;
  const bUpper = viaNegativa?.bUpper ?? spotPrice + 1800;
  const isSpotForbidden = simulatedPrice <= bLower || simulatedPrice >= bUpper;
  const isPStarForbidden = pStar <= bLower || pStar >= bUpper;

  // Generate Potential & Force Curves across Price Spectrum
  const { points, curvatureKappa } = useMemo(() => {
    const numSteps = 70;
    const priceSpan = 2200; // ±2200 from center
    const startP = simulatedPrice - priceSpan;
    const endP = simulatedPrice + priceSpan;
    const stepSize = (endP - startP) / numSteps;

    const data: PotentialPoint[] = [];
    let minV = Infinity;
    let maxV = -Infinity;

    for (let i = 0; i <= numSteps; i++) {
      const p = Math.round(startP + i * stepSize);

      // Distances from respective component attractors
      const dVis = (p - pStarVis) / 450;
      const dBlind = (p - pStarBlind) / 500;
      const dPoly = (p - pStarPoly) / 420;

      // Parabolic harmonic wells with orderbook & dark-pool perturbations
      const vVisRaw = 18 + Math.pow(dVis, 2) * 28 + Math.sin((p - simulatedPrice) / 160) * 3.5;
      const vBlindRaw = 22 + Math.pow(dBlind, 2) * 32 + Math.cos((p - simulatedPrice) / 210) * 4.2;
      const vPolyRaw = 15 + Math.pow(dPoly, 2) * 38 + (1 - polyProb) * 8;

      const vVis = Number(Math.max(5, Math.min(95, vVisRaw)).toFixed(2));
      const vBlind = Number(Math.max(5, Math.min(95, vBlindRaw)).toFixed(2));
      const vPoly = Number(Math.max(5, Math.min(95, vPolyRaw)).toFixed(2));

      const vTotal = Number((wVis * vVis + wBlind * vBlind + wPoly * vPoly).toFixed(2));

      // Gradient Forces F_i = -dV_i/dP
      const forceVis = Number((-(p - pStarVis) * 0.10 + Math.cos((p - simulatedPrice) / 160) * 5).toFixed(2));
      const forceBlind = Number((-(p - pStarBlind) * 0.13 + Math.sin((p - simulatedPrice) / 210) * 6).toFixed(2));
      const forcePoly = Number((-(p - pStarPoly) * 0.16).toFixed(2));
      const forceNet = Number((wVis * forceVis + wBlind * forceBlind + wPoly * forcePoly).toFixed(2));

      if (vTotal < minV) minV = vTotal;
      if (vTotal > maxV) maxV = vTotal;

      data.push({
        price: p,
        vVis,
        vBlind,
        vPoly,
        vTotal,
        forceNet,
        forceVis,
        forceBlind,
        forcePoly
      });
    }

    // Potential Well Curvature kappa = d^2V/dP^2 at minimum
    const kappa = Number((wVis * 0.28 + wBlind * 0.32 + wPoly * 0.38).toFixed(3));

    return { points: data, minVal: minV, maxVal: maxV, curvatureKappa: kappa };
  }, [simulatedPrice, pStarVis, pStarBlind, pStarPoly, polyProb, wVis, wBlind, wPoly]);

  // SVG Dimensions & Scales
  const svgWidth = 780;
  const svgHeight = chartMode === 'SPLIT_VIEW' ? 360 : 250;
  const padX = 50;
  const padY = 30;
  const plotWidth = svgWidth - 2 * padX;

  const minP = simulatedPrice - 2200;
  const maxP = simulatedPrice + 2200;

  const scaleX = useCallback((p: number) => {
    return padX + ((p - minP) / (maxP - minP)) * plotWidth;
  }, [minP, maxP, padX, plotWidth]);

  // Potential scaling (0-100 on Y-axis)
  const scaleYPotential = useCallback((v: number) => {
    const topY = padY;
    const bottomY = chartMode === 'SPLIT_VIEW' ? (svgHeight / 2) - 15 : svgHeight - padY;
    const clamped = Math.max(0, Math.min(100, v));
    // Lower potential V is positioned toward the bottom (gravitational valley)
    return bottomY - (clamped / 100) * (bottomY - topY);
  }, [padY, chartMode, svgHeight]);

  // Force scaling (-100N to +100N)
  const scaleYForce = useCallback((f: number) => {
    const topY = chartMode === 'SPLIT_VIEW' ? (svgHeight / 2) + 20 : padY;
    const bottomY = svgHeight - padY;
    const midY = topY + (bottomY - topY) / 2;
    const maxF = 90;
    const clamped = Math.max(-maxF, Math.min(maxF, f));
    return midY - (clamped / maxF) * ((bottomY - topY) / 2);
  }, [chartMode, padY, svgHeight]);

  // SVG Paths for Potential Well
  const pathTotalPot = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYPotential(pt.vTotal).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYPotential]);

  const pathVisPot = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYPotential(pt.vVis).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYPotential]);

  const pathBlindPot = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYPotential(pt.vBlind).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYPotential]);

  const pathPolyPot = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYPotential(pt.vPoly).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYPotential]);

  // SVG Paths for Force Gradient
  const pathNetForce = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYForce(pt.forceNet).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYForce]);

  const pathVisForce = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYForce(pt.forceVis).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYForce]);

  const pathBlindForce = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYForce(pt.forceBlind).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYForce]);

  const pathPolyForce = useMemo(() => {
    return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.price).toFixed(1)} ${scaleYForce(pt.forcePoly).toFixed(1)}`).join(' ');
  }, [points, scaleX, scaleYForce]);

  // Current Spot Point on the Total Curve
  const spotPointOnCurve = useMemo(() => {
    const closest = points.reduce((prev, curr) =>
      Math.abs(curr.price - simulatedPrice) < Math.abs(prev.price - simulatedPrice) ? curr : prev
    );
    return {
      x: scaleX(simulatedPrice),
      yPot: scaleYPotential(closest.vTotal),
      yForce: scaleYForce(closest.forceNet),
      vTotal: closest.vTotal,
      forceNet: closest.forceNet
    };
  }, [points, simulatedPrice, scaleX, scaleYPotential, scaleYForce]);

  // Target Minimum P* on Total Curve
  const pStarPointOnCurve = useMemo(() => {
    const closest = points.reduce((prev, curr) =>
      Math.abs(curr.price - pStar) < Math.abs(prev.price - pStar) ? curr : prev
    );
    return {
      x: scaleX(pStar),
      yPot: scaleYPotential(closest.vTotal),
      yForce: scaleYForce(0),
      vTotal: closest.vTotal
    };
  }, [points, pStar, scaleX, scaleYPotential, scaleYForce]);

  // Mouse Hover Interaction Handler
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (mouseX - (padX * rect.width) / svgWidth) / ((plotWidth * rect.width) / svgWidth)));
    const targetPrice = Math.round(minP + ratio * (maxP - minP));

    const closest = points.reduce((prev, curr) =>
      Math.abs(curr.price - targetPrice) < Math.abs(prev.price - targetPrice) ? curr : prev
    );
    setHoveredPoint(closest);
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  // Preset Scenario Handlers
  const applyScenario = (name: string, l2: number, ice: number, poly: number, spotAdj: number = 0) => {
    setL2Depth(l2);
    setIcebergDepth(ice);
    setPolyProb(poly);
    if (spotAdj !== 0) {
      setSimulatedPrice(spotPrice + spotAdj);
    }
    if (onLogEvent) {
      onLogEvent(`Gravitationsfeld-Szenario angewendet: ${name} (L2: ${l2} BTC, Ice: ${ice} BTC, Poly: ${(poly * 100).toFixed(0)}%)`, 'info', 'GravityVisualizer');
    }
  };

  const handleReset = () => {
    setPolyProb(0.78);
    setL2Depth(1450);
    setIcebergDepth(2200);
    setSimulatedPrice(spotPrice);
    if (onLogEvent) {
      onLogEvent('Gravitationsfeld-Parameter auf Standardwerte zurückgesetzt.', 'success', 'GravityVisualizer');
    }
  };

  return (
    <div id="gravity-field-visualizer" className={`glass-card rounded-2xl p-6 shadow-2xl border border-cyan-500/20 text-slate-200 relative overflow-hidden ${className}`}>
      {/* Dynamic Background Glows */}
      <div className="absolute -top-24 -right-24 w-80 h-80 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-80 h-80 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-white/10 relative z-10">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0">
            <Compass className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-white tracking-wide font-mono">
                §2 DREI-KOMPONENTEN-GRAVITATIONSFELD
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                P* = argmin V_total
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                POTENTIAL-WELL DYNAMIK
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Superposition: <strong className="text-cyan-300">0.25·V_vis</strong> (L2 Tiefe) + <strong className="text-purple-300">0.35·V_blind</strong> (Schattenbuch) + <strong className="text-amber-300">0.40·V_poly</strong> (Polymarket)
            </p>
          </div>
        </div>

        {/* View Mode & Live Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-[#0d121f] border border-slate-700/80 rounded-lg p-1 text-xs font-mono">
            <button
              id="gravity-mode-pot"
              onClick={() => setChartMode('POTENTIAL_WELL')}
              className={`px-3 py-1 rounded transition-all flex items-center gap-1.5 ${
                chartMode === 'POTENTIAL_WELL' ? 'bg-cyan-600 text-white shadow-sm font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Potentialtopf V(P)
            </button>
            <button
              id="gravity-mode-force"
              onClick={() => setChartMode('FORCE_GRADIENT')}
              className={`px-3 py-1 rounded transition-all flex items-center gap-1.5 ${
                chartMode === 'FORCE_GRADIENT' ? 'bg-cyan-600 text-white shadow-sm font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Kraftgradient F(P)
            </button>
            <button
              id="gravity-mode-split"
              onClick={() => setChartMode('SPLIT_VIEW')}
              className={`px-3 py-1 rounded transition-all flex items-center gap-1.5 ${
                chartMode === 'SPLIT_VIEW' ? 'bg-cyan-600 text-white shadow-sm font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              Dual-Topf &amp; Kraft
            </button>
          </div>

          <button
            id="gravity-toggle-drift"
            onClick={() => setIsLiveDrift(!isLiveDrift)}
            className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              isLiveDrift
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20'
                : 'bg-amber-500/10 border-amber-500/40 text-amber-400 hover:bg-amber-500/20'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isLiveDrift ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`} />
            {isLiveDrift ? 'Drift Aktiv' : 'Gefroren'}
          </button>

          <button
            id="gravity-reset-btn"
            onClick={handleReset}
            title="Auf Standardwerte zurücksetzen"
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Physics HUD Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 my-5">
        {/* Attractor P* Card */}
        <div className="p-3.5 rounded-xl bg-[#0e1726] border border-emerald-500/40 shadow-sm shadow-emerald-500/10">
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <span className="text-emerald-400 font-bold uppercase flex items-center gap-1">
              <Target className="w-3.5 h-3.5" />
              Potentialminimum P*
            </span>
            <span className="text-[10px] text-slate-400">∇V = 0</span>
          </div>
          <div className="flex items-baseline justify-between mt-1.5">
            <span className="text-2xl font-mono font-bold text-emerald-300">
              ${pStar.toLocaleString()}
            </span>
            <span className={`text-xs font-mono font-bold ${deltaP >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {deltaP >= 0 ? `+${deltaP}` : deltaP} $
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Zustand:</span>
            {isPStarForbidden ? (
              <span className="text-rose-400 font-bold flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" /> Verbotene Zone!
              </span>
            ) : (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Stabil im Toleranzband
              </span>
            )}
          </div>
        </div>

        {/* Current Spot Particle Card */}
        <div className="p-3.5 rounded-xl bg-[#0f1422] border border-cyan-500/30 shadow-sm shadow-cyan-500/10">
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <span className="text-cyan-400 font-bold uppercase flex items-center gap-1">
              <Activity className="w-3.5 h-3.5" />
              Spot-Position P
            </span>
            <span className="text-[10px] text-slate-400">Teilchen</span>
          </div>
          <div className="flex items-baseline justify-between mt-1.5">
            <span className="text-2xl font-mono font-bold text-white">
              ${simulatedPrice.toLocaleString()}
            </span>
            <span className="text-xs font-mono text-slate-400">
              Kraken L2
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Axiom 1 (Via Neg.):</span>
            {isSpotForbidden ? (
              <span className="text-rose-400 font-bold">VETO AKTIV</span>
            ) : (
              <span className="text-cyan-400">Erlaubter Bereich</span>
            )}
          </div>
        </div>

        {/* Net Gravitational Force Card */}
        <div className="p-3.5 rounded-xl bg-[#141829] border border-purple-500/30 shadow-sm shadow-purple-500/10">
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <span className="text-purple-400 font-bold uppercase flex items-center gap-1">
              <Zap className="w-3.5 h-3.5" />
              Gravitationskraft F
            </span>
            <span className="text-[10px] text-slate-400 font-mono">-∇V_total</span>
          </div>
          <div className="flex items-baseline justify-between mt-1.5">
            <span className={`text-2xl font-mono font-bold ${forceNetAtSpot >= 0 ? 'text-cyan-300' : 'text-rose-300'}`}>
              {forceNetAtSpot >= 0 ? `+${forceNetAtSpot}` : forceNetAtSpot}
              <span className="text-xs text-slate-400 font-normal ml-1">N</span>
            </span>
            <div className="flex items-center gap-1 text-xs font-mono font-bold">
              {forceNetAtSpot > 2 ? (
                <span className="text-emerald-400 flex items-center"><ArrowUpRight className="w-4 h-4" /> Zug nach OBEN</span>
              ) : forceNetAtSpot < -2 ? (
                <span className="text-rose-400 flex items-center"><ArrowDownRight className="w-4 h-4" /> Zug nach UNTEN</span>
              ) : (
                <span className="text-slate-400 flex items-center"><Minus className="w-4 h-4" /> Gleichgewicht</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Feldkrümmung κ:</span>
            <span className="text-slate-200 font-bold">{curvatureKappa} N/m</span>
          </div>
        </div>

        {/* Polymarket Bias Card */}
        <div className="p-3.5 rounded-xl bg-[#1c1810] border border-amber-500/30 shadow-sm shadow-amber-500/10">
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <span className="text-amber-400 font-bold uppercase flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5" />
              Polymarket Erwartung
            </span>
            <span className="text-[10px] text-amber-300 font-bold">Gewicht: 40%</span>
          </div>
          <div className="flex items-baseline justify-between mt-1.5">
            <span className="text-2xl font-mono font-bold text-amber-300">
              {(polyProb * 100).toFixed(0)}% Up
            </span>
            <span className="text-xs font-mono text-slate-400">
              P*poly: ${pStarPoly.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Wichtigster Vektor:</span>
            <span className="text-amber-400 font-semibold">Dominanter Anker</span>
          </div>
        </div>
      </div>

      {/* SVG Canvas Area */}
      <div className="relative w-full rounded-xl bg-[#080b13] border border-slate-800/80 p-3 shadow-inner">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-auto select-none"
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            {/* Total Potential Well Gradient Fill */}
            <linearGradient id="potTotalGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
              <stop offset="60%" stopColor="#06b6d4" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
            </linearGradient>

            {/* Force Positive & Negative Shading */}
            <linearGradient id="forceBullishGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="forceBearishGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.0" />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.08" />
            </linearGradient>

            {/* Forbidden Zone Diagonal Hatching */}
            <pattern id="forbiddenHatchGV" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="10" stroke="#f43f5e" strokeWidth="1.8" strokeOpacity="0.25" />
            </pattern>

            {/* Force Direction Arrowhead */}
            <marker id="gvArrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#38bdf8" />
            </marker>
          </defs>

          {/* Via Negativa Exclusion Zones (Forbidden) */}
          {scaleX(bLower) > padX && (
            <rect
              x={padX}
              y={padY}
              width={Math.max(0, scaleX(bLower) - padX)}
              height={svgHeight - 2 * padY}
              fill="url(#forbiddenHatchGV)"
            />
          )}
          {scaleX(bUpper) < svgWidth - padX && (
            <rect
              x={scaleX(bUpper)}
              y={padY}
              width={Math.max(0, svgWidth - padX - scaleX(bUpper))}
              height={svgHeight - 2 * padY}
              fill="url(#forbiddenHatchGV)"
            />
          )}

          {/* Via Negativa Boundary Lines */}
          <line
            x1={scaleX(bLower)}
            y1={padY}
            x2={scaleX(bLower)}
            y2={svgHeight - padY}
            stroke="#f43f5e"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text x={scaleX(bLower) - 6} y={padY + 12} fill="#f43f5e" fontSize="9" textAnchor="end" fontFamily="monospace">
            B_lower (${bLower})
          </text>

          <line
            x1={scaleX(bUpper)}
            y1={padY}
            x2={scaleX(bUpper)}
            y2={svgHeight - padY}
            stroke="#f43f5e"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text x={scaleX(bUpper) + 6} y={padY + 12} fill="#f43f5e" fontSize="9" textAnchor="start" fontFamily="monospace">
            B_upper (${bUpper})
          </text>

          {/* ========================================================== */}
          {/* SECTION 1: POTENTIAL WELL VIEW V(P)                        */}
          {/* ========================================================== */}
          {(chartMode === 'POTENTIAL_WELL' || chartMode === 'SPLIT_VIEW') && (
            <g>
              {/* Horizontal Reference Lines for Potential */}
              <line x1={padX} y1={scaleYPotential(20)} x2={svgWidth - padX} y2={scaleYPotential(20)} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 3" />
              <line x1={padX} y1={scaleYPotential(50)} x2={svgWidth - padX} y2={scaleYPotential(50)} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 3" />
              <line x1={padX} y1={scaleYPotential(80)} x2={svgWidth - padX} y2={scaleYPotential(80)} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 3" />

              <text x={padX - 8} y={scaleYPotential(20) + 3} fill="#64748b" fontSize="8" textAnchor="end" fontFamily="monospace">V=20</text>
              <text x={padX - 8} y={scaleYPotential(50) + 3} fill="#64748b" fontSize="8" textAnchor="end" fontFamily="monospace">V=50</text>
              <text x={padX - 8} y={scaleYPotential(80) + 3} fill="#64748b" fontSize="8" textAnchor="end" fontFamily="monospace">V=80</text>

              {/* Sub-potential 1: Visible (Cyan dashed) */}
              {showVisible && (
                <path d={pathVisPot} fill="none" stroke="#22d3ee" strokeWidth="1.4" strokeDasharray="4 3" strokeOpacity="0.7" />
              )}

              {/* Sub-potential 2: Blind (Purple dashed) */}
              {showBlind && (
                <path d={pathBlindPot} fill="none" stroke="#c084fc" strokeWidth="1.4" strokeDasharray="4 3" strokeOpacity="0.7" />
              )}

              {/* Sub-potential 3: Polymarket (Amber dashed) */}
              {showPolymarket && (
                <path d={pathPolyPot} fill="none" stroke="#f59e0b" strokeWidth="1.4" strokeDasharray="4 3" strokeOpacity="0.7" />
              )}

              {/* Composite Total Potential V_total (Cyan Solid with Fill) */}
              {showTotal && (
                <>
                  <path
                    d={`${pathTotalPot} L ${scaleX(maxP)} ${scaleYPotential(0)} L ${scaleX(minP)} ${scaleYPotential(0)} Z`}
                    fill="url(#potTotalGradient)"
                  />
                  <path d={pathTotalPot} fill="none" stroke="#06b6d4" strokeWidth="2.8" strokeLinecap="round" />
                </>
              )}

              {/* Potential Minimum P* Vertical Marker & Anchor Badge */}
              <line
                x1={scaleX(pStar)}
                y1={padY}
                x2={scaleX(pStar)}
                y2={chartMode === 'SPLIT_VIEW' ? svgHeight / 2 - 15 : svgHeight - padY}
                stroke="#10b981"
                strokeWidth="1.8"
                strokeDasharray="3 2"
              />
              <circle cx={scaleX(pStar)} cy={pStarPointOnCurve.yPot} r="5" fill="#10b981" className="animate-pulse" />
              <circle cx={scaleX(pStar)} cy={pStarPointOnCurve.yPot} r="9" fill="none" stroke="#10b981" strokeWidth="1.5" strokeOpacity="0.4" />

              {/* P* Label */}
              <g transform={`translate(${scaleX(pStar)}, ${padY + 12})`}>
                <rect x="-42" y="-12" width="84" height="18" rx="4" fill="#042f2e" stroke="#10b981" strokeWidth="1" />
                <text x="0" y="0" fill="#34d399" fontSize="10" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
                  P* (${pStar})
                </text>
              </g>

              {/* Current Spot Particle Rolling on V_total Curve */}
              <circle cx={spotPointOnCurve.x} cy={spotPointOnCurve.yPot} r="6" fill={isSpotForbidden ? '#f43f5e' : '#38bdf8'} />
              <circle cx={spotPointOnCurve.x} cy={spotPointOnCurve.yPot} r="11" fill="none" stroke={isSpotForbidden ? '#f43f5e' : '#38bdf8'} strokeWidth="1.5" strokeOpacity="0.5" />

              {/* Restoring Force Vector Arrow pointing toward P* */}
              {Math.abs(forceNetAtSpot) > 1 && (
                <line
                  x1={spotPointOnCurve.x}
                  y1={spotPointOnCurve.yPot}
                  x2={spotPointOnCurve.x + (forceNetAtSpot > 0 ? 32 : -32)}
                  y2={spotPointOnCurve.yPot}
                  stroke="#38bdf8"
                  strokeWidth="2.2"
                  markerEnd="url(#gvArrow)"
                />
              )}
            </g>
          )}

          {/* ========================================================== */}
          {/* SECTION 2: FORCE GRADIENT VIEW F(P) = -∇V                 */}
          {/* ========================================================== */}
          {(chartMode === 'FORCE_GRADIENT' || chartMode === 'SPLIT_VIEW') && (
            <g>
              {/* Shading for positive (bullish) and negative (bearish) force zones */}
              <rect
                x={padX}
                y={chartMode === 'SPLIT_VIEW' ? svgHeight / 2 + 20 : padY}
                width={plotWidth}
                height={(chartMode === 'SPLIT_VIEW' ? (svgHeight - padY - (svgHeight / 2 + 20)) : (svgHeight - 2 * padY)) / 2}
                fill="url(#forceBullishGrad)"
              />
              <rect
                x={padX}
                y={scaleYForce(0)}
                width={plotWidth}
                height={(chartMode === 'SPLIT_VIEW' ? (svgHeight - padY - (svgHeight / 2 + 20)) : (svgHeight - 2 * padY)) / 2}
                fill="url(#forceBearishGrad)"
              />

              {/* Equilibrium Zero-Force Line (F = 0) */}
              <line
                x1={padX}
                y1={scaleYForce(0)}
                x2={svgWidth - padX}
                y2={scaleYForce(0)}
                stroke="#475569"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
              <text x={padX - 8} y={scaleYForce(0) + 3} fill="#94a3b8" fontSize="8" textAnchor="end" fontFamily="monospace">
                0N (GLGW)
              </text>
              <text x={padX - 8} y={scaleYForce(60) + 3} fill="#10b981" fontSize="8" textAnchor="end" fontFamily="monospace">
                +60N
              </text>
              <text x={padX - 8} y={scaleYForce(-60) + 3} fill="#f43f5e" fontSize="8" textAnchor="end" fontFamily="monospace">
                -60N
              </text>

              {/* Sub-component Force Curves */}
              {showVisible && (
                <path d={pathVisForce} fill="none" stroke="#22d3ee" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.7" />
              )}
              {showBlind && (
                <path d={pathBlindForce} fill="none" stroke="#c084fc" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.7" />
              )}
              {showPolymarket && (
                <path d={pathPolyForce} fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.7" />
              )}

              {/* Net Force Curve F_net (Solid Emerald Curve Crossing 0 at P*) */}
              {showTotal && (
                <>
                  <path d={pathNetForce} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" />
                  {/* Spot Marker on Net Force Curve */}
                  <circle cx={spotPointOnCurve.x} cy={spotPointOnCurve.yForce} r="5" fill="#10b981" />
                </>
              )}

              {/* P* Zero-Crossing Marker */}
              <circle cx={scaleX(pStar)} cy={scaleYForce(0)} r="4" fill="#10b981" />
              <line
                x1={scaleX(pStar)}
                y1={chartMode === 'SPLIT_VIEW' ? svgHeight / 2 + 20 : padY}
                x2={scaleX(pStar)}
                y2={svgHeight - padY}
                stroke="#10b981"
                strokeWidth="1.5"
                strokeDasharray="2 2"
              />
            </g>
          )}

          {/* Current Spot Price Vertical Guideline */}
          <line
            x1={scaleX(simulatedPrice)}
            y1={padY}
            x2={scaleX(simulatedPrice)}
            y2={svgHeight - padY}
            stroke="#38bdf8"
            strokeWidth="1.5"
          />
          <text
            x={scaleX(simulatedPrice)}
            y={svgHeight - padY + 14}
            fill="#38bdf8"
            fontSize="10"
            textAnchor="middle"
            fontFamily="monospace"
            fontWeight="bold"
          >
            Spot (${simulatedPrice.toLocaleString()})
          </text>

          {/* Crosshair on Hover */}
          {hoveredPoint && (
            <g>
              <line
                x1={scaleX(hoveredPoint.price)}
                y1={padY}
                x2={scaleX(hoveredPoint.price)}
                y2={svgHeight - padY}
                stroke="#ffffff"
                strokeWidth="1"
                strokeDasharray="2 2"
                strokeOpacity="0.6"
              />
              <circle
                cx={scaleX(hoveredPoint.price)}
                cy={chartMode === 'FORCE_GRADIENT' ? scaleYForce(hoveredPoint.forceNet) : scaleYPotential(hoveredPoint.vTotal)}
                r="4"
                fill="#ffffff"
              />
            </g>
          )}
        </svg>

        {/* Floating Tooltip Crosshair Inspector */}
        {hoveredPoint && (
          <div className="absolute top-4 right-4 bg-[#0d121f]/95 border border-cyan-500/40 rounded-xl p-3 shadow-2xl backdrop-blur-md font-mono text-xs z-20 pointer-events-none">
            <div className="text-white font-bold border-b border-slate-700 pb-1.5 mb-2 flex items-center justify-between gap-4">
              <span>Kurs: ${hoveredPoint.price.toLocaleString()}</span>
              <span className={hoveredPoint.forceNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {hoveredPoint.forceNet >= 0 ? `+${hoveredPoint.forceNet} N` : `${hoveredPoint.forceNet} N`}
              </span>
            </div>
            <div className="space-y-1 text-[11px]">
              <div className="flex items-center justify-between gap-3 text-cyan-300">
                <span>V_vis (25%):</span>
                <span>{hoveredPoint.vVis} J | {hoveredPoint.forceVis > 0 ? `+${hoveredPoint.forceVis}` : hoveredPoint.forceVis}N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-purple-300">
                <span>V_blind (35%):</span>
                <span>{hoveredPoint.vBlind} J | {hoveredPoint.forceBlind > 0 ? `+${hoveredPoint.forceBlind}` : hoveredPoint.forceBlind}N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-amber-300">
                <span>V_poly (40%):</span>
                <span>{hoveredPoint.vPoly} J | {hoveredPoint.forcePoly > 0 ? `+${hoveredPoint.forcePoly}` : hoveredPoint.forcePoly}N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-emerald-300 font-bold pt-1.5 border-t border-slate-800">
                <span>V_total (Effektiv):</span>
                <span>{hoveredPoint.vTotal} J</span>
              </div>
            </div>
          </div>
        )}

        {/* Legend Controls & Component Toggles */}
        <div className="flex items-center justify-between gap-4 mt-3 pt-2.5 border-t border-slate-800/80 text-[11px] font-mono text-slate-400 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setShowTotal(!showTotal)}
              className={`flex items-center gap-1.5 transition-opacity ${showTotal ? 'text-cyan-300 font-bold' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-1 bg-cyan-400 rounded-full" />
              <span>V_total / F_net (Effektiv)</span>
              {showTotal ? <Eye className="w-3 h-3 text-cyan-400" /> : <EyeOff className="w-3 h-3" />}
            </button>

            <button
              onClick={() => setShowVisible(!showVisible)}
              className={`flex items-center gap-1.5 transition-opacity ${showVisible ? 'text-cyan-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-cyan-400 border-b border-dashed" />
              <span>V_vis (L2 Tiefe - 25%)</span>
              {showVisible ? <Eye className="w-3 h-3 text-cyan-400" /> : <EyeOff className="w-3 h-3" />}
            </button>

            <button
              onClick={() => setShowBlind(!showBlind)}
              className={`flex items-center gap-1.5 transition-opacity ${showBlind ? 'text-purple-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-purple-400 border-b border-dashed" />
              <span>V_blind (Schatten - 35%)</span>
              {showBlind ? <Eye className="w-3 h-3 text-purple-400" /> : <EyeOff className="w-3 h-3" />}
            </button>

            <button
              onClick={() => setShowPolymarket(!showPolymarket)}
              className={`flex items-center gap-1.5 transition-opacity ${showPolymarket ? 'text-amber-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-amber-400 border-b border-dashed" />
              <span>V_poly (Polymarket - 40%)</span>
              {showPolymarket ? <Eye className="w-3 h-3 text-amber-400" /> : <EyeOff className="w-3 h-3" />}
            </button>
          </div>

          <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
            <span>Minimum: <strong className="text-emerald-400 font-bold">P* = ${pStar.toLocaleString()}</strong></span>
            <span>•</span>
            <span>Distanz: <strong className={deltaP >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{deltaP} $</strong></span>
          </div>
        </div>
      </div>

      {/* Interactive Parameter Calibration Sliders & Scenarios */}
      <div className="mt-5 pt-4 border-t border-slate-700/60 font-mono text-xs space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-white font-bold">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <span>GRAVITATIONS-PARAMETER KALIBRIERUNG &amp; SZENARIEN:</span>
          </div>

          {/* Quick Preset Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-slate-400 mr-1">Szenarien:</span>
            <button
              onClick={() => applyScenario('Polymarket Bull Shock', 1600, 2400, 0.92)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 text-[11px] transition-colors border border-slate-700"
            >
              Polymarket Shock (92%)
            </button>
            <button
              onClick={() => applyScenario('Dark Pool Wall Absorption', 1200, 4100, 0.68)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 text-[11px] transition-colors border border-slate-700"
            >
              Iceberg Wall (4100 BTC)
            </button>
            <button
              onClick={() => applyScenario('Orderbook Asks Squeeze', 2500, 2100, 0.72)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] transition-colors border border-slate-700"
            >
              L2 Squeeze (2500 BTC)
            </button>
            <button
              onClick={() => applyScenario('Harmonisches Gleichgewicht', 1400, 2000, 0.50)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 text-[11px] transition-colors border border-slate-700"
            >
              Gleichgewicht (P* = Spot)
            </button>
          </div>
        </div>

        {/* 4 Interactive Calibration Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-[#0a0d16] p-4 rounded-xl border border-slate-800/80">
          {/* Slider 1: Polymarket Probability */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-amber-400 font-semibold flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                Polymarket Wahrsch. (40%)
              </span>
              <span className="font-bold text-amber-300">{(polyProb * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.10"
              max="0.95"
              step="0.01"
              value={polyProb}
              onChange={(e) => setPolyProb(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Bärisch (10%)</span>
              <span>Bullisch (95%)</span>
            </div>
          </div>

          {/* Slider 2: Visible L2 Depth */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-cyan-400 font-semibold flex items-center gap-1">
                <Layers className="w-3 h-3" />
                Sichtbare L2-Tiefe (25%)
              </span>
              <span className="font-bold text-cyan-300">{l2Depth} BTC</span>
            </div>
            <input
              type="range"
              min="600"
              max="2800"
              step="50"
              value={l2Depth}
              onChange={(e) => setL2Depth(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Asks Druck</span>
              <span>Bids Stütze</span>
            </div>
          </div>

          {/* Slider 3: Blind Iceberg Depth */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-purple-400 font-semibold flex items-center gap-1">
                <Zap className="w-3 h-3" />
                Schatten-Tiefe (35%)
              </span>
              <span className="font-bold text-purple-300">{icebergDepth} BTC</span>
            </div>
            <input
              type="range"
              min="1000"
              max="4200"
              step="50"
              value={icebergDepth}
              onChange={(e) => setIcebergDepth(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Flache Order</span>
              <span>Tiefe Absorption</span>
            </div>
          </div>

          {/* Slider 4: Simulated Spot Price */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-300 font-semibold flex items-center gap-1">
                <Activity className="w-3 h-3" />
                Simulierter Spot-Kurs P
              </span>
              <span className="font-bold text-white">${simulatedPrice.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={spotPrice - 1800}
              max={spotPrice + 1800}
              step="25"
              value={simulatedPrice}
              onChange={(e) => setSimulatedPrice(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>-${1800}</span>
              <span>+${1800}</span>
            </div>
          </div>
        </div>

        {/* Theoretical Axiom Context Footer */}
        <div className="p-3 bg-white/[0.02] rounded-xl border border-white/5 text-[11px] text-slate-400 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-slate-200">Axiom §14.2 &amp; Blueprint §2 Konformität: </span>
            Das Potentialminimum $P^*$ definiert den stochastischen Gleichgewichtspunkt des Marktes. Orders in Richtung -∇V_total nutzen die thermodynamische Entropie des Orderbuchs. Trades entgegen des Feldgradienten sind durch Axiom 14.2 (Potentialerhaltung) strikt veto-belegt.
          </div>
        </div>
      </div>
    </div>
  );
}
