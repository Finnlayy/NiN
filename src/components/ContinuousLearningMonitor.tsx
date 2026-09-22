import React, { useState, useEffect, useCallback } from 'react';
import {
  Brain,
  Sparkles,
  ShieldAlert,
  BookOpen,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCcw,
  Search,
  PlusCircle,
  ThumbsUp,
  ThumbsDown,
  Layers
} from 'lucide-react';

interface LearningStatePayload {
  generatedAt: string;
  skills: Array<{
    id: string;
    domain: string;
    algorithmTag?: string;
    trials: number;
    successes: number;
    errors: number;
    averageQuality?: number;
    lastTrainedAt?: string;
  }>;
  knowledgeEntries: Array<{
    id: string;
    title: string;
    summary: string;
    domain: string;
    qualityScore?: number;
    tags: string[];
    contentType: string;
  }>;
  feedback: Array<{
    id: string;
    score: number;
    verdict: string;
    comments?: string;
    createdAt: string;
  }>;
  outcomes: Array<{
    id: string;
    taskLabel: string;
    domain: string;
    success: 'success' | 'failure' | 'partial';
    latencyMs?: number;
    observedAccuracy?: number;
    errorClass?: string;
    createdAt: string;
  }>;
  errorPatterns: Array<{
    id: string;
    domain: string;
    pattern: string;
    occurrences: number;
    severity: string;
  }>;
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    intervalMs: number;
    lastRun?: string;
  }>;
}

interface ContinuousLearningMonitorProps {
  onLogEvent?: (message: string, level: 'info' | 'warn' | 'error' | 'success', node?: string) => void;
}

