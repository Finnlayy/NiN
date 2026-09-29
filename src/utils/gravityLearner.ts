/**
 * TypeScript port of `Architect/limbs/ml/gravity_learner.py`.
 *
 * Simplex weights move by exponentiated gradient (Hedge). The Via-Negativa
 * quantile takes an adaptive-conformal step whose fixed point is a breach
 * rate of `1 - q_target`. JSON matches `GravityFieldLearner.to_json()`,
 * including the pending horizon buffer.
 */

export const DEFAULT_WEIGHTS: [number, number, number] = [0.25, 0.35, 0.40];
export const DEFAULT_QUANTILE = 0.999;
export const LEARNER_QUANTILE_FLOOR = 0.99;
export const LEARNER_QUANTILE_CEIL = 0.9999;
const WEIGHT_FLOOR = 1e-12;

export interface PendingTick {
  x: [number, number, number];
  mid: number;
}

export interface GravityLearnerJson {
  version: 1;
  eta: number;
  horizon_ticks: number;
  gamma: number;
  q_target: number;
  min_updates: number;
  weights: [number, number, number];
  prior_weights: [number, number, number];
  quantile: number;
  prior_quantile: number;
  weight_updates: number;
  quantile_updates: number;
  breaches: number;
  hits: number;
  directional: number;
  skipped: number;
  resolved: number;
  pending: PendingTick[];
}

export interface GravityLearnerParams {
  w_vis: number;
  w_blind: number;
  w_poly: number;
  quantile: number;
}

export interface GravityTick {
  l2_depth?: unknown;
  l3_iceberg?: unknown;
  polymarket_prob?: unknown;
  mid_price?: unknown;
  is_forbidden_zone?: unknown;
}

function clipQuantile(value: number): number {
  if (value < LEARNER_QUANTILE_FLOOR) return LEARNER_QUANTILE_FLOOR;
  if (value > LEARNER_QUANTILE_CEIL) return LEARNER_QUANTILE_CEIL;
  return value;
}

function asFinite(value: unknown): number | null {
  if (typeof value === 'boolean' || value == null) return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return number;
}

function asBreach(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  const number = asFinite(value);
  if (number == null) return null;
  return number !== 0;
}

function parseWeights(weights: unknown, label: string): [number, number, number] {
  if (!Array.isArray(weights) || weights.length !== 3) {
    throw new Error(`${label} must be three finite numbers > 0`);
  }
  const parsed: number[] = [];
  for (const weight of weights) {
    const number = asFinite(weight);
    if (number == null || number <= 0) {
      throw new Error(`${label} must be three finite numbers > 0`);
    }
    parsed.push(number);
  }
  const total = parsed[0] + parsed[1] + parsed[2];
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error('weights must sum to 1');
  }
  return [parsed[0] / total, parsed[1] / total, parsed[2] / total];
}

export class GravityFieldLearner {
  readonly eta: number;
  readonly horizonTicks: number;
  readonly gamma: number;
  readonly qTarget: number;
  readonly minUpdates: number;

  weights: [number, number, number];
  private priorWeights: [number, number, number];
  quantile: number;
  private priorQuantile: number;
  private pending: PendingTick[] = [];

  weightUpdates = 0;
  quantileUpdates = 0;
  breaches = 0;
  hits = 0;
  directional = 0;
  skipped = 0;
  resolved = 0;

  constructor(options?: {
    eta?: number;
    horizonTicks?: number;
    gamma?: number;
    qTarget?: number;
    minUpdates?: number;
    weights?: readonly number[];
    quantile?: number;
  }) {
    const eta = options?.eta ?? 0.05;
    const gamma = options?.gamma ?? 0.01;
    const horizonTicks = options?.horizonTicks ?? 5;
    const minUpdates = options?.minUpdates ?? 1;
    const qTarget = options?.qTarget ?? DEFAULT_QUANTILE;
    const startQ = options?.quantile ?? DEFAULT_QUANTILE;
    if (!(eta >= 0) || !Number.isFinite(eta)) throw new Error('eta must be >= 0');
    if (!(gamma > 0) || !Number.isFinite(gamma)) throw new Error('gamma must be > 0');
    if (!Number.isInteger(horizonTicks) || horizonTicks < 1) throw new Error('horizon_ticks must be an int >= 1');
    if (!Number.isInteger(minUpdates) || minUpdates < 1) throw new Error('min_updates must be an int >= 1');
    const target = asFinite(qTarget);
    if (target == null || target < LEARNER_QUANTILE_FLOOR || target > LEARNER_QUANTILE_CEIL) {
      throw new Error(`q_target must be in [${LEARNER_QUANTILE_FLOOR}, ${LEARNER_QUANTILE_CEIL}]`);
    }
    const start = asFinite(startQ);
    if (start == null) throw new Error('quantile must be finite');

    this.eta = eta;
    this.horizonTicks = horizonTicks;
    this.gamma = gamma;
    this.qTarget = target;
    this.minUpdates = minUpdates;
    this.weights = parseWeights(options?.weights ?? DEFAULT_WEIGHTS, 'weights');
    this.priorWeights = [...this.weights];
    this.quantile = clipQuantile(start);
    this.priorQuantile = this.quantile;
  }

  observe(tick: GravityTick): boolean {
    const mid = asFinite(tick.mid_price);
    const l2 = asFinite(tick.l2_depth);
    const iceberg = asFinite(tick.l3_iceberg);
    const poly = asFinite(tick.polymarket_prob);
    if (mid == null || l2 == null || iceberg == null || poly == null) {
      this.skipped += 1;
      return false;
    }
    const breach = asBreach(tick.is_forbidden_zone);
    if (breach != null) this.updateQuantile(breach);
    this.pending.push({ x: [l2, iceberg, poly], mid });
    this.resolve();
    return true;
  }

