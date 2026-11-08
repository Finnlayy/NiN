'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Monitor, Clock } from 'lucide-react';
import { APOLLO_TOKENS, type NodeType, NODE_STYLES } from '../tokens';

interface LiquidityNode {
  id: string;
  symbol: string;
  type: NodeType;
  cx: number; // normalized 0..1
  cy: number; // normalized 0..1
  telemetry: number; // 0..1
}

interface PulseRing {
  id: string;
  x: number;
  y: number;
  r: number;
  alpha: number;
}

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateNodes(): LiquidityNode[] {
  const rand = seededRandom(0x4a9c1f);
  const symbols = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT',
    'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'PEPE/USDT', 'SUI/USDT',
  ];
  const types: NodeType[] = ['Sweep', 'Detect', 'Track'];
  const nodes: LiquidityNode[] = [];
  for (let i = 0; i < 14; i++) {
    nodes.push({
      id: `liq-${i}`,
      symbol: symbols[Math.floor(rand() * symbols.length)],
      type: types[Math.floor(rand() * types.length)] as NodeType,
      cx: 0.17 + 0.64 * rand(),
      cy: 0.15 + 0.70 * rand(),
      telemetry: 0.40 + 0.60 * rand(),
    });
  }
  return nodes;
}

export default function ShadowQueueRadar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbitRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null]);
  const [detected, setDetected] = useState<LiquidityNode | null>(null);
  const [, setRings] = useState<PulseRing[]>([]);
  const rafRef = useRef(0);
  const orbitRafRef = useRef(0);
  const startRef = useRef(0);
  const reducedRef = useRef(false);
  const nodes = useMemo(generateNodes, []);
  const connections = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].cx - nodes[j].cx;
        const dy = nodes[i].cy - nodes[j].cy;
        if (dx * dx + dy * dy < 0.27) out.push([i, j]);
      }
    }
    return out;
  }, [nodes]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      reducedRef.current = mq.matches;
    };
    reducedRef.current = mq.matches;
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const triggerPulse = useCallback((node: LiquidityNode, x: number, y: number) => {
    setDetected(node);
    setRings(prev => [...prev, { id: Math.random().toString(36), x, y, r: 0, alpha: 0.85 }]);
  }, []);

  const draw = useCallback(() => {
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
    const cx = w * 0.5;
    const cy = h * 0.56;
    const R = Math.min(w, h) * 0.44;

    const elapsed = startRef.current ? (performance.now() - startRef.current) / 1000 : 0;
    const angle = reducedRef.current ? 0.35 : (elapsed * 0.7) % (Math.PI * 2);
    const sweepHalf = 0.6;

    // Void floor with subtle radial glow
    const floorGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
    floorGlow.addColorStop(0, 'rgba(139, 92, 246, 0.07)');
    floorGlow.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = floorGlow;
    ctx.fillRect(0, 0, w, h);

    // Filament lines between liquidity clusters
    ctx.lineWidth = 1;
    for (const [i, j] of connections) {
      const a = nodes[i];
      const b = nodes[j];
      const alpha = 0.10 + 0.08 * Math.sin(elapsed * 0.5 + i * 0.9 - j * 0.6);
      ctx.strokeStyle = `rgba(139, 92, 246, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.cx * w, a.cy * h);
      ctx.lineTo(b.cx * w, b.cy * h);
      ctx.stroke();
    }

    // Constellation nodes
    for (const node of nodes) {
      const style = NODE_STYLES[node.type];
      const x = node.cx * w;
      const y = node.cy * h;
      const r = 4.5 + node.telemetry * 7;

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      let nodeAngle = Math.atan2(dy, dx);
      let diff = angle - nodeAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const illuminated = Math.abs(diff) <= sweepHalf + 0.15 && dist <= R * 1.05;

      const glowAlpha = illuminated ? 0.55 : 0.10;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.4);
      g.addColorStop(0, `${style.color}${Math.round(glowAlpha * 255).toString(16).padStart(2, '0')}`);
      g.addColorStop(1, `${style.color}00`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = style.color;
      ctx.lineWidth = illuminated ? 2.4 : 1.3;
      ctx.setLineDash(illuminated ? [] : [6, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (node.telemetry > 0.78) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Sweep radar cone
    const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    sweepGrad.addColorStop(0, 'rgba(139, 92, 246, 0.45)');
    sweepGrad.addColorStop(0.4, 'rgba(139, 92, 246, 0.16)');
    sweepGrad.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle - sweepHalf, angle + sweepHalf);
    ctx.closePath();
    ctx.fill();

    // Sweep center vector line
    ctx.strokeStyle = APOLLO_TOKENS.violet;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * R * 0.98, cy + Math.sin(angle) * R * 0.98);
    ctx.stroke();

    // Sweep tip glow
    const tipX = cx + Math.cos(angle) * R * 0.98;
    const tipY = cy + Math.sin(angle) * R * 0.98;
    const tipG = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 9);
    tipG.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    tipG.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = tipG;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 6.5, 0, Math.PI * 2);
    ctx.fill();

    // Spring-physics style pulse rings triggered on node crossings
    setRings(prev => {
      const alive = prev.filter(ring => ring.alpha > 0.03);
      for (const ring of alive) {
        const ringG = ctx.createRadialGradient(ring.x, ring.y, ring.r, ring.x, ring.y, ring.r * 2.8);
        ringG.addColorStop(0, `rgba(139, 92, 246, ${ring.alpha * 0.45})`);
        ringG.addColorStop(1, `rgba(139, 92, 246, 0)`);
        ctx.strokeStyle = ringG;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      return alive.map(ring => ({
        ...ring,
        r: ring.r + 26 / 60,
        alpha: ring.alpha - 1.4 / 60,
      }));
    });

    // Hit detection: sweep tip crossing an active liquidity node
    for (const node of nodes) {
      const x = node.cx * w;
      const y = node.cy * h;
      const hitRadius = 14 + node.telemetry * 12;
      const distToTip = Math.hypot(x - tipX, y - tipY);
      if (distToTip < hitRadius && distToTip > 0) {
        if (!detected || detected.id !== node.id) {
          triggerPulse(node, x, y);
        }
      }
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [nodes, connections, detected, triggerPulse, reducedRef]);

  useEffect(() => {
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // Deterministic orbital vector animations for the Sweep / Detect / Track sub-panels
  useEffect(() => {
    const panels = orbitRefs.current;
    if (!panels.every(Boolean)) return;
    const start = performance.now();
    const loop = () => {
      const t = (performance.now() - start) / 1000;
      panels.forEach((ref, i) => {
        const c = ref!;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = c.clientWidth;
        const cssH = c.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        c.width = cssW * dpr;
        c.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const pw = cssW;
        const ph = cssH;
        const pcx = pw * 0.5;
        const pcy = ph * 0.5;
        const speed = 0.55 + i * 0.35;
        const dir = i % 2 === 0 ? 1 : -1;
        const a = t * speed * dir + i * 2.1;
        const r = Math.min(pw, ph) * 0.34;
        const ox = pcx + Math.cos(a) * r;
        const oy = pcy + Math.sin(a) * r;
        const style = NODE_STYLES[['Sweep', 'Detect', 'Track'][i] as NodeType];

        ctx.clearRect(0, 0, cssW * dpr, cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // orbital ring
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pcx, pcy, r, 0, Math.PI * 2);
        ctx.stroke();

        // vector filament
        ctx.strokeStyle = `${style.color}40`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(pcx, pcy);
        ctx.lineTo(ox, oy);
        ctx.stroke();

        // vector head glow
        const headG = ctx.createRadialGradient(ox, oy, 0, ox, oy, 11);
        headG.addColorStop(0, `${style.color}88`);
        headG.addColorStop(1, `${style.color}00`);
        ctx.fillStyle = headG;
        ctx.beginPath();
        ctx.arc(ox, oy, 11, 0, Math.PI * 2);
        ctx.fill();

        // core node
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(ox, oy, 4.2, 0, Math.PI * 2);
        ctx.fill();
      });
      orbitRafRef.current = requestAnimationFrame(loop);
    };
    orbitRafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(orbitRafRef.current);
  }, []);

  return (
    <section className="glass-card rounded-2xl border border-white/5 flex flex-col h-full min-h-[560px]">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-ping" />
          <h3 className="text-xs font-mono font-bold text-white tracking-wider uppercase">shadow queue radar</h3>
          <span className="ml-auto px-2 py-0.5 rounded border border-violet-500/30 text-violet-300 bg-violet-500/10 text-[10px] font-mono">live · 60 fps</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          <Monitor className="w-3 h-3 text-slate-500" /> constellation scan
        </div>
      </div>

      <div className="flex-1 relative min-h-0 overflow-hidden bg-obsidian/30">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
        <AnimatePresence mode="wait">
          {detected && (
            <motion.div
              initial={{ opacity: 0, scale: 0.82, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.82, y: 12 }}
              transition={{ type: 'spring', stiffness: 550, damping: 34, duration: 0.35 }}
              className="absolute left-1/2 top-1/2 z-20 w-52 pointer-events-auto"
              style={{ left: `${detected.cx * 100}%`, top: `${detected.cy * 100}%`, transform: 'translate(-50%, -115%)' }}
            >
              <div className="glass-card rounded-xl border border-violet-500/40 p-3.5 shadow-2xl shadow-violet-500/25 ring-1 ring-violet-500/20">
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-violet-400" />
                    <span className="text-[10px] font-mono font-bold text-white uppercase tracking-tighter">candidate detected</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded border border-violet-500/35 bg-violet-500/10 text-violet-300 text-[10px] font-mono">
                    {detected.type}
                  </span>
                </div>
                <div className="space-y-1.5 text-[11px] font-mono">
                  <div className="flex justify-between">
                    <span className="text-slate-500">symbol</span>
                    <span className="text-white">{detected.symbol}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">telemetry</span>
                    <span className="text-emerald-300">{`${(detected.telemetry * 100).toFixed(0)}%`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">confidence</span>
                    <span className="text-violet-300">94%</span>
                  </div>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center gap-2">
                  <Clock className="w-3 h-3 text-amber-400" />
                  <span className="text-[10px] text-slate-300 font-mono">liquidity sweep vector locked</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="px-5 py-3 space-y-2 border-t border-white/5 shrink-0">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-slate-500 font-mono">orbital vectors — sweep / detect / track</p>
          <span className="text-[10px] text-slate-600 font-mono">{`t+${Math.floor((performance.now() - startRef.current) / 1000)}s`}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {['Sweep', 'Detect', 'Track'].map((label, i) => (
            <div key={label} className="bg-[#0e121a]/50 border border-white/5 rounded-lg p-2.5 flex flex-col items-center gap-2">
              <canvas ref={el => { orbitRefs.current[i] = el; }} className="w-16 h-16 block" />
              <span className="text-[9px] font-mono text-slate-400 uppercase tracking-tighter">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
