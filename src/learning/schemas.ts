/**
 * Data schemes for the continuous-learning subsystem.
 *
 * These interfaces describe the persisted, versioned records that let the
 * Neural Intelligence Network evaluate the data it processes, learn from the
 * outcomes of its work, research better solutions, and avoid repeating errors.
 *
 * The JSON Schema mirrors of these records live in `schemas/learning/`.
 */

import type { ComplexDomain, PolitenessTier, UrgencyTier } from '../types';

/** A domain a skill, knowledge entry, or task can be attached to. */
export type LearningDomain = ComplexDomain | 'misc';

/** How an outcome is classified. */
export type OutcomeSuccess = 'success' | 'partial' | 'failure' | 'unsupported';

/** Where feedback originated. */
export type FeedbackKind =
  | 'ground_truth'
  | 'human_correction'
  | 'automated_check'
  | 'self_assessment'
  | 'benchmark';

/** Verdict recorded during review. */
export type FeedbackVerdict = 'correct' | 'incorrect' | 'partial' | 'inconclusive';

/** Coarse failure taxonomy used for error-prevention. */
export type ErrorClass =
  | 'correctness'
  | 'timeout'
  | 'invalid_output'
  | 'missing_evidence'
  | 'hallucination'
  | 'non_executable'
  | 'assumption_violation'
  | 'integration'
  | 'unknown';

/**
 * Stable, content-derived fingerprint of a task. Two near-identical tasks
 * should produce the same signature so errors and successes can be grouped.
 */
export interface TaskSignature {
  taskDescriptionHash: string;
  tokens: string[];
  domain: ComplexDomain;
  algorithmTag: string | null;
}

/**
 * The result of executing one unit of work. This is the primary signal the
 * learning algorithm consumes.
 */
export interface Outcome {
  id: string;
  taskLabel: string;
  signature: TaskSignature;
  promptVariant: 'baseline' | 'urgency_wrapped';
  politenessTier: PolitenessTier;
  urgencyTier: UrgencyTier;
  success: OutcomeSuccess;
  /** Ground-truth or validated correctness in [0, 1]. */
  correctnessScore?: number;
  /** Model / system reported accuracy in [0, 1]. */
  observedAccuracy?: number;
  /** Prior expectation in [0, 1]. */
  expectedAccuracy?: number;
  latencyMs?: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
  appliedPolicies: string[];
  createdAt: string;
}

/**
 * A reviewed, ingestible piece of information about a past outcome. Feedback
 * can correct an incorrect output, confirm a correct one, or provide a better
 * replacement solution.
 */
export interface Feedback {
  id: string;
  outcomeId: string;
  kind: FeedbackKind;
  verdict: FeedbackVerdict;
  score?: number;
  commentary: string;
  errorClass?: ErrorClass;
  correction?: string;
  tags: string[];
  createdAt: string;
}

/**
 * Versioned knowledge-base item. The learning algorithm ingests notes,
 * corrections, research summaries, algorithms and evaluation reports from
 * this store and uses them to upgrade skills and generate better solutions.
 */
