'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  IChartApi,
  ISeriesApi,
  LineStyle,
  Time,
} from 'lightweight-charts';
import { Activity, TrendingUp } from 'lucide-react';
import { APOLLO_TOKENS } from '../tokens';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ProfileLevel {
  price: number;
  vol: number;
  yTop: number;
  yBottom: number;
}

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateCandles(): Candle[] {
  const rand = seededRandom(0x1b6f8a);
  const now = Math.floor(Date.now() / 1000 / 300) * 300;
  let price = 108420;
  const candles: Candle[] = [];
  for (let i = 0; i < 420; i++) {
    const open = price;
    const change = (rand() - 0.5) * 220;
    const close = open + change;
    const high = Math.max(open, close) + rand() * 360;
    const low = Math.min(open, close) - rand() * 360;
    candles.push({
      time: (now - (419 - i) * 300) as unknown as number,
      open,
      high,
      low,
      close,
    });
    price = close;
  }
  return candles;
}

function computeProfile(candles: Candle[]) {
  const minP = Math.min(...candles.map(c => c.low));
  const maxP = Math.max(...candles.map(c => c.high));
  const levels = 36;
  const step = (maxP - minP) / levels;
  const vols = new Array(levels).fill(0);
  candles.forEach(c => {
    // pseudo-volume weighted by candle body + range
    const vol = (c.high - c.low) * (1 + Math.abs(c.close - c.open) * 0.004);
    const idx = Math.min(levels - 1, Math.floor((c.close - minP) / step));
    vols[idx] += vol;
  });
  const maxVol = Math.max(...vols);
  const pocIndex = vols.indexOf(maxVol);
  const range = maxP - minP;
  const profile: ProfileLevel[] = vols.map((vol, i) => {
    const pBottom = minP + i * step;
    const pTop = pBottom + step;
    return {
      price: (pTop + pBottom) / 2,
      vol,
      yTop: ((maxP - pTop) / range) * 100,
      yBottom: ((maxP - pBottom) / range) * 100,
    };
  });
  return { minP, maxP, profile, pocIndex, maxVol };
}

interface VolumeProfileChartProps {
  heightPx?: number;
}

