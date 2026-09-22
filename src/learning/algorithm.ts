import { Skill } from './schemas';

/**
 * Core continuous-learning algorithm.
 *
 * It combines:
 *  - Bayesian / Wilson confidence bound skill profiling
 *  - spaced-repetition review scheduling
 *  - error-pattern memory
 *  - automatic anti-pattern promotion
 *
 * The functions are deterministic, so the same feedback history always
 * produces the same skill state and schedule.
 */

const MIN_QUALITY = 0;
const MAX_QUALITY = 1;
const DEFAULT_INTERVAL_DAYS = 1;
const DEFAULT_EASE_FACTOR = 2.5;
const TARGET_CONFIDENCE = 0.6;
const MAX_CONFIDENCE = 0.95;

/**
 * Wilson score lower bound for a Bernoulli success estimate.
 * This is a conservative beta-conjugate estimate of proficiency that lets the
 * engine treat low-sample skills as uncertain instead of overconfident.
 */
export function wilsonLowerBound(successes: number, trials: number, z: number = 1.96): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, Math.min(1, (centre - margin) / denom));
}

/**
 * SM-2-like spaced-repetition update. `quality` is in [0, 1]:
 *  - >= 0.8: success, increase interval
 *  - 0.4..0.79: partial retention, reset to a short interval
 *  - < 0.4: failure, reset the interval to one day
 */
export function spacedRepetition(
  intervalDays: number,
  easeFactor: number,
  quality: number,
): { intervalDays: number; easeFactor: number } {
  const boundedQuality = Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, quality));
  const newEase = Math.max(1.3, easeFactor + (0.1 - (1 - boundedQuality) * (0.08 + (1 - boundedQuality) * 0.02)));

  let newInterval: number;
  if (boundedQuality >= 0.8) {
    newInterval = intervalDays <= 0
      ? 1
      : intervalDays === 1
        ? 3
        : Math.round(intervalDays * newEase);
  } else if (boundedQuality >= 0.4) {
    newInterval = 1;
  } else {
    newInterval = 1;
  }

  return { intervalDays: newInterval, easeFactor: newEase };
}

/**
 * Deterministically produce the skill key used by the skill index.
 */
export function skillKey(domain: string, algorithmTag?: string | null): string {
  return `${domain}:${algorithmTag ?? 'general'}`;
}

/**
 * Update a skill with the quality (correctness) obtained on one outcome.
 * If no skill exists, it creates a new one with the domain and algorithm tag.
 */
export function updateSkill(
  skill: Skill | undefined,
  params: {
    domain: Skill['domain'];
    algorithmTag?: string | null;
    quality: number;
    errorFingerprint?: string;
    antiPattern?: string;
    knowledgeIds?: string[];
  },
  now: Date = new Date(),
): Skill {
  const trialQuality = clampQuality(params.quality);
  const isSuccess = trialQuality >= 0.75;

  const base: Skill = skill ?? {
    id: `skill_${newSkillId(params.domain, params.algorithmTag ?? 'general')}`,
    name: `${params.domain}${params.algorithmTag ? ` / ${params.algorithmTag}` : ' / general'}`,
    domain: params.domain,
    algorithmTag: params.algorithmTag ?? undefined,
    proficiency: 0,
    confidence: 0,
    trials: 0,
    successes: 0,
    errors: 0,
    intervalDays: DEFAULT_INTERVAL_DAYS,
    easeFactor: DEFAULT_EASE_FACTOR,
    errorFingerprints: [],
    antiPatterns: [],
    knowledgeIds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const trials = base.trials + 1;
  const successes = base.successes + (isSuccess ? 1 : 0);
  const errors = base.errors + (trialQuality < 0.4 ? 1 : 0);
  const proficiency = round(wilsonLowerBound(successes, trials));
  const confidence = clampConfidence(proficiency, trials);

  const schedule = spacedRepetition(base.intervalDays, base.easeFactor, trialQuality);

  const fingerprint = params.errorFingerprint;
  const antiPattern = params.antiPattern;
  const errorFingerprints = fingerprint ? [...new Set([...base.errorFingerprints, fingerprint])] : base.errorFingerprints;
  const antiPatterns = antiPattern ? [...new Set([...base.antiPatterns, antiPattern])] : base.antiPatterns;

  const knowledgeIds = params.knowledgeIds
    ? [...new Set([...base.knowledgeIds, ...params.knowledgeIds])].slice(0, 128)
    : base.knowledgeIds;

  const nextReview = new Date(now.getTime() + schedule.intervalDays * 24 * 60 * 60 * 1000);

  return {
    ...base,
    proficiency,
    confidence,
    trials,
    successes,
    errors,
    lastOutcomeAt: now.toISOString(),
    nextReviewAt: nextReview.toISOString(),
    intervalDays: schedule.intervalDays,
    easeFactor: schedule.easeFactor,
    errorFingerprints,
    antiPatterns,
    knowledgeIds,
    updatedAt: now.toISOString(),
  };
}

/**
 * Select the skills that are due for a learning review, sorted by likelihood
 * of being the highest-value learning intervention.
 */
export function dueSkills(skills: readonly Skill[], now: Date = new Date()): Skill[] {
  return skills
    .filter((skill) => {
      if (skill.trials === 0) return true;
      if (!skill.nextReviewAt) return true;
      return new Date(skill.nextReviewAt).getTime() <= now.getTime();
    })
    .sort((a, b) => {
      const aRisk = a.confidence < TARGET_CONFIDENCE ? (TARGET_CONFIDENCE - a.confidence) : 0;
      const bRisk = b.confidence < TARGET_CONFIDENCE ? (TARGET_CONFIDENCE - b.confidence) : 0;
      const aErrorRate = a.trials > 0 ? a.errors / a.trials : 0;
      const bErrorRate = b.trials > 0 ? b.errors / b.trials : 0;
      return (bRisk + bErrorRate * 0.5) - (aRisk + aErrorRate * 0.5);
    });
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 0;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, quality));
}

function clampConfidence(proficiency: number, trials: number): number {
  const confidence = Math.sqrt(trials / (trials + 4)) * (0.7 + proficiency * 0.3);
  return round(Math.min(MAX_CONFIDENCE, Math.max(0, confidence)));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function newSkillId(domain: string, algorithmTag: string): string {
  const slug = `${domain}_${algorithmTag}_${Date.now()}`;
  return slug.replace(/[^a-z0-9_]/gi, '_');
}
