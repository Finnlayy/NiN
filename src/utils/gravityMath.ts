/**
 * Three-component gravity field shared by the dashboard and the paper worker.
 *
 * The potential matches `ACGravityEngine.compute_gravity_field`: a simplex
 * weighted sum of the visible-book, iceberg, and Polymarket features.
 * The restoring force is F_i = -k_i (P - P*_i) with the decorative sinusoid
 * removed. Forbidden-zone bounds use the same linear quantile as
 * `numpy.quantile` (index = q * (n - 1)).
 */

export interface GravityParams {
  w_vis: number;
  w_blind: number;
  w_poly: number;
  quantile: number;
  history_window: number;
}

export const DEFAULT_GRAVITY_PARAMS: GravityParams = {
  w_vis: 0.25,
  w_blind: 0.35,
  w_poly: 0.40,
  quantile: 0.999,
  history_window: 512,
};

export const QUANTILE_FLOOR = 0.5;
export const QUANTILE_CEIL = 0.9999;

/** Spring constants. F = -k (P - P*). */
export const K_VIS = 0.12;
export const K_BLIND = 0.15;
export const K_POLY = 0.18;

const VIS_CENTER = 1400;
const VIS_SCALE = 0.45;
const VIS_FULL = 2800;
const BLIND_CENTER = 2000;
const BLIND_SCALE = 0.35;
const BLIND_FULL = 4000;
const POLY_SPAN = 1100;

export interface BookLevel {
  price: number;
  volume: number;
}

