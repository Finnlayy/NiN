/**
 * Paragraph 2 — multi-horizon ledger & evaluation invariants.
 * Run with: npm run test:horizon
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVALUATION_HORIZONS,
  HORIZON_MS,
  type CalibrationState,
  type Direction,
  type HorizonMinutes,
  type HorizonResolution,
  type Paragraph2Snapshot,
  type ThreeComponentState,
} from '../../src/features/multiHorizon/types';
import {
  appendResolution,
  appendSnapshot,
  checksumOf,
  createLedger,
  createSnapshot,
  verifyResolution,
  verifySnapshot,
} from '../../src/features/multiHorizon/snapshotStore';
import {
  buildAggregates,
  computeResolution,
  summariseHorizons,
  wilsonLowerBound,
} from '../../src/features/multiHorizon/evaluation';
import { defaultCalibration, updateCalibration } from '../../src/features/multiHorizon/calibration';
import { seedReplayLedger } from '../../src/features/multiHorizon/replay';
import { evaluateCommitGate } from '../../src/features/multiHorizon/riskGate';
import { sampleExchangeClock } from '../../src/features/multiHorizon/exchangeClock';
import {
  buildFeatureFrame,
  buildThreeComponentState,
  classifyRegime,
  estimateHurst,
  type PriceTick,
} from '../../src/features/multiHorizon/featureEngine';

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

function componentsFixture(overrides: Partial<ThreeComponentState> = {}): ThreeComponentState {
  const impliedTargetPrices = {} as Record<HorizonMinutes, number>;
  for (const horizon of EVALUATION_HORIZONS) {
    impliedTargetPrices[horizon] = 101;
  }
  return {
    onnxRawYHat: 0.7,
    onnxCalibratedY: 0.8,
    temperatureT: 1.25,
    bias: 0.1,
    jevGateConfidence: 0.72,
    regime: 'WEAK_BULL',
    hurstExponent: 0.58,
    atrPercentile: 0.4,
    emaDeltaPercent: 0.12,
    krakenPaperSignal: 0.42,
    paperSizingImpulse: 0.3,
    compositeScore: 0.4,
    predictedDirection: 1,
    impliedTargetPrices,
    features: {
      price: 100,
      rsi14: 58,
      atrPercent: 0.1,
      cisd: 0.35,
      bbWidthPercent: 0.4,
      bbPosition: 0.62,
      sampleCount: 64,
    },
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<Parameters<typeof createSnapshot>[0]> = {}): Paragraph2Snapshot {
  return createSnapshot({
    t0ExchangeMs: T0,
    btcPriceAtT0: 100,
    components: componentsFixture(),
    origin: 'LIVE',
    m8EngineStatus: 'ACTIVE',
    ...overrides,
  });
}

function resolutionFixture(
  horizon: HorizonMinutes,
  hit: boolean,
  accuracyPercent: number
): HorizonResolution {
  return {
    snapshotId: `FIX-${horizon}-${Math.random().toString(36).slice(2, 8)}`,
    horizonMinutes: horizon,
    targetTimestampMs: T0 + HORIZON_MS(horizon),
    resolvedAtExchangeMs: T0 + HORIZON_MS(horizon) + 1_000,
    referencePrice: 100,
    actualBtcPrice: hit ? 101 : 99,
    actualDirection: (hit ? 1 : -1) as Direction,
    predictedDirection: 1,
    impliedTargetPrice: 101,
    directionalHit: hit,
    absPercentageError: 0.5,
    smapePercent: 0.5,
    magnitudeClosenessPercent: accuracyPercent,
    accuracyPercent,
    brierContribution: hit ? 0.04 : 0.64,
    predictedProbabilityUp: 0.8,
    paperPnlPercent: hit ? 1 : -1,
    origin: 'LIVE',
    checksum: checksumOf({ fixture: `${horizon}-${hit}` }),
  };
}

test('seven mandatory horizons are exactly 5/15/30/60/120/180/300 minutes', () => {
  assert.deepEqual([...EVALUATION_HORIZONS], [5, 15, 30, 60, 120, 180, 300]);
  assert.equal(EVALUATION_HORIZONS.length, 7);
});

test('snapshots are deeply frozen and integrity-verifiable', () => {
  const snapshot = snapshotFixture();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.components));
  assert.ok(Object.isFrozen(snapshot.horizons));
  assert.ok(Object.isFrozen(snapshot.horizons[5]));
  assert.ok(verifySnapshot(snapshot));

  // A snapshot can never be repainted, not even in a single field.
  try {
    (snapshot as unknown as { btcPriceAtT0: number }).btcPriceAtT0 = 999;
  } catch {
    // strict-mode environments throw; sloppy-mode silently ignores. Either way:
  }
  assert.equal(snapshot.btcPriceAtT0, 100);

  const tampered = JSON.parse(JSON.stringify(snapshot)) as Paragraph2Snapshot;
  tampered.components.compositeScore = -0.9;
  assert.equal(verifySnapshot(tampered), false);
});

test('ledger rejects back-dated and duplicate snapshots', () => {
  const ledger = createLedger();
  const first = appendSnapshot(ledger, snapshotFixture());
  assert.equal(first.error, undefined);

  const older = createSnapshot({
    t0ExchangeMs: T0 - 60_000,
    btcPriceAtT0: 100,
    components: componentsFixture(),
  });
  const rejectedOlder = appendSnapshot(first.ledger, older);
  assert.equal(rejectedOlder.error?.code, 'E4100');

  const duplicate = appendSnapshot(first.ledger, snapshotFixture());
  assert.equal(duplicate.error?.code, 'E4100');
});

test('resolution cannot be evaluated before the horizon matures (zero future leak)', () => {
  const snapshot = snapshotFixture();
  assert.throws(() => computeResolution(snapshot, 5, 101, T0 + 1_000), /future leak/i);

  const ledger = appendSnapshot(createLedger(), snapshot).ledger;
  const draft = computeResolution(snapshot, 5, 101, T0 + HORIZON_MS(5));
  const rejected = appendResolution(ledger, draft, T0 + 1_000);
  assert.equal(rejected.error?.code, 'E5000');

  const accepted = appendResolution(ledger, draft, T0 + HORIZON_MS(5) + 5_000);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.ledger.resolutions.length, 1);
  assert.ok(verifyResolution(accepted.ledger.resolutions[0]));

  // The snapshot itself is untouched by the resolution.
  assert.equal(accepted.ledger.snapshots[0].horizons[5].status, 'pending');
  assert.equal(accepted.ledger.snapshots[0].horizons[5].actualBtcPrice, null);
  assert.ok(verifySnapshot(accepted.ledger.snapshots[0]));

  // Re-resolving the same (snapshot, horizon) pair is refused.
  const duplicate = appendResolution(
    accepted.ledger,
    { ...draft },
    T0 + HORIZON_MS(5) + 10_000
  );
  assert.equal(duplicate.error?.code, 'E4100');
});

test('evaluation computes directional hit, trajectory closeness and Brier contribution', () => {
  const snapshot = snapshotFixture();
  const hit = computeResolution(snapshot, 60, 101, T0 + HORIZON_MS(60));
  assert.equal(hit.directionalHit, true);
  assert.equal(hit.actualDirection, 1);
  assert.ok(hit.magnitudeClosenessPercent > 90);
  assert.ok(hit.accuracyPercent >= 52);
  assert.ok(hit.brierContribution > 0 && hit.brierContribution < 0.25);

  const miss = computeResolution(snapshot, 60, 97, T0 + HORIZON_MS(60));
  assert.equal(miss.directionalHit, false);
  assert.equal(miss.actualDirection, -1);
  assert.ok(miss.accuracyPercent < 45);

  // Neutral tape: the prediction is wrong, but not catastrophically so.
  const neutral = computeResolution(snapshot, 5, 100.01, T0 + HORIZON_MS(5));
  assert.equal(neutral.actualDirection, 0);
  assert.equal(neutral.directionalHit, false);
});

test('one lucky sample never outranks a proven horizon (Bayesian shrinkage)', () => {
  const proven = Array.from({ length: 20 }, () => resolutionFixture(5, true, 70));
  const lucky = [resolutionFixture(15, true, 100)];
  const aggregates = buildAggregates([...proven, ...lucky], 'LIVE');

  const five = aggregates.find((entry) => entry.horizonMinutes === 5)!;
  const fifteen = aggregates.find((entry) => entry.horizonMinutes === 15)!;
  assert.equal(five.samples, 20);
  assert.equal(fifteen.samples, 1);
  assert.ok(five.rankedScore > fifteen.rankedScore, 'proven horizon must outrank one lucky sample');
  assert.equal(five.rank, 1);
  assert.equal(fifteen.isProvisional, false);
  assert.ok(five.confidenceWeight > fifteen.confidenceWeight);
});

test('confidence weight and Wilson lower bound behave monotonically', () => {
  assert.ok(wilsonLowerBound(1, 1) < 100);
  assert.ok(wilsonLowerBound(20, 20) > wilsonLowerBound(1, 1));
  assert.ok(wilsonLowerBound(0, 0) === 0);
});

test('verdict stays conservative without data and turns tradeable with proven data', () => {
  const empty = summariseHorizons([], 3, defaultCalibration());
  assert.equal(empty.verdict.code, 'E2000');
  assert.notEqual(empty.verdict.severity, 'success');
  assert.equal(empty.best, null);

  const proven = Array.from({ length: 20 }, () => resolutionFixture(60, true, 82));
  const summary = summariseHorizons(proven, 2, defaultCalibration());
  assert.equal(summary.verdict.code, null);
  assert.equal(summary.verdict.severity, 'success');
  assert.ok(summary.verdict.detail.includes('Gewichtete Genauigkeit'));
});

test('calibration walks temperature/bias in the direction of the realised error', () => {
  const overconfidentBear: HorizonResolution[] = Array.from({ length: 40 }, (_, index) => ({
    ...resolutionFixture(5, false, 10),
    predictedProbabilityUp: 0.92,
    actualDirection: -1,
    brierContribution: 0.85,
    resolvedAtExchangeMs: T0 + HORIZON_MS(5) + index,
  }));

  const next = updateCalibration(defaultCalibration(), overconfidentBear);
  assert.ok(next.bias < 0, 'persistent bullish over-confidence must push the bias down');
  assert.notEqual(next.temperatureT, defaultCalibration().temperatureT);
  assert.ok(next.temperatureT >= 0.5 && next.temperatureT <= 3);
  assert.ok(next.rollingBrier > 0.5);
});

test('replay seeding is deterministic, tagged REPLAY and excluded from LIVE aggregates', () => {
  const base = createLedger();
  const first = seedReplayLedger(base, {
    nowExchangeMs: T0,
    anchorPrice: 64_000,
    seed: 42,
    hours: 6,
  });
  const second = seedReplayLedger(base, {
    nowExchangeMs: T0,
    anchorPrice: 64_000,
    seed: 42,
    hours: 6,
  });

  assert.ok(first.snapshots > 0);
  assert.ok(first.resolutions > 0);
  assert.equal(first.snapshots, second.snapshots);
  assert.equal(first.resolutions, second.resolutions);
  assert.deepEqual(
    first.ledger.snapshots.map((snapshot) => snapshot.t0ExchangeMs),
    second.ledger.snapshots.map((snapshot) => snapshot.t0ExchangeMs)
  );

  assert.ok(first.ledger.snapshots.every((snapshot) => snapshot.origin === 'REPLAY'));
  assert.ok(first.ledger.resolutions.every((resolution) => resolution.origin === 'REPLAY'));
  assert.ok(first.ledger.resolutions.every((resolution) => resolution.targetTimestampMs <= T0));

  const live = buildAggregates(first.ledger.resolutions, 'LIVE');
  assert.ok(live.every((aggregate) => aggregate.samples === 0));

  const replay = buildAggregates(first.ledger.resolutions, 'REPLAY');
  assert.ok(replay.some((aggregate) => aggregate.samples > 0));

  // The ledger anchor is the requested live price.
  const lastSnapshot = first.ledger.snapshots[first.ledger.snapshots.length - 1];
  assert.ok(lastSnapshot.btcPriceAtT0 > 0);
  assert.ok(lastSnapshot.btcPriceAtT0 < 200_000);
});

test('replay records carry immutable snapshots and verified resolutions', () => {
  const seeded = seedReplayLedger(createLedger(), {
    nowExchangeMs: T0,
    anchorPrice: 64_000,
    hours: 3,
  });
  assert.ok(seeded.ledger.snapshots.every((snapshot) => verifySnapshot(snapshot)));
  assert.ok(seeded.ledger.resolutions.every((resolution) => verifyResolution(resolution)));
  assert.ok(seeded.ledger.snapshots.every((snapshot) => Object.isFrozen(snapshot)));
});

test('commit gate rejects stale feeds and non-positive prices', () => {
  const healthy = evaluateCommitGate({
    nowExchangeMs: T0,
    price: 64_000,
    lastTickMs: T0 - 4_000,
    clockState: 'SYNCED',
    clockOffsetMs: 12,
    tickCount: 60,
  });
  assert.equal(healthy.allowed, true);

  const stale = evaluateCommitGate({
    nowExchangeMs: T0,
    price: 64_000,
    lastTickMs: T0 - 120_000,
    clockState: 'SYNCED',
    clockOffsetMs: 12,
    tickCount: 60,
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.code, 'E1000');
  assert.match(stale.message, /STALE_SIGNAL_REJECT/);

  const missingPrice = evaluateCommitGate({
    nowExchangeMs: T0,
    price: null,
    lastTickMs: T0,
    clockState: 'SYNCED',
    clockOffsetMs: 0,
    tickCount: 60,
  });
  assert.equal(missingPrice.code, 'E3000');

  const drift = evaluateCommitGate({
    nowExchangeMs: T0,
    price: 64_000,
    lastTickMs: T0,
    clockState: 'DEGRADED',
    clockOffsetMs: 9_000,
    tickCount: 60,
  });
  assert.equal(drift.code, 'E1200');
});

test('feature engine and regime machine stay inside their domains', () => {
  const ticks: PriceTick[] = [];
  for (let i = 0; i < 220; i += 1) {
    ticks.push({ tsMs: T0 - (220 - i) * 4_000, price: 64_000 + Math.sin(i / 6) * 60 + i * 0.4 });
  }
  const frame = buildFeatureFrame(ticks);
  assert.ok(frame);
  assert.ok(frame!.snapshot.rsi14 >= 0 && frame!.snapshot.rsi14 <= 100);
  assert.ok(frame!.snapshot.atrPercent >= 0);
  assert.ok(frame!.hurstExponent >= 0 && frame!.hurstExponent <= 1);
  assert.ok(frame!.atrPercentile >= 0 && frame!.atrPercentile <= 1);

  const components = buildThreeComponentState(frame!, defaultCalibration());
  assert.ok(components.onnxCalibratedY > 0 && components.onnxCalibratedY < 1);
  assert.ok(components.jevGateConfidence > 0 && components.jevGateConfidence <= 1);
  assert.equal(EVALUATION_HORIZONS.length, Object.keys(components.impliedTargetPrices).length);
  assert.ok(Object.values(components.impliedTargetPrices).every((price) => price > 0));

  assert.equal(classifyRegime(0, 0.99, 0.6), 'HIGH_VOL_CRISIS');
  assert.equal(classifyRegime(0.01, 0.5, 0.5), 'RANGING_CHOP');
  assert.equal(classifyRegime(0.6, 0.5, 0.6), 'STRONG_BULL');
  assert.equal(classifyRegime(-0.6, 0.5, 0.6), 'STRONG_BEAR');
  assert.ok(estimateHurst([]) === 0.5);
});

test('exchange clock samples an offset with round-trip correction', async () => {
  const offset = 5_000;
  const nowSeconds = Date.now() / 1000 + offset / 1000;
  const sample = await sampleExchangeClock(async () => {
    return new Response(
      JSON.stringify({
        source: 'KRAKEN',
        authoritative: true,
        unixtime: nowSeconds,
        fetchedAtMs: Date.now(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });

  assert.equal(sample.authoritative, true);
  assert.equal(sample.source, 'KRAKEN');
  assert.ok(Math.abs(sample.offsetMs - offset) < 1_500);
  assert.ok(sample.rttMs >= 0);
});
