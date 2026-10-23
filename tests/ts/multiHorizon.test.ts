/**
 * Paragraph 2 — multi-horizon ledger, evaluation and statistical-honesty tests.
 * Run with: npm run test:horizon
 *
 * Three groups:
 *   1. point-in-time invariants (immutability, monotonicity, zero future leak)
 *   2. metric semantics (DA / MC / Brier / overlap correction / shrinkage)
 *   3. statistical honesty (an edge is only reported when one exists)
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
  replaceCalibration,
  verifyResolution,
  verifySnapshot,
  type HorizonLedger,
} from '../../src/features/multiHorizon/snapshotStore';
import {
  buildAggregates,
  computeResolution,
  horizonSigmaPercent,
  summariseHorizons,
  wilsonLowerBound,
} from '../../src/features/multiHorizon/evaluation';
import { defaultCalibration, updateCalibration } from '../../src/features/multiHorizon/calibration';
import { seedReplayLedger } from '../../src/features/multiHorizon/replay';
import {
  deriveM8Status,
  evaluateCommitGate,
  WARMUP_BARS,
} from '../../src/features/multiHorizon/riskGate';
import { sampleExchangeClock } from '../../src/features/multiHorizon/exchangeClock';
import {
  buildFeatureFrameFromBars,
  buildThreeComponentState,
  classifyRegime,
  ema,
  estimateHurst,
  resampleToBars,
  ticksFromBars,
  type Bar,
   type PriceTick,
} from '../../src/features/multiHorizon/featureEngine';
import { mergeBars, mergeBarsWithQuality } from '../../src/features/multiHorizon/historyFeed';
import {
  backfillWindow,
  fetchBatchBars,
  matchBarToTarget,
  resolveQueuedJobs,
  summariseQueue,
} from '../../src/features/multiHorizon/batchBackfill';
import {
  feedStatusOf,
  selectReferencePrice,
  type ReferencePrice,
} from '../../src/features/multiHorizon/referencePrice';
import {
  enqueueJob,
  queuedJobs,
  transitionJobs,
  verifyJob,
} from '../../src/features/multiHorizon/snapshotStore';
import type { LiveSpotObservation } from '../../src/utils/liveSpot';
import {
  ACCURACY_DIRECTION_WEIGHT,
  ACCURACY_MAGNITUDE_WEIGHT,
  MAX_CLOCK_SKEW_MS,
} from '../../src/features/multiHorizon/config';

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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
      sigmaPerMinutePercent: 0.08,
      sampleCount: 240,
    },
    ...overrides,
  };
}

function snapshotFixture(
  overrides: Partial<Parameters<typeof createSnapshot>[0]> = {}
): Paragraph2Snapshot {
  return createSnapshot({
    t0ExchangeMs: T0,
    btcPriceAtT0: 100,
    components: componentsFixture(),
    priceSource: 'LIVE_TICK',
    origin: 'LIVE',
    m8EngineStatus: 'ACTIVE',
    ...overrides,
  });
}

function resolutionFixture(
  horizon: HorizonMinutes,
  hit: boolean,
  accuracyPercent: number,
  resolvedAtMs: number = T0 + HORIZON_MS(horizon) + 1_000
): HorizonResolution {
  return {
    snapshotId: `FIX-${horizon}-${Math.random().toString(36).slice(2, 8)}`,
    horizonMinutes: horizon,
    targetTimestampMs: T0 + HORIZON_MS(horizon),
    resolvedAtExchangeMs: resolvedAtMs,
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
    observedAtExchangeMs: resolvedAtMs,
    verifiedAtExchangeMs: resolvedAtMs,
    verification: 'LIVE_TICK' as const,
    predictedProbabilityUp: 0.8,
    paperPnlPercent: hit ? 1 : -1,
    origin: 'LIVE',
    checksum: checksumOf({ fixture: `${horizon}-${hit}-${resolvedAtMs}` }),
  };
}

/** Deterministic synthetic 1-minute bar tape. */
function syntheticBars(options: {
  bars: number;
  seed: number;
  trendAmplitude?: number;
  volatility?: number;
  startPrice?: number;
  cycle?: number;
  fastCycle?: number;
}): Bar[] {
  const {
    bars: count,
    seed,
    trendAmplitude = 0,
    volatility = 0.00055,
    startPrice = 64_000,
    cycle = 400,
    fastCycle = 180,
  } = options;

  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let price = startPrice;
  const bars: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const drift =
      trendAmplitude *
      (0.7 * Math.sin((i / cycle) * Math.PI * 2 + 0.7) +
        0.3 * Math.sin((i / fastCycle) * Math.PI * 2 + 2.1));
    const open = price;
    price = price * (1 + drift + (rand() + rand() - 1) * volatility);
    bars.push({
      tsMs: T0 + i * 60_000,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: Number(price.toFixed(2)),
    });
  }
  return bars;
}

