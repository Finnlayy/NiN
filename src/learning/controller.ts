import { randomUUID } from 'crypto';
import { ComplexDomain, HttpRequest, HttpResponse, NextFunction } from '../types';
import {
  ContinuousLearningEngine,
  FeedbackResult,
  LearningEngineConfig,
} from './engine';
import { Feedback, Outcome, OutcomeSuccess, RiskGuard } from './schemas';
import { createFeedback, createOutcome } from './input';
import { normalizeTokens } from './tokenizer';

/**
 * HTTP controller that exposes the continuous-learning subsystem to the
 * frontend and to orchestrator clients.
 */

export interface LearningControllerOptions {
  engine?: ContinuousLearningEngine;
  /** Allow injecting an OpenAI-compatible route to exercise guidance. */
  openAiCompatible?: (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
}

export interface GuidancePayload {
  guidance: string;
  risk: RiskGuard;
  research: ReturnType<ContinuousLearningEngine['research']>;
  createdAt: string;
}

export function createLearningController(
  config: LearningEngineConfig,
  options: LearningControllerOptions = {},
) {
  const engine = options.engine ?? new ContinuousLearningEngine({
    store: config.store,
    now: config.now,
  });

  /**
   * Mount the learning routes. Returns a function that matches URL + method.
   */
  return async (
    req: HttpRequest & { method?: string; url?: string },
    res: HttpResponse,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const method = req.method ?? 'POST';
      const rawUrl = req.url ?? '/';
      const url = rawUrl.startsWith('/api') ? rawUrl.slice(4) : rawUrl;
      const body = req.body as Record<string, unknown>;

      if (method === 'POST' && url === '/learning/outcomes') {
        const outcome = normalizeOutcomeInput(body);
        engine.ingestOutcome(outcome);
        res.status(200).json({ outcomeId: outcome.id, outcome });
        return;
      }

      if (method === 'POST' && url === '/learning/feedback') {
        const result = ingestFeedbackRequest(engine, body);
        res.status(200).json({
          quality: result.quality,
          receivedFeedbackId: result.feedback.id,
          skillId: result.skill?.id,
          newErrorPatternIds: result.newErrorPatternIds,
          createdTaskIds: result.createdTaskIds,
          knowledgeEntryId: result.knowledgeEntry?.id,
          researchCount: result.researchResult.length,
        });
        return;
      }

      if (method === 'GET' && url === '/learning/state') {
        const state = engine.state();
        res.status(200).json(state);
        return;
      }

      if (method === 'POST' && url === '/learning/guidance') {
        const payload = await guidanceFor(engine, options, body);
        res.status(200).json(payload);
        return;
      }

      if ((method === 'GET' || method === 'POST') && url === '/learning/research') {
        const taskDescription = String(body.taskDescription ?? '');
        const domain = body.domain ? (body.domain as ComplexDomain) : undefined;
        const algorithmTag = body.algorithmTag ? String(body.algorithmTag) : undefined;
        const findings = engine.research(
          {
            taskDescription,
            domain,
            algorithmTag,
          },
          { limit: typeof body.limit === 'number' ? body.limit : 5 },
        );
        res.status(200).json({ taskDescription, findings });
        return;
      }

      if (method === 'POST' && url === '/learning/schedules/run') {
        const result = engine.runSchedules();
        res.status(200).json(result);
        return;
      }

      if (method === 'POST' && url === '/learning/schedules/install-defaults') {
        const schedules = engine.installDefaultSchedules();
        res.status(200).json({ schedules });
        return;
      }

      res.status(404).json({ error: 'Learning endpoint not found.' });
    } catch (error) {
      next(error);
    }
  };
}

function normalizeOutcomeInput(body: Record<string, unknown>): Outcome {
  const taskDescription =
    typeof body.taskDescription === 'string'
      ? body.taskDescription
      : typeof body.taskLabel === 'string'
        ? body.taskLabel
        : '';
  if (!taskDescription.trim()) {
    throw new Error('learning: taskDescription or taskLabel is required.');
  }

  return createOutcome({
    id: typeof body.id === 'string' ? body.id : randomUUID(),
    taskLabel: typeof body.taskLabel === 'string' ? body.taskLabel : taskDescription,
    taskDescription,
    domain: (body.domain as ComplexDomain) ?? 'generic',
    algorithmTag: typeof body.algorithmTag === 'string' ? body.algorithmTag : undefined,
    promptVariant: body.promptVariant === 'baseline' ? 'baseline' : 'urgency_wrapped',
    politenessTier: (body.politenessTier as Outcome['politenessTier']) ?? 'neutral',
    urgencyTier: (body.urgencyTier as Outcome['urgencyTier']) ?? 'normal',
    success: (body.success as OutcomeSuccess) ?? 'success',
    correctnessScore: typeof body.correctnessScore === 'number' ? body.correctnessScore : undefined,
    observedAccuracy: typeof body.observedAccuracy === 'number' ? body.observedAccuracy : undefined,
    expectedAccuracy: typeof body.expectedAccuracy === 'number' ? body.expectedAccuracy : undefined,
    latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
    errorClass: body.errorClass as Outcome['errorClass'],
    errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
    appliedPolicies: Array.isArray(body.appliedPolicies) ? body.appliedPolicies.map(String) : [],
  });
}

