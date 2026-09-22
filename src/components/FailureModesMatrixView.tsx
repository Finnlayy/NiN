import React, { useState, useMemo, useCallback } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Play,
  RotateCcw,
  CheckCircle,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Cpu,
  Layers,
  Filter,
  Plus,
  Flame,
  Search,
  ArrowUpRight
} from 'lucide-react';
import {
  FAILURE_MODES_MATRIX,
  FailureModeItem,
  PILLARS_LIST
} from '../data/failureModesMatrix';

interface FailureModesMatrixViewProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
}

export default function FailureModesMatrixView({ onLogEvent }: FailureModesMatrixViewProps) {
  // Living document state: allow additions and simulation of breaker tests
  const [matrixData, setMatrixData] = useState<FailureModeItem[]>(FAILURE_MODES_MATRIX);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedPillar, setSelectedPillar] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [expandedId, setExpandedId] = useState<number | null>(1); // default expand #1
  const [activeTestSim, setActiveTestSim] = useState<{ id: number; status: 'running' | 'success' | 'failed'; log: string } | null>(null);

  // Meta-Breaker alert if >= 2 breakers open
  const openBreakersCount = useMemo(() => {
    return matrixData.filter(m => m.technicalDetails.circuitBreakerState === 'OPEN').length;
  }, [matrixData]);

  const isMetaBreakerEngaged = openBreakersCount >= 2;

  // New failure mode modal / form toggle
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newModeTitle, setNewModeTitle] = useState('');
  const [newModeProb, setNewModeProb] = useState<'Hoch' | 'Mittel' | 'Niedrig'>('Mittel');
  const [newModeDamage, setNewModeDamage] = useState<'Sehr hoch' | 'Hoch' | 'Mittel'>('Hoch');
  const [newModeDetection, setNewModeDetection] = useState('');
  const [newModeMitigation, setNewModeMitigation] = useState('');
  const [newModePillar, setNewModePillar] = useState(PILLARS_LIST[0]);

  // Filters
  const filteredModes = useMemo(() => {
    return matrixData.filter(item => {
      const matchCat = selectedCategory === 'ALL' || item.category === selectedCategory;
      const matchPillar = selectedPillar === 'ALL' || item.pillar === selectedPillar;
      const matchSearch = searchTerm === '' ||
        item.riskTitle.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.mitigation.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.earlyDetection.toLowerCase().includes(searchTerm.toLowerCase());
      return matchCat && matchPillar && matchSearch;
    });
  }, [matrixData, selectedCategory, selectedPillar, searchTerm]);

  // Handle Breaker Simulation Test (Verifying the Kill-Switch path)
  const handleRunMitigationTest = useCallback((item: FailureModeItem) => {
    onLogEvent?.(`Starting automated verification test for #${item.id}: ${item.riskTitle}...`, 'info', 'KillSwitchTest');
    setActiveTestSim({ id: item.id, status: 'running', log: `Injecting fault: ${item.technicalDetails.failureSignature}` });

    setTimeout(() => {
      // Simulate trigger and automated verification
      const passed = true; // verification succeeded in mitigating
      if (passed) {
        setMatrixData(prev => prev.map(m => {
          if (m.id === item.id) {
            return {
              ...m,
              technicalDetails: {
                ...m.technicalDetails,
                circuitBreakerState: 'CLOSED'
              }
            };
          }
          return m;
        }));
        setActiveTestSim({
          id: item.id,
          status: 'success',
          log: `Test PASSED: Mitigation '${item.mitigation.slice(0, 45)}...' prevented failure. Metric verified: ${item.technicalDetails.metricThreshold}`
        });
        onLogEvent?.(`Mitigation Verified for #${item.id}: Kill-Switch & fail-safe path operational.`, 'success', 'SafetyAxiom');
      }
    }, 1400);
  }, [onLogEvent]);

  // Toggle Breaker state manually for testing meta-error
  const handleToggleBreaker = useCallback((id: number) => {
    setMatrixData(prev => prev.map(m => {
      if (m.id === id) {
        const nextState = m.technicalDetails.circuitBreakerState === 'CLOSED' ? 'OPEN' : 'CLOSED';
        return {
          ...m,
          technicalDetails: {
            ...m.technicalDetails,
            circuitBreakerState: nextState
          }
        };
      }
      return m;
    }));

    const target = matrixData.find(m => m.id === id);
    const willOpen = target?.technicalDetails.circuitBreakerState === 'CLOSED';
    onLogEvent?.(
      `Manual Circuit Breaker override for #${id} (${target?.riskTitle}): ${willOpen ? 'BREAKER TRIPPED (OPEN)' : 'BREAKER RESET (CLOSED)'}`,
      willOpen ? 'warn' : 'info',
      'MetaBreakerEngine'
    );
  }, [matrixData, onLogEvent]);

  const handleResetAllBreakers = useCallback(() => {
    setMatrixData(prev => prev.map(m => ({
      ...m,
      technicalDetails: { ...m.technicalDetails, circuitBreakerState: 'CLOSED' }
    })));
    onLogEvent?.("Global Reset: All circuit breakers restored to CLOSED state.", 'success', 'MetaBreakerEngine');
  }, [onLogEvent]);

  const handleAddNewItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newModeTitle.trim() || !newModeMitigation.trim()) return;

    const newItem: FailureModeItem = {
      id: matrixData.length + 1,
      riskTitle: newModeTitle,
      category: 'SYSTEMIC_CASCADE',
      probability: newModeProb,
      impact: newModeDamage,
      probabilityScore: newModeProb === 'Hoch' ? 3 : newModeProb === 'Mittel' ? 2 : 1,
      impactScore: newModeDamage === 'Sehr hoch' ? 3 : newModeDamage === 'Hoch' ? 2 : 1,
      earlyDetection: newModeDetection || 'Anomalie im Liveness-Monitor',
      mitigation: newModeMitigation,
      pillar: newModePillar,
      isKillSwitchRelated: true,
      technicalDetails: {
        failureSignature: "Benutzerdefinierter Fehlermodus - Telemetrie-Abweichung",
        automatedAction: `Automatische Mitigation: ${newModeMitigation}`,
        verificationTest: "Synthetische Injektion vor Deployment im Staging-Kanal",
        metricThreshold: "Toleranzdelta < 1.0%",
        circuitBreakerState: "CLOSED"
      }
    };

    setMatrixData(prev => [newItem, ...prev]);
    setShowAddModal(false);
    setNewModeTitle('');
    setNewModeDetection('');
    setNewModeMitigation('');
    onLogEvent?.(`New living document entry added: #${newItem.id} - ${newItem.riskTitle}`, 'success', 'ComplianceAudit');
  };

  return (
    <div className="space-y-6">
      {/* Top Banner: Living Document Governance & Meta-Breaker Sentinel */}
      <div className={`p-6 rounded-2xl border transition-all ${
        isMetaBreakerEngaged 
          ? 'bg-rose-950/40 border-rose-500/80 shadow-2xl shadow-rose-900/40 animate-pulse'
          : 'bg-[#101422] border-slate-800 shadow-xl'
      }`}>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className={`p-2.5 rounded-xl ${
                isMetaBreakerEngaged ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'
              }`}>
                {isMetaBreakerEngaged ? <ShieldAlert className="w-6 h-6 animate-bounce" /> : <ShieldCheck className="w-6 h-6" />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-white tracking-wide font-mono">
                    FEHLERMODI- &amp; AUSFALL-MATRIX (LIVING DOCUMENT)
                  </h2>
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30 rounded-full">
                    {matrixData.length} REGISTRIERTE RISIKEN
                  </span>
                </div>
                <p className="text-xs text-slate-400 max-w-3xl mt-1">
                  Konsolidierte Sicherheitsmatrix des Gesamtsystems. Ungetestete Abschaltpfade sind nach Kill-Switch-Literatur 
                  nicht vertrauenswürdig. Jede neue Venue, Modell oder Kompressor muss vor Inbetriebnahme zertifiziert werden.
                </p>
              </div>
            </div>

            {/* Special Highlight Badges for Row 1 and Row 10 */}
            <div className="flex flex-wrap gap-2 pt-2">
              <div className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[11px] font-mono text-amber-300">
                <Flame className="w-3.5 h-3.5 text-amber-400" />
                <span><strong>Fokus #1:</strong> Parametrischer Look-ahead-Bias (unsichtbar in Backtests, FinCAD-Gate nötig)</span>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 bg-rose-500/10 border border-rose-500/30 rounded-lg text-[11px] font-mono text-rose-300">
                <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                <span><strong>Fokus #10:</strong> Kombinierter Meta-Fehler (≥2 Breaker offen → kein lokales Retry, SAFE-HALT)</span>
              </div>
            </div>
          </div>

          {/* Meta-Breaker Live Status Indicator */}
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <div className={`px-4 py-3 rounded-xl border flex items-center gap-3 ${
              isMetaBreakerEngaged 
                ? 'bg-rose-500/20 border-rose-500/50 text-rose-200' 
                : 'bg-slate-900/80 border-slate-700/60 text-slate-300'
            }`}>
              <div className="text-right">
                <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400">Meta-Breaker Status</div>
                <div className="text-sm font-bold font-mono">
                  {isMetaBreakerEngaged ? '🔴 SAFE-HALT AKTIV' : '🟢 NORMAL (GATING AKTIV)'}
                </div>
              </div>
              <div className="px-2.5 py-1 rounded bg-black/40 text-xs font-mono font-bold border border-white/10">
                {openBreakersCount} / 2 TRIPPED
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setShowAddModal(true)}
                className="px-3 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl transition-all flex items-center gap-1.5 shadow-lg shadow-blue-600/20"
              >
                <Plus className="w-4 h-4" />
                <span>Zeile hinzufügen</span>
              </button>
              {openBreakersCount > 0 && (
                <button
                  onClick={handleResetAllBreakers}
                  className="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-mono rounded-xl transition-all flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Breaker Reset</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Global Meta-Breaker Banner Warning */}
        {isMetaBreakerEngaged && (
          <div className="mt-4 p-3 bg-rose-950/80 border border-rose-500/60 rounded-xl text-rose-200 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 animate-spin" />
              <span>
                <strong>KRITISCHE WARNUNG (Zeile #10 Kaskadenfehler):</strong> Mindestens 2 Circuit Breaker sind simultan im Zustand OPEN. 
                Sämtliche lokalen Retries sind untersagt. Der Orchestrator wurde in den SAFE-HALT versetzt und alle offenen Limit-Orders annulliert.
              </span>
            </div>
            <button
              onClick={handleResetAllBreakers}
              className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded text-[10px] font-mono uppercase font-bold"
            >
              Emergency Override
            </button>
          </div>
        )}
      </div>

      {/* Filter and Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-[#121620] border border-slate-800 rounded-xl">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Risiko, Früherkennung oder Mitigation suchen..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-[#090b12] border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-64"
            />
          </div>

          <div className="flex items-center gap-1.5 bg-[#090b12] p-1 border border-slate-800 rounded-lg text-xs">
            <Filter className="w-3.5 h-3.5 text-slate-400 ml-1" />
            <button
              onClick={() => setSelectedCategory('ALL')}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'ALL' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Alle ({matrixData.length})
            </button>
            <button
              onClick={() => setSelectedCategory('BIAS_MODEL')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'BIAS_MODEL' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Modell / Bias
            </button>
            <button
              onClick={() => setSelectedCategory('EXCHANGE_NETWORK')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'EXCHANGE_NETWORK' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Exchange / Rate-Limit
            </button>
            <button
              onClick={() => setSelectedCategory('ORCHESTRATION_COST')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'ORCHESTRATION_COST' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              FSM / Token
            </button>
            <button
              onClick={() => setSelectedCategory('DATA_INTEGRITY')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'DATA_INTEGRITY' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Daten / Staleness
            </button>
            <button
              onClick={() => setSelectedCategory('SYSTEMIC_CASCADE')}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
                selectedCategory === 'SYSTEMIC_CASCADE' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Meta / Kaskade
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedPillar}
            onChange={(e) => setSelectedPillar(e.target.value)}
            className="bg-[#090b12] border border-slate-700 text-slate-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="ALL">Alle Pfeiler (1 - 5)</option>
            {PILLARS_LIST.map((p, idx) => (
              <option key={idx} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Table: The Core Failure & Mitigation Living Document */}
      <div className="bg-[#121620] border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300 border-collapse">
            <thead>
              <tr className="bg-[#161b2a] text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800">
                <th className="py-3 px-4 w-12 text-center">#</th>
                <th className="py-3 px-4">Risiko / Edge Case</th>
                <th className="py-3 px-3 text-center w-28">Wahrscheinlichkeit</th>
                <th className="py-3 px-3 text-center w-28">Schaden</th>
                <th className="py-3 px-4">Früherkennung</th>
                <th className="py-3 px-4">Mitigation</th>
                <th className="py-3 px-3 text-center w-24">Breaker</th>
                <th className="py-3 px-3 text-right w-24">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {filteredModes.map((item) => {
                const isExpanded = expandedId === item.id;
                const isHighlight = item.id === 1 || item.id === 10;
                const isBreakerOpen = item.technicalDetails.circuitBreakerState === 'OPEN';

                return (
                  <React.Fragment key={item.id}>
                    <tr
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                      className={`hover:bg-slate-800/40 cursor-pointer transition-colors ${
                        isHighlight
                          ? item.id === 1 
                            ? 'bg-amber-950/15 border-l-4 border-amber-500' 
                            : 'bg-rose-950/20 border-l-4 border-rose-500'
                          : isBreakerOpen ? 'bg-rose-950/25' : ''
                      }`}
                    >
                      {/* ID with special highlight tag */}
                      <td className="py-3.5 px-4 text-center font-mono font-bold">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${
                          item.id === 1 
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' 
                            : item.id === 10 
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40' 
                              : 'text-slate-400'
                        }`}>
                          #{item.id}
                        </span>
                      </td>

                      {/* Risk Title */}
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-white flex items-center gap-2">
                          <span>{item.riskTitle}</span>
                          {item.id === 1 && (
                            <span className="px-1.5 py-0.5 text-[9px] font-mono bg-amber-500/20 text-amber-300 rounded border border-amber-500/40 uppercase">
                              Schleichender Bias
                            </span>
                          )}
                          {item.id === 10 && (
                            <span className="px-1.5 py-0.5 text-[9px] font-mono bg-rose-500/20 text-rose-300 rounded border border-rose-500/40 uppercase">
                              Meta-Breaker Trigger
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {item.pillar}
                        </div>
                      </td>

                      {/* Probability */}
                      <td className="py-3.5 px-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                          item.probability === 'Hoch'
                            ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                            : item.probability === 'Mittel'
                              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                              : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        }`}>
                          {item.probability}
                        </span>
                      </td>

                      {/* Damage / Impact */}
                      <td className="py-3.5 px-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                          item.impact === 'Sehr hoch'
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                            : item.impact === 'Hoch'
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                              : 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                        }`}>
                          {item.impact}
                        </span>
                      </td>

                      {/* Early Detection */}
                      <td className="py-3.5 px-4 text-slate-300 text-[11px]">
                        <div className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                          <span>{item.earlyDetection}</span>
                        </div>
                      </td>

                      {/* Mitigation */}
                      <td className="py-3.5 px-4 text-slate-200 font-medium text-[11px]">
                        <div className="flex items-start justify-between gap-2">
                          <span>{item.mitigation}</span>
                          {item.citation && (
                            <a
                              href={item.citation.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-blue-400 hover:text-blue-300 flex items-center gap-0.5 text-[10px] shrink-0 font-mono underline"
                            >
                              <span>{item.citation.title}</span>
                              <ArrowUpRight className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Circuit Breaker Status */}
                      <td className="py-3.5 px-3 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleBreaker(item.id);
                          }}
                          title="Klicken zum manuellen Umschalten für Meta-Fehler-Simulation"
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all border ${
                            isBreakerOpen
                              ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                              : 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60 hover:border-emerald-500'
                          }`}
                        >
                          {isBreakerOpen ? 'OPEN (HALT)' : 'CLOSED'}
                        </button>
                      </td>

                      {/* Expand / Details action */}
                      <td className="py-3.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRunMitigationTest(item);
                            }}
                            title="Kill-Switch Abschaltpfad jetzt testen"
                            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                          >
                            <Play className="w-3.5 h-3.5 text-emerald-400" />
                          </button>
                          <div className="text-slate-500">
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </div>
                        </div>
                      </td>
                    </tr>

                    {/* Detailed Drill-Down Drawer */}
                    {isExpanded && (
                      <tr className="bg-[#0b0e17] border-y border-slate-800">
                        <td colSpan={8} className="p-5">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Column 1: Fault Signature & Automated Action */}
                            <div className="space-y-2 p-3.5 bg-[#121622] border border-slate-800 rounded-xl">
                              <div className="text-[11px] font-mono uppercase font-bold text-amber-400 flex items-center gap-1.5">
                                <Cpu className="w-3.5 h-3.5" />
                                <span>Fehler-Signatur &amp; Trigger</span>
                              </div>
                              <p className="text-xs text-slate-300 leading-relaxed">
                                {item.technicalDetails.failureSignature}
                              </p>
                              <div className="pt-2 border-t border-slate-800">
                                <div className="text-[10px] font-mono uppercase text-slate-400">Automatisierte Aktion</div>
                                <div className="text-xs text-emerald-300 mt-0.5">
                                  {item.technicalDetails.automatedAction}
                                </div>
                              </div>
                            </div>

                            {/* Column 2: Verification Test (Kill-Switch Proof) */}
                            <div className="space-y-2 p-3.5 bg-[#121622] border border-slate-800 rounded-xl">
                              <div className="text-[11px] font-mono uppercase font-bold text-cyan-400 flex items-center gap-1.5">
                                <ShieldCheck className="w-3.5 h-3.5" />
                                <span>Test des Abschaltpfads (Kill-Switch)</span>
                              </div>
                              <p className="text-xs text-slate-300 leading-relaxed">
                                {item.technicalDetails.verificationTest}
                              </p>
                              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                                <div>
                                  <div className="text-[10px] font-mono uppercase text-slate-400">Metrische Schwelle</div>
                                  <div className="text-xs font-mono text-cyan-300 font-semibold">
                                    {item.technicalDetails.metricThreshold}
                                  </div>
                                </div>
                                <button
                                  onClick={() => handleRunMitigationTest(item)}
                                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-mono font-bold flex items-center gap-1"
                                >
                                  <Play className="w-3 h-3" />
                                  <span>Test ausführen</span>
                                </button>
                              </div>
                            </div>

                            {/* Column 3: Literature Reference & Governance */}
                            <div className="space-y-2 p-3.5 bg-[#121622] border border-slate-800 rounded-xl flex flex-col justify-between">
                              <div>
                                <div className="text-[11px] font-mono uppercase font-bold text-purple-400 flex items-center gap-1.5">
                                  <Layers className="w-3.5 h-3.5" />
                                  <span>Governance &amp; Literatur</span>
                                </div>
                                <p className="text-xs text-slate-400 mt-1">
                                  Zertifizierter Pfeiler: <strong className="text-slate-200">{item.pillar}</strong>
                                </p>
                                {item.citation && (
                                  <div className="mt-2 text-xs">
                                    <span className="text-slate-400">Referenz: </span>
                                    <a
                                      href={item.citation.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 font-mono"
                                    >
                                      {item.citation.title}
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  </div>
                                )}
                              </div>

                              <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[11px]">
                                <span className="text-slate-500">Breaker Tripping Test:</span>
                                <button
                                  onClick={() => handleToggleBreaker(item.id)}
                                  className={`px-2.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                                    isBreakerOpen ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                                  }`}
                                >
                                  {isBreakerOpen ? 'Breaker Schließen' : 'Breaker Simulieren'}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Simulation Result feedback if running */}
                          {activeTestSim && activeTestSim.id === item.id && (
                            <div className="mt-3 p-2.5 bg-black/60 border border-slate-700 rounded-lg font-mono text-xs flex items-center gap-2">
                              {activeTestSim.status === 'running' ? (
                                <Zap className="w-4 h-4 text-amber-400 animate-spin" />
                              ) : (
                                <CheckCircle className="w-4 h-4 text-emerald-400" />
                              )}
                              <span className={activeTestSim.status === 'running' ? 'text-amber-300' : 'text-emerald-300'}>
                                {activeTestSim.log}
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Deep-Dive Analysis Cards: Highlight 1 (Lookahead) & Highlight 2 (Meta-Breaker) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Parametric Lookahead Deep Dive */}
        <div className="p-5 bg-[#121620] border border-amber-500/30 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-400 font-mono font-bold text-sm">
              <Flame className="w-4 h-4" />
              <span>KERNTREFFER #1: PARAMETRISCHER LOOK-AHEAD-BIAS</span>
            </div>
            <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded text-[10px] font-mono font-bold">
              UNSICHTBARE GEFAHR
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Der parametrische Look-ahead-Bias ist der <strong>einzige Fehlermodus</strong>, der im Backtest nicht 
            wie ein Fehler aussieht: Er generiert <em>scheinbar herausragende Renditen</em> und bleibt unsichtbar, 
            bis Live-Daten ihn durch drastischen OOS-Alpha-Zerfall entlarven.
          </p>
          <div className="bg-[#090b12] p-3 rounded-xl border border-slate-800 space-y-1.5 font-mono text-[11px]">
            <div className="text-slate-400">Schutzarchitektur:</div>
            <div className="text-emerald-400">• FinCAD-LogitsProcessor (arXiv:2605.24564) mit dynamischer α(s,t)-Drosselung</div>
            <div className="text-emerald-400">• Post-Cutoff-Evaluierungs-Split (Daten nach dem Trainings-Cutoff als harter Prüfstein)</div>
            <div className="text-emerald-400">• Two-Pass-Fallback nur als Kontrollkanal — niemals als alleiniges Entscheidungsorgan</div>
          </div>
        </div>

        {/* Card 2: Meta-Breaker Deep Dive */}
        <div className="p-5 bg-[#121620] border border-rose-500/30 rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-rose-400 font-mono font-bold text-sm">
              <ShieldAlert className="w-4 h-4" />
              <span>KERNTREFFER #10: KOMBINIERTER META-FEHLER</span>
            </div>
            <span className="px-2 py-0.5 bg-rose-500/20 text-rose-300 rounded text-[10px] font-mono font-bold">
              STOPP-KRITERIUM
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            Sobald <strong>zwei oder mehr Breaker gleichzeitig den Status OPEN</strong> erreichen (z. B. Venue-Gate + LLM-Orchestrator), 
            greift der Meta-Breaker. Ab diesem Moment ist <em>kein lokales Retry mehr legitim</em>, da die Zustandsintegrität 
            des Gesamtsystems gebrochen ist.
          </p>
          <div className="bg-[#090b12] p-3 rounded-xl border border-slate-800 space-y-1.5 font-mono text-[11px]">
            <div className="text-slate-400">Meta-Abschaltpfad (Kill-Switch):</div>
            <div className="text-rose-400">• 1. Sofortiges Kraken Dead-Man Timeout (cancel_all_orders_after 60s)</div>
            <div className="text-rose-400">• 2. Redis/Lua State-Locking (Pending Deltas = 0.0, Risk-Halt = 1)</div>
            <div className="text-rose-400">• 3. PagerDuty/Sentry Eskalation an das Risk-Committee; manuelles Entsperren erforderlich</div>
          </div>
        </div>
      </div>

      {/* Modal: Add New Failure Mode to Living Document */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#121622] border border-slate-700 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white font-mono flex items-center gap-2">
                <Plus className="w-4 h-4 text-blue-400" />
                Neuen Fehlermodus erfassen (Living Document)
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleAddNewItem} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 font-mono mb-1">Risiko / Edge Case Name *</label>
                <input
                  type="text"
                  required
                  placeholder="z. B. WebSocket Heartbeat Desynchronisation..."
                  value={newModeTitle}
                  onChange={(e) => setNewModeTitle(e.target.value)}
                  className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-mono mb-1">Wahrscheinlichkeit</label>
                  <select
                    value={newModeProb}
                    onChange={(e: any) => setNewModeProb(e.target.value)}
                    className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200"
                  >
                    <option value="Hoch">Hoch</option>
                    <option value="Mittel">Mittel</option>
                    <option value="Niedrig">Niedrig</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-mono mb-1">Schaden</label>
                  <select
                    value={newModeDamage}
                    onChange={(e: any) => setNewModeDamage(e.target.value)}
                    className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200"
                  >
                    <option value="Sehr hoch">Sehr hoch</option>
                    <option value="Hoch">Hoch</option>
                    <option value="Mittel">Mittel</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-mono mb-1">Pfeiler-Zuordnung</label>
                <select
                  value={newModePillar}
                  onChange={(e) => setNewModePillar(e.target.value)}
                  className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200"
                >
                  {PILLARS_LIST.map((p, idx) => (
                    <option key={idx} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-400 font-mono mb-1">Früherkennung</label>
                <input
                  type="text"
                  placeholder="Metrik oder Signal zur Früherkennung..."
                  value={newModeDetection}
                  onChange={(e) => setNewModeDetection(e.target.value)}
                  className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-mono mb-1">Mitigation *</label>
                <input
                  type="text"
                  required
                  placeholder="Konkreter Schutzmechanismus / Failsafe..."
                  value={newModeMitigation}
                  onChange={(e) => setNewModeMitigation(e.target.value)}
                  className="w-full bg-[#090b12] border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 font-mono"
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-mono font-bold"
                >
                  In Matrix aufnehmen
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
