import { useState, useEffect, useRef, useCallback } from "react";
import { Activity, Brain, Server, Shield, Zap, Terminal, Atom, Bot as BotIcon, Compass, ShieldAlert } from "lucide-react";
import KrakenTerminal from "./KrakenTerminal";
import NeuralKonsole from "./NeuralKonsole";
import AgentCanvas from "./AgentCanvas";
import KnowledgeLib from "./KnowledgeLib";
import SentimentSidebar from "./SentimentSidebar";
import OmegaCockpit from "./OmegaCockpit";
import OmegaDashboard from "./OmegaDashboard";
import GravitationTelemetryGraph from "./GravitationTelemetryGraph";
import GravityFieldVisualizer from "./GravityFieldVisualizer";
import SymbolAmpel from "./SymbolAmpel";
import GPMIncubationArena from "./GPMIncubationArena";
import DualStateVault from "./DualStateVault";
import SystemAxiomMonitor from "./SystemAxiomMonitor";
import SystemStatus from "./SystemStatus";
import BotFleetManager from "./BotFleetManager";
import FailureModesMatrixView from "./FailureModesMatrixView";
import { ContinuousLearningMonitor } from "./ContinuousLearningMonitor";
import { ArchitectTerminalMonitor } from "./ArchitectTerminalMonitor";
import { AgentLogInspector } from "./AgentLogInspector";
import { getLiveOmegaTelemetry } from "../utils/omegaLogic";

