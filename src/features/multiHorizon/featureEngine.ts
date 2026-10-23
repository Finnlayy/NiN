/**
 * [Blanche] — Data & Feature Normalisation.
 *
 * Paragraph 2 features are **bar-based**, not tick-based: RSI(14) must cover
 * 14 minutes, EMA50/200 must cover 50/200 minutes, the ATR(14) percentile
 * needs 100 bars and the Hurst exponent needs ≥ 40 return samples. Computing
 * those over raw 4 s ticks would leave every oscillator in pure microstructure
 * noise, so incoming ticks are first resampled into 1-minute closes.
 *
 * Everything here is pure and deterministic: identical bars and identical
 * calibration parameters always produce the identical component state, which
 * is a precondition for the point-in-time ledger.
 */

import {
  EVALUATION_HORIZONS,
  type CalibrationState,
  type FeatureSnapshot,
  type HorizonMinutes,
  type MarketRegime,
  type ThreeComponentState,
} from './types';
import {
  MAX_SIGMA_PER_MINUTE_PERCENT,
  MIN_SIGMA_PER_MINUTE_PERCENT,
  REFERENCE_SIGMA_PER_MINUTE_PERCENT,
  TARGET_DISPLACEMENT_PERSISTENCE_GAIN,
  TARGET_DISPLACEMENT_SIGMA,
} from './config';

export interface PriceTick {
  /** Exchange-clock milliseconds (never local wall clock). */
  tsMs: number;
  price: number;
}

export interface Bar {
  /** Exchange-clock milliseconds at the start of the bar. */
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FeatureFrame {
  snapshot: FeatureSnapshot;
  emaDeltaPercent: number;
  atrPercentile: number;
  hurstExponent: number;
  tickCount: number;
  barCount: number;
}

/** Resampling interval for the bar series (1 minute, as per the spec). */
export const BAR_INTERVAL_MS = 60_000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((acc, v) => acc + v, 0) / values.length;

const stdev = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
};

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-clamp(x, -30, 30)));

const logit = (p: number): number => {
  const safe = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(safe / (1 - safe));
};

/* ------------------------------------------------------------------ */
/* Resampling                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resamples irregular ticks into fixed-interval bars (close = last tick of the
 * bucket, high/low from the bucket). Deterministic and order-independent for
 * the same tick set.
 */
export function resampleToBars(
  ticks: readonly PriceTick[],
  intervalMs: number = BAR_INTERVAL_MS
): Bar[] {
  const usable = ticks.filter(
    (tick) => Number.isFinite(tick.tsMs) && Number.isFinite(tick.price) && tick.price > 0
  );
  if (usable.length === 0) return [];
  const buckets = new Map<number, { open: number; high: number; low: number; close: number }>();
  for (const tick of usable) {
    const bucketTs = Math.floor(tick.tsMs / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketTs);
    if (!bucket) {
      buckets.set(bucketTs, {
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      });
    } else {
      bucket.high = Math.max(bucket.high, tick.price);
      bucket.low = Math.min(bucket.low, tick.price);
      bucket.close = tick.price;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tsMs, bucket]) => ({ tsMs, ...bucket }));
}

/* ------------------------------------------------------------------ */
/* Indicators (bar-based)                                             */
/* ------------------------------------------------------------------ */

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * samples and then iterated — the standard formulation.
 *
 * Seeding with the first value instead would bias a 200-period EMA towards the
 * oldest sample and turn the EMA50/200 delta into a heavily lagged momentum
 * proxy (on a fast cycle it even flips sign). While the window is not warm the
 * simple mean is returned, which carries no lag and no phantom trend.
 */
export function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return mean(values);
  const alpha = 2 / (period + 1);
  let acc = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    acc = values[i] * alpha + acc * (1 - alpha);
  }
  return acc;
}

/** Wilder RSI over bar closes. Returns 50 while the window is incomplete. */
export function rsi(closes: readonly number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * ATR(14) as a percentage of the last close. Uses the true range when bar
 * high/low data is available, otherwise |close-to-close|.
 */
export function atrPercent(bars: readonly Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const window = bars.slice(-(period + 1));
  const ranges: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const bar = window[i];
    const previousClose = window[i - 1].close;
    const hasRange = bar.high > 0 && bar.low > 0 && bar.high >= bar.low;
    const trueRange = hasRange
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(previousClose - bar.low))
      : Math.abs(bar.close - previousClose);
    ranges.push(trueRange);
  }
  const last = bars[bars.length - 1].close;
  if (last <= 0) return 0;
  return (mean(ranges) / last) * 100;
}