/**
 * Runs the real pipeline over a bar tape: snapshot → resolution →
 * calibration, exactly as the live hook does with observed ticks.
 */
function simulate(bars: readonly Bar[], strideMinutes = 1) {
  let ledger: HorizonLedger = createLedger();
  let calibration: CalibrationState = defaultCalibration();
  const maxHorizon = 300;

  for (let i = 260; i < bars.length - maxHorizon; i += strideMinutes) {
    const window = bars.slice(0, i + 1);
    const frame = buildFeatureFrameFromBars(window, 0);
    if (!frame) continue;
    const snapshot = createSnapshot({
      t0ExchangeMs: bars[i].tsMs,
      btcPriceAtT0: bars[i].close,
      components: buildThreeComponentState(frame, calibration),
      origin: 'LIVE',
      m8EngineStatus: 'ACTIVE',
    });
    const appended = appendSnapshot(ledger, snapshot);
    if (appended.error) continue;
    ledger = appended.ledger;

    for (const horizon of EVALUATION_HORIZONS) {
      if (i + horizon >= bars.length) continue;
      const target = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
      const draft = computeResolution(snapshot, horizon, bars[i + horizon].close, target);
      const resolved = appendResolution(ledger, draft, target + 60_000);
      if (!resolved.error) ledger = resolved.ledger;
    }

    calibration = updateCalibration(calibration, ledger.resolutions);
    ledger = replaceCalibration(ledger, calibration);
  }

  return { ledger, calibration, summary: summariseHorizons(ledger.resolutions, 0, calibration, 'LIVE') };
}

/* ------------------------------------------------------------------ */
/* 1. Point-in-time invariants                                        */
/* ------------------------------------------------------------------ */

test('seven mandatory horizons are exactly 5/15/30/60/120/180/300 minutes', () => {
  assert.deepEqual([...EVALUATION_HORIZONS], [5, 15, 30, 60, 120, 180, 300]);
  assert.equal(EVALUATION_HORIZONS.length, 7);
  assert.equal(HORIZON_MS(5), 300_000);
  assert.equal(HORIZON_MS(300), 18_000_000);
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
    // strict mode throws, sloppy mode silently ignores — both must be no-ops
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
  assert.equal(appendSnapshot(first.ledger, older).error?.code, 'E4100');
  assert.equal(appendSnapshot(first.ledger, snapshotFixture()).error?.code, 'E4100');
});

test('resolution cannot be evaluated before the horizon matures (zero future leak)', () => {
  const snapshot = snapshotFixture();
  assert.throws(() => computeResolution(snapshot, 5, 101, T0 + 1_000), /future leak/i);

  const ledger = appendSnapshot(createLedger(), snapshot).ledger;
  const draft = computeResolution(snapshot, 5, 101, T0 + HORIZON_MS(5));
  assert.equal(appendResolution(ledger, draft, T0 + 1_000).error?.code, 'E5000');

  const accepted = appendResolution(ledger, draft, T0 + HORIZON_MS(5) + 5_000);
  assert.equal(accepted.error, undefined);
  assert.ok(verifyResolution(accepted.ledger.resolutions[0]));

  // The snapshot itself is untouched by the resolution — no repainting.
  assert.equal(accepted.ledger.snapshots[0].horizons[5].status, 'pending');
  assert.equal(accepted.ledger.snapshots[0].horizons[5].actualBtcPrice, null);
  assert.ok(verifySnapshot(accepted.ledger.snapshots[0]));

  const duplicate = appendResolution(accepted.ledger, draft, T0 + HORIZON_MS(5) + 10_000);
  assert.equal(duplicate.error?.code, 'E4100');
});

/* ------------------------------------------------------------------ */
/* 2. Metric semantics                                                */
/* ------------------------------------------------------------------ */

test('resolution maths: directional hit, trajectory closeness, Brier', () => {
  const snapshot = snapshotFixture();
  const hit = computeResolution(snapshot, 60, 101, T0 + HORIZON_MS(60));
  assert.equal(hit.directionalHit, true);
  assert.equal(hit.actualDirection, 1);
  assert.ok(hit.magnitudeClosenessPercent > 90);
  assert.ok(hit.accuracyPercent >= 52);
  assert.ok(hit.brierContribution > 0 && hit.brierContribution < 0.25);
  assert.ok(hit.paperPnlPercent > 0);

  const miss = computeResolution(snapshot, 60, 97, T0 + HORIZON_MS(60));
  assert.equal(miss.directionalHit, false);
  assert.equal(miss.actualDirection, -1);
  assert.ok(miss.accuracyPercent < 45);
  assert.ok(miss.paperPnlPercent < 0);

  // An (almost) unchanged price lands inside the neutral band → flat outcome.
  const flat = computeResolution(snapshot, 5, 100.001, T0 + HORIZON_MS(5));
  assert.equal(flat.actualDirection, 0);
});

