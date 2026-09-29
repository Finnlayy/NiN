/**
 * Shared fixture for the third-component mix, plus the adapter's fallback switch.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeForces, DEFAULT_GRAVITY_PARAMS } from '../src/utils/gravityMath';
import { intelConsensusText, intelEntersField, mixIntel, type IntelSourceInput } from '../src/utils/intelMix';
import { readIntel, readIntelSources, type IntelSource } from './intelAdapter';

interface FixtureCase {
  name: string;
  sources: IntelSourceInput[];
  value: number | null;
  ids: string[];
}

const fixturePath = resolve(process.cwd(), 'Architect/tests/fixtures/intel_mix.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { cases: FixtureCase[] };

function close(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-9) throw new Error(`${label}: ${actual} != ${expected}`);
}

for (const item of fixture.cases) {
  const mix = mixIntel(item.sources);
  if (item.value == null) {
    if (mix.value != null) throw new Error(`${item.name} should be empty, got ${mix.value}`);
  } else {
    if (mix.value == null) throw new Error(`${item.name} produced no mix`);
    close(mix.value, item.value, item.name);
  }
  const ids = mix.contributions.map((entry) => entry.id);
  if (ids.join(',') !== item.ids.join(',')) {
    throw new Error(`${item.name} ids ${ids.join(',')} != ${item.ids.join(',')}`);
  }
  const weightSum = mix.contributions.reduce((sum, entry) => sum + entry.weight, 0);
  if (mix.contributions.length > 0) close(weightSum, 1, `${item.name} weights`);
}

const away = 84141;
const placeholder = computeForces(away, 83891, 0.62, 0.2, 0.5, DEFAULT_GRAVITY_PARAMS, true);
const excluded = computeForces(away, 83891, 0.62, 0.2, 0.5, DEFAULT_GRAVITY_PARAMS, false);
if (Math.abs(excluded.fNet - placeholder.fNet) < 1e-6) {
  throw new Error('a dark third component still changes the net force');
}
if (excluded.fPoly !== 0) throw new Error('excluded poly force must be 0');

const desk: IntelSource = {
  id: 'desk',
  label: 'Desk',
  weight: 1,
  enabled: true,
  fallback: false,
  read: async () => {
    throw new Error('desk down');
  },
};
const note: IntelSource = {
  id: 'note',
  label: 'Note',
  weight: 2,
  enabled: true,
  fallback: true,
  read: async () => ({ value: 0.3, status: 'live' }),
};

async function checkAdapter(): Promise<void> {
  const fallen = await readIntelSources(83891, [desk, note]);
  if (fallen.value == null) throw new Error('fallback should cover a thrown primary');
  close(fallen.value, 0.3, 'fallback value');
  if (fallen.contributions[0]?.id !== 'note') throw new Error('note should be the only contribution');
  if (intelConsensusText(fallen) !== '30% Up · Note fallback') throw new Error(intelConsensusText(fallen));

  const previousEnabled = process.env.INTEL_STATIC_ENABLED;
  const previousValue = process.env.INTEL_STATIC_VALUE;
  const previousFeed = process.env.POLYMARKET_FEED;
  delete process.env.POLYMARKET_FEED;
  delete process.env.INTEL_STATIC_ENABLED;
  delete process.env.INTEL_STATIC_VALUE;
  try {
    const dark = await readIntel(83891);
    if (intelEntersField(dark)) throw new Error('offline feed must stay out of the field');
    if (intelConsensusText(dark) !== 'ausgeschlossen') throw new Error(intelConsensusText(dark));
    const ids = dark.sources.map((source) => source.id);
    if (!ids.includes('polymarket') || !ids.includes('static')) {
      throw new Error(`registry missing a built-in: ${ids.join(',')}`);
    }

    process.env.INTEL_STATIC_ENABLED = 'true';
    process.env.INTEL_STATIC_VALUE = '0.25';
    const backed = await readIntel(83891);
    if (backed.value == null) throw new Error('static fallback did not activate');
    close(backed.value, 0.25, 'static fallback');
    if (!backed.contributions[0]?.fallback) throw new Error('static contribution should be marked fallback');
  } finally {
    if (previousEnabled == null) delete process.env.INTEL_STATIC_ENABLED;
    else process.env.INTEL_STATIC_ENABLED = previousEnabled;
    if (previousValue == null) delete process.env.INTEL_STATIC_VALUE;
    else process.env.INTEL_STATIC_VALUE = previousValue;
    if (previousFeed == null) delete process.env.POLYMARKET_FEED;
    else process.env.POLYMARKET_FEED = previousFeed;
  }
}

checkAdapter()
  .then(() => {
    console.log('intel mix ok', { cases: fixture.cases.length });
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
