/**
 * Fixture check for the Polymarket density and the fail-closed Gamma feed.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeForces, DEFAULT_GRAVITY_PARAMS } from '../src/utils/gravityMath';
import { densityFromLadder, type StrikeRung } from '../src/utils/polymarketDensity';
import { polyConsensusText } from '../src/utils/liveGravity';
import {
  neutralPolymarket,
  parseGammaPayload,
  polymarketFreshness,
  readPolymarketWith,
  resetPolymarketCache,
} from './polymarket';

interface Fixture {
  spot: number;
  ladder: StrikeRung[];
  masses: number[];
  poly: number;
  rising: StrikeRung[];
  short: StrikeRung[];
  gamma: unknown;
}

const fixturePath = resolve(process.cwd(), 'Architect/tests/fixtures/polymarket_density.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: ${actual} != ${expected}`);
  }
}

const density = densityFromLadder(fixture.ladder, fixture.spot);
if (!density) throw new Error('fixture ladder produced no density');
if (density.bins.length !== fixture.masses.length) {
  throw new Error(`bin count ${density.bins.length} != ${fixture.masses.length}`);
}
density.bins.forEach((bin, index) => {
  const expected = fixture.masses[index];
  if (expected == null) throw new Error(`missing mass ${index}`);
  close(bin.mass, expected, `mass ${index}`);
});
close(density.poly, fixture.poly, 'poly');
close(density.bins.reduce((sum, bin) => sum + bin.mass, 0), 1, 'mass sum');

if (densityFromLadder(fixture.rising, fixture.spot) !== null) {
  throw new Error('rising ladder should fail closed');
}
if (densityFromLadder(fixture.short, fixture.spot) !== null) {
  throw new Error('short ladder should fail closed');
}

const parsed = parseGammaPayload(fixture.gamma, 'btc-above-fixture');
if (!parsed) throw new Error('gamma fixture did not parse');
const fromGamma = densityFromLadder(parsed.ladder, fixture.spot);
if (!fromGamma) throw new Error('parsed gamma ladder produced no density');
close(fromGamma.poly, fixture.poly, 'gamma poly');
if (parsed.ladder.some((rung) => rung.strike === 0)) {
  throw new Error('non-numeric strike was kept');
}

const atNeutral = computeForces(fixture.spot, fixture.spot, 0.5, 0.5, 0.5, DEFAULT_GRAVITY_PARAMS);
const failed = densityFromLadder(fixture.rising, fixture.spot);
const fallbackPoly = failed ? failed.poly : neutralPolymarket(fixture.spot).poly;
const atFallback = computeForces(fixture.spot, fixture.spot, 0.5, 0.5, fallbackPoly, DEFAULT_GRAVITY_PARAMS);
close(atFallback.fNet, atNeutral.fNet, 'fail-closed force');
close(atFallback.fPoly, atNeutral.fPoly, 'fail-closed poly force');

if (polyConsensusText(0.5, 'neutral') !== '50% Up') throw new Error('neutral label');
if (polyConsensusText(0.4, 'gamma') !== '40% Up · Gamma') throw new Error('gamma label');
if (polyConsensusText(0.4, 'stale') !== '40% Up · stale') throw new Error('stale label');

if (polymarketFreshness(59_000) !== 'gamma') throw new Error('59s should be fresh');
if (polymarketFreshness(61_000) !== 'stale') throw new Error('61s should be stale');
if (polymarketFreshness(5 * 60_000) !== 'neutral') throw new Error('5 min should be neutral');

async function checkFeed(): Promise<void> {
  const previousFeed = process.env.POLYMARKET_FEED;
  const previousSlug = process.env.POLYMARKET_EVENT_SLUG;
  process.env.POLYMARKET_FEED = 'true';
  process.env.POLYMARKET_EVENT_SLUG = 'btc-above-fixture';
  resetPolymarketCache();
  try {
    const live = await readPolymarketWith(fixture.spot, 1_000, async () => fixture.gamma);
    if (live.polySource !== 'gamma' || live.gateOpen !== false) {
      throw new Error(`expected gamma snapshot, got ${live.polySource}`);
    }
    close(live.poly, fixture.poly, 'feed poly');
    if (live.gateDisplay !== false) throw new Error('0.40 must not raise the 0.60 display flag');

    const stale = await readPolymarketWith(fixture.spot, 1_000 + 61_000, async () => {
      throw new Error('GAMMA_DOWN');
    });
    if (stale.polySource !== 'stale') throw new Error(`expected stale, got ${stale.polySource}`);
    close(stale.poly, fixture.poly, 'stale poly');
    if (stale.gateOpen !== false) throw new Error('stale gate must stay closed');

    const junk = await readPolymarketWith(fixture.spot, 1_000 + 61_000, async () => [{
      slug: 'btc-above-fixture',
      markets: [{ groupItemTitle: 'not-a-strike', outcomePrices: '["0.5","0.5"]' }],
    }]);
    if (junk.polySource !== 'neutral') throw new Error(`rejected ladder should be neutral, got ${junk.polySource}`);
    close(junk.poly, 0.5, 'rejected poly');

    const risingSnap = await readPolymarketWith(fixture.spot, 9_000_000, async () => [{
      slug: 'btc-above-fixture',
      markets: fixture.rising.map((rung) => ({
        groupItemTitle: String(rung.strike),
        outcomePrices: [String(rung.yes), '0'],
      })),
    }]);
    if (risingSnap.polySource !== 'neutral') throw new Error('rising ladder must fail closed');
    close(risingSnap.poly, 0.5, 'rising poly');
    const afterJunk = computeForces(fixture.spot, fixture.spot, 0.5, 0.5, junk.poly, DEFAULT_GRAVITY_PARAMS);
    close(afterJunk.fNet, atNeutral.fNet, 'rejected payload force');
  } finally {
    resetPolymarketCache();
    if (previousFeed == null) delete process.env.POLYMARKET_FEED;
    else process.env.POLYMARKET_FEED = previousFeed;
    if (previousSlug == null) delete process.env.POLYMARKET_EVENT_SLUG;
    else process.env.POLYMARKET_EVENT_SLUG = previousSlug;
  }
}

checkFeed()
  .then(() => {
    console.log('polymarket density ok', { poly: density.poly, masses: density.bins.map((bin) => bin.mass) });
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
