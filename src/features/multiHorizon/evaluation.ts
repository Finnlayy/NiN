/**
 * [Jaune] — Quant & Horizon Computation.
 *
 * Pure functions only. Given an immutable snapshot and a realised price, the
 * evaluator produces:
 *   · directional hit rate        DA_h
 *   · trajectory price closeness  MC_h  (scaled symmetric MAPE)
 *   · combined accuracy           Accuracy_h
 *   · Brier contribution          per resolved horizon
 *   · Bayesian confidence weight  w_h = N_h / (N_h + k)
 *   · confidence-weighted ranking of the seven horizons
 */

import {
  ACCURACY_DIRECTION_WEIGHT,
  ACCURACY_MAGNITUDE_WEIGHT,
  CONFIDENCE_K,
  GRADUATION_PROFIT_FACTOR,
  GRADUATION_SAMPLES,
  GRADUATION_WIN_RATE,
  MIN_SAMPLES_PROVISIONAL,
  MIN_TRADEABLE_RANK_SCORE,
  NEUTRAL_BAND_PERCENT,
} from './config';
import {
  EVALUATION_HORIZONS,
  HORIZON_MS,
  type AccuracySummary,
  type CalibrationState,
  type HorizonAggregate,
  type HorizonMinutes,
  type HorizonResolution,
  type HorizonEvaluationSlot,
  type MarketRegime,
  type PaperGraduation,
  type Paragraph2Snapshot,
  type SnapshotOrigin,
  type Verdict,
} from './types';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, digits = 2): number =>
  Number(value.toFixed(digits));

/**
 * Volatility of one horizon in percent, derived from the snapshot's own ATR —
 * never from future data. It sets the tolerance band for the magnitude score.
 */
export function horizonSigmaPercent(snapshot: Paragraph2Snapshot, horizon: HorizonMinutes): number {
  const atrPercent = snapshot.components.features.atrPercent;
  const sigmaPerMinute = clamp(atrPercent * 0.35, 0.06, 0.4);
  return sigmaPerMinute * Math.sqrt(horizon);
}

export type ResolutionDraft = Omit<HorizonResolution, 'checksum'>;

/**
 * Evaluates one horizon. The caller is responsible for only invoking this once
 * `currentExchangeMs >= t0 + h`, and for passing the price observed at/after
 * that target — never a later, more convenient price.
 */
export function computeResolution(
  snapshot: Paragraph2Snapshot,
  horizon: HorizonMinutes,
  actualPrice: number,
  resolvedAtExchangeMs: number
): ResolutionDraft {
  if (!Number.isFinite(actualPrice) || actualPrice <= 0) {
    throw new Error('computeResolution: actual price must be a positive finite number');
  }
  const targetTimestampMs = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
  if (resolvedAtExchangeMs < targetTimestampMs) {
    throw new Error('computeResolution: horizon has not matured (future leak rejected)');
  }

  const referencePrice = snapshot.btcPriceAtT0;
  const returnPercent = (actualPrice - referencePrice) / referencePrice * 100;
  const actualDirection: -1 | 0 | 1 =
    returnPercent > NEUTRAL_BAND_PERCENT
      ? 1
      : returnPercent < -NEUTRAL_BAND_PERCENT
        ? -1
        : 0;

  const predictedDirection = snapshot.components.predictedDirection;
  const impliedTargetPrice = snapshot.components.impliedTargetPrices[horizon];
  const directionalHit = predictedDirection === actualDirection;

  const absPercentageError = (Math.abs(impliedTargetPrice - actualPrice) / actualPrice) * 100;
  const symmetricDenominator = Math.abs(impliedTargetPrice) + Math.abs(actualPrice);
  const smapePercent =
    symmetricDenominator > 0
      ? (200 * Math.abs(impliedTargetPrice - actualPrice)) / symmetricDenominator
      : 100;

  const tolerancePercent = Math.max(0.05, 1.2 * horizonSigmaPercent(snapshot, horizon));
  const magnitudeClosenessPercent = clamp(100 * (1 - smapePercent / tolerancePercent), 0, 100);

  const accuracyPercent = round(
    ACCURACY_DIRECTION_WEIGHT * (directionalHit ? 100 : 0) +
      ACCURACY_MAGNITUDE_WEIGHT * magnitudeClosenessPercent,
    2
  );

  const predictedProbabilityUp = clamp(snapshot.components.onnxCalibratedY, 0.001, 0.999);
  const outcome = actualDirection === 1 ? 1 : actualDirection === -1 ? 0 : 0.5;
  const brierContribution = round((predictedProbabilityUp - outcome) ** 2, 5);

  return {
    snapshotId: snapshot.id,
    horizonMinutes: horizon,
    targetTimestampMs,
    resolvedAtExchangeMs,
    referencePrice,
    actualBtcPrice: actualPrice,
    actualDirection,
    predictedDirection,
    impliedTargetPrice,
    directionalHit,
    absPercentageError: round(absPercentageError, 4),
    smapePercent: round(smapePercent, 4),
    magnitudeClosenessPercent: round(magnitudeClosenessPercent, 2),
    accuracyPercent,
    brierContribution,
    predictedProbabilityUp,
    paperPnlPercent: round(predictedDirection * returnPercent, 5),
    origin: snapshot.origin,
  };
}

