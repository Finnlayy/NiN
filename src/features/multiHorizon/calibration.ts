/**
 * Self-optimising temperature scaling — Paragraph 2, component 1 post-processing.
 *
 * The ONNX head emits a raw probability. Calibration learns `T` (temperature)
 * and `bias` online from realised binary outcomes via a gradient step on the
 * log-loss of the calibrated probability:
 *
 *   p_cal = sigmoid(logit(p_raw) / T + bias)
 *
 * A model that is consistently over-confident drifts T upward; a persistent
 * directional bias drifts the bias term. Both are stored in the immutable
 * ledgers' calibration record so a reload resumes at the same parameters.
 */

import type { CalibrationState, HorizonResolution } from './types';
import { TARGET_BRIER } from './config';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-clamp(x, -30, 30)));

const logit = (p: number): number => {
  const safe = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(safe / (1 - safe));
};

export const defaultCalibration = (): CalibrationState => ({
  temperatureT: 1.25,
  bias: 0,
  calibrationSamples: 0,
  rollingBrier: 0.25,
  lastUpdatedMs: null,
});

const LEARNING_RATE = 0.05;
const MAX_FIT_SAMPLES = 400;

/**
 * One deterministic online calibration pass over the realised resolutions.
 * Neutral (0-direction) outcomes carry no binary label and are skipped.
 */
export function updateCalibration(
  previous: CalibrationState,
  resolutions: readonly HorizonResolution[]
): CalibrationState {
  const labelled = resolutions
    .filter((resolution) => resolution.actualDirection !== 0)
    .slice(-MAX_FIT_SAMPLES);
  if (labelled.length === 0) {
    return previous;
  }

  let temperatureT = clamp(previous.temperatureT, 0.5, 3);
  let bias = clamp(previous.bias, -1.5, 1.5);

  for (const resolution of labelled) {
    const raw = clamp(resolution.predictedProbabilityUp, 1e-4, 1 - 1e-4);
    const target = resolution.actualDirection === 1 ? 1 : 0;
    const calibrated = sigmoid(logit(raw) / temperatureT + bias);
    const error = calibrated - target;
    bias -= LEARNING_RATE * error;
    temperatureT -= LEARNING_RATE * error * (-logit(raw) / (temperatureT * temperatureT));
    temperatureT = clamp(temperatureT, 0.5, 3);
    bias = clamp(bias, -1.5, 1.5);
  }

  const brier =
    labelled.reduce((acc, resolution) => acc + resolution.brierContribution, 0) / labelled.length;

  return {
    temperatureT: Number(temperatureT.toFixed(4)),
    bias: Number(bias.toFixed(4)),
    calibrationSamples: labelled.length,
    rollingBrier: Number(brier.toFixed(4)),
    lastUpdatedMs: labelled[labelled.length - 1].resolvedAtExchangeMs,
  };
}

/** Calibration health signal used by the Rouge widget. */
export function calibrationQuality(calibration: CalibrationState): {
  label: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'WARMUP';
  isHealthy: boolean;
  detail: string;
} {
  if (calibration.calibrationSamples === 0) {
    return {
      label: 'WARMUP',
      isHealthy: true,
      detail: 'Keine aufgelösten Stichproben — Kalibrierung startet bei T=1.25.',
    };
  }
  const brier = calibration.rollingBrier;
  const label =
    brier <= TARGET_BRIER ? 'EXCELLENT' : brier <= 0.25 ? 'GOOD' : brier <= 0.3 ? 'FAIR' : 'POOR';
  return {
    label,
    isHealthy: brier <= 0.3,
    detail: `Rollierender Brier-Score ${brier.toFixed(3)} (Ziel ≤ ${TARGET_BRIER.toFixed(2)}).`,
  };
}
