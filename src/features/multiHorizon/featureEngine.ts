/**
 * [Blanche] — Data & Feature Normalisation.
 *
 * Ingests live BTC ticks, normalises them into the four Paragraph 2 features
 * (RSI / ATR / CISD / Bollinger) and derives the regime descriptors used by
 * the JEV System-1 gate.
 *
 * Everything here is pure and deterministic: identical ticks and identical
 * calibration parameters always produce the identical component state, which
 * is a precondition for the point-in-time ledger.
 */

import { EVALUATION_HORIZONS, type FeatureSnapshot, type HorizonMinutes, type MarketRegime, type ThreeComponentState } from './types';
import type { CalibrationState } from './types';

export interface PriceTick {
  /** Exchange-clock milliseconds (never local wall clock). */
  tsMs: number;
  price: number;
}

export interface FeatureFrame {
  snapshot: FeatureSnapshot;
  emaDeltaPercent: number;
  atrPercentile: number;
  hurstExponent: number;
  tickCount: number;
}

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

/** Exponential moving average over the tick series (seed = first value). */
export function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let acc = values[0];
  for (let i = 1; i < values.length; i += 1) {
    acc = values[i] * alpha + acc * (1 - alpha);
  }
  return acc;
}

/** Wilder RSI over closes. Returns 50 when the sample is too small. */
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
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average absolute tick-to-tick change in percent of price (ATR proxy). */
export function atrPercent(closes: readonly number[], period = 14): number {
  if (closes.length < 2) return 0;
  const window = closes.slice(-(period + 1));
  const ranges: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    ranges.push(Math.abs(window[i] - window[i - 1]));
  }
  const last = closes[closes.length - 1];
  if (last <= 0) return 0;
  return (mean(ranges) / last) * 100;
}

/** Bollinger width (%) and the position of price inside the bands (0..1). */
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
 * CISD — Change-In-State-Direction: displacement of the current price against
 * its recent anchor, scaled by the observed tick volatility. Bounded to -1..1
 * so it can be compared across volatility regimes.
 */