/** Projects a stored resolution back onto a copy of the snapshot's slot. */
export function materialiseHorizon(
  snapshot: Paragraph2Snapshot,
  horizon: HorizonMinutes,
  resolution?: HorizonResolution
): HorizonEvaluationSlot {
  const base = snapshot.horizons[horizon];
  if (!resolution) return { ...base, status: 'pending' };
  return {
    ...base,
    status: 'resolved',
    actualBtcPrice: resolution.actualBtcPrice,
    actualDirection: resolution.actualDirection,
    directionalHit: resolution.directionalHit,
    absPercentageError: resolution.absPercentageError,
    brierContribution: resolution.brierContribution,
    accuracyPercent: resolution.accuracyPercent,
  };
}

/** Wilson 95% lower bound for a binomial proportion, in percent. */
export function wilsonLowerBound(wins: number, samples: number, z = 1.96): number {
  if (samples <= 0) return 0;
  const p = wins / samples;
  const denominator = 1 + (z * z) / samples;
  const centre = p + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples));
  return clamp(((centre - margin) / denominator) * 100, 0, 100);
}

const meanOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((acc, value) => acc + value, 0) / values.length;

/**
 * Builds the seven horizon aggregates, ranks them by confidence-weighted score
 * and marks provisional / graduated horizons. REPLAY records are excluded
 * unless explicitly requested — synthetic data never ranks a live horizon.
 */
export function buildAggregates(
  resolutions: readonly HorizonResolution[],
  origin: SnapshotOrigin = 'LIVE'
): HorizonAggregate[] {
  const scoped = resolutions.filter((resolution) => resolution.origin === origin);

  const aggregates = EVALUATION_HORIZONS.map((horizon) => {
    const rows = scoped.filter((resolution) => resolution.horizonMinutes === horizon);
    const samples = rows.length;
    const wins = rows.filter((row) => row.directionalHit).length;
    const directionalAccuracyPercent = samples > 0 ? (wins / samples) * 100 : 0;
    const magnitudeClosenessPercent = meanOf(rows.map((row) => row.magnitudeClosenessPercent));
    const brierScore = meanOf(rows.map((row) => row.brierContribution));
    const accuracyPercent =
      samples > 0
        ? ACCURACY_DIRECTION_WEIGHT * directionalAccuracyPercent +
          ACCURACY_MAGNITUDE_WEIGHT * magnitudeClosenessPercent
        : 0;
    const confidenceWeight = samples / (samples + CONFIDENCE_K);
    const lastResolved = rows.reduce<number | null>(
      (acc, row) => (acc === null || row.resolvedAtExchangeMs > acc ? row.resolvedAtExchangeMs : acc),
      null
    );

    return {
      horizonMinutes: horizon,
      samples,
      wins,
      directionalAccuracyPercent: round(directionalAccuracyPercent, 2),
      daLowerBoundPercent: round(wilsonLowerBound(wins, samples), 2),
      magnitudeClosenessPercent: round(magnitudeClosenessPercent, 2),
      accuracyPercent: round(accuracyPercent, 2),
      brierScore: round(brierScore, 4),
      confidenceWeight: round(confidenceWeight, 4),
      rankedScore: round(confidenceWeight * accuracyPercent, 2),
      rank: 0,
      isProvisional: samples >= MIN_SAMPLES_PROVISIONAL,
      isGraduated: samples >= GRADUATION_SAMPLES,
      lastResolvedAtMs: lastResolved,
    } satisfies HorizonAggregate;
  });

  const ranked = [...aggregates].sort((a, b) => b.rankedScore - a.rankedScore);
  ranked.forEach((aggregate, index) => {
    aggregate.rank = index + 1;
  });

  return aggregates;
}

/**
 * Kraken paper-mode graduation. Only actually traded directions count — neutral
 * calls are "no trade" and never pad the sample size.
 */
export function buildPaperGraduation(resolutions: readonly HorizonResolution[]): PaperGraduation {
  const trades = resolutions.filter(
    (resolution) => resolution.origin === 'LIVE' && resolution.predictedDirection !== 0
  );
  const samples = trades.length;
  const wins = trades.filter((trade) => trade.directionalHit).length;
  const grossProfit = trades
    .filter((trade) => trade.paperPnlPercent > 0)
    .reduce((acc, trade) => acc + trade.paperPnlPercent, 0);
  const grossLoss = trades
    .filter((trade) => trade.paperPnlPercent < 0)
    .reduce((acc, trade) => acc + Math.abs(trade.paperPnlPercent), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = samples > 0 ? wins / samples : 0;

  return {
    samples,
    requiredSamples: GRADUATION_SAMPLES,
    winRate: round(winRate * 100, 2),
    winRateTarget: GRADUATION_WIN_RATE * 100,
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 2) : 99.99,
    profitFactorTarget: GRADUATION_PROFIT_FACTOR,
    isGraduated:
      samples >= GRADUATION_SAMPLES &&
      winRate >= GRADUATION_WIN_RATE &&
      profitFactor >= GRADUATION_PROFIT_FACTOR,
  };
}