test('the neutral band scales with the horizon sigma, not a fixed percent', () => {
  const snapshot = snapshotFixture();
  const sigma5 = horizonSigmaPercent(snapshot, 5);
  const sigma300 = horizonSigmaPercent(snapshot, 300);
  assert.ok(sigma300 > sigma5 * 7, 'sigma must scale roughly with sqrt(h)');
  assert.ok(Math.abs(sigma300 / sigma5 - Math.sqrt(300 / 5)) < 0.01);

  // sigma5 ≈ 0.18 % → band 0.045 %; sigma300 ≈ 1.39 % → band 0.35 %.
  // A 0.05 % move is therefore decisive at 5 min and flat at 300 min.
  const five = computeResolution(snapshot, 5, 100.05, T0 + HORIZON_MS(5));
  const threeHundred = computeResolution(snapshot, 300, 100.05, T0 + HORIZON_MS(300));
  assert.equal(five.actualDirection, 1);
  assert.equal(threeHundred.actualDirection, 0);

  // Missing/!finite sigma must not produce NaN metrics.
  const broken = snapshotFixture({
    components: componentsFixture({
      features: { ...componentsFixture().features, sigmaPerMinutePercent: Number.NaN },
    }),
  });
  const robust = computeResolution(broken, 60, 101, T0 + HORIZON_MS(60));
  assert.ok(Number.isFinite(robust.magnitudeClosenessPercent));
  assert.ok(Number.isFinite(robust.accuracyPercent));
});

test('hit rate is measured on decisive outcomes and coverage is reported', () => {
  const resolutions = [
    ...Array.from({ length: 10 }, () => resolutionFixture(5, true, 70)),
    ...Array.from({ length: 10 }, () => resolutionFixture(5, false, 10)),
  ];
  const withFlats: HorizonResolution[] = [
    ...resolutions,
    ...Array.from({ length: 20 }, () => ({
      ...resolutionFixture(5, false, 50),
      actualDirection: 0 as Direction,
    })),
  ];

  const clean = buildAggregates(resolutions, 'LIVE').find((a) => a.horizonMinutes === 5)!;
  const padded = buildAggregates(withFlats, 'LIVE').find((a) => a.horizonMinutes === 5)!;

  assert.equal(clean.directionalAccuracyPercent, 50);
  assert.equal(padded.directionalAccuracyPercent, 50, 'flat outcomes must not move the hit rate');
  assert.equal(clean.coveragePercent, 100);
  assert.equal(padded.coveragePercent, 50);
  assert.equal(padded.neutralShare, 0.5);
  assert.equal(
    padded.accuracyPercent,
    Number(
      (
        ACCURACY_DIRECTION_WEIGHT * padded.directionalAccuracyPercent +
        ACCURACY_MAGNITUDE_WEIGHT * padded.magnitudeClosenessPercent
      ).toFixed(2)
    )
  );
});

test('overlapping windows are discounted (N_eff < N)', () => {
  // 60 snapshots one minute apart → a 60-minute horizon has N_eff ≈ 1.
  const resolutions: HorizonResolution[] = [];
  for (let i = 0; i < 60; i += 1) {
    const t0 = T0 + i * 60_000;
    resolutions.push({
      ...resolutionFixture(60, true, 80, t0 + HORIZON_MS(60)),
      snapshotId: `SNAP-${i}`,
      targetTimestampMs: t0 + HORIZON_MS(60),
    });
  }
  const aggregate = buildAggregates(resolutions, 'LIVE').find((a) => a.horizonMinutes === 60)!;
  assert.equal(aggregate.samples, 60);
  assert.ok(aggregate.effectiveSamples < 2, `N_eff must collapse, got ${aggregate.effectiveSamples}`);
  assert.ok(aggregate.confidenceWeight < 0.3);
  assert.equal(aggregate.isProvisional, false, 'one independent sample is not a proven horizon');
});

test('one lucky sample never outranks a proven horizon (Bayesian shrinkage)', () => {
  const proven: HorizonResolution[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = T0 + i * HORIZON_MS(5);
    proven.push({ ...resolutionFixture(5, true, 70, t0 + HORIZON_MS(5)), snapshotId: `P-${i}`, targetTimestampMs: t0 + HORIZON_MS(5) });
  }
  const lucky = [resolutionFixture(15, true, 100)];
  const aggregates = buildAggregates([...proven, ...lucky], 'LIVE');

  const five = aggregates.find((a) => a.horizonMinutes === 5)!;
  const fifteen = aggregates.find((a) => a.horizonMinutes === 15)!;
  assert.ok(five.rankedScore > fifteen.rankedScore);
  assert.equal(five.rank, 1);
  assert.ok(five.confidenceWeight > fifteen.confidenceWeight);
});

test('Wilson lower bound and confidence weight are monotone in sample size', () => {
  assert.ok(wilsonLowerBound(1, 1) < 100);
  assert.ok(wilsonLowerBound(20, 20) > wilsonLowerBound(1, 1));
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(51, 100) < 51, 'a 51 % hit rate on 100 samples is not significant');
});