/** Bollinger width (%) and the position of the close inside the bands. */
export function bollinger(
  closes: readonly number[],
  period = 20
): { widthPercent: number; position: number } {
  if (closes.length < 3) return { widthPercent: 0, position: 0.5 };
  const window = closes.slice(-period);
  const mu = mean(window);
  const sigma = stdev(window);
  if (mu <= 0) return { widthPercent: 0, position: 0.5 };
  const upper = mu + 2 * sigma;
  const lower = mu - 2 * sigma;
  const spread = upper - lower;
  return {
    widthPercent: (spread / mu) * 100,
    position: spread <= 0 ? 0.5 : clamp((window[window.length - 1] - lower) / spread, 0, 1),
  };
}

/**
 * CISD — Change-In-State-Direction: displacement of the latest close against
 * its anchor, scaled by the observed ATR over the same span and by the square
 * root of the span (random-walk expectation). Bounded to ±1.
 */
export function cisd(bars: readonly Bar[], lookback = 12): number {
  if (bars.length < 4) return 0;
  const span = Math.min(lookback, bars.length - 1);
  const anchor = bars[bars.length - 1 - span].close;
  const last = bars[bars.length - 1].close;
  if (!(anchor > 0)) return 0;
  const atr = atrPercent(bars) / 100;
  if (atr <= 0) return 0;
  const displacement = (last - anchor) / anchor;
  return clamp(displacement / (atr * Math.sqrt(span)), -1, 1);
}

/** Percentile rank (0..1) of the newest value within the provided history. */
export function percentileRank(history: readonly number[], value: number): number {
  if (history.length === 0) return 0.5;
  let below = 0;
  for (const sample of history) {
    if (sample < value) below += 1;
  }
  return below / history.length;
}

/**
 * Hurst exponent via the rescaled-range (R/S) method over logarithmic returns.
 * H < 0.45 → mean reverting, 0.45–0.55 → random walk, H > 0.55 → persistent.
 */
export function estimateHurst(returns: readonly number[]): number {
  if (returns.length < 40) return 0.5;
  const sizes = [8, 12, 16, 24, 32].filter((size) => size * 2 <= returns.length);
  if (sizes.length < 2) return 0.5;

  const points: Array<{ x: number; y: number }> = [];
  for (const size of sizes) {
    const chunks: number[] = [];
    for (let start = 0; start + size <= returns.length; start += size) {
      const chunk = returns.slice(start, start + size);
      const mu = mean(chunk);
      let cumulative = 0;
      let max = -Infinity;
      let min = Infinity;
      for (const value of chunk) {
        cumulative += value - mu;
        max = Math.max(max, cumulative);
        min = Math.min(min, cumulative);
      }
      const spread = stdev(chunk);
      if (spread > 0) chunks.push((max - min) / spread);
    }
    if (chunks.length === 0) continue;
    const rs = mean(chunks);
    if (rs > 0) points.push({ x: Math.log(size), y: Math.log(rs) });
  }
  if (points.length < 2) return 0.5;

  const xMean = mean(points.map((p) => p.x));
  const yMean = mean(points.map((p) => p.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - xMean) * (point.y - yMean);
    denominator += (point.x - xMean) ** 2;
  }
  if (denominator === 0) return 0.5;
  return clamp(numerator / denominator, 0, 1);
}

/**
 * Realised volatility in percent of price **per minute**, from bar closes.
 * Interval scaling is applied explicitly so the value is comparable across
 * sampling cadences (1-minute bars → no scaling, but the guard stays).
 */
export function realisedVolPerMinutePercent(bars: readonly Bar[]): number {
  if (bars.length < 6) return REFERENCE_SIGMA_PER_MINUTE_PERCENT;
  const returns: number[] = [];
  const deltas: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const dt = bars[i].tsMs - bars[i - 1].tsMs;
    if (dt <= 0 || bars[i - 1].close <= 0 || bars[i].close <= 0) continue;
    deltas.push(dt);
    returns.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  if (returns.length < 5) return REFERENCE_SIGMA_PER_MINUTE_PERCENT;
  const dtMinutes = Math.max(mean(deltas) / 60_000, 1 / 60);
  const sigmaStep = stdev(returns) * 100;
  const sigmaPerMinute = sigmaStep / Math.sqrt(dtMinutes);
  if (!Number.isFinite(sigmaPerMinute) || sigmaPerMinute <= 0) {
    return REFERENCE_SIGMA_PER_MINUTE_PERCENT;
  }
  return clamp(sigmaPerMinute, MIN_SIGMA_PER_MINUTE_PERCENT, MAX_SIGMA_PER_MINUTE_PERCENT);
}

/* ------------------------------------------------------------------ */
/* Frame assembly                                                     */
/* ------------------------------------------------------------------ */

/**
 * Derives a tick stream from venue bars. Used as the reference-price fallback
 * when the live spot route is unreachable: the closes are real exchange prices,
 * merely sampled at bar resolution, so no value is invented.
 */