export function cisd(closes: readonly number[], lookback = 12): number {
  if (closes.length < 4) return 0;
  const span = Math.min(lookback, closes.length - 1);
  const anchor = closes[closes.length - 1 - span];
  const last = closes[closes.length - 1];
  if (!(anchor > 0)) return 0;
  const atr = atrPercent(closes) / 100;
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

/** Builds the normalised feature frame from a tick history. */
export function buildFeatureFrame(ticks: readonly PriceTick[]): FeatureFrame | null {
  const usable = ticks.filter((tick) => Number.isFinite(tick.price) && tick.price > 0);
  if (usable.length < 4) return null;

  const closes = usable.map((tick) => tick.price);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  // Rolling ATR history for the volatility percentile (100-bar lookback).
  const atrHistory: number[] = [];
  const historyWindow = Math.min(100, closes.length - 1);
  for (let end = closes.length - historyWindow; end < closes.length; end += 1) {
    atrHistory.push(atrPercent(closes.slice(0, end + 1)));
  }
  const currentAtr = atrPercent(closes);

  const emaFast = ema(closes.slice(-50), 50);
  const emaSlow = ema(closes.slice(-200), 200);
  const emaDeltaPercent = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 100 : 0;

  const bands = bollinger(closes);

  return {
    snapshot: {
      price: closes[closes.length - 1],
      rsi14: rsi(closes),
      atrPercent: currentAtr,
      cisd: cisd(closes),
      bbWidthPercent: bands.widthPercent,
      bbPosition: bands.position,
      sampleCount: closes.length,
    },
    emaDeltaPercent,
    atrPercentile: percentileRank(atrHistory, currentAtr),
    hurstExponent: estimateHurst(returns),
    tickCount: closes.length,
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
  if (Math.abs(emaDeltaPercent) < 0.05 || (hurstExponent >= 0.45 && hurstExponent <= 0.55 && Math.abs(emaDeltaPercent) < 0.2)) {
    return 'RANGING_CHOP';
  }
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
 * Calibration (`T`, `bias`) comes from the self-optimising store; the raw head
 * logits are temperature-scaled exactly like the ONNX post-processing step:
 *   y_cal = sigmoid(logit(y_hat) / T + bias)
 */
export function buildThreeComponentState(
  frame: FeatureFrame,
  calibration: CalibrationState
): ThreeComponentState {
  const features = frame.snapshot;
  const zRsi = clamp((features.rsi14 - 50) / 25, -1.5, 1.5);
  const zCisd = clamp(features.cisd, -1.5, 1.5);
  const zBbPosition = clamp((features.bbPosition - 0.5) * 2, -2, 2);
  const zAtr = clamp(features.atrPercent / 0.15, 0, 3);

  const rawLogit = 1.05 * zCisd + 0.55 * zRsi - 0.35 * zBbPosition - 0.25 * zAtr + 0.05;
  const onnxRawYHat = sigmoid(rawLogit);
  const temperatureT = clamp(calibration.temperatureT, 0.5, 3);
  const bias = clamp(calibration.bias, -1.5, 1.5);
  const onnxCalibratedY = sigmoid(logit(onnxRawYHat) / temperatureT + bias);

  const regime = classifyRegime(frame.emaDeltaPercent, frame.atrPercentile, frame.hurstExponent);
  const trendStrength = clamp(Math.abs(frame.emaDeltaPercent) / 1.0, 0, 1);
  const persistence =
    regimeDirection(regime) === 0
      ? clamp((0.55 - frame.hurstExponent) / 0.2, 0, 1)
      : clamp((frame.hurstExponent - 0.5) / 0.25, 0, 1);

  let jevGateConfidence =
    0.35 + 0.35 * trendStrength + 0.2 * persistence + 0.1 * (1 - clamp(frame.atrPercentile, 0, 1));
  if (regime === 'RANGING_CHOP') jevGateConfidence *= 0.75;
  if (regime === 'HIGH_VOL_CRISIS') jevGateConfidence *= 0.5;
  if (features.sampleCount < 40) jevGateConfidence *= 0.9;
  jevGateConfidence = clamp(jevGateConfidence, 0.05, 0.98);

  const onnxSigned = (onnxCalibratedY - 0.5) * 2;
  const gateSigned = regimeDirection(regime) * jevGateConfidence;
  const aligned = gateSigned === 0 || Math.sign(onnxSigned) === Math.sign(gateSigned);
  const conflictDamping = aligned ? 1 : 0.45;

  const krakenPaperSignal = clamp(
    (0.6 * onnxSigned + 0.4 * gateSigned) * conflictDamping,
    -1,
    1
  );
  const paperSizingImpulse = clamp(
    Math.abs(krakenPaperSignal) * (0.4 + 0.6 * jevGateConfidence),
    0,
    1
  );

  const compositeScore = clamp(
    0.5 * onnxSigned + 0.3 * gateSigned + 0.2 * krakenPaperSignal,
    -1,
    1
  );

  const predictedDirection: -1 | 0 | 1 =
    compositeScore > 0.08 ? 1 : compositeScore < -0.08 ? -1 : 0;

  // Per-minute sigma from observed tick volatility, floored so targets stay
  // legible on quiet tape and capped so they cannot run away in a crisis.
  const sigmaPerMinute = clamp((features.atrPercent / 100) * 0.35, 0.0006, 0.004);
  const impliedTargetPrices = {} as Record<HorizonMinutes, number>;
  for (const horizon of EVALUATION_HORIZONS) {
    const sigmaHorizon = sigmaPerMinute * Math.sqrt(horizon);
    impliedTargetPrices[horizon] = Number(
      (features.price * (1 + compositeScore * 0.8 * sigmaHorizon)).toFixed(2)
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