test('calibration shrinks its bias instead of becoming a directional bet', () => {
  const overconfidentBear: HorizonResolution[] = Array.from({ length: 40 }, (_, index) => ({
    ...resolutionFixture(5, false, 10, T0 + HORIZON_MS(5) + index),
    predictedProbabilityUp: 0.92,
    actualDirection: -1,
    brierContribution: 0.85,
  }));
  const next = updateCalibration(defaultCalibration(), overconfidentBear);
  assert.ok(next.bias < 0, 'persistent bullish over-confidence must push the bias down');
  assert.ok(Math.abs(next.bias) <= 0.4, 'bias must stay inside its guard-rail');
  assert.ok(next.temperatureT >= 0.5 && next.temperatureT <= 3);
  assert.ok(next.rollingBrier > 0.5);

  // With no labelled outcomes nothing changes.
  const untouched = updateCalibration(defaultCalibration(), []);
  assert.deepEqual(untouched, defaultCalibration());
});

/* ------------------------------------------------------------------ */
/* 3. Statistical honesty                                             */
/* ------------------------------------------------------------------ */

test('a random walk is never declared tradeable', () => {
  const { summary } = simulate(syntheticBars({ bars: 1_200, seed: 4242, trendAmplitude: 0 }));
  assert.equal(summary.verdict.severity, 'warn');
  assert.notEqual(summary.verdict.code, null);
  assert.ok(
    ['E2000', 'E2100'].includes(summary.verdict.code as string),
    `expected a conservative gate, got ${summary.verdict.code}`
  );
});

test('a genuinely trending tape is detected and ranked', () => {
  const { summary } = simulate(
    syntheticBars({ bars: 1_200, seed: 4242, trendAmplitude: 0.00055 })
  );
  assert.equal(summary.verdict.severity, 'success');
  assert.ok(summary.best);
  assert.ok(summary.best!.directionalAccuracyPercent > 55);
  assert.ok(summary.best!.daLowerBoundPercent > 50);
  assert.ok(summary.best!.isOutOfSampleConsistent);
  assert.equal(summary.horizons.filter((h) => h.rank > 0).length, 7);
});

test('verdict stays conservative without data', () => {
  const empty = summariseHorizons([], 3, defaultCalibration());
  assert.equal(empty.verdict.code, 'E2000');
  assert.equal(empty.best, null);
  assert.equal(empty.liveResolutions, 0);
});

/* ------------------------------------------------------------------ */
/* 4. Feature engine / data layer                                     */
/* ------------------------------------------------------------------ */

test('ticks are resampled into 1-minute bars and merged with OHLC history', () => {
  const ticks: PriceTick[] = [
    { tsMs: T0, price: 100 },
    { tsMs: T0 + 10_000, price: 101 },
    { tsMs: T0 + 59_000, price: 99 },
    { tsMs: T0 + 61_000, price: 102 },
  ];
  const bars = resampleToBars(ticks);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].high, 101);
  assert.equal(bars[0].low, 99);
  assert.equal(bars[0].close, 99);
  assert.equal(bars[1].tsMs, T0 + 60_000);

  const history: Bar[] = [
    { tsMs: T0, open: 99.2, high: 99.6, low: 99, close: 99.5 },
    { tsMs: T0 + 60_000, open: 99.5, high: 99.9, low: 99.4, close: 101.2 },
  ];
  const merged = mergeBars(history, ticks);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].open, 99.2, 'history open is kept');
  assert.equal(merged[0].close, 99, 'live close wins for the overlapping bar');
  assert.equal(merged[0].high, 101, 'live high extends the bar');
  assert.equal(merged[1].close, 102);

  // Feed divergence: a 12 % gap between bar close and live price is refused
  // (it would fake a volatility spike and a HIGH_VOL_CRISIS regime).
  const divergent = mergeBarsWithQuality(history, [{ tsMs: T0 + 61_000, price: 113 }]);
  assert.equal(divergent.gapRejected, true);
  assert.ok(divergent.gapPercent !== null && divergent.gapPercent > 11);
  assert.equal(divergent.bars.length, 2, 'history is left untouched');
  assert.equal(divergent.bars[1].close, 101.2);
});

test('bar closes can stand in as the reference tick stream', () => {
  const bars: Bar[] = [
    { tsMs: T0, open: 100, high: 101, low: 99, close: 100.5 },
    { tsMs: T0 + 60_000, open: 100.5, high: 102, low: 100, close: 101.5 },
  ];
  const ticks = ticksFromBars(bars);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].tsMs, T0 + 60_000, 'a bar close belongs to the end of its minute');
  assert.equal(ticks[1].price, 101.5);
});

