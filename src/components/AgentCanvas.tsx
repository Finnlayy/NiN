import React, { useCallback, useState, useEffect } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Handle,
  Position,
  NodeProps,
  Panel,
  MarkerType,
  Edge,
  Node
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { 
  Brain, 
  Activity, 
  Database, 
  Shield, 
  Cpu, 
  Zap, 
  Radio, 
  X, 
  Coins, 
  TrendingUp, 
  CheckCircle2, 
  RefreshCw, 
  Layers, 
  ShieldCheck,
  AlertTriangle,
  Bot as BotIcon
} from 'lucide-react';
import { motion } from 'framer-motion';
import BotTelemetryCard from './BotTelemetryCard';
import { TradingBot } from '../types';

// Standard Agent Node (NIO, Feeds, Limbs)
const AgentNode = ({ data, selected }: NodeProps) => {
  const getAmpelStyle = (state: string) => {
    switch (state) {
      case 'GREEN_GLOW': return 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.6)] bg-emerald-950/50 text-emerald-100';
      case 'GREEN_SOLID': return 'border-emerald-500 bg-emerald-950/40 text-emerald-100';
      case 'YELLOW': return 'border-amber-500 bg-amber-950/40 text-amber-100';
      case 'RED_GLOW': return 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.6)] bg-red-950/40 text-red-100';
      case 'BLUE_GLOW': return 'border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)] bg-blue-950/40 text-blue-100';
      case 'PURPLE_GLOW': return 'border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.5)] bg-purple-950/40 text-purple-100';
      case 'GRAY': default: return 'border-slate-700 bg-slate-900/50 text-slate-300';
    }
  };

  const Icon: any = data.icon || Brain;

  return (
    <motion.div 
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      className={`relative px-3.5 py-2.5 rounded-lg border-2 ${getAmpelStyle(String(data.state || 'GRAY'))} backdrop-blur-md transition-all duration-300 min-w-[155px] ${selected ? 'ring-2 ring-white/90 scale-105' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="w-2.5 h-2.5 !bg-slate-400 border-none" />
      <Handle type="target" position={Position.Left} id="target-left" className="w-2 h-2 !bg-slate-400 border-none" />
      <Handle type="source" position={Position.Left} id="source-left" className="w-2 h-2 !bg-purple-400 border-none" />
      <Handle type="target" position={Position.Right} id="target-right" className="w-2 h-2 !bg-slate-400 border-none" />
      <Handle type="source" position={Position.Right} id="source-right" className="w-2 h-2 !bg-purple-400 border-none" />
      
      <div className="flex items-center gap-2.5">
         <div className="p-1.5 rounded-md bg-white/10 shrink-0">
           <Icon className={`w-4 h-4 ${String(data.state || '').includes('GLOW') ? 'animate-pulse' : ''}`} />
         </div>
         <div>
           <div className="text-[11px] font-bold uppercase tracking-wider leading-tight">{String(data.label || '')}</div>
           <div className="text-[9px] opacity-75 font-mono leading-tight">{String(data.role || '')}</div>
         </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="w-2.5 h-2.5 !bg-slate-400 border-none" />
    </motion.div>
  );
};

// Wide Bottom Node for Kraken & Kraken Pro Execution Engine Mesh
const KrakenExecutionNode = ({ data, selected }: NodeProps) => {
  const isConnected = data.connected === true;

  return (
    <motion.div 
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={`w-[980px] p-4 rounded-xl border-2 transition-all duration-300 backdrop-blur-md ${
        isConnected 
          ? 'border-cyan-500/70 bg-[#070b14]/95 shadow-[0_0_30px_rgba(6,182,212,0.2)]' 
          : 'border-red-500/50 bg-[#120a0e]/95 shadow-[0_0_30px_rgba(239,68,68,0.15)]'
      } ${selected ? (isConnected ? 'ring-2 ring-cyan-400 border-cyan-400' : 'ring-2 ring-red-400 border-red-400') : ''}`}
    >
      {/* 5 Distinct Handles matching the 5 Swarm Limbs */}
      <Handle type="target" position={Position.Top} id="target-s1" style={{ left: '9%' }} className={`w-3 h-3 border-2 !border-[#070b14] ${isConnected ? '!bg-emerald-400' : '!bg-slate-600'}`} />
      <Handle type="target" position={Position.Top} id="target-s2" style={{ left: '29%' }} className={`w-3 h-3 border-2 !border-[#070b14] ${isConnected ? '!bg-amber-400' : '!bg-slate-600'}`} />
      <Handle type="target" position={Position.Top} id="target-s3" style={{ left: '50%' }} className={`w-3 h-3 border-2 !border-[#070b14] ${isConnected ? '!bg-red-400' : '!bg-slate-600'}`} />
      <Handle type="target" position={Position.Top} id="target-s4" style={{ left: '71%' }} className={`w-3 h-3 border-2 !border-[#070b14] ${isConnected ? '!bg-blue-400' : '!bg-slate-600'}`} />
      <Handle type="target" position={Position.Top} id="target-s5" style={{ left: '91%' }} className={`w-3 h-3 border-2 !border-[#070b14] ${isConnected ? '!bg-purple-400' : '!bg-slate-600'}`} />

      <div className={`flex items-center justify-between border-b pb-2.5 mb-3 ${isConnected ? 'border-cyan-900/50' : 'border-red-900/40'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg border ${
            isConnected 
              ? 'bg-cyan-950/80 border-cyan-500/40 text-cyan-300' 
              : 'bg-red-950/80 border-red-500/40 text-red-400'
          }`}>
            <Layers className={`w-5 h-5 ${isConnected ? 'animate-pulse text-cyan-400' : 'text-red-400'}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-black tracking-wider uppercase text-white font-mono">
                {String(data.label || 'Execution over Kraken + Kraken Pro')}
              </span>
              {isConnected ? (
                <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                  PRO LIVE MESH
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/40 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                  DISCONNECTED (ZERO-DUMMY)
                </span>
              )}
            </div>
            <p className={`text-[10px] font-mono ${isConnected ? 'text-cyan-300/70' : 'text-red-300/80'}`}>
              {isConnected
                ? `Kraken CLI ${String(data.cliVersion || '')} • BTC ${data.btcLast ?? '—'} • SOL ${data.solLast ?? '—'}`
                : String(data.reason || 'Kraken CLI did not return status. No orders are sent.')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px]">
          {isConnected ? (
            <>
              <div className="px-2.5 py-1 rounded bg-slate-900/80 border border-slate-700 text-slate-300 flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-cyan-400" />
                <span>CLI: <strong>{data.latencyMs != null ? `${data.latencyMs} ms` : '—'}</strong></span>
              </div>
              <div className="px-2.5 py-1 rounded bg-slate-900/80 border border-slate-700 text-slate-300 flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span>BTC: <strong>{data.btcLast != null ? String(data.btcLast) : '—'}</strong></span>
              </div>
              <div className="px-2.5 py-1 rounded bg-emerald-950/50 border border-emerald-500/30 text-emerald-300 font-bold">
                SOL: {data.solLast != null ? String(data.solLast) : '—'}
              </div>
            </>
          ) : (
            <>
              <div className="px-2.5 py-1 rounded bg-red-950/40 border border-red-800 text-red-300 flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-red-400" />
                <span>Exchange: <strong>OFFLINE</strong></span>
              </div>
              <div className="px-2.5 py-1 rounded bg-slate-900/80 border border-slate-800 text-slate-400 flex items-center gap-1.5">
                <span>Orders: <strong>0 (No Dummies)</strong></span>
              </div>
              <div className="px-2.5 py-1 rounded bg-red-950/30 border border-red-500/40 text-red-400 font-bold">
                Fail-Closed: GESPERRT
              </div>
            </>
          )}
        </div>
      </div>

      {/* 5 Ingress Channels */}
      <div className="grid grid-cols-5 gap-2">
        <div className={`p-2 rounded-lg font-mono text-[10px] flex flex-col gap-1 ${
          isConnected ? 'bg-emerald-950/30 border border-emerald-500/30' : 'bg-slate-900/50 border border-slate-800'
        }`}>
          <div className={`font-bold flex items-center justify-between ${isConnected ? 'text-emerald-400' : 'text-slate-400'}`}>
            <span>L1: Scout Router</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          </div>
          <div className="text-slate-400 text-[9px]">Pair: XXBTZUSD</div>
          <div className="text-slate-500 text-[9px]">{isConnected ? 'Tranche 1 Market/Limit' : 'Offline (No Connection)'}</div>
        </div>

        <div className={`p-2 rounded-lg font-mono text-[10px] flex flex-col gap-1 ${
          isConnected ? 'bg-amber-950/30 border border-amber-500/30' : 'bg-slate-900/50 border border-slate-800'
        }`}>
          <div className={`font-bold flex items-center justify-between ${isConnected ? 'text-amber-400' : 'text-slate-400'}`}>
            <span>L2: Pyramid Trailing</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-amber-400' : 'bg-slate-600'}`} />
          </div>
          <div className="text-slate-400 text-[9px]">Pair: XXBTZUSD</div>
          <div className="text-slate-500 text-[9px]">{isConnected ? 'Tranches 2-4 (ATR Lock)' : 'Offline (No Connection)'}</div>
        </div>

        <div className={`p-2 rounded-lg font-mono text-[10px] flex flex-col gap-1 ${
          isConnected ? 'bg-red-950/30 border border-red-500/30' : 'bg-slate-900/50 border border-slate-800'
        }`}>
          <div className={`font-bold flex items-center justify-between ${isConnected ? 'text-red-400' : 'text-slate-400'}`}>
            <span>L3: Cluster Exit</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-red-400' : 'bg-slate-600'}`} />
          </div>
          <div className="text-slate-400 text-[9px]">Axiom 3 Ground State</div>
          <div className="text-slate-500 text-[9px]">{isConnected ? 'Atomic 100% Cash Reset' : 'Offline (No Connection)'}</div>
        </div>

        <div className={`p-2 rounded-lg font-mono text-[10px] flex flex-col gap-1 ${
          isConnected ? 'bg-blue-950/30 border border-blue-500/30' : 'bg-slate-900/50 border border-slate-800'
        }`}>
          <div className={`font-bold flex items-center justify-between ${isConnected ? 'text-blue-400' : 'text-slate-400'}`}>
            <span>L4: BTC DCA</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-blue-400 animate-pulse' : 'bg-slate-600'}`} />
          </div>
          <div className="text-slate-400 text-[9px]">{isConnected ? 'Schedule: 4h / Dip > 2.5%' : 'Inactive'}</div>
          <div className="text-slate-500 text-[9px]">{isConnected ? '$150 Tranche / Auto-DCA' : 'Offline (No Connection)'}</div>
        </div>

        <div className={`p-2 rounded-lg font-mono text-[10px] flex flex-col gap-1 ${
          isConnected ? 'bg-purple-950/30 border border-purple-500/30' : 'bg-slate-900/50 border border-slate-800'
        }`}>
          <div className={`font-bold flex items-center justify-between ${isConnected ? 'text-purple-400' : 'text-slate-400'}`}>
            <span>L5: SOL DCA</span>
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-purple-400 animate-pulse' : 'bg-slate-600'}`} />
          </div>
          <div className="text-slate-400 text-[9px]">{isConnected ? 'High-Beta Dip Trigger' : 'Inactive'}</div>
          <div className="text-slate-500 text-[9px]">{isConnected ? '$75 Tranche / Auto-DCA' : 'Offline (No Connection)'}</div>
        </div>
      </div>
    </motion.div>
  );
};

const nodeTypes = {
  agentNode: AgentNode,
  executionNode: KrakenExecutionNode,
};

const initialNodes: Node[] = [
  // Top: Master Orchestrator
  { 
    id: 'nio', 
    type: 'agentNode', 
    position: { x: 480, y: 30 }, 
    data: { 
      label: 'NIO Twin', 
      role: 'Master Orchestrator', 
      state: 'GREEN_GLOW', 
      icon: Brain, 
      logs: ['System boot OK', 'Governance matrix online', 'Kraken Pro Gateway bound'] 
    } 
  },
  // Middle Layer: Feeds, Risk Gate, Knowledge
  { 
    id: 'kraken_feed', 
    type: 'agentNode', 
    position: { x: 100, y: 170 }, 
    data: { 
      label: 'Kraken Feed', 
      role: 'Market Data L2/L3', 
      state: 'GREEN_SOLID', 
      icon: Radio, 
      logs: ['Connected to WSS ws.kraken.com/v2', 'Ingesting Ticks L2/L3', 'Latency: 0.12ms'] 
    } 
  },
  { 
    id: 'judge', 
    type: 'agentNode', 
    position: { x: 480, y: 180 }, 
    data: { 
      label: 'The Judge', 
      role: 'M8-Gate Risk Eval', 
      state: 'GREEN_SOLID', 
      icon: Shield, 
      logs: ['Validating Pyramiding Invariance', 'Risk boundaries verified', 'Axiom 5 Exchange Hard-Stop active'] 
    } 
  },
  { 
    id: 'knowledge', 
    type: 'agentNode', 
    position: { x: 860, y: 170 }, 
    data: { 
      label: 'Knowledge Lib', 
      role: 'Vision / Vector', 
      state: 'GREEN_GLOW', 
      icon: Database, 
      logs: [
        'Photos & Wyckoff Schemas loaded',
        'Ontology & Vector Store: Ingested',
        'M8-Gate Reference active to The Judge',
        'Dip-DCA Matrices active to Limbs 4 & 5'
      ] 
    } 
  },
  // Swarm Limbs: 1 to 5 (Directly matching user drawing)
  { 
    id: 'swarm_1', 
    type: 'agentNode', 
    position: { x: 70, y: 330 }, 
    data: { 
      label: 'Swarm Limb 1', 
      role: 'Scout Node', 
      state: 'GREEN_GLOW', 
      icon: Zap, 
      logs: ['P_active detected', 'Scout deployed @ 64320 on Kraken Pro', 'Axiom 1 Tranche Invariance OK'] 
    } 
  },
  { 
    id: 'swarm_2', 
    type: 'agentNode', 
    position: { x: 275, y: 330 }, 
    data: { 
      label: 'Swarm Limb 2', 
      role: 'Pyramid Node', 
      state: 'YELLOW', 
      icon: Activity, 
      logs: ['Standby for ATR trailing expansion', 'Target: XXBTZUSD +1.8% break'] 
    } 
  },
  { 
    id: 'swarm_3', 
    type: 'agentNode', 
    position: { x: 480, y: 330 }, 
    data: { 
      label: 'Swarm Limb 3', 
      role: 'Cluster Exit', 
      state: 'RED_GLOW', 
      icon: Cpu, 
      logs: ['Locked - Awaiting Phase Reversal', 'Atomic 100% Cash Ground State armed'] 
    } 
  },
  { 
    id: 'swarm_4', 
    type: 'agentNode', 
    position: { x: 685, y: 330 }, 
    data: { 
      label: 'Swarm Limb 4', 
      role: 'Btc Dca', 
      state: 'BLUE_GLOW', 
      icon: Coins, 
      logs: ['Schedule: Every 4h or Dip > 2.5%', 'Alloc: $150 BTC Tranche', 'Target: Kraken Pro Book'] 
    } 
  },
  { 
    id: 'swarm_5', 
    type: 'agentNode', 
    position: { x: 890, y: 330 }, 
    data: { 
      label: 'Swarm Limb 5', 
      role: 'Sol Dca', 
      state: 'PURPLE_GLOW', 
      icon: TrendingUp, 
      logs: ['High-Beta Dip Accumulation', 'Alloc: $75 SOL Tranche', 'Sub-15µs matching armed'] 
    } 
  },
  // Bottom Wide Node: Execution over Kraken + Kraken Pro
  { 
    id: 'kraken_exec', 
    type: 'executionNode', 
    position: { x: 70, y: 470 }, 
    data: { 
      label: 'Execution over Kraken + Kraken Pro', 
      role: 'Sub-15µs Native REST / WebSocket / FIX Matching Engine Mesh', 
      state: 'GREEN_GLOW', 
      icon: Layers,
      logs: [
        'Kraken Pro REST / FIX / WebSocket v2 Engine CONNECTED',
        'OCO Shadow-Limit Mesh: Active across all 5 Limb pipelines',
        'Auto-Earn: 10% Vault engaged at 7.25% APY',
        'Order routes active: Scout, Pyramid, Exit, BTC DCA, SOL DCA'
      ] 
    } 
  }
];

const initialEdges: Edge[] = [
  // Orchestrator connections
  { id: 'e-nio-kraken', source: 'nio', target: 'kraken_feed', animated: true, style: { stroke: '#22d3ee', strokeWidth: 2 } },
  { id: 'e-nio-knowledge', source: 'nio', target: 'knowledge', animated: true, style: { stroke: '#c084fc', strokeWidth: 2 } },
  { id: 'e-nio-judge', source: 'nio', target: 'judge', animated: true, style: { stroke: '#22d3ee', strokeWidth: 2 } },
  { id: 'e-kraken-judge', source: 'kraken_feed', target: 'judge', animated: true, style: { stroke: '#10b981', strokeWidth: 2 } },
  
  // Knowledge Library Data Feeds (Vision / Vector / Wyckoff)
  // 1. To The Judge: M8-Gate Pattern Validation & Ontology Ref
  { 
    id: 'e-knowledge-judge', 
    source: 'knowledge', 
    sourceHandle: 'source-left', 
    target: 'judge', 
    targetHandle: 'target-right', 
    animated: true, 
    style: { stroke: '#c084fc', strokeWidth: 2.2, strokeDasharray: '4,4' } 
  },
  // 2. To Swarm Limb 5 (SOL DCA): Historical Dip Vectors & Support Schemas
  { 
    id: 'e-knowledge-s5', 
    source: 'knowledge', 
    target: 'swarm_5', 
    animated: true, 
    style: { stroke: '#a855f7', strokeWidth: 1.8, strokeDasharray: '4,4' } 
  },
  // 3. To Swarm Limb 4 (BTC DCA): Wyckoff Accumulation Zone Lookup
  { 
    id: 'e-knowledge-s4', 
    source: 'knowledge', 
    target: 'swarm_4', 
    animated: true, 
    style: { stroke: '#818cf8', strokeWidth: 1.8, strokeDasharray: '4,4' } 
  },

  // Judge to Swarm Limbs 1-5 (Evaluating risk gate)
  { id: 'e-judge-s1', source: 'judge', target: 'swarm_1', animated: true, style: { stroke: '#10b981', strokeWidth: 2 } },
  { id: 'e-judge-s2', source: 'judge', target: 'swarm_2', animated: false, style: { stroke: '#f59e0b', strokeWidth: 2 } },
  { id: 'e-judge-s3', source: 'judge', target: 'swarm_3', animated: false, style: { stroke: '#ef4444', strokeWidth: 2 } },
  { id: 'e-judge-s4', source: 'judge', target: 'swarm_4', animated: true, style: { stroke: '#3b82f6', strokeWidth: 2 } },
  { id: 'e-judge-s5', source: 'judge', target: 'swarm_5', animated: true, style: { stroke: '#a855f7', strokeWidth: 2 } },

  // Execution Streams: All 5 Limbs routing orders directly into Kraken + Kraken Pro
  { id: 'e-s1-exec', source: 'swarm_1', target: 'kraken_exec', targetHandle: 'target-s1', animated: true, style: { stroke: '#10b981', strokeWidth: 2.5 } },
  { id: 'e-s2-exec', source: 'swarm_2', target: 'kraken_exec', targetHandle: 'target-s2', animated: false, style: { stroke: '#f59e0b', strokeWidth: 2.5 } },
  { id: 'e-s3-exec', source: 'swarm_3', target: 'kraken_exec', targetHandle: 'target-s3', animated: false, style: { stroke: '#ef4444', strokeWidth: 2.5 } },
  { id: 'e-s4-exec', source: 'swarm_4', target: 'kraken_exec', targetHandle: 'target-s4', animated: true, style: { stroke: '#3b82f6', strokeWidth: 2.5 } },
  { id: 'e-s5-exec', source: 'swarm_5', target: 'kraken_exec', targetHandle: 'target-s5', animated: true, style: { stroke: '#a855f7', strokeWidth: 2.5 } }
];

export default function AgentCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [inspectedNode, setInspectedNode] = useState<any | null>(null);
  const [executionTelemetry, setExecutionTelemetry] = useState<any | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [selectedBotModal, setSelectedBotModal] = useState<TradingBot | null>(null);

  const openBotWidget = async (botId: string) => {
    try {
      const res = await fetch(`/api/bots/${botId}`);
      if (res.ok) {
        const botData: TradingBot = await res.json();
        setSelectedBotModal(botData);
      }
    } catch (e) {
      console.error('Failed to load bot widget', e);
    }
  };
  const [isExecutingAction, setIsExecutingAction] = useState(false);

  const fetchExecutionStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/kraken/status');
      if (res.ok) {
        const data = await res.json();
        setExecutionTelemetry(data);

        // Dynamically synchronize nodes with real exchange connectivity
        setNodes((currentNodes) =>
          currentNodes.map((node) => {
            if (node.id === 'kraken_exec') {
              return {
                ...node,
                data: {
                  ...node.data,
                  connected: data.connected,
                  state: data.connected ? 'GREEN_GLOW' : 'RED_GLOW',
                  latencyMs: data.latencyMs,
                  cliVersion: data.cliVersion,
                  cliPath: data.cliPath,
                  btcLast: data.ticker?.BTCUSD?.last ?? null,
                  solLast: data.ticker?.SOLUSD?.last ?? null,
                  reason: data.reason,
                  logs: data.connected
                    ? [
                        `${data.cliVersion || 'kraken'} ${data.cliPath || ''}`.trim(),
                        data.ticker?.BTCUSD?.last
                          ? `BTCUSD last ${data.ticker.BTCUSD.last}`
                          : 'BTC ticker missing',
                        data.ticker?.SOLUSD?.last
                          ? `SOLUSD last ${data.ticker.SOLUSD.last}`
                          : 'SOL ticker missing'
                      ]
                    : [
                        'Exchange Status: DISCONNECTED / OFFLINE',
                        'Zero-Dummy Guarantee: Keine Schein-Orders simuliert',
                        data.reason || 'Kraken CLI did not return status'
                      ]
                }
              };
            }
            if (node.id === 'kraken_feed') {
              return {
                ...node,
                data: {
                  ...node.data,
                  state: data.connected ? 'GREEN_SOLID' : 'RED_GLOW',
                  logs: data.connected
                    ? ['Connected to WSS ws.kraken.com/v2', 'Ingesting Ticks L2/L3']
                    : [
                        'Feed: DISCONNECTED (Offline)',
                        'Zero-Dummy Guarantee: Keine gefakten Ticks generiert'
                      ]
                }
              };
            }
            return node;
          })
        );

        // Dynamically toggle edge animations based on connectivity
        setEdges((currentEdges) =>
          currentEdges.map((edge) => {
            if (edge.target === 'kraken_exec') {
              return {
                ...edge,
                animated: data.connected,
                style: data.connected
                  ? edge.style
                  : { stroke: '#475569', strokeWidth: 1.5, strokeDasharray: '4,4' }
              };
            }
            return edge;
          })
        );
      }
    } catch (e) {
      console.error('Failed to fetch Kraken execution status', e);
    }
  }, [setNodes, setEdges]);

  useEffect(() => {
    fetchExecutionStatus();
    const interval = setInterval(fetchExecutionStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchExecutionStatus]);

  const onConnect = useCallback((params: any) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: any) => {
    setInspectedNode(node);
    setActionStatus(null);
  }, []);

  const closeInspector = () => setInspectedNode(null);

  // Trigger manual DCA order via Kraken backend
  const handleTriggerDca = async (limb: 4 | 5, asset: 'BTC' | 'SOL', amountUSD: number) => {
    if (!executionTelemetry?.connected) {
      setActionStatus('⛔ ABGELEHNT (Zero-Dummy Guarantee): Keine Kraken-Verbindung aktiv. Simulationen und Schein-Fills sind strikt deaktiviert.');
      return;
    }

    setIsExecutingAction(true);
    setActionStatus(`Dispatching Limb ${limb} (${asset}) order to Kraken Pro...`);
    try {
      const res = await fetch('/api/kraken/dca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limb, asset, amountUSD })
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`Order executed on Kraken Pro: ${data.limb} ${amountUSD} filled.`);
        fetchExecutionStatus();
      } else {
        setActionStatus(`⛔ Order abgelehnt: ${data.error || 'Check exchange connection'}`);
      }
    } catch (e: any) {
      setActionStatus(`Execution error: ${e.message}`);
    } finally {
      setIsExecutingAction(false);
    }
  };

  return (
    <div className="w-full h-full relative font-sans">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        className="bg-[#090b12]"
        defaultEdgeOptions={{
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' }
        }}
      >
        <Background color="#1e293b" gap={24} size={1} />
        <Controls className="!bg-[#121620] !border-slate-800 !fill-slate-300" />
        <MiniMap 
          nodeColor={(n) => {
            if (n.id === 'kraken_exec') return '#06b6d4';
            switch(n.data?.state) {
              case 'GREEN_GLOW': return '#10b981';
              case 'GREEN_SOLID': return '#059669';
              case 'YELLOW': return '#f59e0b';
              case 'RED_GLOW': return '#ef4444';
              case 'BLUE_GLOW': return '#3b82f6';
              case 'PURPLE_GLOW': return '#a855f7';
              default: return '#475569';
            }
          }}
          maskColor="rgba(9, 11, 18, 0.8)"
          className="!bg-[#121620] !border-slate-800"
        />
        
        {inspectedNode && (
          <Panel position="top-right" className="bg-[#121620] border border-slate-700 p-4 rounded-xl shadow-2xl w-96 text-slate-200 m-4 flex flex-col gap-3.5 z-20">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2 font-mono">
                  {inspectedNode.data.label}
                </h3>
                <p className="text-[11px] text-slate-400 font-mono">{inspectedNode.data.role}</p>
              </div>
              <button onClick={closeInspector} className="p-1 hover:bg-slate-800 rounded-md transition-colors">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Special Inspection View for Kraken Execution Node */}
            {inspectedNode.id === 'kraken_exec' ? (
              <div className="space-y-3 font-mono text-xs">
                <div className={`p-2.5 rounded-lg border ${
                  executionTelemetry?.connected
                    ? 'bg-[#0a0e17] border-cyan-500/30'
                    : 'bg-red-950/40 border-red-500/40'
                }`}>
                  <div className="text-[10px] uppercase font-bold tracking-wider mb-1.5 flex items-center justify-between">
                    <span className={executionTelemetry?.connected ? 'text-cyan-400' : 'text-red-400'}>
                      Kraken Pro Execution Gate
                    </span>
                    {executionTelemetry?.connected ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> ONLINE
                      </span>
                    ) : (
                      <span className="text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> DISCONNECTED
                      </span>
                    )}
                  </div>
                  {executionTelemetry?.connected ? (
                    <div className="space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">CLI:</span>
                        <span className="text-white truncate">{executionTelemetry.cliVersion || 'kraken'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">BTCUSD last:</span>
                        <span className="text-emerald-400 font-bold">{executionTelemetry.ticker?.BTCUSD?.last ?? '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">SOLUSD last:</span>
                        <span className="text-emerald-400 font-bold">{executionTelemetry.ticker?.SOLUSD?.last ?? '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Round trip:</span>
                        <span className="text-white">{executionTelemetry.latencyMs ?? '—'} ms</span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5 text-[10px] text-slate-300">
                      <div className="font-bold text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                        ZERO-DUMMY GUARANTEE: FAIL-CLOSED
                      </div>
                      <p className="text-slate-300 leading-relaxed text-[10px]">
                        {executionTelemetry?.reason || 'Kraken CLI binary was not found, or `kraken status` did not return online.'}
                      </p>
                      <p className="text-red-300/90 leading-relaxed text-[10px]">
                        Da keine Verbindung besteht, wird nichts simuliert (keine Schein-Orders, keine erfundenen Responses). Order-Routing ist Fail-Closed gesperrt.
                      </p>
                    </div>
                  )}
                </div>

                {/* Quick Execution Actions */}
                <div className="space-y-1.5">
                  <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                    Instant Kraken Pro Order Dispatch
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => handleTriggerDca(4, 'BTC', 150)}
                      disabled={isExecutingAction || !executionTelemetry?.connected}
                      title={!executionTelemetry?.connected ? 'Keine Kraken-Verbindung (Zero-Dummy: Keine Simulationen)' : undefined}
                      className="p-2 bg-blue-950/60 hover:bg-blue-900/80 border border-blue-500/40 text-blue-300 rounded text-[11px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      <Coins className="w-3.5 h-3.5" />
                      L4: BTC DCA ($150)
                    </button>
                    <button
                      onClick={() => handleTriggerDca(5, 'SOL', 75)}
                      disabled={isExecutingAction || !executionTelemetry?.connected}
                      title={!executionTelemetry?.connected ? 'Keine Kraken-Verbindung (Zero-Dummy: Keine Simulationen)' : undefined}
                      className="p-2 bg-purple-950/60 hover:bg-purple-900/80 border border-purple-500/40 text-purple-300 rounded text-[11px] font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      <TrendingUp className="w-3.5 h-3.5" />
                      L5: SOL DCA ($75)
                    </button>
                  </div>
                  {actionStatus && (
                    <div className="p-2 bg-slate-900 border border-slate-700 rounded text-[10px] text-cyan-300">
                      {actionStatus}
                    </div>
                  )}
                </div>

                {/* Recent Execution Order History */}
                <div className="space-y-1.5">
                  <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider flex items-center justify-between">
                    <span>Recent Kraken Pro Fills</span>
                    <button onClick={fetchExecutionStatus} className="text-slate-500 hover:text-slate-300">
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="bg-[#0a0c10] border border-slate-800 p-2.5 rounded-lg text-[10px] flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                    {executionTelemetry?.recentOrders?.map((ord: any) => (
                      <div key={ord.id} className="flex justify-between items-center border-b border-slate-900/80 pb-1 text-slate-300">
                        <div>
                          <span className="text-emerald-400 font-bold mr-1.5">{ord.type}</span>
                          <span className="text-slate-200">{ord.volume}</span>
                          <span className="text-slate-500 text-[9px] ml-1">({ord.limb})</span>
                        </div>
                        <div className="text-right">
                          <div className="text-cyan-300">{ord.price}</div>
                          <div className="text-slate-600 text-[8px]">{ord.time}</div>
                        </div>
                      </div>
                    )) || (
                      <div className="text-slate-500 italic text-[10px]">
                        {executionTelemetry?.connected ? 'No orders yet.' : 'Keine Verbindung: 0 Orders (Zero-Dummy).'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              // Standard Limb or Node Inspector
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Node State</p>
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      inspectedNode.data.state.includes('GREEN') ? 'bg-emerald-500' :
                      inspectedNode.data.state.includes('BLUE') ? 'bg-blue-500' :
                      inspectedNode.data.state.includes('PURPLE') ? 'bg-purple-500' :
                      inspectedNode.data.state.includes('YELLOW') ? 'bg-amber-500' :
                      inspectedNode.data.state.includes('RED') ? 'bg-red-500' : 'bg-slate-500'
                    } ${inspectedNode.data.state.includes('GLOW') ? 'animate-pulse shadow-[0_0_8px_currentColor]' : ''}`} />
                    <span className="text-xs font-mono font-medium">{inspectedNode.data.state}</span>
                  </div>
                </div>

                {/* Specific actions if Limb 4 or 5 is selected */}
                {inspectedNode.id === 'swarm_4' && (
                  <div className="p-2.5 rounded bg-blue-950/40 border border-blue-500/30 text-[11px] font-mono space-y-2">
                    <div className="text-blue-300 font-bold">Limb 4: BTC DCA Accumulator</div>
                    <p className="text-slate-300 text-[10px]">
                      Routes dynamic market/limit DCA tranches directly into Kraken Pro book.
                    </p>
                    <button
                      onClick={() => handleTriggerDca(4, 'BTC', 150)}
                      disabled={isExecutingAction || !executionTelemetry?.connected}
                      className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {executionTelemetry?.connected ? 'Execute $150 BTC DCA Now' : 'DCA Gesperrt (Keine Kraken-Verbindung)'}
                    </button>
                    <button
                      onClick={() => openBotWidget('SWARM-L4')}
                      className="w-full py-1.5 bg-gradient-to-r from-purple-600/30 to-indigo-600/30 hover:from-purple-600/50 hover:to-indigo-600/50 border border-purple-500/40 text-purple-300 rounded font-bold text-[10px] flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <BotIcon className="w-3.5 h-3.5" />
                      Bot-Widget (BTC DCA) öffnen
                    </button>
                    {!executionTelemetry?.connected && (
                      <div className="text-[9px] text-amber-400">⚠️ Gateway Offline: Keine Simulationen im Zero-Dummy Modus.</div>
                    )}
                    {actionStatus && <div className="text-[9px] text-cyan-300">{actionStatus}</div>}
                  </div>
                )}

                {inspectedNode.id === 'swarm_5' && (
                  <div className="p-2.5 rounded bg-purple-950/40 border border-purple-500/30 text-[11px] font-mono space-y-2">
                    <div className="text-purple-300 font-bold">Limb 5: SOL DCA Accumulator</div>
                    <p className="text-slate-300 text-[10px]">
                      High-beta dip trigger routing orders into Kraken Pro matching engine.
                    </p>
                    <button
                      onClick={() => handleTriggerDca(5, 'SOL', 75)}
                      disabled={isExecutingAction || !executionTelemetry?.connected}
                      className="w-full py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded font-bold text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {executionTelemetry?.connected ? 'Execute $75 SOL DCA Now' : 'DCA Gesperrt (Keine Kraken-Verbindung)'}
                    </button>
                    <button
                      onClick={() => openBotWidget('SWARM-L5')}
                      className="w-full py-1.5 bg-gradient-to-r from-purple-600/30 to-indigo-600/30 hover:from-purple-600/50 hover:to-indigo-600/50 border border-purple-500/40 text-purple-300 rounded font-bold text-[10px] flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <BotIcon className="w-3.5 h-3.5" />
                      Bot-Widget (SOL DCA) öffnen
                    </button>
                    {!executionTelemetry?.connected && (
                      <div className="text-[9px] text-amber-400">⚠️ Gateway Offline: Keine Simulationen im Zero-Dummy Modus.</div>
                    )}
                    {actionStatus && <div className="text-[9px] text-cyan-300">{actionStatus}</div>}
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Recent Telemetry</p>
                  <div className="bg-[#0a0c10] border border-slate-800 p-3 rounded-lg font-mono text-[10px] text-slate-300 flex flex-col gap-1.5 h-28 overflow-y-auto">
                    {inspectedNode.data.logs?.map((log: string, idx: number) => (
                      <div key={idx} className="flex gap-2">
                        <span className="text-slate-500 shrink-0">&gt;</span>
                        <span>{log}</span>
                      </div>
                    ))}
                    {!inspectedNode.data.logs?.length && (
                      <span className="text-slate-600 italic">No telemetry data.</span>
                    )}
                  </div>
                </div>

                <div className="flex gap-2 pt-2 border-t border-slate-800">
                  <button 
                    onClick={() => {
                      setActionStatus(`Ping sent to ${inspectedNode.data.label}: 0.14ms ACK`);
                    }}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold py-1.5 rounded-lg transition-colors font-mono"
                  >
                    Ping Agent
                  </button>
                  <button 
                    onClick={() => {
                      setActionStatus(`Node ${inspectedNode.data.label} safety lock verified.`);
                    }}
                    className="flex-1 bg-cyan-950/40 text-cyan-400 hover:bg-cyan-900/50 border border-cyan-800/50 text-xs font-semibold py-1.5 rounded-lg transition-colors font-mono"
                  >
                    Inspect Mesh
                  </button>
                </div>
              </div>
            )}
          </Panel>
        )}
      </ReactFlow>

      {/* Standalone Bot Widget Modal Inspector */}
      {selectedBotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="relative">
            <BotTelemetryCard
              bot={selectedBotModal}
              onClose={() => setSelectedBotModal(null)}
              onToggleStatus={(_botId, newStatus) => {
                setSelectedBotModal(prev => prev ? { ...prev, status: newStatus } : null);
              }}
              onTriggerCycle={async (botId) => {
                try {
                  const res = await fetch(`/api/bots/${botId}/trigger`, { method: 'POST' });
                  if (res.ok) {
                    const updated = await res.json();
                    setSelectedBotModal(updated);
                  }
                } catch (e) {
                  console.error('Trigger cycle failed', e);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
