import { randomUUID } from 'crypto';
import { ComplexDomain, PolitenessTier, UrgencyTier } from '../types';
import { Feedback, FeedbackKind, FeedbackVerdict, Outcome, OutcomeSuccess } from './schemas';
import { normalizeTokens, taskSignatureHash } from './tokenizer';

/** Convenience constructors for the learning subsystem's input records. */

export function createOutcome(params: {
  taskLabel: string;
  taskDescription: string;
  domain: ComplexDomain;
  algorithmTag?: string | null;
  promptVariant: 'baseline' | 'urgency_wrapped';
  politenessTier: PolitenessTier;
  urgencyTier: UrgencyTier;
  success: OutcomeSuccess;
  correctnessScore?: number;
  observedAccuracy?: number;
  expectedAccuracy?: number;
  latencyMs?: number;
  errorClass?: Outcome['errorClass'];
  errorMessage?: string;
  appliedPolicies?: string[];
  id?: string;
  createdAt?: string;
  tokens?: string[];
}): Outcome {
  const tokens = params.tokens ?? normalizeTokens(`${params.taskLabel} ${params.taskDescription}`);
  return {
    id: params.id ?? randomUUID(),
    taskLabel: params.taskLabel,
    signature: {
      taskDescriptionHash: taskSignatureHash(tokens),
      tokens,
      domain: params.domain,
      algorithmTag: params.algorithmTag ?? null,
    },
    promptVariant: params.promptVariant,
    politenessTier: params.politenessTier,
    urgencyTier: params.urgencyTier,
    success: params.success,
    correctnessScore: params.correctnessScore,
    observedAccuracy: params.observedAccuracy,
    expectedAccuracy: params.expectedAccuracy,
    latencyMs: params.latencyMs,
    errorClass: params.errorClass,
    errorMessage: params.errorMessage,
    appliedPolicies: params.appliedPolicies ?? [],
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

export function createFeedback(params: {
  outcomeId: string;
  kind: FeedbackKind;
  verdict: FeedbackVerdict;
  score?: number;
  commentary: string;
  errorClass?: Feedback['errorClass'];
  correction?: string;
  tags?: string[];
  id?: string;
  createdAt?: string;
}): Feedback {
  return {
    id: params.id ?? randomUUID(),
    outcomeId: params.outcomeId,
    kind: params.kind,
    verdict: params.verdict,
    score: params.score,
    commentary: params.commentary,
    errorClass: params.errorClass,
    correction: params.correction,
    tags: params.tags ?? [],
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}