export default function VolumeProfileChart({ heightPx = 520 }: VolumeProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [paneW, setPaneW] = useState(0);
  const vpRef = useRef<SVGSVGElement>(null);

  const candles = useMemo(generateCandles, []);
  const { minP, maxP, profile, pocIndex, maxVol } = useMemo(() => computeProfile(candles), [candles]);
  const range = maxP - minP;
  const last = candles[candles.length - 1];
  const tpPrice = last.close + range * 0.16;
  const slPrice = last.close - range * 0.13;

  const zones = useMemo(
    () => [
      { center: minP + range * 0.10, label: 'LIQUIDITY POOL' },
      { center: maxP - range * 0.09, label: 'LIQUIDITY POOL' },
      { center: last.close, label: 'CURRENT PRICE' },
    ],
    [last.close, minP, range, maxP]
  );

  const yPct = useCallback(
    (price: number) => ((maxP - price) / range) * 100,
    [maxP, range]
  );

  useEffect(() => {
    const pane = chartRef.current;
    if (!pane || !containerRef.current) return;
    const width = pane.clientWidth;
    const height = pane.clientHeight;
    if (width === 0 || height === 0) return;
    setPaneW(width);

    if (!vpRef.current) return;
    const chart = createChart(pane, {
      layout: {
        background: { type: ColorType.Solid, color: '#050609' },
        textColor: '#94a3b8',
        fontSize: 11,
        fontFamily: APOLLO_TOKENS.mono,
      },
      width,
      height,
      grid: {
        vertLines: { color: '#161a26' },
        horzLines: { color: '#161a26' },
      },
      crosshair: {
        mode: 0,
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
    });

    const series = chart.addCandlestickSeries({
      upColor: APOLLO_TOKENS.emerald,
      downColor: APOLLO_TOKENS.crimson,
      wickUpColor: APOLLO_TOKENS.emerald,
      wickDownColor: APOLLO_TOKENS.crimson,
      borderVisible: false,
    });

    series.setData(candles as never);

    series.setMarkers([
      {
        time: last.time as unknown as Time,
        position: 'aboveBar',
        color: APOLLO_TOKENS.emerald,
        shape: 'arrowUp',
        size: 3,
        text: 'TP',
      },
      {
        time: last.time as unknown as Time,
        position: 'belowBar',
        color: APOLLO_TOKENS.crimson,
        shape: 'arrowDown',
        size: 3,
        text: 'SL',
      },
    ]);

    series.createPriceLine({
      price: tpPrice,
      color: APOLLO_TOKENS.emerald,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: true,
      axisLabelColor: APOLLO_TOKENS.emerald,
      title: 'TP',
    });

    series.createPriceLine({
      price: slPrice,
      color: APOLLO_TOKENS.crimson,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: true,
      axisLabelColor: APOLLO_TOKENS.crimson,
      title: 'SL',
    });

    chartApiRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      const w = pane.clientWidth;
      const h = pane.clientHeight;
      if (w === 0 || h === 0) return;
      setPaneW(w);
      chart.applyOptions({ width: w, height: h });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartApiRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  return (
    <section className="glass-card rounded-2xl border border-white/5 flex flex-col h-full min-h-[560px]">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          <h3 className="text-xs font-mono font-bold text-white tracking-wider uppercase">volume profile</h3>
          <span className="ml-auto px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-300 bg-emerald-500/10 text-[10px] font-mono">BTC/USDT · 5m</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          <Activity className="w-3 h-3 text-slate-500" /> orderflow tape
        </div>
      </div>

      <div className="flex-1 relative min-h-0 overflow-hidden">
        <div className="flex w-full h-full">
          <div className="relative w-[72%] h-full" ref={containerRef}>
            <div ref={chartRef} className="w-full h-full" />
            {/* Liquidation heat zones overlaid on price axis */}
            {zones.map((zone, i) => (
              <div
                key={i}
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: `${yPct(zone.center) - 1.1}%`,
                  height: '2.2%',
                  background: `linear-gradient(90deg, rgba(245, 158, 11, 0.00), rgba(245, 158, 11, 0.10), rgba(245, 158, 11, 0.00))`,
                  borderTop: `1px solid ${APOLLO_TOKENS.amber}`,
                  borderBottom: `1px solid ${APOLLO_TOKENS.amber}`,
                }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded bg-[#050609]/80 border border-amber-500/40 text-[10px] font-mono text-amber-200 backdrop-blur">
                  {zone.label}
                </div>
              </div>
            ))}
          </div>
          <div className="w-[28%] h-full flex flex-col">
            <svg
              ref={vpRef}
              className="w-full h-full block"
              viewBox={`0 0 ${paneW || 260} ${heightPx}`}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="vpPocGradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                </linearGradient>
              </defs>
              {profile.map((level, i) => {
                const widthPct = Math.min(82, (level.vol / maxVol) * 88);
                const isPoc = i === pocIndex;
                const heightPct = Math.max(level.yBottom - level.yTop, 1.4);
                return (
                  <g key={i}>
                    <rect
                      x={`${100 - widthPct - 4}%`}
                      y={`${level.yTop}%`}
                      width={`${widthPct}%`}
                      height={`${heightPct}%`}
                      fill={isPoc ? 'url(#vpPocGradient)' : 'rgba(255, 255, 255, 0.06)'}
                      stroke={isPoc ? APOLLO_TOKENS.emerald : 'rgba(255, 255, 255, 0.04)'}
                      strokeWidth={isPoc ? 1.5 : 0.5}
                    />
                    {isPoc && widthPct > 14 && (
                      <text
                        x={`${99 - widthPct - 2}%`}
                        y={`${(level.yTop + level.yBottom) / 2}%`}
                        dominantBaseline="middle"
                        textAnchor="end"
                        fill="#10b981"
                        fontSize="10"
                        fontFamily={APOLLO_TOKENS.mono}
                        fontWeight="700"
                        style={{ textShadow: '0 0 8px rgba(16, 185, 129, 0.7)' }}
                      >
                        POC
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            <div className="mt-3 px-2">
              <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
                <span className="text-slate-500">poc</span>
                <span className="text-emerald-300 font-bold">{profile[pocIndex]?.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
                <span className="text-slate-500">last</span>
                <span className="text-white font-bold">{last.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 py-2.5 border-t border-white/5 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
          <TrendingUp className="w-3 h-3 text-slate-500" />
          <span>tp/sl price lines · markers on close</span>
        </div>
        <div className="flex gap-2">
          <span className="px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[10px] font-mono">TP {tpPrice.toLocaleString()}</span>
          <span className="px-2 py-0.5 rounded border border-crimson/30 bg-crimson/10 text-crimson-300 text-[10px] font-mono">SL {slPrice.toLocaleString()}</span>
        </div>
      </div>
    </section>
  );
}
