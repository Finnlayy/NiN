import {
  ErrorPattern,
  Feedback,
  KnowledgeEntry,
  LearningSchedule,
  LearningState,
  LearningTask,
  Outcome,
  Skill,
} from './schemas';

/**
 * Minimal persistence contract for the learning subsystem. Replace the
 * in-memory implementation with a database or durable file adapter in
 * production without changing the algorithm.
 */
export interface LearningStore {
  upsertOutcome(outcome: Outcome): void;
  getOutcome(id: string): Outcome | undefined;
  listOutcomes(): readonly Outcome[];

  upsertFeedback(feedback: Feedback): void;
  getFeedback(id: string): Feedback | undefined;
  feedbackForOutcome(outcomeId: string): readonly Feedback[];
  listFeedback(): readonly Feedback[];

  upsertKnowledge(entry: KnowledgeEntry): void;
  getKnowledge(id: string): KnowledgeEntry | undefined;
  listKnowledge(): readonly KnowledgeEntry[];

  upsertSkill(skill: Skill): void;
  getSkill(id: string): Skill | undefined;
  findBySkillKey(key: string): Skill | undefined;
  listSkills(): readonly Skill[];
  clearSkillKnowledge(skillId: string): void;

  upsertErrorPattern(pattern: ErrorPattern): void;
  getErrorPattern(id: string): ErrorPattern | undefined;
  findByFingerprint(fingerprint: string): ErrorPattern | undefined;
  listErrorPatterns(): readonly ErrorPattern[];

  upsertTask(task: LearningTask): void;
  getTask(id: string): LearningTask | undefined;
  listTasks(): readonly LearningTask[];

  upsertSchedule(schedule: LearningSchedule): void;
  getSchedule(id: string): LearningSchedule | undefined;
  listSchedules(): readonly LearningSchedule[];

  toJSON(): string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Durable-by-construction in-memory store. `toJSON()` captures the full
 * state so it can be persisted and reloaded.
 */
export class InMemoryLearningStore implements LearningStore {
  private readonly outcomes = new Map<string, Outcome>();
  private readonly feedback = new Map<string, Feedback>();
  private readonly knowledge = new Map<string, KnowledgeEntry>();
  private readonly skills = new Map<string, Skill>();
  private readonly errorPatterns = new Map<string, ErrorPattern>();
  private readonly tasks = new Map<string, LearningTask>();
  private readonly schedules = new Map<string, LearningSchedule>();

  private readonly skillIndex = new Map<string, string>();

  upsertOutcome(outcome: Outcome): void {
    this.outcomes.set(outcome.id, clone(outcome));
  }

  getOutcome(id: string): Outcome | undefined {
    const entry = this.outcomes.get(id);
    return entry ? clone(entry) : undefined;
  }

  listOutcomes(): readonly Outcome[] {
    return [...this.outcomes.values()].map(clone);
  }

  upsertFeedback(feedback: Feedback): void {
    this.feedback.set(feedback.id, clone(feedback));
  }

  getFeedback(id: string): Feedback | undefined {
    const entry = this.feedback.get(id);
    return entry ? clone(entry) : undefined;
  }

  feedbackForOutcome(outcomeId: string): readonly Feedback[] {
    return [...this.feedback.values()]
      .filter((f) => f.outcomeId === outcomeId)
      .map(clone);
  }

  listFeedback(): readonly Feedback[] {
    return [...this.feedback.values()].map(clone);
  }

  upsertKnowledge(entry: KnowledgeEntry): void {
    this.knowledge.set(entry.id, clone(entry));
  }

  getKnowledge(id: string): KnowledgeEntry | undefined {
    const entry = this.knowledge.get(id);
    return entry ? clone(entry) : undefined;
  }

  listKnowledge(): readonly KnowledgeEntry[] {
    return [...this.knowledge.values()].map(clone);
  }

  upsertSkill(skill: Skill): void {
    this.skills.set(skill.id, clone(skill));
    this.skillIndex.set(`${skill.domain}:${skill.algorithmTag ?? 'general'}`, skill.id);
  }

  getSkill(id: string): Skill | undefined {
    const entry = this.skills.get(id);
    return entry ? clone(entry) : undefined;
  }

  findBySkillKey(key: string): Skill | undefined {
    const id = this.skillIndex.get(key);
    return id ? this.getSkill(id) : undefined;
  }

