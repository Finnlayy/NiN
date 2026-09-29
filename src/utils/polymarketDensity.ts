/**
 * Discrete density of a Polymarket "BTC above strike" ladder.
 * Yes is cumulative, C(K) = P(S > K). The bin that contains spot is not split.
 */

export interface StrikeRung {
  strike: number;
  yes: number;
}

export interface DensityBin {
  /** Null is the open tail below the first strike. */
  lo: number | null;
  /** Null is the open tail above the last strike. */
  hi: number | null;
  mass: number;
}

export interface DensityLadder {
  bins: DensityBin[];
  /** Probability mass in bins that lie entirely above spot. */
  poly: number;
}

const RISE_TOLERANCE = 0.02;
const MIN_RUNGS = 3;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Drop a later rung when its Yes price rises by more than 0.02, or when the
 * strike does not move up. Fewer than three rungs left means no density.
 */
export function densityFromLadder(rungs: readonly StrikeRung[], spot: number): DensityLadder | null {
  if (!finite(spot)) return null;
  const sorted = rungs
    .filter((rung) => finite(rung.strike) && rung.strike > 0 && finite(rung.yes) && rung.yes >= 0 && rung.yes <= 1)
    .slice()
    .sort((a, b) => a.strike - b.strike);

  const kept: StrikeRung[] = [];
  for (const rung of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && rung.strike <= prev.strike) continue;
    if (prev && rung.yes > prev.yes + RISE_TOLERANCE) continue;
    kept.push({ strike: rung.strike, yes: rung.yes });
  }
  if (kept.length < MIN_RUNGS) return null;

  const raw: DensityBin[] = [];
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (!first || !last) return null;
  raw.push({ lo: null, hi: first.strike, mass: Math.max(0, 1 - first.yes) });
  for (let i = 0; i < kept.length - 1; i += 1) {
    const left = kept[i];
    const right = kept[i + 1];
    if (!left || !right) return null;
    raw.push({ lo: left.strike, hi: right.strike, mass: Math.max(0, left.yes - right.yes) });
  }
  raw.push({ lo: last.strike, hi: null, mass: Math.max(0, last.yes) });

  const total = raw.reduce((sum, bin) => sum + bin.mass, 0);
  if (!(total > 0)) return null;
  const bins = raw.map((bin) => ({ ...bin, mass: bin.mass / total }));

  let poly = 0;
  for (const bin of bins) {
    if (containsSpot(bin, spot)) continue;
    if (bin.lo != null && bin.lo >= spot) poly += bin.mass;
  }
  return { bins, poly };
}

function containsSpot(bin: DensityBin, spot: number): boolean {
  if (bin.lo == null && bin.hi != null) return spot <= bin.hi;
  if (bin.lo != null && bin.hi == null) return spot > bin.lo;
  if (bin.lo != null && bin.hi != null) return bin.lo < spot && spot <= bin.hi;
  return false;
}