/** German verdict banner — conservative by construction. */
export function buildVerdict(
  aggregates: readonly HorizonAggregate[],
  liveResolutions: number,
  pendingHorizons: number
): Verdict {
  const best = [...aggregates].sort((a, b) => b.rankedScore - a.rankedScore)[0] ?? null;

  if (!best || best.samples === 0 || liveResolutions === 0) {
    return {
      code: 'E2000',
      severity: 'info',
      headline: 'DATENBASIS ZU DÜNN — NOCH KEIN HORIZONT AUFGELÖST',
      detail:
        pendingHorizons > 0
          ? `${pendingHorizons} Horizont-Slots warten auf ihre Zielzeit. Eine Empfehlung ist erst ab N ≥ ${MIN_SAMPLES_PROVISIONAL} aufgelösten Stichproben zulässig.`
          : 'Es existieren keine offenen Slots — die Prognose-Ledger ist leer.',
      horizon: null,
    };
  }

  if (best.samples < MIN_SAMPLES_PROVISIONAL) {
    return {
      code: 'E2000',
      severity: 'warn',
      headline: `PROVISORISCH: HORIZONT ${best.horizonMinutes} MIN (N = ${best.samples})`,
      detail: `Gewichtete Genauigkeit ${best.rankedScore.toFixed(1)}% bei nur ${best.samples} Stichprobe(n). Mindestbasis N ≥ ${MIN_SAMPLES_PROVISIONAL} noch nicht erreicht (Shrinkage k = ${CONFIDENCE_K}).`,
      horizon: best.horizonMinutes,
    };
  }

  if (best.rankedScore < MIN_TRADEABLE_RANK_SCORE) {
    return {
      code: 'E2100',
      severity: 'warn',
      headline: 'KEIN HANDELBARER HORIZONT — GEWICHTETE GENAUIGKEIT UNTER SCHWELLE',
      detail: `Bester Horizont ${best.horizonMinutes} min erreicht nur ${best.rankedScore.toFixed(1)}% (Schwelle ${MIN_TRADEABLE_RANK_SCORE}%). Trefferquote ${best.directionalAccuracyPercent.toFixed(1)}% · N = ${best.samples}. Keine Handelsfreigabe.`,
      horizon: best.horizonMinutes,
    };
  }

  return {
    code: null,
    severity: 'success',
    headline: `HORIZONT ${best.horizonMinutes} MIN IST DER ZUVERLÄSSIGSTE`,
    detail: `Gewichtete Genauigkeit ${best.rankedScore.toFixed(1)}% · Richtungstreffer ${best.directionalAccuracyPercent.toFixed(1)}% (Wilson-Untergrenze ${best.daLowerBoundPercent.toFixed(1)}%) · Kursnähe ${best.magnitudeClosenessPercent.toFixed(1)}% · N = ${best.samples} · Gewicht ${(best.confidenceWeight * 100).toFixed(1)}%.`,
    horizon: best.horizonMinutes,
  };
}

/** Builds the full summary consumed by the Rouge presentation layer. */
export function summariseHorizons(
  resolutions: readonly HorizonResolution[],
  pendingHorizons: number,
  calibration: CalibrationState,
  origin: SnapshotOrigin = 'LIVE'
): AccuracySummary {
  const aggregates = buildAggregates(resolutions, origin);
  const scoped = resolutions.filter((resolution) => resolution.origin === origin);
  const best = [...aggregates].sort((a, b) => b.rankedScore - a.rankedScore)[0] ?? null;
  const rollingBrier = meanOf(scoped.map((resolution) => resolution.brierContribution));

  return {
    horizons: aggregates,
    best: best && best.samples > 0 ? best : null,
    liveResolutions: scoped.length,
    pendingHorizons,
    rollingBrier: round(rollingBrier, 4),
    graduation: buildPaperGraduation(resolutions),
    verdict: buildVerdict(aggregates, scoped.length, pendingHorizons),
    calibration,
  };
}

export const REGIME_LABELS: Record<MarketRegime, string> = {
  STRONG_BULL: 'Starker Aufwärtstrend',
  WEAK_BULL: 'Schwacher Aufwärtstrend',
  STRONG_BEAR: 'Starker Abwärtstrend',
  WEAK_BEAR: 'Schwacher Abwärtstrend',
  RANGING_CHOP: 'Seitwärts / Chop',
  HIGH_VOL_CRISIS: 'Hochvolatilitäts-Krise',
};

export const REGIME_TONE: Record<MarketRegime, string> = {
  STRONG_BULL: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  WEAK_BULL: 'text-emerald-200 border-emerald-500/30 bg-emerald-500/5',
  STRONG_BEAR: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  WEAK_BEAR: 'text-rose-200 border-rose-500/30 bg-rose-500/5',
  RANGING_CHOP: 'text-amber-200 border-amber-500/30 bg-amber-500/10',
  HIGH_VOL_CRISIS: 'text-fuchsia-200 border-fuchsia-500/40 bg-fuchsia-500/10',
};