test('EMA is SMA-seeded and carries no lag while warming up', () => {
  const flat = new Array(300).fill(100);
  assert.ok(Math.abs(ema(flat, 200) - 100) < 1e-9);
  // Below the period the plain mean is returned (no phantom trend).
  assert.ok(Math.abs(ema([100, 102, 104], 200) - 102) < 1e-9);
  // SMA seed then iterate: a step series converges towards the new level.
  const step = [...new Array(200).fill(100), ...new Array(100).fill(120)];
  const value = ema(step, 50);
  assert.ok(value > 100 && value < 120, `EMA must sit between the regimes, got ${value}`);
  assert.ok(ema(step, 50) > ema(step, 200), 'faster EMA must lead the slower one');
});

test('feature frame stays inside its domains and reports per-minute volatility', () => {
  const bars = syntheticBars({ bars: 400, seed: 9, trendAmplitude: 0.0004 });
  const frame = buildFeatureFrameFromBars(bars, 0)!;
  assert.ok(frame);
  assert.ok(frame.snapshot.rsi14 >= 0 && frame.snapshot.rsi14 <= 100);
  assert.ok(frame.snapshot.atrPercent >= 0);
  assert.ok(frame.hurstExponent >= 0 && frame.hurstExponent <= 1);
  assert.ok(frame.atrPercentile >= 0 && frame.atrPercentile <= 1);
  // Per-minute volatility of 1-minute bars must be on a realistic scale
  // (percent), not a 4-second tick ATR that would flatten the target fan.
  assert.ok(
    frame.snapshot.sigmaPerMinutePercent > 0.01 && frame.snapshot.sigmaPerMinutePercent < 0.8,
    `sigma/min out of range: ${frame.snapshot.sigmaPerMinutePercent}`
  );

  const components = buildThreeComponentState(frame, defaultCalibration());
  assert.ok(components.onnxCalibratedY > 0 && components.onnxCalibratedY < 1);
  assert.ok(components.jevGateConfidence > 0 && components.jevGateConfidence <= 1);
  assert.equal(Object.keys(components.impliedTargetPrices).length, 7);
  assert.ok(Object.values(components.impliedTargetPrices).every((price) => price > 0));

  // Implied targets must be a meaningful distance from spot, ordered by horizon.
  const price = frame.snapshot.price;
  const far = Math.abs(components.impliedTargetPrices[300] / price - 1) * 100;
  const near = Math.abs(components.impliedTargetPrices[5] / price - 1) * 100;
  assert.ok(far >= near, 'longer horizons must not have smaller displacement');
  assert.ok(far > 0.02, `target fan is too tight to be meaningful (${far.toFixed(4)}%)`);
});

test('regime machine covers all six states', () => {
  assert.equal(classifyRegime(0, 0.99, 0.6), 'HIGH_VOL_CRISIS');
  assert.equal(classifyRegime(0.01, 0.5, 0.5), 'RANGING_CHOP');
  assert.equal(classifyRegime(0.6, 0.5, 0.6), 'STRONG_BULL');
  assert.equal(classifyRegime(0.2, 0.5, 0.6), 'WEAK_BULL');
  assert.equal(classifyRegime(-0.6, 0.5, 0.6), 'STRONG_BEAR');
  assert.equal(classifyRegime(-0.2, 0.5, 0.6), 'WEAK_BEAR');
  assert.equal(estimateHurst([]), 0.5);
});

/* ------------------------------------------------------------------ */
/* 5. Gates, replay and clock                                         */
/* ------------------------------------------------------------------ */

test('commit gate rejects stale feeds, bad prices and clock drift', () => {
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

  assert.equal(
    evaluateCommitGate({
      nowExchangeMs: T0,
      price: null,
      lastTickMs: T0,
      clockState: 'SYNCED',
      clockOffsetMs: 0,
      tickCount: 60,
    }).code,
    'E3000'
  );

  assert.equal(
    evaluateCommitGate({
      nowExchangeMs: T0,
      price: 64_000,
      lastTickMs: T0,
      clockState: 'DEGRADED',
      clockOffsetMs: 9_000,
      tickCount: 60,
    }).code,
    'E1200'
  );

  // A local-clock fallback is allowed but must be flagged degraded.
  const local = evaluateCommitGate({
    nowExchangeMs: T0,
    price: 64_000,
    lastTickMs: T0,
    clockState: 'LOCAL',
    clockOffsetMs: 0,
    tickCount: 60,
  });
  assert.equal(local.allowed, true);
  assert.equal(local.degraded, true);
  assert.ok(MAX_CLOCK_SKEW_MS > 0);
});

test('M8 status degrades during warm-up and hostility, never silently', () => {
  const allowed = { allowed: true, code: null, severity: 'info' as const, message: '', degraded: false };
  assert.equal(deriveM8Status(allowed, 'WEAK_BULL', WARMUP_BARS + 1), 'ACTIVE');
  assert.equal(deriveM8Status(allowed, 'WEAK_BULL', WARMUP_BARS - 1), 'THROTTLED');
  assert.equal(deriveM8Status(allowed, 'HIGH_VOL_CRISIS', WARMUP_BARS + 1), 'THROTTLED');
  assert.equal(
    deriveM8Status({ ...allowed, allowed: false }, 'WEAK_BULL', WARMUP_BARS + 1),
    'QUARANTINED'
  );
});

