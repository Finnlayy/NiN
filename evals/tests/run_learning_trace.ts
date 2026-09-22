import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  ContinuousLearningEngine,
  createFeedback,
  createOutcome,
  evaluateData,
  InMemoryLearningStore,
} from '../../src';
import { defineEval, MetricDefinition, RlhfSampleSchema } from '../../src/learning/defineEval';
import { learningEvaluator } from '../../src/learning/evaluator';

const ROOT = process.cwd();
const TRACE_PATH = join(ROOT, 'data', 'vectors', 'learning_trace.json');
const FIXED_NOW = new Date('2026-09-03T10:00:00.000Z');

async function main(): Promise<void> {
  const store = new InMemoryLearningStore();
  const engine = new ContinuousLearningEngine({ store, now: () => FIXED_NOW });
  engine.installDefaultSchedules();

  // Successful outcome: the system earns confidence.
  const good = createOutcome({
    taskLabel: 'good knapsack',
    taskDescription: 'Solve the 0/1 knapsack problem with dynamic programming and prove correctness.',
    domain: 'dev_dp',
    algorithmTag: 'knapsack_01',
    promptVariant: 'urgency_wrapped',
    politenessTier: 'neutral',
    urgencyTier: 'critical',
    success: 'success',
    correctnessScore: 0.92,
    observedAccuracy: 0.92,
    expectedAccuracy: 0.848,
    latencyMs: 412,
    appliedPolicies: ['prompt_variant:urgency_wrapped', 'politeness_tier:neutral'],
    createdAt: FIXED_NOW.toISOString(),
  });
  engine.ingestOutcome(good);
  const goodFeedback = engine.ingestFeedback(
    createFeedback({
      outcomeId: good.id,
      kind: 'ground_truth',
      verdict: 'correct',
      score: 0.92,
      commentary: 'Ground-truth proof matched the reference solution.',
      tags: ['knapsack', 'correct'],
      createdAt: FIXED_NOW.toISOString(),
    }),
  );

  // Failing outcome: the system must retain the error, research and remediate.
  const badTaskDescription =
    'Select between XGBoost and a Transformer architecture for a tabular sequence task.';
  const bad = createOutcome({
    taskLabel: 'bad xgboost',
    taskDescription: badTaskDescription,
    domain: 'ml_30core',
    algorithmTag: 'xgboost',
    promptVariant: 'urgency_wrapped',
    politenessTier: 'very_rude',
    urgencyTier: 'critical',
    success: 'failure',
    correctnessScore: 0.35,
    observedAccuracy: 0.35,
    expectedAccuracy: 0.848,
    latencyMs: 98,
    errorClass: 'correctness',
    errorMessage: 'The selected model ignored interaction effects in tabular features.',
    appliedPolicies: ['prompt_variant:urgency_wrapped', 'politeness_tier:very_rude'],
    createdAt: FIXED_NOW.toISOString(),
  });
  engine.ingestOutcome(bad);
  const badFeedback = engine.ingestFeedback(
    createFeedback({
      outcomeId: bad.id,
      kind: 'human_correction',
      verdict: 'incorrect',
      score: 0.3,
      commentary: 'Missing categorical interaction awareness caused an incorrect recommendation.',
      errorClass: 'correctness',
      correction: 'Use a gradient-boosted model with explicit categorical interaction terms and report validation error per fold.',
      tags: ['xgboost', 'feature-engineering'],
      createdAt: FIXED_NOW.toISOString(),
    }),
  );

  const research = engine.research(
    {
      taskDescription: badTaskDescription,
      domain: 'ml_30core',
      algorithmTag: 'xgboost',
    },
    { limit: 5 },
  );

  const dataEvaluation = evaluateData({
    model: 'xgboost',
    features: ['age', 'duration', 'campaign'],
    interactions: null,
    targetMetric: 'auc',
  });

  // Make the successful skill due for review so the schedule can produce a
  // fresh learning task rather than only seeing the already-open error tasks.
  const goodSkill = store.findBySkillKey('dev_dp:knapsack_01');
  if (goodSkill) {
    store.upsertSkill({ ...goodSkill, nextReviewAt: FIXED_NOW.toISOString() });
  }

  // Force the default schedule to be due and run it.
  const schedules = store.listSchedules();
  for (const schedule of schedules) {
    schedule.nextRunAt = FIXED_NOW.toISOString();
    store.upsertSchedule(schedule);
  }
  const scheduleRun = engine.runSchedules();

  // Integration der neuen `defineEval`-Pipeline mit echten historischen `rlhf_samples`.
  const rlhfSamplesRaw = await import('../datasets/rlhf_samples.json');
  // Handle default export logic if any
  const samplesArray = (rlhfSamplesRaw as any).default ? (rlhfSamplesRaw as any).default : rlhfSamplesRaw;
  const rlhfSample = Array.isArray(samplesArray) && samplesArray.length > 0 ? samplesArray[0] : undefined;

  const pipelineRun = await learningEvaluator.run(
    {
      outcome: { correctnessScore: 0.92, errorMessage: undefined } as any,
      feedbacks: [{ verdict: 'correct', score: 0.92 }],
      errors: [],
      humanFeedbackCategory: rlhfSample ? rlhfSample.humanFeedbackCategory : 'approved',
    } as any,
    rlhfSample ? { rlhfSamples: [rlhfSample] } : undefined,
  );

  const guard = engine.guardTask({
    taskDescription: badTaskDescription,
    domain: 'ml_30core',
    algorithmTag: 'xgboost',
  });

  const state = engine.state();
  const trace = {
    generatedAt: new Date().toISOString(),
    fixedNow: FIXED_NOW.toISOString(),
    goodOutcome: good,
    goodFeedback,
    badOutcome: bad,
    badFeedback: {
      ...badFeedback,
      knowledgeEntry: badFeedback.knowledgeEntry,
      createdTaskIds: badFeedback.createdTaskIds,
      newErrorPatternIds: badFeedback.newErrorPatternIds,
    },
    research,
    dataEvaluation,
    defineEvalPipeline: {
      name: pipelineRun.pipelineName,
      totalScore: pipelineRun.totalScore,
      threshold: pipelineRun.threshold,
      passed: pipelineRun.passed,
      metrics: pipelineRun.metrics,
      evaluatedAt: pipelineRun.evaluatedAt,
      rlhfContextUsed: pipelineRun.rlhfContextUsed,
    },
    scheduleRun,
    guard,
    state: {
      skills: state.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        domain: skill.domain,
        algorithmTag: skill.algorithmTag,
        proficiency: skill.proficiency,
        confidence: skill.confidence,
        trials: skill.trials,
        successes: skill.successes,
        errors: skill.errors,
        nextReviewAt: skill.nextReviewAt,
        antiPatterns: skill.antiPatterns,
        knowledgeIds: skill.knowledgeIds,
      })),
      knowledgeCount: state.knowledgeEntries.length,
      feedbackCount: state.feedback.length,
      outcomeCount: state.outcomes.length,
      errorPatternCount: state.errorPatterns.length,
      openTaskCount: state.openTasks.length,
      openTasks: state.openTasks.map((task) => ({
        id: task.id,
        type: task.type,
        subject: task.subject,
        priority: task.priority,
        status: task.status,
      })),
      weakestSkillIds: state.weakestSkillIds,
      riskPatternIds: state.riskPatternIds,
    },
  };

  await mkdir(join(ROOT, 'data', 'vectors'), { recursive: true });
  await writeFile(TRACE_PATH, JSON.stringify(trace, null, 2), 'utf-8');
  console.log(`learning trace written to ${TRACE_PATH}`);
  console.log(`state: ${state.skills.length} skills, ${state.knowledgeEntries.length} knowledge entries, ${state.openTasks.length} open tasks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
