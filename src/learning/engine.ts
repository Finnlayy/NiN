import { randomUUID } from 'crypto';
import { evaluateOutcome, evaluateRisk } from './evaluator';
import { mergeResearchResults, researchFromVectorHits, researchKnowledge } from './research';
import { dueSkills, skillKey, updateSkill, wilsonLowerBound } from './algorithm';
import { KnowledgeVectorIndex, KNOWLEDGE_VECTOR_SIZE } from './qdrantKnowledge';
import { errorFingerprint, hashVector, knowledgeTokens, normalizeTokens, taskSignatureHash } from './tokenizer';
import {
  ErrorPattern,
  Feedback,
  KnowledgeEntry,
  LearningDomain,
  LearningSchedule,
  LearningState,
  LearningTask,
  Outcome,
  ResearchOptions,
  ResearchResult,
  RiskGuard,
  Skill,
} from './schemas';
import { LearningStore, toLearningState } from './store';
import { createOutcome } from './input';

/** Configuration for the continuous-learning engine. */
export interface LearningEngineConfig {
  store: LearningStore;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /** Qdrant index for knowledge entries. Absent or disconnected searches stay local. */
  knowledgeIndex?: KnowledgeVectorIndex;
}

/** Result of processing one feedback event. */
export interface FeedbackResult {
  feedback: Feedback;
  outcome: Outcome | undefined;
  quality: number;
  skill: Skill | undefined;
  newErrorPatternIds: string[];
  researchResult: ResearchResult[];
  knowledgeEntry: KnowledgeEntry | undefined;
  createdTaskIds: string[];
}

/** Result of schedule evaluation. */
export interface ScheduleRunResult {
  createdTaskIds: string[];
  nextRunAt: string | null;
  schedulesRunCount: number;
}

/**
 * Continuous-learning engine.
 *
 * Drives:
 *  - feedback ingestion and outcome evaluation
 *  - skill profiling (Wilson confidence bounds)
 *  - spaced-repetition learning schedules
 *  - error-pattern memory and anti-pattern promotion
 *  - Knowledge Base research and revision
 */
export class ContinuousLearningEngine {
  readonly store: LearningStore;
  private readonly knowledgeIndex: KnowledgeVectorIndex | undefined;

  constructor(config: LearningEngineConfig) {
    this.store = config.store;
    this.knowledgeIndex = config.knowledgeIndex;
    this.now = config.now ?? (() => new Date());
  }

  /** Clock used by scheduling and timestamping. */
  private readonly now: () => Date;

  /** Push a completed outcome into the learning memory. */
  ingestOutcome(outcome: Outcome): Outcome {
    this.store.upsertOutcome(outcome);
    return outcome;
  }

  /**
   * Ingest one feedback signal, evaluate the parent outcome, update the
   * relevant skill, record repeated error patterns, research the Knowledge
   * Base, optionally insert an improved solution, and create follow-up
   * learning work.
   */
  ingestFeedback(feedback: Feedback): FeedbackResult {
    this.store.upsertFeedback(feedback);

    const outcome = this.store.getOutcome(feedback.outcomeId);
    const feedbacks = this.store.feedbackForOutcome(feedback.outcomeId);
    const quality = outcome
      ? evaluateOutcome(outcome, feedbacks)
      : normalizeScore(feedback.score);

    const skill = this.updateSkillFromOutcome(outcome, quality);
    const newErrorPatternIds = this.recordErrors(outcome, feedback, quality);
    const researchResult = this.researchForOutcome(outcome, quality, feedback);
    const knowledgeEntry = this.insertKnowledgeFromFeedback(outcome, feedback, quality, researchResult);
    const createdTaskIds = this.scheduleTasks({
      outcome,
      quality,
      feedback,
      researchResult,
      knowledgeEntry,
      skill,
    });

    return {
      feedback,
      outcome,
      quality,
      skill,
      newErrorPatternIds,
      researchResult,
      knowledgeEntry,
      createdTaskIds,
    };
  }

  /**
   * Pre-flight guard that prevents the orchestrator from blindly repeating a
   * recorded failure. Call before executing a new task.
   */
  guardTask(params: {
    taskDescription: string;
    domain: LearningDomain;
    algorithmTag?: string | null;
  }): RiskGuard {
    const tokens = normalizeTokens(params.taskDescription);
    return evaluateRisk(tokens, params.domain, params.algorithmTag ?? null, this.store, this.now());
  }