function ingestFeedbackRequest(
  engine: ContinuousLearningEngine,
  body: Record<string, unknown>,
): FeedbackResult {
  const outcomeInput = body.outcome as Record<string, unknown> | undefined;
  const outcome = outcomeInput
    ? normalizeOutcomeInput(outcomeInput)
    : createOutcome({
        taskLabel: String(body.taskLabel ?? 'unknown'),
        taskDescription: String(body.taskDescription ?? 'unknown'),
        domain: (body.domain as ComplexDomain) ?? 'generic',
        algorithmTag: typeof body.algorithmTag === 'string' ? body.algorithmTag : undefined,
        promptVariant: 'urgency_wrapped',
        politenessTier: 'neutral',
        urgencyTier: 'normal',
        success: body.success === 'failure' ? 'failure' : body.success === 'partial' ? 'partial' : 'success',
      });
  engine.ingestOutcome(outcome);

  const feedback: Feedback = createFeedback({
    outcomeId: typeof body.outcomeId === 'string'
      ? body.outcomeId
      : outcome.id,
    kind: (body.kind as Feedback['kind']) ?? 'automated_check',
    verdict: (body.verdict as Feedback['verdict']) ?? 'inconclusive',
    score: typeof body.score === 'number' ? body.score : undefined,
    commentary: typeof body.commentary === 'string' ? body.commentary : String(body.result ?? ''),
    errorClass: body.errorClass as Feedback['errorClass'],
    correction: typeof body.correction === 'string' ? body.correction : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });

  return engine.ingestFeedback(feedback);
}

async function guidanceFor(
  engine: ContinuousLearningEngine,
  options: LearningControllerOptions,
  body: Record<string, unknown>,
): Promise<GuidancePayload> {
  const taskDescription = typeof body.taskDescription === 'string' ? body.taskDescription : '';
  if (!taskDescription.trim()) throw new Error('learning: taskDescription is required for guidance.');

  const domain = (body.domain as ComplexDomain) ?? 'generic';
  const algorithmTag = typeof body.algorithmTag === 'string' ? body.algorithmTag : undefined;
  const risk = engine.guardTask({ taskDescription, domain, algorithmTag });
  const research = engine.research({ taskDescription, domain, algorithmTag }, { limit: 5 });

  let guidance = buildGuidance(risk, research);
  if (research.length > 0 && options.openAiCompatible) {
    const model = typeof body.model === 'string' ? body.model : 'deterministic-guidance';
    if (model !== 'deterministic-guidance') {
      const researchText = research
        .slice(0, 3)
        .map((r) => `- ${r.entry.contentType}: ${r.entry.title} (${r.relevanceScore.toFixed(3)})`)
        .join('\n');
      const response = await options.openAiCompatible({
        model,
        messages: [
          {
            role: 'system',
            content: 'You improve a solution by using the risk guard and Knowledge Base. Return concise, actionable guidance.',
          },
          {
            role: 'user',
            content: `Task: ${taskDescription}\n\nRisk:${risk.risk}\n${risk.recommendation}\n\nKB:\n${researchText}\n\nWrite an improved solution approach.`,
          },
        ],
      });
      guidance = response.choices[0]?.message?.content ?? guidance;
    }
  }

  return {
    guidance,
    risk,
    research,
    createdAt: new Date().toISOString(),
  };
}

function buildGuidance(
  risk: RiskGuard,
  research: ReturnType<ContinuousLearningEngine['research']>,
): string {
  const lines: string[] = [
    'Continuous-learning guidance:',
    `Risk guard: ${risk.risk.toFixed(2)} - ${risk.recommendation}`,
  ];

  if (research.length > 0) {
    lines.push('', 'Best Knowledge Base candidates in order:');
    for (const result of research.slice(0, 3)) {
      lines.push(`- ${result.entry.contentType}: ${result.entry.title} (${result.relevanceScore.toFixed(3)})`);
      lines.push(`  ${result.entry.body.trim().replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  } else {
    lines.push('', 'No matching Knowledge Base entry found. Execute carefully and record the outcome.');
  }

  return lines.join('\n');
}

export { normalizeTokens };