export interface KnowledgeEntry {
  id: string;
  namespace: string;
  title: string;
  contentType: 'note' | 'solution' | 'algorithm' | 'research' | 'correction' | 'evaluation_report';
  domain: LearningDomain;
  algorithmTag?: string;
  body: string;
  tags: string[];
  /** Tokenized content, used by the deterministic retrieval index. */
  tokenIds: string[];
  /** Optional dense embedding, used when the producer can supply one. */
  embedding?: number[];
  source: {
    kind: 'internal' | 'external';
    ref?: string;
  };
  evidence: Array<{ key: string; value: string }>;
  /** Quality score assigned by the engine when the entry is evaluated. */
  qualityScore?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A learned capability. Profiling a skill is what allows the system to detect
 * weaknesses, schedule practice, and grow without repeating errors.
 */
export interface Skill {
  id: string;
  name: string;
  domain: LearningDomain;
  algorithmTag?: string;
  /** Long-run expected quality in [0, 1]. */
  proficiency: number;
  /** Statistical confidence in the proficiency estimate in [0, 1]. */
  confidence: number;
  trials: number;
  successes: number;
  errors: number;
  lastOutcomeAt?: string;
  nextReviewAt?: string;
  /** Spaced-repetition interval in days. */
  intervalDays: number;
  /** SM-2-like ease factor. */
  easeFactor: number;
  /** Failure fingerprints that this skill has produced. */
  errorFingerprints: string[];
  /** Explicit anti-patterns to avoid in future executions. */
  antiPatterns: string[];
  knowledgeIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A recurring failure signature. Keeping these enables the engine to warn the
 * orchestrator before repeating the same error.
 */
export interface ErrorPattern {
  id: string;
  fingerprint: string;
  domain: LearningDomain;
  algorithmTag?: string;
  tokens: string[];
  errorClass: ErrorClass;
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCorrectnessScore?: number;
}

/**
 * A unit of scheduled learning work generated from outcomes, feedback, and
 * knowledge-base changes.
 */
export interface LearningTask {
  id: string;
  type:
    | 'remediation'
    | 'practice'
    | 'research'
    | 'kb_upgrade'
    | 'evaluation'
    | 'calibration'
    | 'schema_revision';
  title: string;
  description: string;
  subject: string;
  relatedTaskSignature?: TaskSignature;
  targetSkillId?: string;
  /** Priority in [0, 1]; higher is more urgent. */
  priority: number;
  effortHours?: number;
  status: 'pending' | 'scheduled' | 'in_progress' | 'done' | 'cancelled';
  schedule?: {
    dueAt: string;
    createdAt: string;
    intervalMs: number;
    windowMs: number;
  };
  requirements: string[];
  progress: number;
  results?: {
    outcomeId?: string;
    knowledgeEntryIds?: string[];
    improvedSkillId?: string;
    note?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * A schedule step describes a class of learning work and the events or
 * cadence that causes it to be generated.
 */
export interface ScheduleStep {
  id: string;
  trigger: 'on_outcome' | 'on_feedback' | 'on_kb_change' | 'on_error' | 'time_based' | 'manual';
  taskType: LearningTask['type'];
  cadenceMs?: number;
  minPriority?: number;
  subjects?: string[];
  enabled: boolean;
}

/**
 * A named schedule that turns raw outcomes and knowledge changes into
 * manageable learning work at a controlled cadence.
 */
export interface LearningSchedule {
  id: string;
  name: string;
  enabled: boolean;
  owner: string;
  cadence: 'on_demand' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string;
  /** Milliseconds between schedule evaluations. */
  cadenceMs: number;
  nextRunAt: string;
  lastRunAt?: string;
  steps: ScheduleStep[];
  createdAt: string;
  updatedAt: string;
}

/** Result returned by knowledge-base research / retrieval. */
export interface ResearchResult {
  entry: KnowledgeEntry;
  relevanceScore: number;
  tokenScore: number;
  embeddingScore: number | null;
  tagScore: number;
  matchedTags: string[];
  reasons: string[];
}

/** Pre-execution guard that prevents a known, repeated error. */
export interface RiskGuard {
  risk: number;
  hasKnownPattern: boolean;
  matchedPatterns: ErrorPattern[];
  matchedAntiPatterns: string[];
  recommendation: string;
}

/** Quality evaluation of a processed data record. */
export interface DataEvaluation {
  dataScore: number;
  completenessScore: number;
  typeScore: number;
  anomalyScore: number;
  missingKeys: string[];
  nullValues: number;
  unsupportedTypes: number;
  observations: string[];
}

/** Complete snapshot of the learning engine for observability. */
export interface LearningState {
  generatedAt: string;
  skills: Skill[];
  knowledgeEntries: KnowledgeEntry[];
  feedback: Feedback[];
  outcomes: Outcome[];
  errorPatterns: ErrorPattern[];
  openTasks: LearningTask[];
  schedules: LearningSchedule[];
  weakestSkillIds: string[];
  strongestSkillIds: string[];
  riskPatternIds: string[];
}

/** Options for a knowledge research call. */
export interface ResearchOptions {
  limit?: number;
  domain?: LearningDomain;
  algorithmTag?: string;
  minRelevance?: number;
  includeCorrections?: boolean;
}
