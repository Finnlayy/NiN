'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, TrendingDown, TrendingUp } from 'lucide-react';
import { APOLLO_TOKENS } from '../tokens';

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const LEVELS = 24;
const COLS = 20;

interface OrderflowCell {
  row: number;
  col: number;
  bid: number;
  ask: number;
}

function generateOrderflow() {
  const rand = seededRandom(0x3e9b12);
  const cells: OrderflowCell[] = [];
  for (let row = 0; row < LEVELS; row++) {
    for (let col = 0; col < COLS; col++) {
      cells.push({ row, col, bid: rand() * 1.05, ask: rand() * 1.05 });
    }
  }
  return cells;
}

export default function OrderflowCVD() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [flash, setFlash] = useState<{ row: number; col: number } | null>(null);
  const cells = useMemo(generateOrderflow, []);
  const maxVol = Math.max(...cells.map(c => Math.max(c.bid, c.ask)));

  // CVD per column (net bid/ask imbalance), then cumulative across time
  const columnDelta = useMemo(
    () => {
      const out = new Array(COLS).fill(0);
      for (const c of cells) out[c.col] += c.bid - c.ask;
      return out;
    },
    [cells]
  );
  const cumulative = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const d of columnDelta) {
      acc += d;
      out.push(acc);
    }
    return out;
  }, [columnDelta]);
  const cumMin = Math.min(...cumulative);
  const cumMax = Math.max(...cumulative);
  const cumRange = cumMax - cumMin || 1;

  // Flash a random cell periodically (simulated tick hit)
  useEffect(() => {
    const iv = setInterval(() => {
      setFlash({
        row: Math.floor(Math.random() * LEVELS),
        col: Math.floor(Math.random() * COLS),
      });
      setTimeout(() => setFlash(null), 350);
    }, 750);
    return () => clearInterval(iv);
  }, []);

  const drawCVD = useCallback(() => {
    const canvas = canvasRef.current;
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
    const bandH = h * 0.72; // footprint matrix area
    const sparkH = h * 0.24; // CVD sparkline band
    const cellW = w / COLS;
    const cellH = bandH / LEVELS;

    ctx.clearRect(0, 0, w, h);

    // footprint matrix
    for (const c of cells) {
      const x = c.col * cellW;
      const y = c.row * cellH;
      const bidAlpha = Math.min(0.85, (c.bid / maxVol) * 0.85);
      const askAlpha = Math.min(0.85, (c.ask / maxVol) * 0.85);

      // bid half (left) — teal
      ctx.fillStyle = `rgba(34, 211, 238, ${bidAlpha})`;
      ctx.fillRect(x + 1, y + 1, cellW / 2 - 2, cellH - 2);
      // ask half (right) — crimson
      ctx.fillStyle = `rgba(239, 68, 68, ${askAlpha})`;
      ctx.fillRect(x + cellW / 2 + 1, y + 1, cellW / 2 - 2, cellH - 2);

      // imbalance accent when one side dominates
      if (Math.abs(c.bid - c.ask) > maxVol * 0.72) {
        ctx.fillStyle = c.bid > c.ask ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)';
        ctx.fillRect(x + cellW / 2 - 1, y + 1, 2, cellH - 2);
      }
    }

    // flash hit
    if (flash) {
      const x = flash.col * cellW;
      const y = flash.row * cellH;
      const g = ctx.createRadialGradient(x + cellW / 2, y + cellH / 2, 0, x + cellW / 2, y + cellH / 2, cellW);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
    }

    // CVD sparkline band
    const sy = bandH + sparkH * 0.12;
    const sh = sparkH * 0.72;
    const midZero = sy + sh * (0 - cumMin) / cumRange;
    ctx.beginPath();
    ctx.moveTo(0, midZero);
    cumulative.forEach((v, i) => {
      const x = (i + 0.5) * cellW;
      const y = sy + sh * (0 - v) / cumRange;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(w, midZero);
    const grad = ctx.createLinearGradient(0, sy, 0, sy + sh);
    grad.addColorStop(0, 'rgba(16, 185, 129, 0.18)');
    grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = APOLLO_TOKENS.emerald;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, midZero);
    cumulative.forEach((v, i) => {
      const x = (i + 0.5) * cellW;
      const y = sy + sh * (0 - v) / cumRange;
      ctx.lineTo(x, y);
    });
    ctx.stroke();

    // axis labels
    ctx.fillStyle = APOLLO_TOKENS.textDim;
    ctx.font = '10px ' + APOLLO_TOKENS.mono;
    ctx.textAlign = 'right';
    ctx.fillText(`CVD max ${cumMax.toFixed(1)}`, w - 8, sy - 8);
    ctx.fillText(`CVD min ${cumMin.toFixed(1)}`, w - 8, sy + sh + 14);
    ctx.textAlign = 'left';
    ctx.fillText(`CVD now ${cumulative[cumulative.length - 1].toFixed(1)}`, 8, sy + sh + 14);
  }, [cells, maxVol, cumulative, cumMin, cumMax, flash]);

  useEffect(() => {
    const loop = () => {
      drawCVD();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawCVD]);

  // ---------- P&L calendar heatmap ----------
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - 53 * 7 + (6 - today.getDay() + 7) % 7);
  const rand = seededRandom(0x9c4420);
  const dayPnL = new Map<string, number>();
  let walk = 0;
  for (let w = 0; w < 53; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) continue;
      walk += (rand() - 0.48) * 420;
      dayPnL.set(date.toISOString().slice(0, 10), walk);
    }
  }
  const values = [...dayPnL.values()];
  const maxAbs = Math.max(...values.map(Math.abs), 1);

  const monthLabels: { x: number; label: string }[] = [];
  const weekCells = 53;
  for (let m = 1; m <= 12; m++) {
    const firstOfMonth = new Date(today.getFullYear(), m - 1, 1);
    if (firstOfMonth < start) continue;
    const weekOfMonth = Math.round(((firstOfMonth.getTime() - start.getTime()) / 86400000) / 7);
    monthLabels.push({ x: weekOfMonth / weekCells, label: firstOfMonth.toLocaleString(undefined, { month: 'short' }) });
  }

  const pnlColor = (v: number) => {
    const intensity = Math.min(0.9, Math.abs(v) / maxAbs);
    if (v > 0.5) return `rgba(16, 185, 129, ${0.25 + intensity * 0.65})`;
    if (v < -0.5) return `rgba(239, 68, 68, ${0.25 + intensity * 0.65})`;
    return 'rgba(255, 255, 255, 0.05)';
  };

  return (
    <section className="glass-card rounded-2xl border border-white/5 flex flex-col h-full min-h-[560px]">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
          <h3 className="text-xs font-mono font-bold text-white tracking-wider uppercase">orderflow cvd</h3>
          <span className="ml-auto px-2 py-0.5 rounded border border-amber-500/30 text-amber-300 bg-amber-500/10 text-[10px] font-mono">footprint · tape</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          <Calendar className="w-3 h-3 text-slate-500" /> p&l calendar
        </div>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0 px-5 pb-4 pt-2">
        {/* CVD footprint matrix */}
        <div className="glass-card rounded-xl border border-white/5 flex flex-col h-full min-h-0">
          <div className="px-3 py-2 border-b border-white/5 shrink-0 flex items-center justify-between">
            <span className="text-[10px] font-mono text-white font-bold">CVD Footprint Matrix</span>
            <span className="text-[10px] font-mono text-slate-400">24 levels × 20 ticks</span>
          </div>
          <div className="flex-1 relative bg-[#060709] rounded-b-lg overflow-hidden">
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
          </div>
        </div>

        {/* P&L calendar heatmap */}
        <div className="glass-card rounded-xl border border-white/5 flex flex-col h-full min-h-0">
          <div className="px-3 py-2 border-b border-white/5 shrink-0 flex items-center justify-between">
            <span className="text-[10px] font-mono text-white font-bold">Daily P&L Heatmap</span>
            <span className="text-[10px] font-mono text-slate-400">trailing 53 weeks</span>
          </div>
            <div className="flex-1 p-3 min-h-0 flex flex-col">
              <div className="relative flex-1">
                <div className="flex h-full">
                  {Array.from({ length: 53 }).map((_, wi) => (
                    <div key={wi} className="flex-1 flex flex-col">
                      {Array.from({ length: 7 }).map((_, di) => {
                        const date = new Date(start);
                        date.setDate(start.getDate() + wi * 7 + di);
                        const iso = date.toISOString().slice(0, 10);
                        const v = dayPnL.get(iso);
                        const isToday = date.getTime() === today.getTime();
                        return (
                          <div
                            key={iso}
                            className={`w-2 h-2 mx-[1px] mb-[1px] rounded-sm transition-colors ${isToday ? 'ring-1 ring-white ring-offset-2 ring-offset-[#060709] shadow-[0_0_8px_rgba(139,92,246,0.6)]' : ''}`}
                            style={{ backgroundColor: v === undefined ? 'transparent' : pnlColor(v) }}
                            title={`${iso}: ${v === undefined ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} USD`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
                {monthLabels.map((m) => (
                  <div
                    key={m.label}
                    className="absolute -top-8 text-[9px] font-mono text-slate-600 whitespace-nowrap"
                    style={{ left: `${m.x * 100}%`, transform: 'translateX(-50%)' }}
                  >
                    {m.label}
                  </div>
                ))}
              </div>
            <div className="mt-2 flex items-center justify-between text-[9px] font-mono">
              <span className="text-slate-400">max abs pnl</span>
              <span className="text-slate-200">{Math.abs(maxAbs).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
              <span className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-emerald-400" />
                <TrendingDown className="w-3 h-3 text-crimson-400" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