  private updateQuantile(breach: boolean): void {
    const breachT = breach ? 1 : 0;
    const targetBreach = 1 - this.qTarget;
    this.quantile = clipQuantile(this.quantile + this.gamma * (breachT - targetBreach));
    this.quantileUpdates += 1;
    if (breach) this.breaches += 1;
  }

  private resolve(): void {
    while (this.pending.length > this.horizonTicks) {
      const past = this.pending.shift();
      if (!past) break;
      const future = this.pending[this.horizonTicks - 1];
      const move = future.mid - past.mid;
      this.resolved += 1;
      if (move === 0 || this.eta === 0) continue;
      const label = move > 0 ? 1 : -1;
      this.recordHit(past.x, label);
      this.updateWeights(past.x, label);
    }
  }

  private recordHit(components: [number, number, number], label: number): void {
    const mean = (components[0] + components[1] + components[2]) / 3;
    let score = 0;
    for (let i = 0; i < 3; i += 1) score += this.weights[i] * (components[i] - mean);
    if (score === 0) return;
    this.directional += 1;
    if (score * label > 0) this.hits += 1;
  }

  private updateWeights(components: [number, number, number], label: number): void {
    const logs = this.weights.map((w, i) => Math.log(Math.max(w, WEIGHT_FLOOR)) + this.eta * label * components[i]);
    const peak = Math.max(...logs);
    const lifted = logs.map((v) => Math.exp(v - peak));
    const total = lifted.reduce((sum, v) => sum + v, 0);
    const floored = lifted.map((v) => Math.max(v / total, WEIGHT_FLOOR));
    const renormalized = floored.reduce((sum, v) => sum + v, 0);
    this.weights = [
      floored[0] / renormalized,
      floored[1] / renormalized,
      floored[2] / renormalized,
    ];
    this.weightUpdates += 1;
  }

  params(): GravityLearnerParams {
    const weights = this.weightUpdates >= this.minUpdates ? this.weights : this.priorWeights;
    return {
      w_vis: weights[0],
      w_blind: weights[1],
      w_poly: weights[2],
      quantile: this.quantile,
    };
  }

  toJSON(): GravityLearnerJson {
    return {
      version: 1,
      eta: this.eta,
      horizon_ticks: this.horizonTicks,
      gamma: this.gamma,
      q_target: this.qTarget,
      min_updates: this.minUpdates,
      weights: [...this.weights],
      prior_weights: [...this.priorWeights],
      quantile: this.quantile,
      prior_quantile: this.priorQuantile,
      weight_updates: this.weightUpdates,
      quantile_updates: this.quantileUpdates,
      breaches: this.breaches,
      hits: this.hits,
      directional: this.directional,
      skipped: this.skipped,
      resolved: this.resolved,
      pending: this.pending.map((item) => ({ x: [...item.x] as [number, number, number], mid: item.mid })),
    };
  }

  static fromJSON(payload: Partial<GravityLearnerJson>): GravityFieldLearner {
    const prior = (payload.prior_weights ?? payload.weights ?? DEFAULT_WEIGHTS) as number[];
    const learner = new GravityFieldLearner({
      eta: typeof payload.eta === 'number' ? payload.eta : 0.05,
      horizonTicks: typeof payload.horizon_ticks === 'number' ? payload.horizon_ticks : 5,
      gamma: typeof payload.gamma === 'number' ? payload.gamma : 0.01,
      qTarget: typeof payload.q_target === 'number' ? payload.q_target : DEFAULT_QUANTILE,
      minUpdates: typeof payload.min_updates === 'number' ? payload.min_updates : 1,
      weights: prior,
      quantile: typeof payload.prior_quantile === 'number'
        ? payload.prior_quantile
        : typeof payload.quantile === 'number'
          ? payload.quantile
          : DEFAULT_QUANTILE,
    });
    if (Array.isArray(payload.weights)) {
      const parsed = payload.weights.map((w) => Number(w));
      const total = parsed.reduce((sum, w) => sum + w, 0);
      if (parsed.length === 3 && total > 0) {
        learner.weights = [parsed[0] / total, parsed[1] / total, parsed[2] / total];
      }
    }
    if (typeof payload.quantile === 'number') {
      learner.quantile = clipQuantile(payload.quantile);
    }
    const counters = [
      'weight_updates',
      'quantile_updates',
      'breaches',
      'hits',
      'directional',
      'skipped',
      'resolved',
    ] as const;
    for (const field of counters) {
      const value = payload[field];
      if (typeof value === 'number') {
        if (field === 'weight_updates') learner.weightUpdates = value;
        else if (field === 'quantile_updates') learner.quantileUpdates = value;
        else if (field === 'breaches') learner.breaches = value;
        else if (field === 'hits') learner.hits = value;
        else if (field === 'directional') learner.directional = value;
        else if (field === 'skipped') learner.skipped = value;
        else learner.resolved = value;
      }
    }
    if (Array.isArray(payload.pending)) {
      const restored: PendingTick[] = [];
      for (const item of payload.pending) {
        if (!item || typeof item !== 'object') continue;
        const row = item as { x?: unknown; mid?: unknown };
        if (!Array.isArray(row.x) || row.x.length !== 3) continue;
        const x0 = asFinite(row.x[0]);
        const x1 = asFinite(row.x[1]);
        const x2 = asFinite(row.x[2]);
        const mid = asFinite(row.mid);
        if (x0 == null || x1 == null || x2 == null || mid == null) continue;
        restored.push({ x: [x0, x1, x2], mid });
      }
      learner.pending = restored;
    }
    return learner;
  }
}
