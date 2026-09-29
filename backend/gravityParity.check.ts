/**
 * Cross-check the TypeScript learner and quantile against the Python fixture
 * produced by Architect/limbs/ml/gravity_learner.py.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GravityFieldLearner, type GravityLearnerJson, type GravityTick } from '../src/utils/gravityLearner';
import { numpyQuantile } from '../src/utils/gravityMath';

interface Fixture {
  ticks: GravityTick[];
  state: {
    weights: number[];
    quantile: number;
    weight_updates: number;
    quantile_updates: number;
    pending: Array<{ x: number[]; mid: number }>;
  };
  quantile_samples: number[];
  quantiles: Record<string, number>;
}

const fixturePath = resolve(process.cwd(), 'Architect/tests/fixtures/gravity_learner_roundtrip.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

const restored = GravityFieldLearner.fromJSON(fixture.state as unknown as GravityLearnerJson);

const fresh = new GravityFieldLearner({
  eta: 0.08,
  horizonTicks: 3,
  gamma: 0.02,
  qTarget: 0.995,
  minUpdates: 1,
  quantile: 0.995,
});
for (const tick of fixture.ticks) fresh.observe(tick);

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: ${actual} != ${expected}`);
  }
}

close(fresh.weights[0], fixture.state.weights[0], 'w_vis');
close(fresh.weights[1], fixture.state.weights[1], 'w_blind');
close(fresh.weights[2], fixture.state.weights[2], 'w_poly');
close(fresh.quantile, fixture.state.quantile, 'quantile');
if (fresh.weightUpdates !== fixture.state.weight_updates) {
  throw new Error(`weight_updates ${fresh.weightUpdates} != ${fixture.state.weight_updates}`);
}
if (fresh.quantileUpdates !== fixture.state.quantile_updates) {
  throw new Error(`quantile_updates ${fresh.quantileUpdates} != ${fixture.state.quantile_updates}`);
}
if (restored.toJSON().pending.length !== fixture.state.pending.length) {
  throw new Error('pending length mismatch after fromJSON');
}
close(restored.quantile, fixture.state.quantile, 'restored quantile');
close(restored.weights[0], fixture.state.weights[0], 'restored w_vis');

for (const [q, expected] of Object.entries(fixture.quantiles)) {
  close(numpyQuantile(fixture.quantile_samples, Number(q)), expected, `quantile ${q}`);
}

console.log('gravity parity ok', {
  weights: fresh.weights,
  quantile: fresh.quantile,
  updates: fresh.weightUpdates,
});
