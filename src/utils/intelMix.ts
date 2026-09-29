/**
 * Blend for the gravity field's third component.
 * Several intel sources share one slot. A source with no live value is left
 * out. Fallbacks are used only when every enabled primary is dark.
 */

export type IntelFreshness = 'live' | 'stale' | 'off';

export interface IntelSourceInput {
  id: string;
  label: string;
  /** Configured share. Non-positive weights never contribute. */
  weight: number;
  enabled: boolean;
  /** Used only after every enabled primary source is dark. */
  fallback: boolean;
  /** Null when this source has nothing to contribute. */
  value: number | null;
  status: IntelFreshness;
}

export interface IntelContribution {
  id: string;
  label: string;
  value: number;
  /** Share of the mix after the contributing sources are renormalized. */
  weight: number;
  fallback: boolean;
  status: 'live' | 'stale';
}

export interface IntelMix {
  /** Null when nothing contributed. The third component then stays out of the field. */
  value: number | null;
  contributions: IntelContribution[];
  sources: IntelSourceInput[];
}

function usable(source: IntelSourceInput): boolean {
  return source.enabled
    && source.weight > 0
    && source.value != null
    && Number.isFinite(source.value)
    && source.value >= 0
    && source.value <= 1
    && (source.status === 'live' || source.status === 'stale');
}

function copySource(source: IntelSourceInput): IntelSourceInput {
  return {
    id: source.id,
    label: source.label,
    weight: source.weight,
    enabled: source.enabled,
    fallback: source.fallback,
    value: source.value,
    status: source.status,
  };
}

/** Weighted mix of the sources that are actually on and have a value. */
export function mixIntel(sources: readonly IntelSourceInput[]): IntelMix {
  const listed = sources.map(copySource);
  const primaries = listed.filter((source) => !source.fallback && usable(source));
  const chosen = primaries.length > 0
    ? primaries
    : listed.filter((source) => source.fallback && usable(source));
  if (chosen.length === 0) return { value: null, contributions: [], sources: listed };

  const total = chosen.reduce((sum, source) => sum + source.weight, 0);
  const contributions: IntelContribution[] = [];
  for (const source of chosen) {
    if (source.value == null || (source.status !== 'live' && source.status !== 'stale')) continue;
    contributions.push({
      id: source.id,
      label: source.label,
      value: source.value,
      weight: source.weight / total,
      fallback: source.fallback,
      status: source.status,
    });
  }
  const value = contributions.reduce((sum, item) => sum + item.weight * item.value, 0);
  return { value, contributions, sources: listed };
}

export function intelEntersField(mix: IntelMix | null | undefined): boolean {
  return mix != null && mix.value != null && Number.isFinite(mix.value);
}

/** Card line. A dark mix says it is out of the field instead of inventing 50%. */
export function intelConsensusText(mix: IntelMix | null | undefined): string {
  if (!intelEntersField(mix) || mix == null || mix.value == null) return 'ausgeschlossen';
  const pct = `${(mix.value * 100).toFixed(0)}% Up`;
  const names = mix.contributions.map((item) => {
    const role = item.fallback ? `${item.label} fallback` : item.label;
    return item.status === 'stale' ? `${role} stale` : role;
  });
  return names.length > 0 ? `${pct} · ${names.join(' + ')}` : pct;
}

export function intelSourceLine(mix: IntelMix | null | undefined): string {
  if (mix == null || mix.sources.length === 0) return '';
  return mix.sources.map((source) => {
    const role = source.fallback ? `${source.label} fallback` : source.label;
    if (!source.enabled) return `${role} inaktiv`;
    if (source.status === 'off' || source.value == null) return `${role} aus`;
    const used = mix.contributions.find((item) => item.id === source.id);
    const weight = used ? used.weight : source.weight;
    return `${role} ${source.status} w${weight.toFixed(2)}`;
  }).join(' · ');
}