export default function NetworkDashboard() {
  const [health, setHealth] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Lifted state from KnowledgeLib
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [orderState, setOrderState] = useState<'idle' | 'executing' | 'success'>('idle');

  // View switch: Network Canvas, Gravitationsfeld (§2), System Status (§14), Risk Matrix (Living Doc), Bot Fleet, OMEGA Blueprint, Continuous Learning, Architect Core, or Rust Kernel Logs
  const [activeView, setActiveView] = useState<'NETWORK' | 'GRAVITY' | 'SYSTEM_STATUS' | 'RISK_MATRIX' | 'BOT_FLEET' | 'OMEGA' | 'LEARNING' | 'ARCHITECT' | 'KERNEL_LOGS'>('NETWORK');

  // States for features
  const [showSentimentSidebar, setShowSentimentSidebar] = useState(false);
  const [autoEarnActive, setAutoEarnActive] = useState(false);
  const [showOmegaCockpit, setShowOmegaCockpit] = useState(false);
  const [omegaTelemetry, setOmegaTelemetry] = useState(getLiveOmegaTelemetry());

  useEffect(() => {
    const timer = setInterval(() => {
      setOmegaTelemetry(getLiveOmegaTelemetry());
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const addLog = useCallback((message: string, level: LogEntry['level'], node?: string) => {
    setLogs(prev => {
      const newLog = {
        id: Math.random().toString(36).slice(2),
        timestamp: new Date(),
        message,
        level,
        node
      };
      const updated = [...prev, newLog];
      return updated.length > 50 ? updated.slice(updated.length - 50) : updated;
    });
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(data => setHealth(data))
      .catch(e => console.error(e));
  }, []);

  useEffect(() => {
    setLogs([{
      id: 'init',
      timestamp: new Date(),
      message: 'M8-Gate Engine Initialized. The Judge & The Swarm online.',
      level: 'success'
    }]);

    const interval = setInterval(() => {
      const newLog = generateRandomLog();
      addLog(newLog.message, newLog.level, newLog.node);
    }, 1800 + Math.random() * 2000);

    return () => clearInterval(interval);
  }, [addLog]);

  const handleAnalyze = useCallback(() => {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalysisResult(null);
    addLog("Initiating secondary vector analysis...", "info", "Knowledge Lib");
    
    // Simulate secondary analysis compute kernel
    setTimeout(() => {
      setIsAnalyzing(false);
      setAnalysisResult("Vector matched. Pattern structural integrity verified at 99.4%.");
      addLog("Vector matched. Pattern structural integrity verified at 99.4%.", "success", "Knowledge Lib");
    }, 2000);
  }, [isAnalyzing, addLog]);

  const handleOrchestrateOrder = useCallback(() => {
    if (orderState !== 'idle') return;
    setOrderState('executing');
    addLog("Orchestrating limit order via Kraken CLI...", "warn", "The Judge");
    
    // Simulate Kraken CLI execution
    setTimeout(() => {
      setOrderState('success');
      addLog("Kraken CLI: Order filled & confirmed. TWAP execution active.", "success", "Kraken Feed");
    }, 1500);
  }, [orderState, addLog]);

  const handleResetKnowledgeState = useCallback(() => {
    setIsAnalyzing(false);
    setAnalysisResult(null);
    setOrderState('idle');
  }, []);

  const handleToggleAutoEarn = useCallback(() => {
    setAutoEarnActive(prev => {
      const newState = !prev;
      addLog(
        newState ? "Auto-Earn protocol engaged. Yield farming initialized." : "Auto-Earn protocol disabled. Returning to standby.",
        newState ? "success" : "warn",
        "The Swarm"
      );
      return newState;
    });
  }, [addLog]);

  const toggleSentimentSidebar = useCallback(() => {
    setShowSentimentSidebar(prev => {
      const newState = !prev;
      if (newState) {
        addLog("Sentiment Sidebar initialized. Connecting to X/Twitter firehose...", "info", "Kraken Feed");
      }
      return newState;
    });
  }, [addLog]);

  return (
    <div className="min-h-screen bg-[#090b12] text-slate-200 p-8">
      <header className="mb-10">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2 flex items-center gap-3">
              <Brain className="w-8 h-8 text-blue-500" />
              Neural Intelligence Network
            </h1>
            <p className="text-slate-400">Monitoring core systems and active nodes.</p>
          </div>
          <div className="flex items-center gap-3">
            {/* View Switcher: Network Canvas vs OMEGA Blueprint Dashboard */}
            <div className="flex items-center gap-1 p-1 bg-[#161a26] border border-slate-700/60 rounded-full">
              <button
                onClick={() => setActiveView('NETWORK')}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${
                  activeView === 'NETWORK' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Network Nodes
              </button>
              <button
                onClick={() => {
                  setActiveView('GRAVITY');
                  addLog("Switched to §2 Gravitationsfeld Potential-Chart & Simulation.", "info", "GravityEngine");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'GRAVITY' ? 'bg-cyan-600 text-white shadow-md' : 'text-cyan-400 hover:text-cyan-200'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                Gravitationsfeld (§2)
              </button>
              <button
                onClick={() => {
                  setActiveView('SYSTEM_STATUS');
                  addLog("Switched to §14 System Axioms Status & Health Metrics.", "info", "SystemStatus");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'SYSTEM_STATUS' ? 'bg-emerald-600 text-white shadow-md' : 'text-emerald-400 hover:text-emerald-200'
                }`}
              >
                <Shield className="w-3.5 h-3.5" />
                System Status (§14)
              </button>
              <button
                onClick={() => {
                  setActiveView('RISK_MATRIX');
                  addLog("Switched to Ausfall- & Fehlermodi Living Document Matrix (12 Mitigations).", "warn", "RiskSentinel");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'RISK_MATRIX' ? 'bg-rose-600 text-white shadow-md animate-pulse' : 'text-rose-400 hover:text-rose-200'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                Fehlermodi-Matrix
              </button>
              <button
                onClick={() => {
                  setActiveView('BOT_FLEET');
                  addLog("Switched to Bot-Flotte & Telemetry Widgets.", "info", "BotManager");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'BOT_FLEET' ? 'bg-purple-600 text-white shadow-md' : 'text-purple-400 hover:text-purple-200'
                }`}
              >
                <BotIcon className="w-3.5 h-3.5" />
                Bot-Flotte &amp; Widgets
              </button>
              <button
                onClick={() => {
                  setActiveView('OMEGA');
                  addLog("Switched to OMEGA Blueprint Dashboard.", "info", "NIO Twin");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'OMEGA' ? 'bg-cyan-600 text-white shadow-md' : 'text-cyan-400 hover:text-cyan-200'
                }`}
              >
                <Atom className="w-3.5 h-3.5 animate-spin-slow" />
                OMEGA Blueprint
              </button>
              <button
                onClick={() => {
                  setActiveView('LEARNING');
                  addLog("Switched to Continuous-Learning Subsystem.", "info", "LearningEngine");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'LEARNING' ? 'bg-indigo-600 text-white shadow-md' : 'text-indigo-400 hover:text-indigo-200'
                }`}
              >
                <Brain className="w-3.5 h-3.5" />
                Continuous Learning
              </button>
              <button
                onClick={() => {
                  setActiveView('ARCHITECT');
                  addLog("Switched to Architect Python GMT Core.", "info", "ArchitectCore");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'ARCHITECT' ? 'bg-emerald-600 text-white shadow-md' : 'text-emerald-400 hover:text-emerald-200'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                Architect GMT
              </button>
              <button
                onClick={() => {
                  setActiveView('KERNEL_LOGS');
                  addLog("Switched to Rust Compute Kernel Agent Log Inspector.", "info", "RustKernel");
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeView === 'KERNEL_LOGS' ? 'bg-amber-600 text-white shadow-md' : 'text-amber-400 hover:text-amber-200'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                Rust Kernel Logs
              </button>
            </div>

            <button 
              onClick={() => {
                setShowOmegaCockpit(true);
                addLog("OMEGA Cockpit opened. Loading Quantum-State and Axiom Telemetry...", "info", "NIO Twin");
              }}
              className="px-4 py-2 bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 hover:from-cyan-500/30 hover:to-indigo-500/30 text-cyan-300 text-sm font-semibold rounded-full transition-all border border-cyan-500/40 whitespace-nowrap flex items-center gap-2 shadow-lg shadow-cyan-500/10"
            >
              <Atom className="w-4 h-4 text-cyan-400 animate-spin-slow" />
              <span>Cockpit Modal</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            </button>
            <button 
              onClick={toggleSentimentSidebar}
              className="px-4 py-2 bg-[#252a36] hover:bg-[#2d3342] text-slate-300 text-sm font-medium rounded-full transition-colors border border-slate-700/50 whitespace-nowrap"
            >
              Add Sentiment Sidebar
            </button>
            <button 
              onClick={handleToggleAutoEarn}
              className={`px-4 py-2 text-sm font-medium rounded-full transition-colors border border-slate-700/50 whitespace-nowrap ${
                autoEarnActive 
                  ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' 
                  : 'bg-[#252a36] hover:bg-[#2d3342] text-slate-300'
              }`}
            >
              Implement Auto-Earn Toggle
            </button>
          </div>
        </div>
      </header>

      {activeView === 'GRAVITY' ? (
        <div className="mt-2 space-y-6">
          <GravityFieldVisualizer
            spotPrice={omegaTelemetry.viaNegativa.spotPrice}
            viaNegativa={omegaTelemetry.viaNegativa}
            gravityField={omegaTelemetry.gravityField}
            onLogEvent={addLog}
          />
        </div>
      ) : activeView === 'SYSTEM_STATUS' ? (
        <div className="mt-2 space-y-6">
          <SystemStatus onLogEvent={addLog} showControls={true} />
          <SystemAxiomMonitor onLogEvent={addLog} />
        </div>
      ) : activeView === 'RISK_MATRIX' ? (
        <div className="mt-2 space-y-6">
          <FailureModesMatrixView onLogEvent={addLog} />
        </div>
      ) : activeView === 'BOT_FLEET' ? (
        <div className="mt-2">
          <BotFleetManager onLogEvent={addLog} />
        </div>
      ) : activeView === 'OMEGA' ? (
        <div className="mt-2">
          <OmegaDashboard onLogEvent={addLog} />
        </div>
      ) : activeView === 'LEARNING' ? (
        <div className="mt-2">
          <ContinuousLearningMonitor onLogEvent={addLog} />
        </div>
      ) : activeView === 'ARCHITECT' ? (
        <div className="mt-2">
          <ArchitectTerminalMonitor onLogEvent={addLog} />
        </div>
      ) : activeView === 'KERNEL_LOGS' ? (
        <div className="mt-2">
          <AgentLogInspector onLogEvent={addLog} />
        </div>
      ) : (
        <>
          {/* OMEGA Canonical Telemetry Banner */}
          <div className="mb-8 p-4 bg-gradient-to-r from-[#101422] via-[#0f1526] to-[#121624] border border-cyan-500/30 rounded-2xl shadow-xl flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400 shrink-0">
                <Atom className="w-6 h-6 animate-spin-slow" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white tracking-wide font-mono">
                    PROJEKT OMEGA: QUANTUM TRADING ENGINE
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded">
                    L4/L5 SOVEREIGN
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono text-slate-400 mt-1 flex-wrap">
                  <span>Leistungsfaktor: <strong className="text-emerald-400">cos φ {omegaTelemetry.acSystem.powerFactor}</strong> ({omegaTelemetry.acSystem.regime})</span>
                  <span>•</span>
                  <span>Gravitation: <strong className="text-cyan-400">V_total {omegaTelemetry.gravityField.vTotal}</strong> (P* ${omegaTelemetry.gravityField.potentialMinimumPrice.toLocaleString()})</span>
                  <span>•</span>
                  <span>Via Negativa: <strong className="text-amber-300">Bounds [${omegaTelemetry.viaNegativa.bLower}, ${omegaTelemetry.viaNegativa.bUpper}]</strong></span>
                  <span>•</span>
                  <span>Anti-Martingale: <strong className="text-emerald-400">Free-Roll ($0.00 Risk)</strong></span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setActiveView('OMEGA');
                  addLog("Opening full OMEGA Blueprint Dashboard...", "info", "NIO Twin");
                }}
                className="px-4 py-2 bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 hover:from-cyan-500/30 hover:to-indigo-500/30 text-cyan-300 border border-cyan-500/40 rounded-xl text-xs font-mono font-bold transition-all shadow-md shadow-cyan-500/10 flex items-center gap-2"
              >
                <Atom className="w-3.5 h-3.5 animate-spin-slow" />
                Vollansicht öffnen
              </button>
              <button
                onClick={() => {
                  setShowOmegaCockpit(true);
                  addLog("Opening OMEGA Quantum Matrix & Axioms Gate...", "info", "The Judge");
                }}
                className="px-4 py-2 bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-2"
              >
                <Zap className="w-3.5 h-3.5" />
                Cockpit Modal
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <StatCard icon={<Server />} title="System Status" value={health?.status === 'ok' ? 'Online' : 'Connecting...'} color="text-emerald-400" />
            <StatCard icon={<Activity />} title="Core Service" value={health?.service || 'N/A'} color="text-blue-400" />
            <StatCard icon={<Zap />} title="Active Tasks" value="0" color="text-amber-400" />
            <StatCard icon={<Shield />} title="Security Tier" value="Maximum" color="text-purple-400" />
          </div>

          {/* §2 3-Component Gravitation Field Force Telemetry Component */}
          <div className="mb-8">
            <GravitationTelemetryGraph
              gravityField={omegaTelemetry.gravityField}
              viaNegativa={omegaTelemetry.viaNegativa}
              spotPrice={omegaTelemetry.viaNegativa.spotPrice}
              onLogEvent={addLog}
            />
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* §8 & §11 Symbol-Ampel: Market Leaders & 5-Min Meta-Rotation */}
            <div className="lg:col-span-3">
              <SymbolAmpel onLogEvent={addLog} />
            </div>

            {/* §9 GPM-Incubation Arena: Top-4 Candidates & Top-2 Live Promotion */}
            <div className="lg:col-span-3">
              <GPMIncubationArena onLogEvent={addLog} />
            </div>

            {/* §10 Dual-State Vault: 90/10 Capital Split & Kraken Flexible Auto-Earn */}
            <div className="lg:col-span-3">
              <DualStateVault onLogEvent={addLog} />
            </div>

            {/* §14 Omega Engine System Status: Health Metrics & 6 Axioms Status Indicators */}
            <div className="lg:col-span-3">
              <SystemStatus onLogEvent={addLog} />
            </div>

            {/* §14 The Judge: System Axiom Monitor & Via Negativa Safe-Zone */}
            <div className="lg:col-span-3">
              <SystemAxiomMonitor onLogEvent={addLog} />
            </div>

            {/* Trading-Bot Flotte: Widgets für jeden aktiven & erstellten Bot */}
            <div className="lg:col-span-3">
              <BotFleetManager onLogEvent={addLog} />
            </div>

            <div className="lg:col-span-2 bg-[#121620] border border-slate-800 rounded-xl h-[500px] min-h-0 relative overflow-hidden flex flex-col">
              <div className="absolute top-4 left-4 z-10 flex flex-col gap-1 pointer-events-none">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" /> Reaktives Node-Canvas
                </h3>
                <p className="text-xs text-slate-400">Interactive telemetry orchestration graph.</p>
              </div>
              <AgentCanvas />
            </div>
            <div className="lg:col-span-1 bg-[#0a0c10] border border-slate-800 rounded-xl flex flex-col overflow-hidden h-[500px] min-h-0">
              <div className="flex-1 min-h-0 overflow-hidden">
                 <TerminalLog logs={logs} />
              </div>
              <KrakenTerminal />
            </div>
          </div>

          <KnowledgeLib 
            isAnalyzing={isAnalyzing}
            analysisResult={analysisResult}
            orderState={orderState}
            onAnalyze={handleAnalyze}
            onOrchestrateOrder={handleOrchestrateOrder}
            onCloseModal={handleResetKnowledgeState}
          />
          
          <NeuralKonsole />
        </>
      )}
      
      <SentimentSidebar 
        isOpen={showSentimentSidebar} 
        onClose={() => setShowSentimentSidebar(false)} 
      />

      <OmegaCockpit
        isOpen={showOmegaCockpit}
        onClose={() => setShowOmegaCockpit(false)}
        onLogEvent={addLog}
      />
    </div>
  );
}



function StatCard({ icon, title, value, color }: { icon: React.ReactNode, title: string, value: string, color: string }) {
  return (
    <div className="bg-[#121620] border border-slate-800 rounded-xl p-6 flex flex-col gap-3">
      <div className={`w-10 h-10 rounded-lg bg-slate-900/50 flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-sm text-slate-400">{title}</p>
        <p className="text-xl font-semibold text-white mt-1">{value}</p>
      </div>
    </div>
  );
}

type LogEntry = {
  id: string;
  timestamp: Date;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  node?: string;
};

const MOCK_EVENTS = [
  { msg: "Ingesting FIX protocol tick data...", type: "info" as const, node: "Kraken Feed" },
  { msg: "[OMEGA §4] cos φ = 0.89. High-efficiency active breakout confirmed.", type: "success" as const, node: "Quantum Core" },
  { msg: "[OMEGA §2] -∇V_total vector pulling towards P* equilibrium ($64,730).", type: "info" as const, node: "Gravity Engine" },
  { msg: "[VIA NEGATIVA §3] 99.9% Quantile bounds verified. Forbidden zone clearance 100%.", type: "info" as const, node: "Via Negativa" },
  { msg: "[OMEGA §5] Anti-Martingale: Trailing stop above entry. Free-Roll active ($0.00 risk).", type: "success" as const, node: "Anti-Martingale" },
  { msg: "[THE JUDGE §14] M8-Gate: Axioms 1-6 evaluated with 100% mathematical integrity.", type: "success" as const, node: "The Judge (M8)" },
  { msg: "[NIO-TWIN §8] 5m Meta-Rotation: SUI leading cluster with RVOL 3.10x and beta 3.20.", type: "info" as const, node: "NIO Twin" },
  { msg: "[OMEGA §10] Dual-State Vault: 10% capital earning in Kraken Flexible Staking (7.25% APY).", type: "info" as const, node: "Dual-State Vault" },
  { msg: "Matrix inversion for covariance estimation completed (0.4ms).", type: "info" as const, node: "Compute Kernel" },
  { msg: "Arbitrage opportunity identified across L2/L3 order books.", type: "info" as const, node: "The Swarm" },
  { msg: "Celery worker [swarm-node-7] heartbeat received. Latency: 1.2ms.", type: "info" as const, node: "Swarm Limbs" },
];

function generateRandomLog(): LogEntry {
  const event = MOCK_EVENTS[Math.floor(Math.random() * MOCK_EVENTS.length)];
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date(),
    message: event.msg,
    level: event.type,
    node: event.node
  };
}

function TerminalLog({ logs }: { logs: LogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0a0c10]">
      <div className="flex items-center gap-2 p-3 border-b border-slate-800 bg-[#121620] shrink-0">
        <Terminal className="w-4 h-4 text-slate-400" />
        <h3 className="text-xs font-semibold text-slate-300 tracking-wider uppercase">Live Terminal Output</h3>
      </div>
      <div 
        ref={containerRef}
        className="flex-1 min-h-0 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-2 scrollbar-thin scrollbar-thumb-slate-700"
      >
        {logs.map(log => (
          <div key={log.id} className="flex gap-3">
            <span className="text-slate-500 shrink-0">
              {log.timestamp.toISOString().split('T')[1].slice(0, 12)}
            </span>
            <span className={`shrink-0 w-[60px] ${
              log.level === 'info' ? 'text-blue-400' :
              log.level === 'success' ? 'text-emerald-400' :
              log.level === 'warn' ? 'text-amber-400' :
              'text-red-400'
            }`}>
              [{log.level.toUpperCase()}]
            </span>
            <span className="text-slate-300 break-words">
              {log.node ? <span className="text-purple-400">[{log.node}] </span> : null}
              {log.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