  listSkills(): readonly Skill[] {
    return [...this.skills.values()].map(clone);
  }

  clearSkillKnowledge(skillId: string): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    skill.knowledgeIds = [];
    this.skills.set(skillId, clone(skill));
  }

  upsertErrorPattern(pattern: ErrorPattern): void {
    this.errorPatterns.set(pattern.id, clone(pattern));
  }

  getErrorPattern(id: string): ErrorPattern | undefined {
    const entry = this.errorPatterns.get(id);
    return entry ? clone(entry) : undefined;
  }

  findByFingerprint(fingerprint: string): ErrorPattern | undefined {
    for (const pattern of this.errorPatterns.values()) {
      if (pattern.fingerprint === fingerprint) return clone(pattern);
    }
    return undefined;
  }

  listErrorPatterns(): readonly ErrorPattern[] {
    return [...this.errorPatterns.values()].map(clone);
  }

  upsertTask(task: LearningTask): void {
    this.tasks.set(task.id, clone(task));
  }

  getTask(id: string): LearningTask | undefined {
    const entry = this.tasks.get(id);
    return entry ? clone(entry) : undefined;
  }

  listTasks(): readonly LearningTask[] {
    return [...this.tasks.values()].map(clone);
  }

  upsertSchedule(schedule: LearningSchedule): void {
    this.schedules.set(schedule.id, clone(schedule));
  }

  getSchedule(id: string): LearningSchedule | undefined {
    const entry = this.schedules.get(id);
    return entry ? clone(entry) : undefined;
  }

  listSchedules(): readonly LearningSchedule[] {
    return [...this.schedules.values()].map(clone);
  }

  toJSON(): string {
    return JSON.stringify(
      {
        version: 1,
        skills: [...this.skills.values()],
        knowledge: [...this.knowledge.values()],
        feedback: [...this.feedback.values()],
        outcomes: [...this.outcomes.values()],
        errorPatterns: [...this.errorPatterns.values()],
        tasks: [...this.tasks.values()],
        schedules: [...this.schedules.values()],
      },
      null,
      2,
    );
  }

  /** Rebuild an in-memory store from a `toJSON()` payload. */
  static fromJSON(payload: unknown): InMemoryLearningStore {
    const store = new InMemoryLearningStore();
    const data = payload as Partial<{
      skills: Skill[];
      knowledge: KnowledgeEntry[];
      feedback: Feedback[];
      outcomes: Outcome[];
      errorPatterns: ErrorPattern[];
      tasks: LearningTask[];
      schedules: LearningSchedule[];
    }>;

    for (const outcome of data.outcomes ?? []) store.upsertOutcome(outcome);
    for (const feedback of data.feedback ?? []) store.upsertFeedback(feedback);
    for (const knowledge of data.knowledge ?? []) store.upsertKnowledge(knowledge);
    for (const skill of data.skills ?? []) store.upsertSkill(skill);
    for (const pattern of data.errorPatterns ?? []) store.upsertErrorPattern(pattern);
    for (const task of data.tasks ?? []) store.upsertTask(task);
    for (const schedule of data.schedules ?? []) store.upsertSchedule(schedule);

    return store;
  }
}

/** Build a LearningState snapshot for observability / dashboards. */
export function toLearningState(store: LearningStore, now: Date = new Date()): LearningState {
  const skills = [...store.listSkills()];
  const tasks = [...store.listTasks()];
  const errorPatterns = [...store.listErrorPatterns()];

  const sortedByProficiency = [...skills].sort((a, b) => b.proficiency - a.proficiency);
  const weakest = sortedByProficiency.filter((s) => s.proficiency < 0.65).slice(0, 5).map((s) => s.id);
  const strongest = sortedByProficiency.slice(0, 3).map((s) => s.id);
  const riskPatternIds = errorPatterns
    .filter((p) => p.occurrences >= 2)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 10)
    .map((p) => p.id);

  return {
    generatedAt: now.toISOString(),
    skills,
    knowledgeEntries: [...store.listKnowledge()],
    feedback: [...store.listFeedback()],
    outcomes: [...store.listOutcomes()],
    errorPatterns,
    openTasks: tasks.filter((t) => t.status === 'pending' || t.status === 'scheduled' || t.status === 'in_progress'),
    schedules: [...store.listSchedules()],
    weakestSkillIds: weakest,
    strongestSkillIds: strongest,
    riskPatternIds,
  };
}
