import { z } from 'zod';

// Typisierung für Evaluierungsmetriken und echte historische RLHF-Datensätze
export const RlhfSampleSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  agentOutput: z.string(),
  expectedOutcome: z.string().optional(),
  humanFeedbackCategory: z.enum(['approved', 'modified', 'rejected']),
  feedbackScore: z.number().min(0).max(1),
  tags: z.array(z.string()).default([]),
});

export type RlhfSample = z.infer<typeof RlhfSampleSchema>;

export interface EvaluationMetricResult {
  score: number; // 0 bis 100
  passed: boolean;
  reasoning: string;
}

export interface MetricDefinition<TInput = any> {
  name: string;
  weight: number;
  evaluate: (input: TInput) => Promise<EvaluationMetricResult> | EvaluationMetricResult;
}

export interface EvalPipelineConfig<TInput> {
  name: string;
  threshold: number; // z. B. 85 — ersetzt starre statische Schwelle
  metrics: MetricDefinition<TInput>[];
}

/**
 * Erstellt eine multidimensionale Evaluierungs-Pipeline (`defineEval`).
 * Ersetzt statische Heuristiken durch strukturierte, gewichtete Scorer,
 * die auf echte historische `rlhf_samples`-Datensätze aufbauen können.
 */
export function defineEval<TInput>(config: EvalPipelineConfig<TInput>) {
  return {
    name: config.name,
    threshold: config.threshold,

    async run(input: TInput, context?: { rlhfSamples?: RlhfSample[] }) {
      const metricResults: Record<string, EvaluationMetricResult> = {};
      let weightedSum = 0;
      let totalWeight = 0;

      for (const metric of config.metrics) {
        // Echte historische `rlhf_samples` können als Zusatzkontext übergeben werden,
        // um Feedback-Alignment und Korrektheit mit realen Daten zu prüfen.
        const result = await metric.evaluate(context ? { ...input, rlhfContext: context.rlhfSamples } : input);
        metricResults[metric.name] = result;
        weightedSum += result.score * metric.weight;
        totalWeight += metric.weight;
      }

      const totalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
      const passed = totalScore >= config.threshold;

      return {
        pipelineName: config.name,
        totalScore,
        threshold: config.threshold,
        passed,
        metrics: metricResults,
        evaluatedAt: new Date().toISOString(),
        // Explizite Referenz auf verwendete RLHF-Daten für Nachvollziehbarkeit
        rlhfContextUsed: context?.rlhfSamples ? context.rlhfSamples.length : 0,
      };
    },
  };
}