test('replay seeding is deterministic, tagged REPLAY and excluded from LIVE metrics', () => {
  const options = { nowExchangeMs: T0, anchorPrice: 64_000, seed: 42, hours: 6 };
  const first = seedReplayLedger(createLedger(), options);
  const second = seedReplayLedger(createLedger(), options);

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
  assert.ok(first.ledger.snapshots.every((snapshot) => verifySnapshot(snapshot)));
  assert.ok(first.ledger.resolutions.every((resolution) => verifyResolution(resolution)));

  // Live aggregates stay empty and live graduation cannot be earned by replay.
  const live = buildAggregates(first.ledger.resolutions, 'LIVE');
  assert.ok(live.every((aggregate) => aggregate.samples === 0));
  const liveSummary = summariseHorizons(first.ledger.resolutions, 0, defaultCalibration(), 'LIVE');
  assert.equal(liveSummary.graduation.samples, 0);

  const replay = buildAggregates(first.ledger.resolutions, 'REPLAY');
  assert.ok(replay.some((aggregate) => aggregate.samples > 0));
});

test('a full replay horizon can demonstrate a tradeable verdict (demo path)', () => {
  const seeded = seedReplayLedger(createLedger(), {
    nowExchangeMs: T0,
    anchorPrice: 64_000,
    hours: 24,
    snapshotIntervalMinutes: 15,
  });
  const summary = summariseHorizons(
    seeded.ledger.resolutions,
    0,
    seeded.ledger.calibration,
    'REPLAY'
  );
  assert.ok(summary.liveResolutions > 400);
  assert.equal(summary.verdict.severity, 'success');
  assert.ok(summary.best!.samples > 20);
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

/* ------------------------------------------------------------------ */
/* 6. No fallback prices                                              */
/* ------------------------------------------------------------------ */

test('no price is ever invented: missing or stale data yields null', () => {
  const now = T0;
  const freshObs: LiveSpotObservation = {
    symbol: 'BTC',
    price: 64_000,
    updatedAtMs: now - 2_000,
    source: 'KRAKEN_TICKERS',
  };
  const staleObs: LiveSpotObservation = { ...freshObs, updatedAtMs: now - 10 * 60_000 };
  const freshBar: Bar = { tsMs: now - 60_000, open: 63_000, high: 64_000, low: 63_000, close: 63_900 };
  const staleBar: Bar = { ...freshBar, tsMs: now - 30 * 60_000 };

  // nothing at all → null (the widget must not snapshot)
  assert.equal(
    selectReferencePrice({ observation: null, lastBar: null, nowMs: now, maxAgeMs: 90_000 }),
    null
  );
  // stale observation and stale bar → still null, never "last known"
  assert.equal(
    selectReferencePrice({ observation: staleObs, lastBar: staleBar, nowMs: now, maxAgeMs: 90_000 }),
    null
  );
  // fresh live tick wins
  const live = selectReferencePrice({
    observation: freshObs,
    lastBar: freshBar,
    nowMs: now,
    maxAgeMs: 90_000,
  }) as ReferencePrice;
  assert.equal(live.source, 'LIVE_TICK');
  assert.equal(live.price, 64_000);
  assert.equal(feedStatusOf(live), 'LIVE');

  // live tick stale, real bar close fresh → BAR_CLOSE (still a venue price)
  const barOnly = selectReferencePrice({
    observation: staleObs,
    lastBar: freshBar,
    nowMs: now,
    maxAgeMs: 90_000,
  }) as ReferencePrice;
  assert.equal(barOnly.source, 'BAR_CLOSE');
  assert.equal(barOnly.price, 63_900);
  assert.equal(feedStatusOf(barOnly), 'BAR_ONLY');

  // a "future" observation beyond clock drift is not trusted either
  assert.equal(
    selectReferencePrice({
      observation: { ...freshObs, updatedAtMs: now + 60_000 },
      lastBar: null,
      nowMs: now,
      maxAgeMs: 90_000,
    }),
    null
  );
  assert.equal(feedStatusOf(null), 'MISSING');
});

test('snapshots refuse to be created without a real observed price', () => {
  assert.throws(
    () =>
      createSnapshot({
        t0ExchangeMs: T0,
        btcPriceAtT0: Number.NaN,
        components: componentsFixture(),
        priceSource: 'LIVE_TICK',
      }),
    /real observed price/i
  );
  assert.throws(
    () =>
      createSnapshot({
        t0ExchangeMs: T0,
        btcPriceAtT0: 0,
        components: componentsFixture(),
        priceSource: 'BAR_CLOSE',
      }),
    /real observed price/i
  );

  const snapshot = snapshotFixture({ priceSource: 'BAR_CLOSE' });
  assert.equal(snapshot.priceSource, 'BAR_CLOSE');
  assert.ok(verifySnapshot(snapshot));
});

/* ------------------------------------------------------------------ */
/* 7. Offline comparison queue + single batch backfill                */
/* ------------------------------------------------------------------ */

test('a matured horizon without an observation is queued, not fabricated', () => {
  const ledger = appendSnapshot(createLedger(), snapshotFixture()).ledger;
  const horizon: HorizonMinutes = 5;
  const targetMs = T0 + HORIZON_MS(horizon);

  const first = enqueueJob(ledger, {
    snapshotId: ledger.snapshots[0].id,
    horizonMinutes: horizon,
    targetMs,
    nowExchangeMs: targetMs + 1_000,
  });
  assert.equal(first.added, true);
  assert.equal(queuedJobs(first.ledger).length, 1);
  assert.ok(verifyJob(queuedJobs(first.ledger)[0]));

  // Idempotent — the same comparison is never queued twice.
  const second = enqueueJob(first.ledger, {
    snapshotId: ledger.snapshots[0].id,
    horizonMinutes: horizon,
    targetMs,
    nowExchangeMs: targetMs + 2_000,
  });
  assert.equal(second.added, false);
  assert.equal(queuedJobs(second.ledger).length, 1);

  // Already-resolved horizons are never queued.
  const resolution = computeResolution(ledger.snapshots[0], horizon, 101, targetMs);
  const resolvedLedger = appendResolution(ledger, resolution, targetMs + 1_000).ledger;
  const third = enqueueJob(resolvedLedger, {
    snapshotId: ledger.snapshots[0].id,
    horizonMinutes: horizon,
    targetMs,
    nowExchangeMs: targetMs + 3_000,
  });
  assert.equal(third.added, false);
  assert.equal(queuedJobs(third.ledger).length, 0);
});

test('one batch request resolves the whole missed window from real bar closes', () => {
  // Three snapshots, each 5 minutes apart; the feed was down at every target.
  const snapshots = [0, 5, 10].map((offsetMinutes) =>
    snapshotFixture({ t0ExchangeMs: T0 + offsetMinutes * 60_000, btcPriceAtT0: 100 })
  );
  let ledger = createLedger();
  for (const snapshot of snapshots) {
    ledger = appendSnapshot(ledger, snapshot).ledger;
  }
  const nowExchangeMs = T0 + 30 * 60_000;
  for (const snapshot of snapshots) {
    const targetMs = snapshot.t0ExchangeMs + HORIZON_MS(5);
    ledger = enqueueJob(ledger, {
      snapshotId: snapshot.id,
      horizonMinutes: 5,
      targetMs,
      nowExchangeMs,
    }).ledger;
  }
  assert.equal(queuedJobs(ledger).length, 3);

  // The window the widget would request in ONE call.
  const window = backfillWindow(queuedJobs(ledger), nowExchangeMs)!;
  assert.ok(window.fromMs <= T0 + HORIZON_MS(5));
  assert.ok(window.toMs >= T0 + 10 * 60_000 + HORIZON_MS(5));

  // Venue bars for the missed minutes (real closes, one per minute).
  const bars: Bar[] = [];
  for (let minute = 0; minute <= 30; minute += 1) {
    const price = 100 + minute * 0.1;
    bars.push({
      tsMs: T0 + minute * 60_000,
      open: price,
      high: price,
      low: price,
      close: price,
    });
  }

  const flush = resolveQueuedJobs(ledger, bars, nowExchangeMs);
  assert.equal(flush.resolved, 3);
  assert.equal(flush.unresolvable, 0);
  assert.equal(queuedJobs(flush.ledger).length, 0);
  assert.equal(flush.ledger.resolutions.length, 3);
  assert.ok(flush.ledger.resolutions.every((resolution) => resolution.verification === 'BATCH_BACKFILL'));
  assert.ok(flush.ledger.resolutions.every((resolution) => verifyResolution(resolution)));

  // Each outcome uses the real close of its target minute, never an estimate.
  for (const resolution of flush.ledger.resolutions) {
    assert.equal(resolution.observedAtExchangeMs, resolution.targetTimestampMs + 60_000);
    const minute = Math.round((resolution.targetTimestampMs - T0) / 60_000);
    assert.equal(resolution.actualBtcPrice, Number((100 + minute * 0.1).toFixed(2)));
  }

  // Jobs are closed out and the queue summary reflects the backfill.
  const summary = summariseQueue(flush.ledger.jobs, nowExchangeMs);
  assert.equal(summary.queued, 0);
  assert.equal(summary.resolvedByBackfill, 3);
});

test('a hole in the venue history yields unresolvable, never an interpolation', () => {
  const snapshot = snapshotFixture();
  let ledger = appendSnapshot(createLedger(), snapshot).ledger;
  const targetMs = snapshot.t0ExchangeMs + HORIZON_MS(15);
  ledger = enqueueJob(ledger, {
    snapshotId: snapshot.id,
    horizonMinutes: 15,
    targetMs,
    nowExchangeMs: targetMs + 10 * 60_000,
  }).ledger;

  // Bars exist, but the target minute itself is missing (venue gap).
  const bars: Bar[] = [
    { tsMs: targetMs - 10 * 60_000, open: 100, high: 100, low: 100, close: 100 },
    { tsMs: targetMs + 10 * 60_000, open: 101, high: 101, low: 101, close: 101 },
  ];
  assert.equal(matchBarToTarget(targetMs, bars), null);

  const flush = resolveQueuedJobs(ledger, bars, targetMs + 10 * 60_000);
  assert.equal(flush.resolved, 0);
  assert.equal(flush.unresolvable, 1);
  assert.equal(flush.ledger.resolutions.length, 0, 'no price may be invented for the hole');
  assert.equal(flush.ledger.jobs[0].status, 'unresolvable');
  assert.match(flush.ledger.jobs[0].lastError ?? '', /keine Schätzung/);
});

test('queue resolution never touches the snapshot (no repainting)', () => {
  const snapshot = snapshotFixture();
  let ledger = appendSnapshot(createLedger(), snapshot).ledger;
  const targetMs = T0 + HORIZON_MS(30);
  ledger = enqueueJob(ledger, {
    snapshotId: snapshot.id,
    horizonMinutes: 30,
    targetMs,
    nowExchangeMs: targetMs + 60_000,
  }).ledger;

  const bars: Bar[] = [
    { tsMs: targetMs, open: 100, high: 103, low: 100, close: 103 },
  ];
  const flush = resolveQueuedJobs(ledger, bars, targetMs + 60_000);
  const after = flush.ledger.snapshots[0];
  assert.equal(after.btcPriceAtT0, snapshot.btcPriceAtT0);
  assert.equal(after.horizons[30].actualBtcPrice, null);
  assert.equal(after.horizons[30].status, 'pending');
  assert.deepEqual(after, snapshot);
  assert.ok(verifySnapshot(after));
});

test('a queued comparison only matures by exchange time', () => {
  const snapshot = snapshotFixture();
  let ledger = appendSnapshot(createLedger(), snapshot).ledger;
  const targetMs = T0 + HORIZON_MS(60);
  ledger = enqueueJob(ledger, {
    snapshotId: snapshot.id,
    horizonMinutes: 60,
    targetMs,
    nowExchangeMs: targetMs - 60_000,
  }).ledger;

  const bars: Bar[] = [{ tsMs: targetMs, open: 100, high: 101, low: 100, close: 101 }];
  const early = resolveQueuedJobs(ledger, bars, targetMs - 1);
  assert.equal(early.resolved, 0);
  assert.equal(early.skipped, 1);
  assert.equal(queuedJobs(early.ledger).length, 1, 'the job stays queued');

  const mature = resolveQueuedJobs(ledger, bars, targetMs + 1_000);
  assert.equal(mature.resolved, 1);
});

test('batch fetch sends exactly one request for the whole window', async () => {
  const calls: string[] = [];
  const bars = [
    { tsMs: T0, open: 100, high: 100, low: 100, close: 100 },
    { tsMs: T0 + 60_000, open: 100, high: 101, low: 100, close: 101 },
  ];
  const result = await fetchBatchBars(T0, T0 + 60_000, async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({ source: 'KRAKEN', authoritative: true, bars, latencyMs: 5 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });

  assert.equal(calls.length, 1, 'one request, not one per data point');
  assert.match(calls[0], /\/api\/exchange\/ohlc\/batch/);
  assert.match(calls[0], /from=\d+/);
  assert.match(calls[0], /to=\d+/);
  assert.equal(result.authoritative, true);
  assert.equal(result.bars.length, 2);
  assert.equal(result.error, null);
});

test('a failed batch keeps the queue intact and records the reason', async () => {
  const result = await fetchBatchBars(T0, T0 + 600_000, async () =>
    new Response(JSON.stringify({ error: 'kraken unreachable' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(result.authoritative, false);
  assert.equal(result.bars.length, 0);
  assert.ok(result.error);

  const ledger = appendSnapshot(createLedger(), snapshotFixture()).ledger;
  const queued = enqueueJob(ledger, {
    snapshotId: ledger.snapshots[0].id,
    horizonMinutes: 5,
    targetMs: T0 + HORIZON_MS(5),
    nowExchangeMs: T0 + HORIZON_MS(5),
  }).ledger;
  const retried = transitionJobs(queued, [
    {
      id: queuedJobs(queued)[0].id,
      status: 'queued',
      attempts: 1,
      lastAttemptExchangeMs: T0,
      lastError: result.error,
    },
  ]);
  assert.equal(queuedJobs(retried).length, 1, 'still queued for the next attempt');
  assert.equal(retried.jobs[0].attempts, 1);
  assert.ok(verifyJob(retried.jobs[0]));
});
