/**
 * MANAS : CIEL — Paragraph 2 ("Drei-Komponenten-Berechnung")
 * Multi-Horizon Prediction Accuracy Domain Types
 *
 * Every confirmed Paragraph 2 calculation is stored as an immutable snapshot.
 * A snapshot never carries its own outcome: resolutions live in a separate,
 * append-only collection. That separation is what makes retro-active
 * "repainting" structurally impossible — there is no writable field on a
 * snapshot that could later absorb the realised price.
 */

export type HorizonMinutes = 5 | 15 | 30 | 60 | 120 | 180 | 300;

/** The seven mandatory forward evaluation horizons (minutes). */
export const EVALUATION_HORIZONS: readonly HorizonMinutes[] = [
  5, 15, 30, 60, 120, 180, 300,
] as const;

export const HORIZON_MS = (horizon: HorizonMinutes): number => horizon * 60_000;

export type MarketRegime =
  | 'STRONG_BULL'
  | 'WEAK_BULL'
  | 'STRONG_BEAR'
  | 'WEAK_BEAR'
  | 'RANGING_CHOP'
  | 'HIGH_VOL_CRISIS';

export type Direction = -1 | 0 | 1;

/** Data provenance. Only LIVE records may feed graduation / trading verdicts. */
export type SnapshotOrigin = 'LIVE' | 'REPLAY';

export type M8EngineStatus = 'ACTIVE' | 'THROTTLED' | 'QUARANTINED' | 'RETIRED';

/** Normalised features that feed the ONNX-style head (Paragraph 2, component 1). */
export interface FeatureSnapshot {
  price: number;
  rsi14: number;
  atrPercent: number;
  cisd: number;
  bbWidthPercent: number;
  bbPosition: number;
  /** Realised volatility in percent of price per minute (interval-corrected). */
  sigmaPerMinutePercent: number;
  /** Number of price ticks the features were derived from. */
  sampleCount: number;
}

/** Immutable record of the three Paragraph 2 components at t0. */
export interface ThreeComponentState {
  // Component 1 — self-optimising ONNX inference with temperature calibration.
  onnxRawYHat: number;
  onnxCalibratedY: number;
  temperatureT: number;
  bias: number;
  // Component 2 — JEV 1.13 System-1 gate + 4(+2)-regime state machine.
  jevGateConfidence: number;
  regime: MarketRegime;
  hurstExponent: number;
  atrPercentile: number;
  emaDeltaPercent: number;
  // Component 3 — Kraken-CLI paper-mode execution signal.
  krakenPaperSignal: number;
  paperSizingImpulse: number;
  // Paragraph 2 composite.
  compositeScore: number;
  predictedDirection: Direction;
  impliedTargetPrices: Record<HorizonMinutes, number>;
  features: FeatureSnapshot;
}

/**
 * Prediction-side slot. Stored permanently in `pending` state; outcomes are
 * projected in by `materialiseHorizon()` from the separate resolution ledger.
 */
export interface HorizonEvaluationSlot {
  horizonMinutes: HorizonMinutes;
  status: 'pending' | 'resolved';
  targetTimestampMs: number;
  actualBtcPrice: number | null;
  actualDirection: Direction | null;
  directionalHit: boolean | null;
  absPercentageError: number | null;
  brierContribution: number | null;
  accuracyPercent: number | null;
}

export interface Paragraph2Snapshot {
  id: string;
  /** Authoritative exchange timestamp (Kraken server clock), immutable. */
  t0ExchangeMs: number;
  /** Immutable reference price P(t0). */
  btcPriceAtT0: number;
  origin: SnapshotOrigin;
  m8EngineStatus: M8EngineStatus;
  components: ThreeComponentState;
  horizons: Record<HorizonMinutes, HorizonEvaluationSlot>;
  /** FNV-1a integrity fingerprint of the immutable payload. */
  checksum: string;
}

