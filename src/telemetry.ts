import { createHash, randomUUID } from 'crypto';
import {
  PolitenessTier,
  TelemetryEvent,
  TelemetrySink,
  UrgencyTier,
} from './types';

/**
 * Deterministic SHA-256 hash for a task description used in telemetry.
 */
export function hashTaskDescription(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Compute the empirical accuracy lift of a treated group over a baseline.
 * Reference benchmark: very-rude prompts achieved 84.8% vs 80.8% for
 * very-polite prompts, a +4.0 percentage point gain (Dobariya & Kumar, 2025).
 */
export function computeEmpiricalGain(
  baselineAccuracy: number,
  treatedAccuracy: number,
): number {
  if (!Number.isFinite(baselineAccuracy) || !Number.isFinite(treatedAccuracy)) {
    throw new Error('computeEmpiricalGain: inputs must be finite numbers.');
  }
  if (baselineAccuracy < 0 || baselineAccuracy > 1 || treatedAccuracy < 0 || treatedAccuracy > 1) {
    throw new Error('computeEmpiricalGain: accuracies must be in [0, 1].');
  }
  return treatedAccuracy - baselineAccuracy;
}

/**
 * Default accuracy targets per politeness tier for A/B telemetry baselines.
 */
export function defaultAccuracyForPoliteness(tier: PolitenessTier): number {
  switch (tier) {
    case 'very_polite':
      return 0.808;
    case 'polite':
      return 0.814;
    case 'neutral':
      return 0.822;
    case 'rude':
      return 0.828;
    case 'very_rude':
      return 0.848;
    default:
      return 0.822;
  }
}

/**
 * Factory for a telemetry event capturing everything needed to replicate
 * the politeness / urgency accuracy experiments.
 */
export function buildTelemetryEvent(params: {
  domain: string;
  algorithmTag: string | null;
  isComplex: boolean;
  politenessTier: PolitenessTier;
  urgencyTier: UrgencyTier;
  promptVariant: 'baseline' | 'urgency_wrapped';
  expectedAccuracy: number;
  taskDescription: string;
  observedAccuracy?: number;
  latencyMs?: number;
}): TelemetryEvent {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    domain: params.domain as TelemetryEvent['domain'],
    algorithmTag: params.algorithmTag,
    isComplex: params.isComplex,
    politenessTier: params.politenessTier,
    urgencyTier: params.urgencyTier,
    promptVariant: params.promptVariant,
    expectedAccuracy: params.expectedAccuracy,
    observedAccuracy: params.observedAccuracy,
    latencyMs: params.latencyMs,
    taskDescriptionHash: hashTaskDescription(params.taskDescription),
  };
}

/**
 * In-memory telemetry sink. Production systems can swap this for a database
 * or metrics exporter implementing TelemetrySink.
 */
export class InMemoryTelemetryStore implements TelemetrySink {
  private readonly events: TelemetryEvent[] = [];

  async record(event: TelemetryEvent): Promise<void> {
    this.events.push({ ...event });
  }

  snapshot(): readonly TelemetryEvent[] {
    return Object.freeze([...this.events]);
  }

  /**
   * Aggregate mean observed accuracy by prompt variant and politeness tier.
   */
  summarize(): Record<string, number> {
    const buckets: Record<string, { sum: number; count: number }> = {};

    for (const event of this.events) {
      if (event.observedAccuracy === undefined) continue;
      const key = `${event.promptVariant}:${event.politenessTier}`;
      const bucket = buckets[key] ?? { sum: 0, count: 0 };
      bucket.sum += event.observedAccuracy;
      bucket.count += 1;
      buckets[key] = bucket;
    }

    const result: Record<string, number> = {};
    for (const [key, bucket] of Object.entries(buckets)) {
      result[key] = bucket.sum / bucket.count;
    }
    return result;
  }

  toJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }
}