export const ContinuousLearningMonitor: React.FC<ContinuousLearningMonitorProps> = ({ onLogEvent }) => {
  const [state, setState] = useState<LearningStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [feedbackScore, setFeedbackScore] = useState(90);
  const [feedbackComment, setFeedbackComment] = useState('Execution verified against rigid M8 criteria.');
  const [feedbackVerdict, setFeedbackVerdict] = useState<'approved' | 'modified' | 'rejected'>('approved');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [isRunningSchedules, setIsRunningSchedules] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/learning/state');
      if (res.ok) {
        const data = await res.json();
        setState(data);
      }
    } catch (err) {
      console.error('Error fetching learning state:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 15000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const handleRunSchedules = async () => {
    try {
      setIsRunningSchedules(true);
      onLogEvent?.('Triggering continuous-learning evaluation cycle...', 'info', 'LearningEngine');
      const res = await fetch('/api/learning/schedules/run', { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        onLogEvent?.(`Evaluation cycle complete. Evaluated ${result.evaluatedTasks ?? 0} tasks.`, 'success', 'LearningEngine');
        await fetchState();
      }
    } catch (err) {
      onLogEvent?.(`Failed running schedules: ${err}`, 'error', 'LearningEngine');
    } finally {
      setIsRunningSchedules(false);
    }
  };

  const handleResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      setIsSearching(true);
      onLogEvent?.(`Querying Continuous-Learning Knowledge Base for '${searchQuery}'...`, 'info', 'ResearchBrief');
      const res = await fetch('/api/learning/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskDescription: searchQuery, limit: 4 }),
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.findings ?? []);
        onLogEvent?.(`Research returned ${data.findings?.length ?? 0} matching entries.`, 'success', 'ResearchBrief');
      }
    } catch (err) {
      onLogEvent?.(`Research query error: ${err}`, 'error', 'ResearchBrief');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmittingFeedback(true);
      onLogEvent?.('Submitting RLHF Human-in-the-loop verdict...', 'info', 'RLHF Pipeline');
      const res = await fetch('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          score: feedbackScore / 100,
          verdict: feedbackVerdict === 'approved' ? 'correct' : feedbackVerdict === 'modified' ? 'partial' : 'incorrect',
          comments: feedbackComment,
          humanFeedbackCategory: feedbackVerdict,
          outcome: {
            taskLabel: 'The Judge M8 Invariant Verification',
            taskDescription: 'Deterministic check of 6 core axioms and via negativa bound safety',
            domain: 'ml_30core',
            success: feedbackVerdict === 'rejected' ? 'failure' : 'success',
            correctnessScore: feedbackScore,
            appliedPolicies: ['the_judge_m8:rigid', 'zero_dummy_guarantee:enforced'],
          },
        }),
      });
      if (res.ok) {
        onLogEvent?.(`Feedback ingested. Pipeline Quality adjusted.`, 'success', 'RLHF Pipeline');
        await fetchState();
      }
    } catch (err) {
      onLogEvent?.(`Feedback ingestion failed: ${err}`, 'error', 'RLHF Pipeline');
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="p-5 bg-gradient-to-r from-[#0d1326] via-[#101935] to-[#0c1224] border border-blue-500/30 rounded-2xl shadow-xl flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-xl text-blue-400">
            <Brain className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-white tracking-wide font-mono">
                CONTINUOUS-LEARNING SUBSYSTEM (RLHF & KNOWLEDGE ENGINE)
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded">
                PIPELINE THRESHOLD 85
              </span>
            </div>
            <p className="text-xs font-mono text-slate-400 mt-1">
              Autonomous error-pattern detection, multi-dimensional evaluation pipelines, and self-reinforcing skill calibration.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchState}
            disabled={loading}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-mono font-bold flex items-center gap-1.5 transition-all"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Sync
          </button>
          <button
            onClick={handleRunSchedules}
            disabled={isRunningSchedules}
            className="px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white rounded-xl text-xs font-mono font-bold flex items-center gap-2 shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {isRunningSchedules ? 'Evaluating...' : 'Run Scheduled Evals'}
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono">
        <div className="p-4 bg-[#111626] border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Evaluated Outcomes</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-2">
            {state?.outcomes.length ?? 0}
          </div>
          <div className="text-[11px] text-emerald-400 mt-1">
            Pass Rate:{' '}
            {state?.outcomes.length
              ? Math.round(
                  (state.outcomes.filter((o) => o.success === 'success').length /
                    state.outcomes.length) *
                    100,
                )
              : 100}
            %
          </div>
        </div>

        <div className="p-4 bg-[#111626] border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Calibrated Skills</span>
            <Sparkles className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-2">
            {state?.skills.length ?? 0}
          </div>
          <div className="text-[11px] text-cyan-400 mt-1">
            Domains: ml_30core, dev_dp
          </div>
        </div>

        <div className="p-4 bg-[#111626] border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Guarded Anti-Patterns</span>
            <ShieldAlert className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-2">
            {state?.errorPatterns.length ?? 0}
          </div>
          <div className="text-[11px] text-amber-400 mt-1">
            Auto-mitigation active
          </div>
        </div>

        <div className="p-4 bg-[#111626] border border-slate-800 rounded-xl">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>RLHF Feedback Samples</span>
            <ThumbsUp className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-2">
            {state?.feedback.length ?? 0}
          </div>
          <div className="text-[11px] text-blue-400 mt-1">
            Multi-metric pipeline
          </div>
        </div>
      </div>

      {/* Main Grid: Research Query & RLHF Feedback Ingestion */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Knowledge Base Live Research Query */}
        <div className="p-5 bg-[#101524] border border-slate-800/80 rounded-2xl">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="w-5 h-5 text-cyan-400" />
            <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wider">
              Knowledge Base Semantic Research
            </h3>
          </div>

          <form onSubmit={handleResearch} className="space-y-3 font-mono text-xs">
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g. XGBoost regularization, TheJudge via negativa, AC resonance..."
                className="flex-1 px-3 py-2 bg-[#090d1a] border border-slate-700 rounded-xl text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
              <button
                type="submit"
                disabled={isSearching}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl font-bold flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                <Search className="w-3.5 h-3.5" />
                Query
              </button>
            </div>
          </form>

          <div className="mt-4 space-y-2">
            {searchResults.length === 0 ? (
              <div className="p-4 border border-dashed border-slate-800 rounded-xl text-center text-xs text-slate-500 font-mono">
                No research query executed yet. Enter a task description to inspect dynamic knowledge grounding.
              </div>
            ) : (
              searchResults.map((result, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-[#0a0e1c] border border-cyan-500/20 rounded-xl text-xs font-mono"
                >
                  <div className="flex items-center justify-between text-cyan-300 font-bold">
                    <span>{result.title ?? 'Knowledge Entry'}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-cyan-500/10 rounded">
                      Rel: {Math.round((result.relevanceScore ?? 0) * 100)}%
                    </span>
                  </div>
                  <p className="text-slate-400 mt-1">{result.summary ?? result.content}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Human-in-the-Loop RLHF Feedback Box */}
        <div className="p-5 bg-[#101524] border border-slate-800/80 rounded-2xl">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-5 h-5 text-blue-400" />
            <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wider">
              RLHF Feedback Ingestion Pipeline
            </h3>
          </div>

          <form onSubmit={handleSubmitFeedback} className="space-y-4 font-mono text-xs">
            <div>
              <label className="block text-slate-400 mb-1">Verdict Quality Assessment</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setFeedbackVerdict('approved')}
                  className={`py-2 px-3 rounded-xl border flex items-center justify-center gap-2 font-bold transition-all ${
                    feedbackVerdict === 'approved'
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                  Approved
                </button>
                <button
                  type="button"
                  onClick={() => setFeedbackVerdict('modified')}
                  className={`py-2 px-3 rounded-xl border flex items-center justify-center gap-2 font-bold transition-all ${
                    feedbackVerdict === 'modified'
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Modified
                </button>
                <button
                  type="button"
                  onClick={() => setFeedbackVerdict('rejected')}
                  className={`py-2 px-3 rounded-xl border flex items-center justify-center gap-2 font-bold transition-all ${
                    feedbackVerdict === 'rejected'
                      ? 'bg-rose-500/20 border-rose-500 text-rose-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                  Rejected
                </button>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-slate-400 mb-1">
                <span>Correctness Score</span>
                <span className="text-white font-bold">{feedbackScore}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={feedbackScore}
                onChange={(e) => setFeedbackScore(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Evaluator Comments</label>
              <textarea
                value={feedbackComment}
                onChange={(e) => setFeedbackComment(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 bg-[#090d1a] border border-slate-700 rounded-xl text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmittingFeedback}
              className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
            >
              <PlusCircle className="w-4 h-4" />
              {isSubmittingFeedback ? 'Ingesting Feedback...' : 'Commit Feedback to Store'}
            </button>
          </form>
        </div>
      </div>

      {/* Autonomous Schedules Table */}
      <div className="p-5 bg-[#101524] border border-slate-800/80 rounded-2xl font-mono text-xs">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-purple-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Autonomous Learning Schedules
            </h3>
          </div>
          <span className="text-slate-400">
            {state?.schedules.length ?? 0} active routine(s)
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 pb-2">
                <th className="py-2">Schedule ID</th>
                <th className="py-2">Routine Name</th>
                <th className="py-2">Interval</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Trigger Mode</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850">
              {state?.schedules.map((schedule) => (
                <tr key={schedule.id} className="text-slate-300">
                  <td className="py-2.5 font-bold text-purple-300">{schedule.id}</td>
                  <td className="py-2.5">{schedule.name}</td>
                  <td className="py-2.5 text-slate-400">
                    {Math.round(schedule.intervalMs / 1000)}s
                  </td>
                  <td className="py-2.5">
                    <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded text-[10px]">
                      ENABLED
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-slate-400">on_outcome & tick</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