  /** Research the best available Knowledge Base candidates for a task. */
  research(
    params: {
      taskDescription: string;
      domain?: LearningDomain;
      algorithmTag?: string | null;
      tokens?: string[];
    },
    options: ResearchOptions = {},
  ): ResearchResult[] {
    const tokens = params.tokens ?? normalizeTokens(params.taskDescription);
    return researchKnowledge(this.store, tokens, {
      domain: params.domain as ResearchOptions['domain'],
      algorithmTag: params.algorithmTag ?? undefined,
      ...options,
    });
  }

  /**
   * Same ranking as `research`, plus a live nearest-neighbour query against
   * Qdrant when the knowledge index is connected.
   */
  async researchIndexed(
    params: {
      taskDescription: string;
      domain?: LearningDomain;
      algorithmTag?: string | null;
      tokens?: string[];
    },
    options: ResearchOptions = {},
  ): Promise<ResearchResult[]> {
    const limit = options.limit ?? 5;
    const local = this.research(params, options);
    const index = this.knowledgeIndex;
    if (!index || index.status().mode !== 'qdrant') return local;

    const tokens = params.tokens ?? normalizeTokens(params.taskDescription);
    const domain = params.domain as ResearchOptions['domain'];
    const algorithmTag = params.algorithmTag ?? undefined;
    const searchTokens = [
      ...tokens,
      ...(domain ? [`@@domain:${domain}`] : []),
      ...(algorithmTag ? [`@@alg:${algorithmTag}`] : []),
    ];

    try {
      const hits = await index.search({
        vector: hashVector(searchTokens, KNOWLEDGE_VECTOR_SIZE),
        limit: Math.max(limit * 4, 20),
        domain,
        algorithmTag,
        includeCorrections: options.includeCorrections !== false,
      });
      const remote = researchFromVectorHits(hits, tokens, {
        ...options,
        domain,
        algorithmTag,
        limit,
      });
      return mergeResearchResults([local, remote], limit);
    } catch (error) {
      console.error('Qdrant knowledge search failed, using the local snapshot:', error);
      return local;
    }
  }

  /**
   * Evaluate the enabled schedules and create the learning tasks that are
   * due at `now`.
   */
  runSchedules(): ScheduleRunResult {
    const now = this.now();
    const schedules = this.store.listSchedules();
    const createdTaskIds: string[] = [];
    let schedulesRunCount = 0;
    let nextRunAt: string | null = null;

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const runAt = new Date(schedule.nextRunAt).getTime();
      if (runAt > now.getTime()) {
        if (nextRunAt === null || runAt < new Date(nextRunAt).getTime()) nextRunAt = schedule.nextRunAt;
        continue;
      }

      const generated = this.generateScheduleTasks(schedule, now);
      for (const task of generated) {
        this.store.upsertTask(task);
        createdTaskIds.push(task.id);
      }

      schedule.lastRunAt = now.toISOString();
      schedule.nextRunAt = new Date(now.getTime() + schedule.cadenceMs).toISOString();
      schedule.updatedAt = now.toISOString();
      this.store.upsertSchedule(schedule);
      schedulesRunCount += 1;

      const candidate = new Date(schedule.nextRunAt).getTime();
      if (nextRunAt === null || candidate < new Date(nextRunAt).getTime()) nextRunAt = schedule.nextRunAt;
    }

