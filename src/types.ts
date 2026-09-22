import type {
  ResearchResult,
  RiskGuard,
} from './learning/schemas';
import type { LearningEngineConfig } from './learning/engine';

/**
 * Context attached by the continuous-learning engine before execution.
 */
export interface LearningContext {
  riskGuard?: RiskGuard;
  research?: ResearchResult[];
  knowledgeBrief?: string;
  guardAppliedAt?: string;
}

/**
 * Core domain identifiers recognized by the classifier.
 */
export type ComplexDomain = 'ml_30core' | 'dev_dp' | 'generic' | 'unknown';

/**
 * Urgency levels used for prompt wrapping and telemetry.
 */
export type UrgencyTier = 'low' | 'normal' | 'high' | 'critical';

/**
 * Politeness tier for empirical tone experiments.
 * Reference: Dobariya & Kumar (2025) observed +4.0 pp accuracy
 * for very-rude over very-polite prompts on ChatGPT-4o.
 */
export type PolitenessTier = 'very_polite' | 'polite' | 'neutral' | 'rude' | 'very_rude';

/**
 * Incoming task context supplied by upstream callers.
 */
export interface PromptContext {
  /** Human-readable description of the task. */
  taskDescription: string;

  /** Explicit flag from the caller; if true the task is treated as complex. */
  isComplexWorkflow: boolean;

  /** Optional explicit domain hint, e.g. 'ml_30core' or 'dev_dp'. */
  domainHint?: ComplexDomain;

  /** Optional algorithm tag, e.g. 'xgboost', 'transformer_selection', 'knapsack_01'. */
  algorithmTag?: string;

  /** Optional desired politeness tier for tone experiments. */
  politenessTier?: PolitenessTier;

  /** Optional chaining ID for multi-turn interactions */
  previousInteractionId?: string;

  /** Optional continuous-learning context gathered before execution. */
  learningContext?: LearningContext;
}

/**
 * Result of deterministic domain / complexity classification.
 */
export interface ClassificationResult {
  domain: ComplexDomain;
  algorithmTag: string | null;
  complexityScore: number;
  isComplex: boolean;
}

/**
 * Parsed system template structure.
 */
export interface SystemTemplate {
  metadata: {
    domain: string;
    node_id: string;
    urgency_tier: UrgencyTier;
    expected_accuracy: number;
    version: string;
    author: string;
  };
  execution: {
    preamble: string;
    instruction: string;
    urgency_injection_slot: string;
    closing: string;
  };
}

/**
 * Final wrapped prompt bundle.
 */
export interface WrappedPrompt {
  systemPrompt: string;
  userPrompt: string;
  urgencyBlock: string;
  isComplex: boolean;
  domain: ComplexDomain;
  expectedAccuracy: number;
  politenessTier: PolitenessTier;
  previousInteractionId?: string;
}

/**
 * Single telemetry event persisted for empirical analysis.
 */
export interface TelemetryEvent {
  eventId: string;
  timestamp: string;
  domain: ComplexDomain;
  algorithmTag: string | null;
  isComplex: boolean;
  politenessTier: PolitenessTier;
  urgencyTier: UrgencyTier;
  promptVariant: 'baseline' | 'urgency_wrapped';
  expectedAccuracy: number;
  observedAccuracy?: number;
  latencyMs?: number;
  taskDescriptionHash: string;
}

/**
 * Abstraction for the downstream Neural Core. Inject a real HTTP client,
 * local model wrapper or deterministic simulator here.
 */
export interface NeuralCoreAdapter {
  execute(prompt: WrappedPrompt): Promise<NeuralCoreResponse>;
}

/**
 * Response shape returned by the Neural Core adapter.
 */
export interface NeuralCoreResponse {
  coreNodeId: string;
  output: string;
  latencyMs: number;
  metadata: Record<string, unknown>;
}

/**
 * Runtime configuration for the middleware pipeline.
 */
export interface MiddlewareConfig {
  /** Absolute or relative path to the YAML system template. */
  systemTemplatePath: string;

  /** Expected accuracy target (default read from template). */
  expectedAccuracy?: number;

  /** Threshold above which a complexity score triggers urgency mode. */
  complexityThreshold?: number;

  /** Default politeness tier for experiments. */
  defaultPolitenessTier?: PolitenessTier;

  /** Telemetry sink. */
  telemetry?: TelemetrySink;

  /** Downstream core adapter. */
  coreAdapter: NeuralCoreAdapter;

  /** Optional continuous-learning subsystem. When present, the middleware
   * guards against recorded errors and learns from every outcome. */
  learning?: LearningEngineConfig;
}

/**
 * Telemetry sink contract.
 */
export interface TelemetrySink {
  record(event: TelemetryEvent): Promise<void> | void;
}

/**
 * Minimal Express-like request / response / next types so the middleware
 * remains framework-agnostic.
 */
export interface HttpRequest {
  body: {
    taskDescription?: string;
    isComplexWorkflow?: boolean;
    domainHint?: ComplexDomain;
    algorithmTag?: string;
    politenessTier?: PolitenessTier;
    previousInteractionId?: string;
  };
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): HttpResponse;
}

export type NextFunction = (err?: unknown) => void;

export interface TradingBot {
  id: string;
  name: string;
  venue: string;
  pair: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  status: 'ACTIVE' | 'PAUSED' | 'STOPPED';
  
  // Pricing & PnL
  entryPrice: number;
  currentPrice: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPercent: number;
  
  // Financial metrics
  investmentUsd: number;
  investmentEur: number;
  realizedProfitUsd: number;
  realizedProfitLabel?: string;
  
  // Strategy metrics
  dcaRangeMin: number;
  dcaRangeMax: number;
  dcaLevels: number;
  dcaOrdersTriggered: number;
  
  // Fees & Risk
  fundingFeesUsd: number;
  liquidationPrice: number;
  liquidationDistancePercent: number;
  
  // Runtime & Cycles
  startedAt: string;
  runtimeDisplay: string;
  cycles: number;
  cycleProgressPercent: number;
  
  // Overall Summary
  totalProfitUsd: number;
  roiPercent: number;
  aprPercent: number;
  
  lastUpdated: string;
}