export interface GravityForces {
  pStarVis: number;
  pStarBlind: number;
  pStarPoly: number;
  attractor: number;
  fVis: number;
  fBlind: number;
  fPoly: number;
  fNet: number;
  vVis: number;
  vBlind: number;
  vPoly: number;
  vTotal: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function clipQuantile(value: number): number {
  if (value < QUANTILE_FLOOR) return QUANTILE_FLOOR;
  if (value > QUANTILE_CEIL) return QUANTILE_CEIL;
  return value;
}

/**
 * `numpy.quantile(values, q, method="linear")`.
 * Empty input returns NaN. A single sample returns that sample.
 */
export function numpyQuantile(values: readonly number[], q: number): number {
  if (values.length === 0 || !Number.isFinite(q)) return Number.NaN;
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const weight = pos - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

export function isInForbiddenZone(
  price: number,
  history: readonly number[],
  quantile: number,
  window: number = DEFAULT_GRAVITY_PARAMS.history_window,
): boolean {
  if (!Number.isFinite(price) || history.length === 0) return false;
  const sample = history.slice(-Math.max(1, window)).filter((v) => Number.isFinite(v));
  if (sample.length === 0) return false;
  const q = clipQuantile(quantile);
  const upper = numpyQuantile(sample, q);
  const lower = numpyQuantile(sample, 1 - q);
  return price > upper || price < lower;
}

export function forbiddenBand(
  history: readonly number[],
  quantile: number,
  window: number,
): { lower: number; upper: number } | null {
  const sample = history.slice(-Math.max(1, window)).filter((v) => Number.isFinite(v));
  if (sample.length === 0) return null;
  const q = clipQuantile(quantile);
  return {
    lower: numpyQuantile(sample, 1 - q),
    upper: numpyQuantile(sample, q),
  };
}

/** Map a raw engine depth or an already-normalized feature onto [0, 1]. */
export function asUnit(value: number, fullScale: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value >= 0 && value <= 1) return value;
  if (!(fullScale > 0)) return 0.5;
  return clamp(value / fullScale, 0, 1);
}

/**
 * Price offset of one component's attractor from spot.
 * Raw depths (the old slider scale) use (value - center) * scale, which is
 * identical to (unit - 0.5) * fullScale * scale.
 */
export function attractorShift(kind: 'vis' | 'blind' | 'poly', value: number): number {
  if (kind === 'vis') {
    if (value >= 0 && value <= 1) return (value - 0.5) * VIS_FULL * VIS_SCALE;
    return (value - VIS_CENTER) * VIS_SCALE;
  }
  if (kind === 'blind') {
    if (value >= 0 && value <= 1) return (value - 0.5) * BLIND_FULL * BLIND_SCALE;
    return (value - BLIND_CENTER) * BLIND_SCALE;
  }
  const unit = value >= 0 && value <= 1 ? value : clamp(value / 100, 0, 1);
  return (unit - 0.5) * POLY_SPAN;
}

export function normalizeParams(params: GravityParams): GravityParams {
  const total = params.w_vis + params.w_blind + params.w_poly;
  const scale = total > 0 ? total : 1;
  return {
    w_vis: params.w_vis / scale,
    w_blind: params.w_blind / scale,
    w_poly: params.w_poly / scale,
    quantile: clipQuantile(params.quantile),
    history_window: Math.max(2, Math.floor(params.history_window)),
  };
}

/** Weighted potential. Inputs may be raw depths or unit features. */
export function gravityPotential(l2: number, iceberg: number, poly: number, params: GravityParams): number {
  const w = normalizeParams(params);
  const vVis = asUnit(l2, VIS_FULL);
  const vBlind = asUnit(iceberg, BLIND_FULL);
  const vPoly = asUnit(poly, 1);
  return w.w_vis * vVis + w.w_blind * vBlind + w.w_poly * vPoly;
}

export function computeForces(
  price: number,
  spot: number,
  l2: number,
  iceberg: number,
  poly: number,
  params: GravityParams,
): GravityForces {
  const w = normalizeParams(params);
  const vVis = asUnit(l2, VIS_FULL);
  const vBlind = asUnit(iceberg, BLIND_FULL);
  const vPoly = asUnit(poly, 1);
  const pStarVis = spot + attractorShift('vis', l2);
  const pStarBlind = spot + attractorShift('blind', iceberg);
  const pStarPoly = spot + attractorShift('poly', poly);
  const fVis = -K_VIS * (price - pStarVis);
  const fBlind = -K_BLIND * (price - pStarBlind);
  const fPoly = -K_POLY * (price - pStarPoly);
  const fNet = w.w_vis * fVis + w.w_blind * fBlind + w.w_poly * fPoly;
  return {
    pStarVis,
    pStarBlind,
    pStarPoly,
    attractor: w.w_vis * pStarVis + w.w_blind * pStarBlind + w.w_poly * pStarPoly,
    fVis,
    fBlind,
    fPoly,
    fNet,
    vVis,
    vBlind,
    vPoly,
    vTotal: w.w_vis * vVis + w.w_blind * vBlind + w.w_poly * vPoly,
  };
}

/**
 * Visible size inside `bandPct` of mid, normalized to [0, 1) the same way
 * the Python feed normalizes total displayed size: total / (1 + total).
 */
export function l2Depth(bids: readonly BookLevel[], asks: readonly BookLevel[], mid: number, bandPct = 0.02): number {
  if (!(mid > 0)) return 0;
  const lo = mid * (1 - bandPct);
  const hi = mid * (1 + bandPct);
  let total = 0;
  for (const level of bids) {
    if (level.price >= lo && level.price <= mid) total += level.volume;
  }
  for (const level of asks) {
    if (level.price <= hi && level.price >= mid) total += level.volume;
  }
  if (!(total > 0)) return 0;
  return total / (1 + total);
}

/** Share of displayed size sitting on the single largest level. 0 when the book is empty. */
export function icebergRatio(bids: readonly BookLevel[], asks: readonly BookLevel[]): number {
  let total = 0;
  let peak = 0;
  for (const level of bids) {
    total += level.volume;
    if (level.volume > peak) peak = level.volume;
  }
  for (const level of asks) {
    total += level.volume;
    if (level.volume > peak) peak = level.volume;
  }
  if (!(total > 0)) return 0;
  return peak / total;
}

/** Bid share of size inside the band. 0.5 when the band is empty. */
export function bookImbalance(bids: readonly BookLevel[], asks: readonly BookLevel[], mid: number, bandPct = 0.02): number {
  if (!(mid > 0)) return 0.5;
  const lo = mid * (1 - bandPct);
  const hi = mid * (1 + bandPct);
  let bidVol = 0;
  let askVol = 0;
  for (const level of bids) {
    if (level.price >= lo && level.price <= mid) bidVol += level.volume;
  }
  for (const level of asks) {
    if (level.price <= hi && level.price >= mid) askVol += level.volume;
  }
  const total = bidVol + askVol;
  if (!(total > 0)) return 0.5;
  return bidVol / total;
}
