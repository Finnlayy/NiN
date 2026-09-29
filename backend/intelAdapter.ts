/**
 * Third-component adapter. Register a source with `registerIntelSource`.
 * Primaries are mixed by weight when they have a live or stale value.
 * A fallback is used only when every enabled primary is dark.
 * `enabled: false` parks a source without removing it.
 *
 * Per-process overrides, id uppercased with non-alphanumerics as underscores:
 * INTEL_<ID>_WEIGHT, INTEL_<ID>_ENABLED (true|false), INTEL_<ID>_FALLBACK (true|false).
 *
 * The Polymarket ladder is the built-in primary. A static number is installed
 * as a fallback and stays off until INTEL_STATIC_ENABLED=true and
 * INTEL_STATIC_VALUE is a probability in [0, 1]. A dark adapter returns no
 * value, and the field leaves the third component out.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readPolymarket } from './polymarket';
import {
  mixIntel,
  type IntelFreshness,
  type IntelMix,
  type IntelSourceInput,
} from '../src/utils/intelMix';

export interface IntelReading {
  value: number | null;
  status: IntelFreshness;
}

export interface IntelSource {
  id: string;
  label: string;
  weight: number;
  enabled: boolean;
  fallback: boolean;
  read(spot: number): Promise<IntelReading>;
}

const registry: IntelSource[] = [];

/** Install or replace one source. Later registrations with the same id win. */
export function registerIntelSource(source: IntelSource): void {
  const index = registry.findIndex((item) => item.id === source.id);
  if (index >= 0) registry[index] = source;
  else registry.push(source);
}

export function listIntelSources(): readonly IntelSource[] {
  return registry;
}

function envKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function flag(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Apply INTEL_<ID>_* overrides onto a registered source. */
export function configureIntelSource(source: IntelSource): IntelSource {
  const key = envKey(source.id);
  const weightRaw = process.env[`INTEL_${key}_WEIGHT`];
  const weight = weightRaw != null && weightRaw.trim() !== '' ? Number(weightRaw) : source.weight;
  const enabled = flag(process.env[`INTEL_${key}_ENABLED`]);
  const fallback = flag(process.env[`INTEL_${key}_FALLBACK`]);
  return {
    ...source,
    weight: Number.isFinite(weight) ? weight : source.weight,
    enabled: enabled == null ? source.enabled : enabled,
    fallback: fallback == null ? source.fallback : fallback,
  };
}

function unitValue(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

async function readPolymarketSource(spot: number): Promise<IntelReading> {
  const snap = await readPolymarket(spot);
  if (snap.polySource === 'neutral') return { value: null, status: 'off' };
  return { value: snap.poly, status: snap.polySource === 'stale' ? 'stale' : 'live' };
}

async function readStaticSource(): Promise<IntelReading> {
  const value = unitValue(process.env.INTEL_STATIC_VALUE);
  if (value == null) return { value: null, status: 'off' };
  return { value, status: 'live' };
}

function installDefaults(): void {
  registerIntelSource({
    id: 'polymarket',
    label: 'Polymarket',
    weight: 1,
    enabled: true,
    fallback: false,
    read: readPolymarketSource,
  });
  registerIntelSource({
    id: 'static',
    label: 'Static',
    weight: 1,
    enabled: false,
    fallback: true,
    read: () => readStaticSource(),
  });
}

installDefaults();

function dark(source: IntelSource): IntelSourceInput {
  return {
    id: source.id,
    label: source.label,
    weight: source.weight,
    enabled: source.enabled,
    fallback: source.fallback,
    value: null,
    status: 'off',
  };
}

/** Read one list of sources. A thrown reader counts as off so the others still mix. */
export async function readIntelSources(spot: number, sources: readonly IntelSource[]): Promise<IntelMix> {
  const readings: IntelSourceInput[] = [];
  for (const source of sources) {
    const configured = configureIntelSource(source);
    if (!configured.enabled) {
      readings.push(dark(configured));
      continue;
    }
    try {
      const got = await configured.read(spot);
      const value = got.value != null && Number.isFinite(got.value) ? got.value : null;
      readings.push({
        id: configured.id,
        label: configured.label,
        weight: configured.weight,
        enabled: true,
        fallback: configured.fallback,
        value,
        status: value == null ? 'off' : got.status,
      });
    } catch {
      readings.push(dark({ ...configured, enabled: true }));
    }
  }
  return mixIntel(readings);
}

export function readIntel(spot: number): Promise<IntelMix> {
  return readIntelSources(spot, registry);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

export async function handleIntelApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const raw = req.url || '/';
  const pathOnly = raw.split('?')[0] || '/';
  if (method !== 'GET' || pathOnly !== '/api/market/intel') return false;
  const spot = Number(new URL(raw, 'http://localhost').searchParams.get('spot'));
  if (!Number.isFinite(spot) || !(spot > 0)) {
    sendJson(res, 400, { error: 'SPOT_REQUIRED', gateOpen: false });
    return true;
  }
  const mix = await readIntel(spot);
  sendJson(res, 200, { ...mix, spot, gateOpen: false });
  return true;
}
