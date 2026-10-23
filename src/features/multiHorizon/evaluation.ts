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
  GRADUATION_SAMPLES_STRICT,
  MC_TOLERANCE_SIGMA,
  GRADUATION_PROFIT_FACTOR,
  GRADUATION_SAMPLES,
  GRADUATION_WIN_RATE,
  MAX_SIGMA_PER_MINUTE_PERCENT,
  MIN_SAMPLES_PROVISIONAL,
  MIN_SIGMA_PER_MINUTE_PERCENT,
  MIN_TRADEABLE_RANK_SCORE,
  REFERENCE_SIGMA_PER_MINUTE_PERCENT,
  NEUTRAL_BAND_FLOOR_PERCENT,
  NEUTRAL_BAND_SIGMA,
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
 * Volatility of one horizon in percent, derived from the snapshot's own
 * interval-corrected realised volatility — never from future data. It sets the
 * tolerance band for the magnitude score.
 */
export function horizonSigmaPercent(snapshot: Paragraph2Snapshot, horizon: HorizonMinutes): number {
  const raw = snapshot.components.features.sigmaPerMinutePercent;
  const sigmaPerMinute = Number.isFinite(raw)
    ? clamp(raw, MIN_SIGMA_PER_MINUTE_PERCENT, MAX_SIGMA_PER_MINUTE_PERCENT)
    : REFERENCE_SIGMA_PER_MINUTE_PERCENT;
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
  // Volatility-scaled neutral band: a move only counts as directional when it
  // exceeds a fraction of the horizon's own sigma.
  const neutralBandPercent = Math.max(
    NEUTRAL_BAND_FLOOR_PERCENT,
    NEUTRAL_BAND_SIGMA * horizonSigmaPercent(snapshot, horizon)
  );
  const actualDirection: -1 | 0 | 1 =
    returnPercent > neutralBandPercent
      ? 1
      : returnPercent < -neutralBandPercent
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

  const tolerancePercent = Math.max(0.05, MC_TOLERANCE_SIGMA * horizonSigmaPercent(snapshot, horizon));
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

  // Snapshot spacing (minutes) per origin — the basis for the overlap
  // correction. Derived from the resolutions themselves so no configuration
  // can quietly claim independence the data does not have.
  const snapshotTimes = new Map<string, number>();
  for (const resolution of scoped) {
    if (!snapshotTimes.has(resolution.snapshotId)) {
      snapshotTimes.set(
        resolution.snapshotId,
        resolution.targetTimestampMs - HORIZON_MS(resolution.horizonMinutes)
      );
    }
  }
  const orderedTimes = [...snapshotTimes.values()].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < orderedTimes.length; i += 1) {
    const gap = (orderedTimes[i] - orderedTimes[i - 1]) / 60_000;
    if (gap > 0) gaps.push(gap);
  }
  const medianGapMinutes = gaps.length > 0 ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 1;

  const aggregates = EVALUATION_HORIZONS.map((horizon) => {
    const rows = scoped.filter((resolution) => resolution.horizonMinutes === horizon);
    const samples = rows.length;
    // Selective-prediction scoring: the hit rate is measured against the moves
    // that actually happened. Scoring abstentions against a flat market would
    // reward reckless calls (a fixed deadband caps a zero-skill model at ~41 %
    // DA and pushes it to call every tick), so neutral outcomes are removed
    // from the denominator and reported separately as coverage/flat share.
    const decisive = rows.filter((row) => row.actualDirection !== 0);
    const decisiveSamples = decisive.length;
    const wins = decisive.filter((row) => row.directionalHit).length;
    const directionalAccuracyPercent = decisiveSamples > 0 ? (wins / decisiveSamples) * 100 : 0;
    const magnitudeClosenessPercent = meanOf(rows.map((row) => row.magnitudeClosenessPercent));
    const brierScore = meanOf(rows.map((row) => row.brierContribution));
    const accuracyPercent =
      decisiveSamples > 0
        ? ACCURACY_DIRECTION_WEIGHT * directionalAccuracyPercent +
          ACCURACY_MAGNITUDE_WEIGHT * magnitudeClosenessPercent
        : 0;
    const neutralShare = samples > 0 ? (samples - decisiveSamples) / samples : 0;
    const coveragePercent = samples > 0 ? (decisiveSamples / samples) * 100 : 0;
    // Overlap correction: consecutive snapshots share horizon/stride of the
    // same price path, so N_eff = N · min(1, stride / horizon).
    const independence = Math.min(1, medianGapMinutes / horizon);
    const effectiveSamples = Math.max(0, samples * independence);
    const confidenceWeight = effectiveSamples / (effectiveSamples + CONFIDENCE_K);
    const lastResolved = rows.reduce<number | null>(
      (acc, row) => (acc === null || row.resolvedAtExchangeMs > acc ? row.resolvedAtExchangeMs : acc),
      null
    );

    // Chronological split-half validation: the edge must survive out of
    // sample, so both halves have to beat a coin flip independently.
    const chronological = [...rows].sort((a, b) => a.resolvedAtExchangeMs - b.resolvedAtExchangeMs);
    const half = Math.floor(chronological.length / 2);
    const halves = [chronological.slice(0, half), chronological.slice(half)];
    const isOutOfSampleConsistent =
      halves.every((part) => {
        const decisivePart = part.filter((row) => row.actualDirection !== 0);
        if (decisivePart.length < 10) return false;
        const partWins = decisivePart.filter((row) => row.directionalHit).length;
        const partIndependence = Math.min(1, independence);
        return (
          wilsonLowerBound(partWins * partIndependence, decisivePart.length * partIndependence) > 50
        );
      });

    return {
      horizonMinutes: horizon,
      samples,
      effectiveSamples: round(effectiveSamples, 2),
      isOutOfSampleConsistent,
      wins,
      directionalAccuracyPercent: round(directionalAccuracyPercent, 2),
      // The confidence bound must use the *overlap-corrected* count, otherwise
      // 1 000 overlapping 5-minute slots masquerade as 1 000 independent bets.
      daLowerBoundPercent: round(
        wilsonLowerBound(wins * independence, decisiveSamples * independence),
        2
      ),
      magnitudeClosenessPercent: round(magnitudeClosenessPercent, 2),
      accuracyPercent: round(accuracyPercent, 2),
      brierScore: round(brierScore, 4),
      neutralShare: round(neutralShare, 4),
      coveragePercent: round(coveragePercent, 2),
      confidenceWeight: round(confidenceWeight, 4),
      rankedScore: round(confidenceWeight * accuracyPercent, 2),
      rank: 0,
      isProvisional: effectiveSamples >= MIN_SAMPLES_PROVISIONAL,
      isGraduated: effectiveSamples >= GRADUATION_SAMPLES,
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
    isGraduatedStrict:
      samples >= GRADUATION_SAMPLES_STRICT &&
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
          ? `${pendingHorizons} Horizont-Slot(s) sind offen (Zielzeit noch nicht erreicht oder ohne beobachteten Zielpreis). Eine Empfehlung ist erst ab N_eff ≥ ${MIN_SAMPLES_PROVISIONAL} zulässig.`
          : 'Es existieren keine offenen Slots — die Prognose-Ledger ist leer.',
      horizon: null,
    };
  }

  if (best.effectiveSamples < MIN_SAMPLES_PROVISIONAL) {
    return {
      code: 'E2000',
      severity: 'warn',
      headline: `PROVISORISCH: HORIZONT ${best.horizonMinutes} MIN (N_eff = ${best.effectiveSamples.toFixed(1)})`,
      detail: `${best.samples} aufgelöste Slots, aber überlappende Fenster reduzieren die unabhängige Basis auf N_eff = ${best.effectiveSamples.toFixed(1)} (Minimum ${MIN_SAMPLES_PROVISIONAL}, Shrinkage k = ${CONFIDENCE_K}).`,
      horizon: best.horizonMinutes,
    };
  }

  // Statistical gate: the Wilson 95 % lower bound must clear 50 %, i.e. the
  // edge must be distinguishable from a coin flip at the achieved sample size.
  if (best.daLowerBoundPercent < 50) {
    return {
      code: 'E2100',
      severity: 'warn',
      headline: `NICHT SIGNIFIKANT: HORIZONT ${best.horizonMinutes} MIN`,
      detail: `Richtungstreffer ${best.directionalAccuracyPercent.toFixed(1)}%, aber die Wilson-Untergrenze liegt bei ${best.daLowerBoundPercent.toFixed(1)}% (< 50%) — kein statistischer Beleg für einen Vorteil (N_eff = ${best.effectiveSamples.toFixed(1)}).`,
      horizon: best.horizonMinutes,
    };
  }

  if (!best.isOutOfSampleConsistent) {
    return {
      code: 'E2100',
      severity: 'warn',
      headline: `NICHT OUT-OF-SAMPLE BESTÄTIGT: HORIZONT ${best.horizonMinutes} MIN`,
      detail: `Der Vorteil (Richtungstreffer ${best.directionalAccuracyPercent.toFixed(1)}%) hält der chronologischen Halbierungsprüfung nicht stand — mindestens eine Hälfte der Historie liegt statistisch nicht über 50%. Keine Handelsfreigabe.`,
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
    detail: `Gewichtete Genauigkeit ${best.rankedScore.toFixed(1)}% · Richtungstreffer ${best.directionalAccuracyPercent.toFixed(1)}% (Wilson-Untergrenze ${best.daLowerBoundPercent.toFixed(1)}%) · Kursnähe ${best.magnitudeClosenessPercent.toFixed(1)}% · N = ${best.samples} (${best.coveragePercent.toFixed(0)}% mit Bewegung) · Gewicht ${(best.confidenceWeight * 100).toFixed(1)}%.`,
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