/** Append-only outcome record. Never mutates the snapshot it belongs to. */
export interface HorizonResolution {
  snapshotId: string;
  horizonMinutes: HorizonMinutes;
  targetTimestampMs: number;
  resolvedAtExchangeMs: number;
  referencePrice: number;
  actualBtcPrice: number;
  actualDirection: Direction;
  predictedDirection: Direction;
  impliedTargetPrice: number;
  directionalHit: boolean;
  absPercentageError: number;
  smapePercent: number;
  magnitudeClosenessPercent: number;
  accuracyPercent: number;
  brierContribution: number;
  /** Calibrated P(up) that was frozen at t0 — needed by the calibration optimiser. */
  predictedProbabilityUp: number;
  /** Directional paper PnL in percent (0 for neutral calls) — feeds the profit factor. */
  paperPnlPercent: number;
  origin: SnapshotOrigin;
  checksum: string;
}

export interface CalibrationState {
  temperatureT: number;
  bias: number;
  /** Resolutions used for the last calibration update. */
  calibrationSamples: number;
  rollingBrier: number;
  lastUpdatedMs: number | null;
}

export type ErrorSeverity = 'info' | 'warn' | 'error';

export type VerdictSeverity = 'success' | 'warn' | 'info' | 'error';

export type SubAgentLayer = 'BLANCHE' | 'JAUNE' | 'NOIR' | 'ROUGE';

/**
 * Unified Error Taxonomy (E1000–E5000). Every rejection the pipeline performs
 * is reported under exactly one of these codes so the UI never has to guess
 * why a snapshot or a verdict is missing.
 */
export type ErrorCode =
  | 'E1000' // stale signal / feed older than tolerance
  | 'E1200' // exchange clock skew exceeded
  | 'E2000' // insufficient samples
  | 'E2100' // low confidence weight / unproven horizon
  | 'E3000' // price feed unavailable for resolution
  | 'E4000' // snapshot integrity violation (checksum mismatch)
  | 'E4100' // snapshot schema / monotonicity reject
  | 'E5000'; // UI fallback render

export interface GovernanceEvent {
  id: string;
  code: ErrorCode;
  severity: ErrorSeverity;
  layer: SubAgentLayer;
  message: string;
  atMs: number;
}

export interface HorizonAggregate {
  horizonMinutes: HorizonMinutes;
  /** Raw resolved slots (overlapping windows included). */
  samples: number;
  /**
   * Overlap-corrected sample count used for every confidence statement.
   * Consecutive snapshots share up to horizon/stride minutes of price path, so
   * raw counts overstate evidence by that factor.
   */
  effectiveSamples: number;
  wins: number;
  directionalAccuracyPercent: number;
  /** Wilson 95% lower bound — guards against a lucky small sample. */
  daLowerBoundPercent: number;
  magnitudeClosenessPercent: number;
  accuracyPercent: number;
  brierScore: number;
  /** Share of resolutions whose realised move stayed inside the neutral band. */
  neutralShare: number;
  /** Resolutions with a realised move (denominator of the hit rate), in percent. */
  coveragePercent: number;
  /** Both chronological halves beat a coin flip (out-of-sample check). */
  isOutOfSampleConsistent: boolean;
  confidenceWeight: number;
  rankedScore: number;
  rank: number;
  isProvisional: boolean;
  isGraduated: boolean;
  lastResolvedAtMs: number | null;
}

export interface PaperGraduation {
  samples: number;
  requiredSamples: number;
  winRate: number;
  winRateTarget: number;
  profitFactor: number;
  profitFactorTarget: number;
  /** N >= 20 with WR/PF targets met. */
  isGraduated: boolean;
  /** N >= 30 (strict threshold) with WR/PF targets met. */
  isGraduatedStrict: boolean;
}

export interface Verdict {
  code: ErrorCode | null;
  severity: VerdictSeverity;
  headline: string;
  detail: string;
  horizon: HorizonMinutes | null;
}

export interface AccuracySummary {
  horizons: HorizonAggregate[];
  best: HorizonAggregate | null;
  liveResolutions: number;
  pendingHorizons: number;
  rollingBrier: number;
  graduation: PaperGraduation;
  verdict: Verdict;
  calibration: CalibrationState;
}