    return {
      createdTaskIds,
      nextRunAt,
      schedulesRunCount,
    };
  }

  /** Current profile / observability snapshot. */
  state(): LearningState {
    return toLearningState(this.store, this.now());
  }

  /** Create the default schedules that enable autonomous growth. */
  installDefaultSchedules(): LearningSchedule[] {
    const existing = this.store.listSchedules();
    const defaultSchedules = defaultScheduleDefinitions(this.now());
    const installed: LearningSchedule[] = [];

    for (const schedule of defaultSchedules) {
      const current = existing.find((item) => item.id === schedule.id);
      if (current) {
        installed.push(current);
      } else {
        this.store.upsertSchedule(schedule);
        installed.push(schedule);
      }
    }

    return installed;
  }

  private updateSkillFromOutcome(
    outcome: Outcome | undefined,
    quality: number,
  ): Skill | undefined {
    if (!outcome) return undefined;

    const domain = outcome.signature.domain;
    const algorithmTag = outcome.signature.algorithmTag;
    const key = skillKey(domain, algorithmTag);
    const existing = this.store.findBySkillKey(key);
    const updated = updateSkill(existing, {
      domain: domain as LearningDomain,
      algorithmTag,
      quality,
      errorFingerprint: outcome.errorClass
        ? errorFingerprint(outcome.signature.tokens, outcome.errorClass)
        : undefined,
      antiPattern: outcome.errorClass
        ? `previous ${outcome.errorClass} for ${domain}${algorithmTag ? ' / ' + algorithmTag : ''}: ${outcome.errorMessage ?? 'recorded error'}`
        : undefined,
    }, this.now());

    this.store.upsertSkill(updated);
    return updated;
  }

  private recordErrors(
    outcome: Outcome | undefined,
    feedback: Feedback,
    quality: number,
  ): string[] {
    const errorClass = feedback.errorClass ?? outcome?.errorClass;
    if (!outcome || !errorClass) return [];

    const erroneous = feedback.verdict === 'incorrect' || quality < 0.4 || outcome.success === 'failure';
    if (!erroneous) return [];

    const fingerprint = errorFingerprint(outcome.signature.tokens, errorClass);
    const now = this.now();
    const existing = this.store.findByFingerprint(fingerprint);

    const pattern: ErrorPattern = existing
      ? {
          ...existing,
          occurrences: existing.occurrences + 1,
          message: feedback.commentary || existing.message,
          lastSeenAt: now.toISOString(),
          lastCorrectnessScore: quality,
        }
      : {
          id: randomUUID(),
          fingerprint,
          domain: outcome.signature.domain as LearningDomain,
          algorithmTag: outcome.signature.algorithmTag ?? undefined,
          tokens: outcome.signature.tokens,
          errorClass,
          message: feedback.commentary,
          occurrences: 1,
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          lastCorrectnessScore: quality,
        };

    this.store.upsertErrorPattern(pattern);
    return [pattern.id];
  }

  private researchForOutcome(
    outcome: Outcome | undefined,
    quality: number,
    feedback: Feedback,
  ): ResearchResult[] {
    if (!outcome) return [];
    const shouldResearch = quality < 0.66 || feedback.commentary.length > 0 || feedback.correction !== undefined;
    if (!shouldResearch) return [];

    return researchKnowledge(this.store, outcome.signature.tokens, {
      domain: outcome.signature.domain as ResearchOptions['domain'],
      algorithmTag: outcome.signature.algorithmTag ?? undefined,
      limit: 5,
    });
  }

  private insertKnowledgeFromFeedback(
    outcome: Outcome | undefined,
    feedback: Feedback,
    quality: number,
    researchResult: ResearchResult[],
  ): KnowledgeEntry | undefined {
    if (!outcome) return undefined;

    // Only store a corrected or high-quality discovered solution. Feedback with
    // no correction is not by itself a new piece of actionable knowledge.
    if (feedback.correction === undefined) return undefined;
    if (quality >= 0.9 && researchResult.length === 0) return undefined;

    const now = this.now();
    const tokens = knowledgeTokens({
      title: `Corrected ${outcome.signature.domain} solution`,
      body: feedback.correction,
      domain: outcome.signature.domain as LearningDomain,
      algorithmTag: outcome.signature.algorithmTag ?? undefined,
      contentType: 'correction',
      tags: feedback.tags,
    });

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      namespace: 'feedback',
      title: `Corrected ${outcome.signature.domain}${outcome.signature.algorithmTag ? ' / ' + outcome.signature.algorithmTag : ''} outcome`,
      contentType: 'correction',
      domain: outcome.signature.domain as LearningDomain,
      algorithmTag: outcome.signature.algorithmTag ?? undefined,
      body: feedback.correction,
      tags: feedback.tags,
      tokenIds: tokens,
      source: { kind: 'internal', ref: feedback.outcomeId },
      evidence: [{ key: 'outcomeId', value: feedback.outcomeId }],
      qualityScore: Math.max(0.3, Math.min(1, quality + 0.2)),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.store.upsertKnowledge(entry);

    const skillId = skillKey(outcome.signature.domain, outcome.signature.algorithmTag);
    const skill = this.store.findBySkillKey(skillId);
    if (skill) {
      const enriched: Skill = {
        ...skill,
        knowledgeIds: [...new Set([...skill.knowledgeIds, entry.id])].slice(0, 128),
        updatedAt: now.toISOString(),
      };
      this.store.upsertSkill(enriched);
    }

    return entry;
  }

  private scheduleTasks(params: {
    outcome: Outcome | undefined;
    quality: number;
    feedback: Feedback;
    researchResult: ResearchResult[];
    knowledgeEntry: KnowledgeEntry | undefined;
    skill: Skill | undefined;
  }): string[] {
    const created: string[] = [];
    if (!params.outcome) return created;

    const { outcome, quality, feedback, researchResult, knowledgeEntry, skill } = params;
    const signatureHash = outcome.signature.taskDescriptionHash;

    if (quality < 0.4 || feedback.verdict === 'incorrect') {
      created.push(
        ...this.insertTaskIfAbsent({
          type: 'remediation',
          title: `Remediate ${outcome.signature.domain}`,
          subject: `${outcome.signature.domain}:${outcome.signature.algorithmTag ?? 'general'}`,
          relatedTaskSignature: outcome.signature,
          targetSkillId: skill?.id,
          priority: 0.9,
          effortHours: 1,
          dueInMs: 24 * 60 * 60 * 1000,
          requirements: ['Re-derive from first principles.', 'Run the corrected solution against the failing case.', 'Record a correction in the Knowledge Base.'],
          signatureHash,
          now: this.now(),
        }),
      );
      created.push(
        ...this.insertTaskIfAbsent({
          type: 'research',
          title: `Research better solution for ${outcome.signature.domain}`,
          subject: `${outcome.signature.domain}:${outcome.signature.algorithmTag ?? 'general'}`,
          relatedTaskSignature: outcome.signature,
          targetSkillId: skill?.id,
          priority: 0.7,
          effortHours: 2,
          dueInMs: 2 * 24 * 60 * 60 * 1000,
          requirements: ['Compare prior Knowledge Base solutions.', 'Validate candidates on the failure trace.', 'Promote the winner into the Knowledge Base.'],
          signatureHash,
          now: this.now(),
        }),
      );
    } else if (quality < 0.75) {
      created.push(
        ...this.insertTaskIfAbsent({
          type: 'practice',
          title: `Practice ${outcome.signature.domain} until stable`,
          subject: `${outcome.signature.domain}:${outcome.signature.algorithmTag ?? 'general'}`,
          relatedTaskSignature: outcome.signature,
          targetSkillId: skill?.id,
          priority: 0.5,
          effortHours: 1,
          dueInMs: 3 * 24 * 60 * 60 * 1000,
          requirements: ['Schedule a spaced review.', 'Re-invoke the task with a held-out variant.', 'Confirm proficiency improves.'],
          signatureHash,
          now: this.now(),
        }),
      );
    }

    if (knowledgeEntry) {
      created.push(
        ...this.insertTaskIfAbsent({
          type: 'kb_upgrade',
          title: 'Promote Knowledge Base correction into skill profile',
          subject: `${outcome.signature.domain}:${outcome.signature.algorithmTag ?? 'general'}`,
          relatedTaskSignature: outcome.signature,
          targetSkillId: skill?.id,
          priority: 0.65,
          effortHours: 0.5,
          dueInMs: 12 * 60 * 60 * 1000,
          requirements: ['Validated correction inserted.', 'Attach to domain skill profile.', 'Suppress the recorded anti-pattern during next execution.'],
          signatureHash,
          now: this.now(),
        }),
      );
    }

    if (feedback.verdict === 'correct' && !knowledgeEntry && researchResult.length > 0) {
      created.push(
        ...this.insertTaskIfAbsent({
          type: 'research',
          title: 'Synthesize best confirmed solution',
          subject: `${outcome.signature.domain}:${outcome.signature.algorithmTag ?? 'general'}`,
          relatedTaskSignature: outcome.signature,
          targetSkillId: skill?.id,
          priority: 0.4,
          effortHours: 1,
          dueInMs: 5 * 24 * 60 * 60 * 1000,
          requirements: ['Confirm the retrieved solution is superior.', 'Store the new solution if validated.'],
          signatureHash,
          now: this.now(),
        }),
      );
    }

    return created;
  }

  private insertTaskIfAbsent(params: {
    type: LearningTask['type'];
    title: string;
    subject: string;
    relatedTaskSignature?: LearningTask['relatedTaskSignature'];
    targetSkillId?: string;
    priority: number;
    effortHours: number;
    dueInMs: number;
    requirements: string[];
    signatureHash: string;
    now: Date;
  }): string[] {
    const existing = this.store
      .listTasks()
      .find(
        (task) =>
          task.status !== 'done' &&
          task.type === params.type &&
          task.subject === params.subject &&
          task.relatedTaskSignature?.taskDescriptionHash === params.signatureHash,
      );

    if (existing) return [];

    const task: LearningTask = {
      id: randomUUID(),
      type: params.type,
      title: params.title,
      description: params.title,
      subject: params.subject,
      relatedTaskSignature: params.relatedTaskSignature,
      targetSkillId: params.targetSkillId,
      priority: round2(params.priority),
      effortHours: params.effortHours,
      status: 'pending',
      schedule: {
        dueAt: new Date(params.now.getTime() + params.dueInMs).toISOString(),
        createdAt: params.now.toISOString(),
        intervalMs: params.dueInMs,
        windowMs: 24 * 60 * 60 * 1000,
      },
      requirements: params.requirements,
      progress: 0,
      createdAt: params.now.toISOString(),
      updatedAt: params.now.toISOString(),
    };
    this.store.upsertTask(task);
    return [task.id];
  }

  private generateScheduleTasks(schedule: LearningSchedule, now: Date): LearningTask[] {
    const tasks: LearningTask[] = [];
    const openExisting = new Set(
      this.store
        .listTasks()
        .filter((task) => task.status === 'pending' || task.status === 'scheduled' || task.status === 'in_progress')
        .map((task) => `${task.type}:${task.subject}`),
    );

    for (const step of schedule.steps) {
      if (!step.enabled) continue;

      const subjects = this.subjectsForScheduleStep(schedule, step, now);
      for (const subject of subjects) {
        const key = `${step.taskType}:${subject}`;
        if (openExisting.has(key)) continue;

        const task: LearningTask = {
          id: randomUUID(),
          type: step.taskType,
          title: taskTitle(step.taskType, subject),
          description: taskTitle(step.taskType, subject),
          subject,
          priority: round2(step.minPriority ?? scheduledPriority(step.taskType)),
          effortHours: scheduledEffort(step.taskType),
          status: 'scheduled',
          requirements: defaultRequirements(step.taskType),
          progress: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        tasks.push(task);
      }
    }

    return tasks;
  }

  private subjectsForScheduleStep(_schedule: LearningSchedule, step: LearningSchedule['steps'][number], now: Date): string[] {
    const skills = [...this.store.listSkills()];

    switch (step.trigger) {
      case 'on_error': {
        return skills
          .filter((skill) => skill.errors > 0)
          .sort((a, b) => b.errors / Math.max(1, b.trials) - a.errors / Math.max(1, a.trials))
          .map((skill) => skillKey(skill.domain, skill.algorithmTag));
      }
      case 'on_outcome':
      case 'time_based':
      case 'on_kb_change': {
        return dueSkills(skills, now)
          .slice(0, step.subjects?.length ? 10 : 5)
          .map((skill) => skillKey(skill.domain, skill.algorithmTag));
      }
      case 'on_feedback': {
        const latest = [...this.store.listFeedback()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
        return latest
          .map((feedback) => {
            const outcome = this.store.getOutcome(feedback.outcomeId);
            return outcome ? skillKey(outcome.signature.domain, outcome.signature.algorithmTag) : undefined;
          })
          .filter((subject): subject is string => subject !== undefined);
      }
      case 'manual':
      default:
        return step.subjects ?? [];
    }
  }
}

export function defaultScheduleDefinitions(now: Date, idPrefix: string = ''): LearningSchedule[] {
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  return [
    {
      id: idPrefix + 'schedule-continuous-evaluation',
      name: 'Continuous Outcome Evaluation',
      enabled: true,
      owner: 'learning-engine',
      cadence: 'daily',
      cadenceMs: dayMs,
      nextRunAt: new Date(nowMs + dayMs).toISOString(),
      steps: [
        {
          id: idPrefix + 'step-remediate-errors',
          trigger: 'on_error',
          taskType: 'remediation',
          minPriority: 0.6,
          enabled: true,
        },
        {
          id: idPrefix + 'step-practice-due-skills',
          trigger: 'time_based',
          taskType: 'practice',
          minPriority: 0.3,
          enabled: true,
        },
        {
          id: idPrefix + 'step-research-weak-skills',
          trigger: 'on_outcome',
          taskType: 'research',
          minPriority: 0.4,
          enabled: true,
        },
      ],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: idPrefix + 'schedule-feedback-remediation',
      name: 'Feedback Remediation',
      enabled: true,
      owner: 'learning-engine',
      cadence: 'hourly',
      cadenceMs: 60 * 60 * 1000,
      nextRunAt: new Date(nowMs + 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: idPrefix + 'step-remediate-recent-feedback',
          trigger: 'on_feedback',
          taskType: 'remediation',
          minPriority: 0.5,
          enabled: true,
        },
      ],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: idPrefix + 'schedule-kb-research',
      name: 'Knowledge Base Research',
      enabled: true,
      owner: 'learning-engine',
      cadence: 'weekly',
      cadenceMs: 7 * dayMs,
      nextRunAt: new Date(nowMs + 7 * dayMs).toISOString(),
      steps: [
        {
          id: idPrefix + 'step-upgrade-kb',
          trigger: 'on_kb_change',
          taskType: 'kb_upgrade',
          minPriority: 0.3,
          enabled: true,
        },
        {
          id: idPrefix + 'step-research-better-solutions',
          trigger: 'on_outcome',
          taskType: 'research',
          minPriority: 0.3,
          enabled: true,
        },
      ],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: idPrefix + 'schedule-quality-calibration',
      name: 'Quality Calibration',
      enabled: true,
      owner: 'learning-engine',
      cadence: 'weekly',
      cadenceMs: 7 * dayMs,
      nextRunAt: new Date(nowMs + 7 * dayMs).toISOString(),
      steps: [
        {
          id: idPrefix + 'step-evaluate-outcomes',
          trigger: 'on_outcome',
          taskType: 'evaluation',
          minPriority: 0.2,
          enabled: true,
        },
        {
          id: idPrefix + 'step-calibrate-priors',
          trigger: 'time_based',
          taskType: 'calibration',
          minPriority: 0.2,
          enabled: true,
        },
      ],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ];
}

export { wilsonLowerBound };
export { taskSignatureHash };
export { createOutcome };

function normalizeScore(score: number | undefined): number {
  if (score === undefined) return 0.5;
  return Math.min(1, Math.max(0, score));
}

function taskTitle(type: LearningTask['type'], subject: string): string {
  const prefix: Record<LearningTask['type'], string> = {
    remediation: 'Scheduled remediation',
    practice: 'Scheduled practice',
    research: 'Scheduled research',
    kb_upgrade: 'Scheduled knowledge base upgrade',
    evaluation: 'Scheduled evaluation',
    calibration: 'Scheduled calibration',
    schema_revision: 'Scheduled schema revision',
  };
  return `${prefix[type]} for ${subject}`;
}

function scheduledPriority(type: LearningTask['type']): number {
  switch (type) {
    case 'remediation':
      return 0.7;
    case 'research':
      return 0.5;
    case 'kb_upgrade':
      return 0.45;
    case 'practice':
      return 0.35;
    default:
      return 0.4;
  }
}

function scheduledEffort(type: LearningTask['type']): number {
  switch (type) {
    case 'remediation':
    case 'research':
      return 2;
    case 'evaluation':
    case 'calibration':
      return 1;
    default:
      return 1;
  }
}

function defaultRequirements(type: LearningTask['type']): string[] {
  switch (type) {
    case 'remediation':
      return ['Review recorded errors.', 'Apply corrected approach.', 'Validate the result.'];
    case 'research':
      return ['Search the Knowledge Base.', 'Compare candidate solutions.', 'Promote the best validated solution.'];
    case 'kb_upgrade':
      return ['Ingest validated corrections.', 'Update skill profile.'];
    case 'practice':
      return ['Run a spaced review.', 'Record the new outcome.'];
    case 'evaluation':
      return ['Evaluate recent outcomes.', 'Report quality and skill deltas.'];
    case 'calibration':
      return ['Re-calibrate expected accuracy.', 'Compare expected vs observed performance.'];
    case 'schema_revision':
      return ['Inspect changed schemas.', 'Revise prompts and knowledge entries.'];
    default:
      return [];
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
