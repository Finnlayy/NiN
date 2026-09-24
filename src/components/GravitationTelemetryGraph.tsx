import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  Compass, 
  Activity, 
  Eye, 
  EyeOff, 
  RotateCcw, 
  Sliders, 
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Minus
} from 'lucide-react';
import { 
  GravityFieldState, 
  ViaNegativaState,
  calculateGravitationForces, 
  generateGravitationForceProfile,
  GravityForceVectorTelemetry,
  GravityForceCurvePoint
} from '../utils/omegaLogic';

interface GravitationTelemetryGraphProps {
  gravityField?: GravityFieldState;
  viaNegativa?: ViaNegativaState;
  spotPrice?: number;
  visibleL2Depth?: number;
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
  className?: string;
}

interface TimeSeriesDataPoint {
  timeLabel: string;
  timestamp: number;
  fVis: number;
  fBlind: number;
  fPoly: number;
  fNet: number;
}

export default function GravitationTelemetryGraph({
  gravityField,
  viaNegativa,
  spotPrice,
  visibleL2Depth,
  onLogEvent,
  className = ''
}: GravitationTelemetryGraphProps) {
  // Graph Mode: Spatial Profile F(P) or Temporal Stream F(t)
  const [graphMode, setGraphMode] = useState<'PROFILE' | 'STREAM'>('PROFILE');
  const [isStreaming, setIsStreaming] = useState(true);

  // Component visibility toggles
  const [showVis, setShowVis] = useState(true);
  const [showBlind, setShowBlind] = useState(true);
  const [showPoly, setShowPoly] = useState(true);
  const [showNet, setShowNet] = useState(true);

  // Simulation Sliders
  const [l2Depth, setL2Depth] = useState(visibleL2Depth && visibleL2Depth > 0 ? visibleL2Depth : 0);
  const [icebergDepth, setIcebergDepth] = useState(2200);
  const [polyProb, setPolyProb] = useState(0.78);
  const [currentSpot, setCurrentSpot] = useState(spotPrice ?? 0);

  // Interactive Hover State
  const [hoveredPoint, setHoveredPoint] = useState<GravityForceCurvePoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Time-series rolling buffer
  const [timeSeries, setTimeSeries] = useState<TimeSeriesDataPoint[]>(() => {
    const initial: TimeSeriesDataPoint[] = [];
    const now = Date.now();
    for (let i = 24; i >= 0; i--) {
      const t = now - i * 1500;
      const forces = calculateGravitationForces(spotPrice ?? 0, visibleL2Depth);
      const jitter = Math.sin(i * 0.4) * 4;
      initial.push({
        timeLabel: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        timestamp: t,
        fVis: Number((forces.forceVisible + jitter * 0.8).toFixed(2)),
        fBlind: Number((forces.forceBlind - jitter * 0.5).toFixed(2)),
        fPoly: Number((forces.forcePolymarket + jitter * 0.3).toFixed(2)),
        fNet: Number((forces.forceNet + jitter * 0.5).toFixed(2)),
      });
    }
    return initial;
  });

  // Sync with incoming prop changes
  useEffect(() => {
    if (gravityField?.spotPrice) {
      setCurrentSpot(gravityField.spotPrice);
    }
  }, [gravityField?.spotPrice]);

  // Live real-time tick for streaming mode and vector telemetry
  useEffect(() => {
    if (!isStreaming) return;

    const interval = setInterval(() => {
      // Natural micro-oscillations in orderbook depth and probability
      const driftVis = (Math.random() - 0.48) * 15;
      const driftBlind = (Math.random() - 0.49) * 20;
      const driftPoly = (Math.random() - 0.48) * 0.005;

      setL2Depth(prev => Math.max(500, Math.min(3000, Math.round(prev + driftVis))));
      setIcebergDepth(prev => Math.max(800, Math.min(4500, Math.round(prev + driftBlind))));
      setPolyProb(prev => Math.max(0.2, Math.min(0.98, Number((prev + driftPoly).toFixed(3)))));

      const forces = calculateGravitationForces(currentSpot, l2Depth);
      const now = Date.now();

      setTimeSeries(prev => {
        const nextPoint: TimeSeriesDataPoint = {
          timeLabel: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: now,
          fVis: forces.forceVisible,
          fBlind: forces.forceBlind,
          fPoly: forces.forcePolymarket,
          fNet: forces.forceNet,
        };
        const updated = [...prev, nextPoint];
        return updated.length > 30 ? updated.slice(updated.length - 30) : updated;
      });
    }, 1500);

    return () => clearInterval(interval);
  }, [isStreaming, currentSpot, l2Depth, icebergDepth, polyProb]);

  // Current Instantaneous Vector
  const vectorTelemetry: GravityForceVectorTelemetry = useMemo(() => {
    return calculateGravitationForces(currentSpot, l2Depth);
  }, [currentSpot, l2Depth, icebergDepth, polyProb]);

  // Profile curve points across price spectrum
  const profilePoints: GravityForceCurvePoint[] = useMemo(() => {
    return generateGravitationForceProfile(currentSpot, l2Depth, undefined, undefined, Math.max(currentSpot * 0.02, 1), 60);
  }, [currentSpot, l2Depth, icebergDepth, polyProb]);

  // Dimensions for SVG Graphs
  const width = 800;
  const height = 280;
  const padX = 55;
  const padY = 35;
  const plotWidth = width - 2 * padX;
  const plotHeight = height - 2 * padY;

  // Coordinate scales for Profile Mode F(P)
  const priceSpan = Math.max(currentSpot * 0.02, 1);
  const minPrice = currentSpot - priceSpan;
  const maxPrice = currentSpot + priceSpan;
  const maxAbsForce = 120; // -120N to +120N

  const scaleXProfile = useCallback((p: number) => {
    return padX + ((p - minPrice) / (maxPrice - minPrice)) * plotWidth;
  }, [minPrice, maxPrice, padX, plotWidth]);

  const scaleYForce = useCallback((f: number) => {
    // 0 force is at center (padY + plotHeight / 2)
    // +maxForce is at top (padY)
    // -maxForce is at bottom (padY + plotHeight)
    const clamped = Math.max(-maxAbsForce, Math.min(maxAbsForce, f));
    return padY + (plotHeight / 2) - (clamped / maxAbsForce) * (plotHeight / 2);
  }, [padY, plotHeight, maxAbsForce]);

  // Coordinate scales for Stream Mode F(t)
  const scaleXStream = useCallback((idx: number, total: number) => {
    return padX + (idx / Math.max(1, total - 1)) * plotWidth;
  }, [padX, plotWidth]);

  // Paths for Profile Mode
  const pathVisProfile = useMemo(() => {
    return profilePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXProfile(pt.price).toFixed(1)} ${scaleYForce(pt.fVis).toFixed(1)}`).join(' ');
  }, [profilePoints, scaleXProfile, scaleYForce]);

  const pathBlindProfile = useMemo(() => {
    return profilePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXProfile(pt.price).toFixed(1)} ${scaleYForce(pt.fBlind).toFixed(1)}`).join(' ');
  }, [profilePoints, scaleXProfile, scaleYForce]);

  const pathPolyProfile = useMemo(() => {
    return profilePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXProfile(pt.price).toFixed(1)} ${scaleYForce(pt.fPoly).toFixed(1)}`).join(' ');
  }, [profilePoints, scaleXProfile, scaleYForce]);

  const pathNetProfile = useMemo(() => {
    return profilePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXProfile(pt.price).toFixed(1)} ${scaleYForce(pt.fNet).toFixed(1)}`).join(' ');
  }, [profilePoints, scaleXProfile, scaleYForce]);

  // Paths for Stream Mode
  const pathVisStream = useMemo(() => {
    return timeSeries.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXStream(i, timeSeries.length).toFixed(1)} ${scaleYForce(pt.fVis).toFixed(1)}`).join(' ');
  }, [timeSeries, scaleXStream, scaleYForce]);

  const pathBlindStream = useMemo(() => {
    return timeSeries.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXStream(i, timeSeries.length).toFixed(1)} ${scaleYForce(pt.fBlind).toFixed(1)}`).join(' ');
  }, [timeSeries, scaleXStream, scaleYForce]);

  const pathPolyStream = useMemo(() => {
    return timeSeries.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXStream(i, timeSeries.length).toFixed(1)} ${scaleYForce(pt.fPoly).toFixed(1)}`).join(' ');
  }, [timeSeries, scaleXStream, scaleYForce]);

  const pathNetStream = useMemo(() => {
    return timeSeries.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleXStream(i, timeSeries.length).toFixed(1)} ${scaleYForce(pt.fNet).toFixed(1)}`).join(' ');
  }, [timeSeries, scaleXStream, scaleYForce]);

  // Via Negativa Bounds
  const hasBands = viaNegativa != null;
  const bLower = viaNegativa?.bLower ?? currentSpot;
  const bUpper = viaNegativa?.bUpper ?? currentSpot;

  // Handle interactive SVG hover
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (graphMode !== 'PROFILE' || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (mouseX - (padX * rect.width) / width) / ((plotWidth * rect.width) / width)));
    const targetPrice = Math.round(minPrice + ratio * (maxPrice - minPrice));

    // Find nearest point
    const closest = profilePoints.reduce((prev, curr) =>
      Math.abs(curr.price - targetPrice) < Math.abs(prev.price - targetPrice) ? curr : prev
    );
    setHoveredPoint(closest);
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  // Preset scenarios
  const applyPreset = (name: string, l2: number, ice: number, poly: number) => {
    setL2Depth(l2);
    setIcebergDepth(ice);
    setPolyProb(poly);
    if (onLogEvent) {
      onLogEvent(`Gravitation Field preset engaged: ${name} (L2: ${l2}, Ice: ${ice}, Poly: ${poly * 100}%)`, 'info', 'Gravitation Telemetry');
    }
  };

  const resetToLive = () => {
    if (visibleL2Depth && visibleL2Depth > 0) setL2Depth(visibleL2Depth);
    if (typeof spotPrice === 'number') setCurrentSpot(spotPrice);
    if (onLogEvent) {
      onLogEvent("Reset Gravitation Field parameters to live exchange baseline.", 'success', 'Gravitation Telemetry');
    }
  };

  if (!(typeof spotPrice === 'number' && spotPrice > 0)) {
    return (
      <div className={`glass-card rounded-2xl p-6 border border-slate-700 text-slate-300 ${className}`} role="status">
        <h2 className="text-base font-bold text-white font-mono">Gravitations-Telemetrie</h2>
        <p className="text-sm text-slate-400 mt-2">Kraken-Quote fehlt. Der Kraftverlauf bleibt leer, bis ein Lastkurs vorliegt.</p>
      </div>
    );
  }

  return (
    <div className={`glass-card rounded-2xl p-6 shadow-2xl border border-slate-700/60 text-slate-200 relative overflow-hidden ${className}`}>
      {/* Subtle Background Glow */}
      <div className="absolute -top-24 -right-24 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-700/60">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0">
            <Compass className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-white tracking-wider font-mono">
                §2 DREI-KOMPONENTEN-GRAVITATIONSFELDKRÄFTE
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                F_net = -∇V_total
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
                <Activity className="w-3 h-3" />
                ECHTZEIT-TELEMETRIE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Vektorieller Kraftgradient: <strong className="text-cyan-300">F_vis (25%)</strong> + <strong className="text-purple-300">F_blind (35%)</strong> + <strong className="text-amber-300">F_poly (40%)</strong>
            </p>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* View Mode Toggle */}
          <div className="flex items-center bg-[#151926] border border-slate-700/80 rounded-lg p-1 text-xs font-mono font-semibold">
            <button
              onClick={() => setGraphMode('PROFILE')}
              className={`px-3 py-1 rounded transition-all flex items-center gap-1.5 ${
                graphMode === 'PROFILE' ? 'bg-cyan-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Kraft-Profil F(P)
            </button>
            <button
              onClick={() => setGraphMode('STREAM')}
              className={`px-3 py-1 rounded transition-all flex items-center gap-1.5 ${
                graphMode === 'STREAM' ? 'bg-cyan-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              Zeit-Stream F(t)
            </button>
          </div>

          {/* Stream Pause/Resume */}
          <button
            onClick={() => setIsStreaming(!isStreaming)}
            className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              isStreaming 
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20' 
                : 'bg-amber-500/10 border-amber-500/40 text-amber-400 hover:bg-amber-500/20'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`} />
            {isStreaming ? 'Live Tick' : 'Pausiert'}
          </button>

          {/* Reset Baseline */}
          <button
            onClick={resetToLive}
            title="Auf Kraken L2 Live-Werte zurücksetzen"
            aria-label="Auf Kraken L2 Live-Werte zurücksetzen"
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 4 Interactive Telemetry Vector Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 my-5">
        {/* Card 1: Visible Force */}
        <div 
          onClick={() => setShowVis(!showVis)}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none ${
            showVis 
              ? 'bg-[#121929] border-cyan-500/40 shadow-sm shadow-cyan-500/10' 
              : 'bg-[#0f1420]/60 border-slate-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
              <span className="text-cyan-300 font-bold uppercase">F_vis (L2 Tiefe)</span>
            </div>
            <span className="text-[10px] text-slate-400 font-bold">w = 0.25</span>
          </div>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-2xl font-mono font-bold text-white tracking-tight">
              {vectorTelemetry.forceVisible >= 0 ? `+${vectorTelemetry.forceVisible}` : vectorTelemetry.forceVisible}
              <span className="text-xs text-slate-400 font-normal ml-1">N</span>
            </span>
            <div className="flex items-center gap-1 text-[11px] font-mono">
              {vectorTelemetry.forceVisible > 0 ? (
                <span className="text-cyan-400 flex items-center font-bold"><ArrowUpRight className="w-3.5 h-3.5" /> Pull UP</span>
              ) : vectorTelemetry.forceVisible < 0 ? (
                <span className="text-rose-400 flex items-center font-bold"><ArrowDownRight className="w-3.5 h-3.5" /> Drag DOWN</span>
              ) : (
                <span className="text-slate-400 flex items-center"><Minus className="w-3.5 h-3.5" /> Neutral</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Tiefe: <strong className="text-slate-200">{l2Depth.toLocaleString()} BTC</strong></span>
            <span className="flex items-center gap-1 text-cyan-400/80">
              {showVis ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-slate-500" />}
              {showVis ? 'Sichtbar' : 'Ausgeblendet'}
            </span>
          </div>
        </div>

        {/* Card 2: Blind Force */}
        <div 
          onClick={() => setShowBlind(!showBlind)}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none ${
            showBlind 
              ? 'bg-[#18152b] border-purple-500/40 shadow-sm shadow-purple-500/10' 
              : 'bg-[#0f1420]/60 border-slate-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400" />
              <span className="text-purple-300 font-bold uppercase">F_blind (Iceberg)</span>
            </div>
            <span className="text-[10px] text-slate-400 font-bold">w = 0.35</span>
          </div>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-2xl font-mono font-bold text-white tracking-tight">
              {vectorTelemetry.forceBlind >= 0 ? `+${vectorTelemetry.forceBlind}` : vectorTelemetry.forceBlind}
              <span className="text-xs text-slate-400 font-normal ml-1">N</span>
            </span>
            <div className="flex items-center gap-1 text-[11px] font-mono">
              {vectorTelemetry.forceBlind > 0 ? (
                <span className="text-purple-400 flex items-center font-bold"><ArrowUpRight className="w-3.5 h-3.5" /> Pull UP</span>
              ) : vectorTelemetry.forceBlind < 0 ? (
                <span className="text-rose-400 flex items-center font-bold"><ArrowDownRight className="w-3.5 h-3.5" /> Drag DOWN</span>
              ) : (
                <span className="text-slate-400 flex items-center"><Minus className="w-3.5 h-3.5" /> Neutral</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Schatten: <strong className="text-slate-200">{icebergDepth.toLocaleString()} BTC</strong></span>
            <span className="flex items-center gap-1 text-purple-400/80">
              {showBlind ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-slate-500" />}
              {showBlind ? 'Sichtbar' : 'Ausgeblendet'}
            </span>
          </div>
        </div>

        {/* Card 3: Polymarket Force */}
        <div 
          onClick={() => setShowPoly(!showPoly)}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none ${
            showPoly 
              ? 'bg-[#221c16] border-amber-500/40 shadow-sm shadow-amber-500/10' 
              : 'bg-[#0f1420]/60 border-slate-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              <span className="text-amber-300 font-bold uppercase">F_poly (Erwartung)</span>
            </div>
            <span className="text-[10px] text-slate-400 font-bold">w = 0.40</span>
          </div>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-2xl font-mono font-bold text-white tracking-tight">
              {vectorTelemetry.forcePolymarket >= 0 ? `+${vectorTelemetry.forcePolymarket}` : vectorTelemetry.forcePolymarket}
              <span className="text-xs text-slate-400 font-normal ml-1">N</span>
            </span>
            <div className="flex items-center gap-1 text-[11px] font-mono">
              {vectorTelemetry.forcePolymarket > 0 ? (
                <span className="text-amber-400 flex items-center font-bold"><ArrowUpRight className="w-3.5 h-3.5" /> Bullish Bias</span>
              ) : vectorTelemetry.forcePolymarket < 0 ? (
                <span className="text-rose-400 flex items-center font-bold"><ArrowDownRight className="w-3.5 h-3.5" /> Bearish Bias</span>
              ) : (
                <span className="text-slate-400 flex items-center"><Minus className="w-3.5 h-3.5" /> Neutral</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Konsensus: <strong className="text-slate-200">{(polyProb * 100).toFixed(0)}% Up</strong></span>
            <span className="flex items-center gap-1 text-amber-400/80">
              {showPoly ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-slate-500" />}
              {showPoly ? 'Sichtbar' : 'Ausgeblendet'}
            </span>
          </div>
        </div>

        {/* Card 4: Net Force Vector */}
        <div 
          onClick={() => setShowNet(!showNet)}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none ${
            showNet 
              ? 'bg-[#10241e] border-emerald-500/50 shadow-md shadow-emerald-500/10 ring-1 ring-emerald-500/30' 
              : 'bg-[#0f1420]/60 border-slate-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono mb-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-emerald-300 font-bold uppercase tracking-wide">F_net (Vektor-Summe)</span>
            </div>
            <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-300">
              {vectorTelemetry.direction}
            </span>
          </div>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-2xl font-mono font-bold text-emerald-300 tracking-tight">
              {vectorTelemetry.forceNet >= 0 ? `+${vectorTelemetry.forceNet}` : vectorTelemetry.forceNet}
              <span className="text-xs text-slate-300 font-normal ml-1">N</span>
            </span>
            <span className="text-[11px] font-mono text-slate-300 font-semibold">
              Attraktor: ${vectorTelemetry.attractorPrice.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-800">
            <span>Delta: <strong className={vectorTelemetry.deltaPToAttractor >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {vectorTelemetry.deltaPToAttractor >= 0 ? `+${vectorTelemetry.deltaPToAttractor}` : vectorTelemetry.deltaPToAttractor} $
            </strong></span>
            <span className="flex items-center gap-1 text-emerald-400">
              {showNet ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-slate-500" />}
              {showNet ? 'F_net aktiv' : 'Ausgeblendet'}
            </span>
          </div>
        </div>
      </div>

      {/* SVG Canvas Container */}
      <div className="relative w-full rounded-xl bg-[#090c14] border border-slate-800/80 p-3 shadow-inner">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto select-none"
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            {/* Gradients */}
            <linearGradient id="netGlowGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
              <stop offset="50%" stopColor="#10b981" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>

            <linearGradient id="bullishZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>

            <linearGradient id="bearishZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.0" />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.06" />
            </linearGradient>

            {/* Forbidden hatch for Via Negativa */}
            <pattern id="forbiddenHatchForce" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="8" stroke="#f43f5e" strokeWidth="1.5" strokeOpacity="0.25" />
            </pattern>

            {/* Marker arrow */}
            <marker id="arrowForce" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
            </marker>
          </defs>

          {/* Background Zone Shading */}
          {/* Top Half: Positive Force Zone (Pulling UP) */}
          <rect x={padX} y={padY} width={plotWidth} height={plotHeight / 2} fill="url(#bullishZoneGrad)" />
          {/* Bottom Half: Negative Force Zone (Pulling DOWN) */}
          <rect x={padX} y={padY + plotHeight / 2} width={plotWidth} height={plotHeight / 2} fill="url(#bearishZoneGrad)" />

          {/* Grid lines */}
          {/* Zero-Force Horizontal Equilibrium Line */}
          <line
            x1={padX}
            y1={padY + plotHeight / 2}
            x2={width - padX}
            y2={padY + plotHeight / 2}
            stroke="#475569"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
          {/* +60N and -60N horizontal reference lines */}
          <line x1={padX} y1={scaleYForce(60)} x2={width - padX} y2={scaleYForce(60)} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />
          <line x1={padX} y1={scaleYForce(-60)} x2={width - padX} y2={scaleYForce(-60)} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />

          {/* Labels for Y-Axis */}
          <text x={padX - 8} y={padY + 4} fill="#10b981" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="bold">
            +120N (UP)
          </text>
          <text x={padX - 8} y={scaleYForce(60) + 3} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="monospace">
            +60N
          </text>
          <text x={padX - 8} y={padY + plotHeight / 2 + 3} fill="#94a3b8" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="bold">
            0N (GLGW)
          </text>
          <text x={padX - 8} y={scaleYForce(-60) + 3} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="monospace">
            -60N
          </text>
          <text x={padX - 8} y={padY + plotHeight} fill="#f43f5e" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="bold">
            -120N (DOWN)
          </text>

          {/* PROFILE MODE RENDERING */}
          {graphMode === 'PROFILE' && (
            <>
              {hasBands && (
              <>
              {/* Forbidden Via Negativa Zones */}
              {scaleXProfile(bLower) > padX && (
                <rect
                  x={padX}
                  y={padY}
                  width={Math.max(0, scaleXProfile(bLower) - padX)}
                  height={plotHeight}
                  fill="url(#forbiddenHatchForce)"
                />
              )}
              {scaleXProfile(bUpper) < width - padX && (
                <rect
                  x={scaleXProfile(bUpper)}
                  y={padY}
                  width={Math.max(0, width - padX - scaleXProfile(bUpper))}
                  height={plotHeight}
                  fill="url(#forbiddenHatchForce)"
                />
              )}

              {/* Forbidden boundary lines */}
              <line
                x1={scaleXProfile(bLower)}
                y1={padY}
                x2={scaleXProfile(bLower)}
                y2={padY + plotHeight}
                stroke="#f43f5e"
                strokeWidth="1.2"
                strokeDasharray="4 4"
              />
              <text x={scaleXProfile(bLower) - 4} y={padY + 12} fill="#f43f5e" fontSize="8" textAnchor="end" fontFamily="monospace">
                B_lower (${bLower})
              </text>

              <line
                x1={scaleXProfile(bUpper)}
                y1={padY}
                x2={scaleXProfile(bUpper)}
                y2={padY + plotHeight}
                stroke="#f43f5e"
                strokeWidth="1.2"
                strokeDasharray="4 4"
              />
              <text x={scaleXProfile(bUpper) + 4} y={padY + 12} fill="#f43f5e" fontSize="8" textAnchor="start" fontFamily="monospace">
                B_upper (${bUpper})
              </text>
              </>
              )}

              {/* Attractor P* Equilibrium line (where F_net crosses 0) */}
              <line
                x1={scaleXProfile(vectorTelemetry.attractorPrice)}
                y1={padY}
                x2={scaleXProfile(vectorTelemetry.attractorPrice)}
                y2={padY + plotHeight}
                stroke="#10b981"
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
              <text
                x={scaleXProfile(vectorTelemetry.attractorPrice)}
                y={padY + 10}
                fill="#10b981"
                fontSize="9"
                textAnchor="middle"
                fontFamily="monospace"
                fontWeight="bold"
              >
                P* (${vectorTelemetry.attractorPrice})
              </text>

              {/* Force Curves */}
              {/* F_vis (Cyan) */}
              {showVis && (
                <path
                  d={pathVisProfile}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  strokeOpacity="0.85"
                />
              )}

              {/* F_blind (Purple) */}
              {showBlind && (
                <path
                  d={pathBlindProfile}
                  fill="none"
                  stroke="#c084fc"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  strokeOpacity="0.85"
                />
              )}

              {/* F_poly (Amber) */}
              {showPoly && (
                <path
                  d={pathPolyProfile}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  strokeOpacity="0.85"
                />
              )}

              {/* F_net (Thick Emerald Solid Curve) */}
              {showNet && (
                <>
                  <path
                    d={pathNetProfile}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                  {/* Spot Marker on Net Curve */}
                  <circle
                    cx={scaleXProfile(currentSpot)}
                    cy={scaleYForce(vectorTelemetry.forceNet)}
                    r="5"
                    fill="#10b981"
                    className="animate-pulse"
                  />
                  <circle
                    cx={scaleXProfile(currentSpot)}
                    cy={scaleYForce(vectorTelemetry.forceNet)}
                    r="9"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="1.5"
                    strokeOpacity="0.5"
                  />
                </>
              )}

              {/* Current Spot Price Vertical Marker */}
              <line
                x1={scaleXProfile(currentSpot)}
                y1={padY}
                x2={scaleXProfile(currentSpot)}
                y2={padY + plotHeight}
                stroke="#38bdf8"
                strokeWidth="1.5"
              />
              <text
                x={scaleXProfile(currentSpot)}
                y={padY + plotHeight + 14}
                fill="#38bdf8"
                fontSize="10"
                textAnchor="middle"
                fontFamily="monospace"
                fontWeight="bold"
              >
                Spot (${currentSpot.toLocaleString()})
              </text>

              {/* Hover Crosshair */}
              {hoveredPoint && (
                <g>
                  <line
                    x1={scaleXProfile(hoveredPoint.price)}
                    y1={padY}
                    x2={scaleXProfile(hoveredPoint.price)}
                    y2={padY + plotHeight}
                    stroke="#ffffff"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                    strokeOpacity="0.6"
                  />
                  <circle
                    cx={scaleXProfile(hoveredPoint.price)}
                    cy={scaleYForce(hoveredPoint.fNet)}
                    r="4"
                    fill="#ffffff"
                  />
                </g>
              )}
            </>
          )}

          {/* STREAM MODE RENDERING */}
          {graphMode === 'STREAM' && (
            <>
              {/* Stream Curves */}
              {showVis && (
                <path
                  d={pathVisStream}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.5"
                  strokeDasharray="3 2"
                  strokeOpacity="0.8"
                />
              )}
              {showBlind && (
                <path
                  d={pathBlindStream}
                  fill="none"
                  stroke="#c084fc"
                  strokeWidth="1.5"
                  strokeDasharray="3 2"
                  strokeOpacity="0.8"
                />
              )}
              {showPoly && (
                <path
                  d={pathPolyStream}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                  strokeDasharray="3 2"
                  strokeOpacity="0.8"
                />
              )}
              {showNet && (
                <>
                  <path
                    d={pathNetStream}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                  {timeSeries.length > 0 && (
                    <circle
                      cx={scaleXStream(timeSeries.length - 1, timeSeries.length)}
                      cy={scaleYForce(timeSeries[timeSeries.length - 1].fNet)}
                      r="5"
                      fill="#10b981"
                      className="animate-ping"
                    />
                  )}
                </>
              )}

              {/* Time Labels on X-Axis */}
              {timeSeries.length > 4 && (
                <>
                  <text x={padX} y={padY + plotHeight + 14} fill="#64748b" fontSize="9" textAnchor="start" fontFamily="monospace">
                    {timeSeries[0].timeLabel}
                  </text>
                  <text x={padX + plotWidth / 2} y={padY + plotHeight + 14} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="monospace">
                    {timeSeries[Math.floor(timeSeries.length / 2)].timeLabel}
                  </text>
                  <text x={width - padX} y={padY + plotHeight + 14} fill="#10b981" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="bold">
                    Jetzt ({timeSeries[timeSeries.length - 1].timeLabel})
                  </text>
                </>
              )}
            </>
          )}
        </svg>

        {/* Hover Crosshair Tooltip Detail */}
        {hoveredPoint && graphMode === 'PROFILE' && (
          <div className="absolute top-4 right-4 bg-[#121624]/95 border border-cyan-500/40 rounded-xl p-3 shadow-xl backdrop-blur-md font-mono text-xs z-20 pointer-events-none">
            <div className="text-white font-bold border-b border-slate-700 pb-1 mb-2 flex items-center justify-between gap-4">
              <span>Kurs P: ${hoveredPoint.price.toLocaleString()}</span>
              <span className={hoveredPoint.fNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {hoveredPoint.fNet >= 0 ? `+${hoveredPoint.fNet} N` : `${hoveredPoint.fNet} N`}
              </span>
            </div>
            <div className="space-y-1 text-[11px]">
              <div className="flex items-center justify-between gap-3 text-cyan-300">
                <span>F_vis (L2):</span>
                <span>{hoveredPoint.fVis >= 0 ? `+${hoveredPoint.fVis}` : hoveredPoint.fVis} N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-purple-300">
                <span>F_blind (Iceberg):</span>
                <span>{hoveredPoint.fBlind >= 0 ? `+${hoveredPoint.fBlind}` : hoveredPoint.fBlind} N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-amber-300">
                <span>F_poly (Erwartung):</span>
                <span>{hoveredPoint.fPoly >= 0 ? `+${hoveredPoint.fPoly}` : hoveredPoint.fPoly} N</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-emerald-300 font-bold pt-1 border-t border-slate-800">
                <span>F_net (Vektor-Summe):</span>
                <span>{hoveredPoint.fNet >= 0 ? `+${hoveredPoint.fNet}` : hoveredPoint.fNet} N</span>
              </div>
            </div>
          </div>
        )}

        {/* Legend Footer */}
        <div className="flex items-center justify-between gap-4 mt-3 pt-2.5 border-t border-slate-800/80 text-[11px] font-mono text-slate-400 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setShowNet(!showNet)}
              className={`flex items-center gap-1.5 transition-opacity ${showNet ? 'text-emerald-400 font-bold' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-1 bg-emerald-400 rounded-full" />
              <span>F_net (Vektor-Summe)</span>
            </button>
            <button
              onClick={() => setShowVis(!showVis)}
              className={`flex items-center gap-1.5 transition-opacity ${showVis ? 'text-cyan-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-cyan-400 border-b border-dashed" />
              <span>F_vis (L2 Tiefe - 25%)</span>
            </button>
            <button
              onClick={() => setShowBlind(!showBlind)}
              className={`flex items-center gap-1.5 transition-opacity ${showBlind ? 'text-purple-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-purple-400 border-b border-dashed" />
              <span>F_blind (Schatten - 35%)</span>
            </button>
            <button
              onClick={() => setShowPoly(!showPoly)}
              className={`flex items-center gap-1.5 transition-opacity ${showPoly ? 'text-amber-400' : 'text-slate-600'}`}
            >
              <span className="w-3.5 h-0.5 bg-amber-400 border-b border-dashed" />
              <span>F_poly (Polymarket - 40%)</span>
            </button>
          </div>

          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span>F &gt; 0: Bullischer Zug nach oben</span>
            <span>•</span>
            <span>F &lt; 0: Bärischer Zug nach unten</span>
          </div>
        </div>
      </div>

      {/* Physics Simulation Control Sliders & Scenario Presets */}
      <div className="mt-5 pt-4 border-t border-slate-700/60 font-mono text-xs space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-white font-bold">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <span>KRAFT-PARAMETER &amp; ORDERFLOW-SIMULATION</span>
          </div>

          {/* Quick Scenario Presets */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-slate-400 mr-1">Szenarien:</span>
            <button
              onClick={() => applyPreset('Bullish Squeeze', 2600, 3100, 0.92)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] transition-colors border border-slate-700"
            >
              Bull Squeeze
            </button>
            <button
              onClick={() => applyPreset('Dark Pool Absorption', 1200, 4200, 0.70)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 text-[11px] transition-colors border border-slate-700"
            >
              Iceberg Wall
            </button>
            <button
              onClick={() => applyPreset('Polymarket Shock', 1300, 1900, 0.35)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 text-[11px] transition-colors border border-slate-700"
            >
              Event Reversal
            </button>
            <button
              onClick={() => applyPreset('Gleichgewicht', 1400, 2000, 0.50)}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 text-[11px] transition-colors border border-slate-700"
            >
              Equilibrium
            </button>
          </div>
        </div>

        {/* 3 Parameter Sliders */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-[#0c101a] p-3.5 rounded-xl border border-slate-800/80">
          {/* Slider 1: L2 Imbalance */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-slate-300 text-[11px]">
              <span className="text-cyan-400 font-semibold">1. Sichtbare L2-Tiefe (Bids vs Asks)</span>
              <span className="font-bold text-white">{l2Depth.toLocaleString()} BTC</span>
            </div>
            <input
              type="range"
              min={600}
              max={2800}
              step={50}
              value={l2Depth}
              onChange={(e) => setL2Depth(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Asks Dominanz</span>
              <span>Bids Dominanz</span>
            </div>
          </div>

          {/* Slider 2: Iceberg Shadow Volume */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-slate-300 text-[11px]">
              <span className="text-purple-400 font-semibold">2. Schattenbuch-Tiefe (Icebergs)</span>
              <span className="font-bold text-white">{icebergDepth.toLocaleString()} BTC</span>
            </div>
            <input
              type="range"
              min={1000}
              max={4500}
              step={50}
              value={icebergDepth}
              onChange={(e) => setIcebergDepth(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Dünne Schatten</span>
              <span>Starke Absorption</span>
            </div>
          </div>

          {/* Slider 3: Polymarket Probability */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-slate-300 text-[11px]">
              <span className="text-amber-400 font-semibold">3. Polymarket Forward-Erwartung</span>
              <span className="font-bold text-white">{(polyProb * 100).toFixed(0)}% Up</span>
            </div>
            <input
              type="range"
              min={0.10}
              max={0.95}
              step={0.01}
              value={polyProb}
              onChange={(e) => setPolyProb(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-400"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>10% Bearish</span>
              <span>95% Bullish</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
