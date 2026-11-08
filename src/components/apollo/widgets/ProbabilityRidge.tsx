'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Shield, TrendingUp } from 'lucide-react';
import { APOLLO_TOKENS } from '../tokens';

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function gaussian(x: number, mean: number, sigma: number) {
  return Math.exp(-0.5 * ((x - mean) / sigma) ** 2);
}

function generateEquity() {
  const rand = seededRandom(0x5a1f3e);
  const n = 400;
  const points: number[] = [];
  let equity = 100000;
  let maxDD = 0;
  let peak = equity;
  for (let i = 0; i < n; i++) {
    const drift = 0.18;
    const shock = rand() < 0.12 ? (rand() - 0.5) * 600 : 0;
    equity += drift * 12 + (rand() - 0.5) * 150 + shock;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    points.push(equity);
  }
  return { points, maxDD, peak };
}

const RIDGE_COLORS = [
  APOLLO_TOKENS.violet,
  '#22d3ee',
  APOLLO_TOKENS.emerald,
  APOLLO_TOKENS.amber,
  APOLLO_TOKENS.violet,
  '#22d3ee',
  APOLLO_TOKENS.emerald,
  APOLLO_TOKENS.amber,
];

export default function ProbabilityRidge() {
  const ridgeRef = useRef<HTMLCanvasElement>(null);
  const equityRef = useRef<HTMLCanvasElement>(null);
  const ridgeRafRef = useRef(0);
  const equityRafRef = useRef(0);

  const { points, maxDD } = useMemo(generateEquity, []);
  const equityStart = points[0];
  const equityEnd = points[points.length - 1];
  const winRate = 68;
  const sharpe = 2.31;
  const sortino = 3.1;

  // Ridge landscape: layered joyplot densities animated via deterministic render(t)
  const drawRidge = useCallback(() => {
    const canvas = ridgeRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;
    const t = (performance.now() - ridgeStartRef.current) / 1000;

    ctx.clearRect(0, 0, w, h);
    const layers = 8;
    const layerH = h / (layers + 1);

    for (let i = 0; i < layers; i++) {
      const baseY = h - layerH * (i + 1.15);
      const color = RIDGE_COLORS[i];
      const mean = w * (0.3 + 0.4 * Math.sin(i * 1.3));
      const sigma = w * (0.14 + 0.06 * i);

      ctx.beginPath();
      ctx.moveTo(0, baseY);
      const step = 2;
      for (let x = 0; x <= w; x += step) {
        const wave = 0.55 + 0.45 * Math.sin(t * (0.7 + i * 0.25) + x * 0.012 + i * 1.7);
        const density = gaussian(x, mean, sigma) * wave * (0.5 + 0.1 * i);
        const y = baseY - density * layerH * 0.85;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, baseY);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, baseY, 0, baseY - layerH * 0.9);
      grad.addColorStop(0, `${color}00`);
      grad.addColorStop(1, `${color}cc`);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let x = 0; x <= w; x += step) {
        const wave = 0.55 + 0.45 * Math.sin(t * (0.7 + i * 0.25) + x * 0.012 + i * 1.7);
        const density = gaussian(x, mean, sigma) * wave * (0.5 + 0.1 * i);
        const y = baseY - density * layerH * 0.85;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, []);

  const ridgeStartRef = useRef(performance.now());

  useEffect(() => {
    const loop = () => {
      drawRidge();
      ridgeRafRef.current = requestAnimationFrame(loop);
    };
    ridgeRafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(ridgeRafRef.current);
  }, [drawRidge]);

  // Equity curve with underwater drawdown shading
  const drawEquity = useCallback(() => {
    const canvas = equityRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;

    const minEq = Math.min(...points);
    const maxEq = Math.max(...points);
    const eqRange = maxEq - minEq || 1;
    const pad = 6;
    const plotH = h - pad * 2;

    const yFor = (v: number) => h - pad - ((v - minEq) / eqRange) * plotH;

    // rolling peak
    const peaks: number[] = [];
    let runPeak = -Infinity;
    for (const v of points) {
      runPeak = Math.max(runPeak, v);
      peaks.push(runPeak);
    }

    // underwater drawdown shading (crimson between equity and peak)
    ctx.beginPath();
    ctx.moveTo(0, h - pad);
    for (let i = 0; i < points.length; i++) {
      const x = (i / (points.length - 1)) * w;
      if (points[i] < peaks[i]) {
        ctx.lineTo(x, yFor(peaks[i]));
      }
    }
    for (let i = points.length - 1; i >= 0; i--) {
      const x = (i / (points.length - 1)) * w;
      if (points[i] < peaks[i]) {
        ctx.lineTo(x, yFor(points[i]));
      } else {
        ctx.lineTo(x, h - pad);
      }
    }
    ctx.closePath();
    const ddGrad = ctx.createLinearGradient(0, h - pad, 0, h - pad - plotH);
    ddGrad.addColorStop(0, `${APOLLO_TOKENS.crimson}22`);
    ddGrad.addColorStop(1, `${APOLLO_TOKENS.crimson}00`);
    ctx.fillStyle = ddGrad;
    ctx.fill();

    // equity fill
    ctx.beginPath();
    ctx.moveTo(0, h - pad);
    ctx.lineTo(0, yFor(points[0]));
    for (let i = 0; i < points.length; i++) {
      const x = (i / (points.length - 1)) * w;
      ctx.lineTo(x, yFor(points[i]));
    }
    ctx.lineTo(w, h - pad);
    ctx.closePath();
    const eqGrad = ctx.createLinearGradient(0, h - pad, 0, h - pad - plotH);
    eqGrad.addColorStop(0, `${APOLLO_TOKENS.emerald}22`);
    eqGrad.addColorStop(1, `${APOLLO_TOKENS.emerald}00`);
    ctx.fillStyle = eqGrad;
    ctx.fill();

    // equity line (glow double stroke)
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(16, 185, 129, 0.25)`;
    ctx.beginPath();
    ctx.moveTo(0, yFor(points[0]));
    for (let i = 0; i < points.length; i++) {
      const x = (i / (points.length - 1)) * w;
      ctx.lineTo(x, yFor(points[i]));
    }
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = APOLLO_TOKENS.emerald;
    ctx.beginPath();
    ctx.moveTo(0, yFor(points[0]));
    for (let i = 0; i < points.length; i++) {
      const x = (i / (points.length - 1)) * w;
      ctx.lineTo(x, yFor(points[i]));
    }
    ctx.stroke();

    // axis labels
    ctx.fillStyle = APOLLO_TOKENS.textDim;
    ctx.font = '10px ' + APOLLO_TOKENS.mono;
    ctx.textAlign = 'left';
    ctx.fillText(equityStart.toLocaleString(undefined, { minimumFractionDigits: 0 }), 8, 16);
    ctx.textAlign = 'right';
    ctx.fillText(equityEnd.toLocaleString(undefined, { minimumFractionDigits: 0 }), w - 8, 16);
    ctx.fillText(`drawdown -${(maxDD / equityStart * 100).toFixed(1)}%`, w - 8, h - pad + 14);
  }, [points, equityStart, equityEnd, maxDD]);

  useEffect(() => {
    const loop = () => {
      drawEquity();
      equityRafRef.current = requestAnimationFrame(loop);
    };
    equityRafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(equityRafRef.current);
  }, [drawEquity]);

  return (
    <section className="glass-card rounded-2xl border border-white/5 flex flex-col h-full min-h-[560px]">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-ping" />
          <h3 className="text-xs font-mono font-bold text-white tracking-wider uppercase">probability ridge</h3>
          <span className="ml-auto px-2 py-0.5 rounded border border-violet-500/30 text-violet-300 bg-violet-500/10 text-[10px] font-mono">telemetry</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          <Shield className="w-3 h-3 text-slate-500" /> distribution
        </div>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0 px-5 pb-4 pt-2">
        <div className="glass-card rounded-xl border border-white/5 flex flex-col h-full min-h-0">
          <div className="px-3 py-2 border-b border-white/5 shrink-0 flex items-center justify-between">
            <span className="text-[10px] font-mono text-white font-bold">3D Probability Ridge</span>
            <span className="text-[10px] font-mono text-slate-400">joyplot landscape</span>
          </div>
          <div className="flex-1 relative bg-[#060709] rounded-b-lg overflow-hidden">
            <canvas ref={ridgeRef} className="absolute inset-0 w-full h-full block" />
          </div>
        </div>

        <div className="glass-card rounded-xl border border-white/5 flex flex-col h-full min-h-0">
          <div className="px-3 py-2 border-b border-white/5 shrink-0 flex items-center justify-between">
            <span className="text-[10px] font-mono text-white font-bold">Equity Curve</span>
            <span className="text-[10px] font-mono text-slate-400">cumulative p&l</span>
          </div>
          <div className="flex-1 relative bg-[#060709] rounded-b-lg overflow-hidden flex flex-col">
            <canvas ref={equityRef} className="flex-1 absolute inset-0 w-full h-full block" />
          </div>
          <div className="px-3 py-2 border-t border-white/5 shrink-0 grid grid-cols-4 gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500 font-mono uppercase">sharpe</span>
              <span className="text-[10px] font-mono text-emerald-300">{sharpe.toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500 font-mono uppercase">sortino</span>
              <span className="text-[10px] font-mono text-emerald-300">{sortino.toFixed(2)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500 font-mono uppercase">max dd</span>
              <span className="text-[10px] font-mono text-crimson-300">-{maxDD / equityStart * 100}%</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-500 font-mono uppercase">win rate</span>
              <span className="text-[10px] font-mono text-violet-300">{winRate}%</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 py-2 border-t border-white/5 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
          <TrendingUp className="w-3 h-3 text-slate-500" />
          <span>equity {equityStart.toLocaleString()} → {equityEnd.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
          <span>prefers-reduced-motion safe</span>
        </div>
      </div>
    </section>
  );
}