export function ticksFromBars(bars: readonly Bar[], limit = 400): PriceTick[] {
  const window = bars.slice(-limit);
  return window.map((bar) => ({
    // A bar's close is the last observed price of that minute.
    tsMs: bar.tsMs + BAR_INTERVAL_MS,
    price: bar.close,
  }));
}

/** Builds the normalised feature frame from a tick history (bar-based). */
export function buildFeatureFrame(ticks: readonly PriceTick[]): FeatureFrame | null {
  const bars = resampleToBars(ticks);
  return buildFeatureFrameFromBars(bars, ticks.length);
}

export function buildFeatureFrameFromBars(
  bars: readonly Bar[],
  tickCount: number
): FeatureFrame | null {
  if (bars.length < 3) return null;

  const closes = bars.map((bar) => bar.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const currentAtr = atrPercent(bars);

  // ATR(14)/Close percentile over the last 100 bars (rolling, no look-ahead).
  const atrHistory: number[] = [];
  const historyWindow = Math.min(100, bars.length - 1);
  for (let end = bars.length - historyWindow; end < bars.length; end += 1) {
    atrHistory.push(atrPercent(bars.slice(0, end + 1)));
  }

  const fastWindow = closes.slice(-50);
  const slowWindow = closes.slice(-200);
  const emaFast = ema(fastWindow, 50);
  const emaSlow = ema(slowWindow, 200);
  const emaDeltaPercent = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 100 : 0;

  const bands = bollinger(closes);

  return {
    snapshot: {
      price: closes[closes.length - 1],
      rsi14: rsi(closes),
      atrPercent: currentAtr,
      cisd: cisd(bars),
      bbWidthPercent: bands.widthPercent,
      bbPosition: bands.position,
      sigmaPerMinutePercent: realisedVolPerMinutePercent(bars),
      sampleCount: bars.length,
    },
    emaDeltaPercent,
    atrPercentile: percentileRank(atrHistory, currentAtr),
    hurstExponent: estimateHurst(returns),
    tickCount,
    barCount: bars.length,
  };
}

/** Maps the regime descriptors onto the 6-state machine. */
export function classifyRegime(
  emaDeltaPercent: number,
  atrPercentile: number,
  hurstExponent: number
): MarketRegime {
  if (atrPercentile >= 0.95) return 'HIGH_VOL_CRISIS';
  if (atrPercentile >= 0.9 && hurstExponent < 0.45) return 'HIGH_VOL_CRISIS';
  const flatTrend = Math.abs(emaDeltaPercent) < 0.05;
  const meanRevertingChop =
    hurstExponent < 0.45 && hurstExponent >= 0.0 && Math.abs(emaDeltaPercent) < 0.25;
  if (flatTrend || meanRevertingChop) return 'RANGING_CHOP';
  if (emaDeltaPercent >= 0.35) return 'STRONG_BULL';
  if (emaDeltaPercent > 0) return 'WEAK_BULL';
  if (emaDeltaPercent <= -0.35) return 'STRONG_BEAR';
  return 'WEAK_BEAR';
}

const regimeDirection = (regime: MarketRegime): -1 | 0 | 1 => {
  if (regime === 'STRONG_BULL' || regime === 'WEAK_BULL') return 1;
  if (regime === 'STRONG_BEAR' || regime === 'WEAK_BEAR') return -1;
  return 0;
};

/**
 * Full Paragraph 2 component computation.
 *
 * Head design (deliberate): trend and momentum carry the sign; the Bollinger
 * position only acts as a mean-reversion term inside RANGING_CHOP. An earlier
 * symmetric mix let the BB term fight the trend and made the composite (and
 * therefore the whole accuracy ledger) systematically anti-correlated.
 *
 * Calibration (`T`, `bias`) comes from the self-optimising store; the raw head
 * logits are temperature-scaled exactly like the ONNX post-processing step:
 *   y_cal = sigmoid(logit(y_hat) / T + bias)
 */
export function buildThreeComponentState(
  frame: FeatureFrame,
  calibration: CalibrationState
): ThreeComponentState {
  const features = frame.snapshot;
  const regime = classifyRegime(frame.emaDeltaPercent, frame.atrPercentile, frame.hurstExponent);

  // Feature normalisation. Per the Paragraph 2 spec the ONNX head consumes
  // RSI / ATR / CISD / BB; the EMA50/200 delta belongs to the JEV gate below.
  // An earlier revision also fed the EMA gap into the head with a dominant
  // weight — walk-forward measurement showed that the 50/200 gap is a
  // phase-lagged regime descriptor (IC ≈ −0.28 on a 300-bar cycle) and it
  // dragged the composite negative. Momentum carries the sign here.
  const zCisd = clamp(features.cisd, -1.5, 1.5);
  const zRsi = clamp((features.rsi14 - 50) / 25, -1.5, 1.5);
  const zBbPosition = clamp((features.bbPosition - 0.5) * 2, -2, 2);
  const zVol = clamp(features.sigmaPerMinutePercent / REFERENCE_SIGMA_PER_MINUTE_PERCENT, 0, 3);

  // Bollinger only mean-reverts where the state machine declares chop.
  const chopFactor = regime === 'RANGING_CHOP' ? 1 : regime === 'HIGH_VOL_CRISIS' ? 0.5 : 0.15;
  // On exhaustion extremes (RSI > 78 / < 22) fade into the band instead of
  // chasing the move.
  const exhaustion = clamp((Math.abs(zRsi) - 1.1) / 0.4, 0, 1) * -Math.sign(zRsi) * 0.35;
  const meanReversionTerm = -0.5 * zBbPosition * chopFactor;
  const volatilityPenalty = -0.12 * (zVol - 1);

  const rawLogit =
    1.0 * zCisd + 0.5 * zRsi + meanReversionTerm + exhaustion + volatilityPenalty + 0.02;
  const onnxRawYHat = sigmoid(rawLogit);
  const temperatureT = clamp(calibration.temperatureT, 0.5, 3);
  const bias = clamp(calibration.bias, -1.5, 1.5);
  const onnxCalibratedY = sigmoid(logit(onnxRawYHat) / temperatureT + bias);

  const trendStrength = clamp(Math.abs(frame.emaDeltaPercent) / 0.6, 0, 1);
  const persistence =
    regimeDirection(regime) === 0
      ? clamp((0.55 - frame.hurstExponent) / 0.2, 0, 1)
      : clamp((frame.hurstExponent - 0.5) / 0.25, 0, 1);

  let jevGateConfidence =
    0.35 + 0.35 * trendStrength + 0.2 * persistence + 0.1 * (1 - clamp(frame.atrPercentile, 0, 1));
  if (regime === 'RANGING_CHOP') jevGateConfidence *= 0.75;
  if (regime === 'HIGH_VOL_CRISIS') jevGateConfidence *= 0.5;
  if (features.sampleCount < 60) jevGateConfidence *= 0.9;
  jevGateConfidence = clamp(jevGateConfidence, 0.05, 0.98);

  const onnxSigned = (onnxCalibratedY - 0.5) * 2;
  const gateSigned = regimeDirection(regime) * jevGateConfidence;
  const aligned = gateSigned === 0 || Math.sign(onnxSigned) === Math.sign(gateSigned);
  // Counter-regime calls are damped, never silently flipped: the gate is a
  // risk veto on conviction, not a second directional forecast.
  const conflictDamping = aligned ? 1 : 0.5;

  const krakenPaperSignal = clamp(
    (0.7 * onnxSigned + 0.3 * gateSigned) * conflictDamping,
    -1,
    1
  );
  const paperSizingImpulse = clamp(
    Math.abs(krakenPaperSignal) * (0.4 + 0.6 * jevGateConfidence),
    0,
    1
  );

  const compositeScore = clamp(
    0.65 * onnxSigned + 0.2 * gateSigned + 0.15 * krakenPaperSignal,
    -1,
    1
  );

  const predictedDirection: -1 | 0 | 1 =
    compositeScore > 0.02 ? 1 : compositeScore < -0.02 ? -1 : 0;

  // Interval-corrected per-minute volatility → per-horizon sigma. The target
  // displacement scales with measured persistence: a persistent trend carries
  // further than a random walk, so the same conviction implies a larger move.
  // Walk-forward: κ ≈ 2.8–8 on trending series vs ≈ 0 on a random walk.
  const sigmaPerMinute = features.sigmaPerMinutePercent / 100;
  const kappa =
    TARGET_DISPLACEMENT_SIGMA + TARGET_DISPLACEMENT_PERSISTENCE_GAIN * persistence;
  const impliedTargetPrices = {} as Record<HorizonMinutes, number>;
  for (const horizon of EVALUATION_HORIZONS) {
    const sigmaHorizon = sigmaPerMinute * Math.sqrt(horizon);
    impliedTargetPrices[horizon] = Number(
      (features.price * (1 + compositeScore * kappa * sigmaHorizon)).toFixed(2)
    );
  }

  return {
    onnxRawYHat,
    onnxCalibratedY,
    temperatureT,
    bias,
    jevGateConfidence,
    regime,
    hurstExponent: frame.hurstExponent,
    atrPercentile: frame.atrPercentile,
    emaDeltaPercent: frame.emaDeltaPercent,
    krakenPaperSignal,
    paperSizingImpulse,
    compositeScore,
    predictedDirection,
    impliedTargetPrices,
    features,
  };
}
