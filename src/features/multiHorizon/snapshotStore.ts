/**
 * Point-in-time snapshot ledger (append-only).
 *
 * Contract:
 *   1. Snapshots are deeply frozen before they are handed out. A snapshot's
 *      `t0`, `P(t0)` and component values can therefore never be rewritten.
 *   2. Resolutions are a separate collection keyed by (snapshotId, horizon).
 *      The snapshot itself stays untouched — no repainting, ever.
 *   3. Every record carries an FNV-1a checksum; hydration verifies it and
 *      quarantines (drops + reports E4000) anything that was tampered with.
 *   4. `appendSnapshot` enforces strictly monotonic `t0` per origin, which
 *      makes back-dated inserts impossible.
 */

import {
  LEDGER_STORAGE_KEY,
  LEDGER_VERSION,
  MAX_STORED_RESOLUTIONS,
  MAX_STORED_SNAPSHOTS,
} from './config';
import {
  EVALUATION_HORIZONS,
  HORIZON_MS,
  type CalibrationState,
  type GovernanceEvent,
  type HorizonEvaluationSlot,
  type HorizonMinutes,
  type HorizonResolution,
  type M8EngineStatus,
  type Paragraph2Snapshot,
  type SnapshotOrigin,
  type ThreeComponentState,
} from './types';
import type { ResolutionDraft } from './evaluation';
import { defaultCalibration } from './calibration';

export interface HorizonLedger {
  version: number;
  snapshots: Paragraph2Snapshot[];
  resolutions: HorizonResolution[];
  calibration: CalibrationState;
  governance: GovernanceEvent[];
}

export interface LedgerMutationResult {
  ledger: HorizonLedger;
  error?: { code: GovernanceEvent['code']; message: string };
}

const MAX_GOVERNANCE_EVENTS = 40;

/* ------------------------------------------------------------------ */
/* Checksums                                                          */
/* ------------------------------------------------------------------ */

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalise(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`).join(',')}}`;
}

/** FNV-1a 32-bit — small, dependency-free and stable across reloads. */
export function checksumOf(value: unknown): string {
  const payload = canonicalise(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Ledger creation                                                    */
/* ------------------------------------------------------------------ */

export function createLedger(): HorizonLedger {
  return {
    version: LEDGER_VERSION,
    snapshots: [],
    resolutions: [],
    calibration: defaultCalibration(),
    governance: [],
  };
}

function buildPendingHorizons(
  t0ExchangeMs: number
): Record<HorizonMinutes, HorizonEvaluationSlot> {
  const slots = {} as Record<HorizonMinutes, HorizonEvaluationSlot>;
  for (const horizon of EVALUATION_HORIZONS) {
    slots[horizon] = deepFreeze({
      horizonMinutes: horizon,
      status: 'pending' as const,
      targetTimestampMs: t0ExchangeMs + HORIZON_MS(horizon),
      actualBtcPrice: null,
      actualDirection: null,
      directionalHit: null,
      absPercentageError: null,
      brierContribution: null,
      accuracyPercent: null,
    });
  }
  return Object.freeze(slots) as Record<HorizonMinutes, HorizonEvaluationSlot>;
}

export interface SnapshotInput {
  t0ExchangeMs: number;
  btcPriceAtT0: number;
  components: ThreeComponentState;
  origin?: SnapshotOrigin;
  m8EngineStatus?: M8EngineStatus;
}

export function createSnapshot(input: SnapshotInput): Paragraph2Snapshot {
  const origin = input.origin ?? 'LIVE';
  const t0 = Math.round(input.t0ExchangeMs);
  const payload = {
    id: `S2-${t0}-${origin.slice(0, 1)}`,
    t0ExchangeMs: t0,
    btcPriceAtT0: Number(input.btcPriceAtT0.toFixed(2)),
    origin,
    m8EngineStatus: input.m8EngineStatus ?? 'ACTIVE',
    components: input.components,
    horizons: buildPendingHorizons(t0),
  };
  const checksum = checksumOf(payload);
  return deepFreeze({ ...payload, checksum });
}

export function verifySnapshot(snapshot: Paragraph2Snapshot): boolean {
  const { checksum, ...payload } = snapshot;
  return checksumOf(payload) === checksum;
}

export function verifyResolution(resolution: HorizonResolution): boolean {
  const { checksum, ...payload } = resolution;
  return checksumOf(payload) === checksum;
}

/* ------------------------------------------------------------------ */
/* Governance                                                         */
/* ------------------------------------------------------------------ */

export function recordGovernance(
  ledger: HorizonLedger,
  event: Omit<GovernanceEvent, 'id'>
): HorizonLedger {
  const entry: GovernanceEvent = {
    ...event,
    id: `${event.code}-${event.atMs}-${ledger.governance.length}`,
  };
  return {
    ...ledger,
    governance: [...ledger.governance, entry].slice(-MAX_GOVERNANCE_EVENTS),
  };
}

/* ------------------------------------------------------------------ */
/* Append-only mutations                                              */
/* ------------------------------------------------------------------ */

export function appendSnapshot(
  ledger: HorizonLedger,
  snapshot: Paragraph2Snapshot
): LedgerMutationResult {
  if (!verifySnapshot(snapshot)) {
    return {
      ledger,
      error: {
        code: 'E4000',
        message: `Snapshot ${snapshot.id} verletzt die Prüfsumme — keine Aufnahme (Integrität).`,
      },
    };
  }
  if (ledger.snapshots.some((entry) => entry.id === snapshot.id)) {
    return {
      ledger,
      error: { code: 'E4100', message: `Snapshot ${snapshot.id} existiert bereits (Duplikat).` },
    };
  }
  const sameOrigin = ledger.snapshots.filter((entry) => entry.origin === snapshot.origin);
  const last = sameOrigin[sameOrigin.length - 1];
  if (last && snapshot.t0ExchangeMs <= last.t0ExchangeMs) {
    return {
      ledger,
      error: {
        code: 'E4100',
        message: `t0 ${new Date(snapshot.t0ExchangeMs).toISOString()} liegt nicht nach dem letzten Snapshot (Monotonie verletzt).`,
      },
    };
  }

  const snapshots = [...ledger.snapshots, snapshot].slice(-MAX_STORED_SNAPSHOTS);
  return { ledger: { ...ledger, snapshots } };
}

export function appendResolution(
  ledger: HorizonLedger,
  draft: ResolutionDraft,
  nowExchangeMs: number
): LedgerMutationResult {
  const snapshot = ledger.snapshots.find((entry) => entry.id === draft.snapshotId);
  if (!snapshot) {
    return {
      ledger,
      error: {
        code: 'E4100',
        message: `Auflösung ohne Snapshot ${draft.snapshotId} — Herkunft nicht belegbar.`,
      },
    };
  }
  if (draft.resolvedAtExchangeMs < draft.targetTimestampMs) {
    return {
      ledger,
      error: {
        code: 'E5000',
        message: `Horizont ${draft.horizonMinutes} min ist noch nicht gereift — Auflösung verweigert (Zukunftsleck).`,
      },
    };
  }
  if (nowExchangeMs < draft.targetTimestampMs) {
    return {
      ledger,
      error: {
        code: 'E5000',
        message: `Börsenuhr ${new Date(nowExchangeMs).toISOString()} liegt vor der Zielzeit — Auflösung verweigert.`,
      },
    };
  }
  if (
    ledger.resolutions.some(
      (entry) =>
        entry.snapshotId === draft.snapshotId && entry.horizonMinutes === draft.horizonMinutes
    )
  ) {
    return {
      ledger,
      error: {
        code: 'E4100',
        message: `Horizont ${draft.horizonMinutes} min für ${draft.snapshotId} ist bereits aufgelöst (keine Neubewertung).`,
      },
    };
  }

  const payload = { ...draft };
  const resolution = deepFreeze({ ...payload, checksum: checksumOf(payload) }) as HorizonResolution;

  const resolutions = [...ledger.resolutions, resolution].slice(-MAX_STORED_RESOLUTIONS);
  return { ledger: { ...ledger, resolutions } };
}

export function replaceCalibration(
  ledger: HorizonLedger,
  calibration: CalibrationState
): HorizonLedger {
  return { ...ledger, calibration };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface LedgerLoadResult {
  ledger: HorizonLedger;
  corruptedRecords: number;
  restored: boolean;
}

/**
 * Hydrates the ledger, verifying every checksum. Corrupted records are dropped
 * and reported through the governance channel instead of being trusted.
 */
export function loadLedger(): LedgerLoadResult {
  const storage = getStorage();
  if (!storage) {
    return { ledger: createLedger(), corruptedRecords: 0, restored: false };
  }

  try {
    const raw = storage.getItem(LEDGER_STORAGE_KEY);
    if (!raw) {
      return { ledger: createLedger(), corruptedRecords: 0, restored: false };
    }
    const parsed = JSON.parse(raw) as Partial<HorizonLedger>;
    if (!parsed || parsed.version !== LEDGER_VERSION) {
      return { ledger: createLedger(), corruptedRecords: 0, restored: false };
    }

    let corruptedRecords = 0;
    const snapshots: Paragraph2Snapshot[] = [];
    for (const candidate of parsed.snapshots ?? []) {
      if (candidate && verifySnapshot(candidate)) snapshots.push(deepFreeze(candidate));
      else corruptedRecords += 1;
    }
    const resolutions: HorizonResolution[] = [];
    for (const candidate of parsed.resolutions ?? []) {
      if (candidate && verifyResolution(candidate)) resolutions.push(deepFreeze(candidate));
      else corruptedRecords += 1;
    }

    let ledger: HorizonLedger = {
      version: LEDGER_VERSION,
      snapshots: snapshots.slice(-MAX_STORED_SNAPSHOTS),
      resolutions: resolutions.slice(-MAX_STORED_RESOLUTIONS),
      calibration: parsed.calibration ?? defaultCalibration(),
      governance: Array.isArray(parsed.governance) ? parsed.governance.slice(-MAX_GOVERNANCE_EVENTS) : [],
    };

    if (corruptedRecords > 0) {
      ledger = recordGovernance(ledger, {
        code: 'E4000',
        severity: 'error',
        layer: 'NOIR',
        message: `${corruptedRecords} Ledger-Datensatz(e) mit ungültiger Prüfsumme quarantänisiert.`,
        atMs: Date.now(),
      });
    }

    return { ledger, corruptedRecords, restored: true };
  } catch {
    return { ledger: createLedger(), corruptedRecords: 0, restored: false };
  }
}

export function saveLedger(ledger: HorizonLedger): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger));
    return true;
  } catch {
    // Quota exceeded — the in-memory ledger keeps working, persistence does not.
    return false;
  }
}

export function clearPersistedLedger(): void {
  try {
    getStorage()?.removeItem(LEDGER_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

/** Count of horizon slots that are still waiting for their target time. */
export function countPendingHorizons(
  snapshots: readonly Paragraph2Snapshot[],
  resolutions: readonly HorizonResolution[],
  nowExchangeMs: number,
  origin: SnapshotOrigin = 'LIVE'
): number {
  const resolvedKeys = new Set(
    resolutions.map((resolution) => `${resolution.snapshotId}:${resolution.horizonMinutes}`)
  );
  let pending = 0;
  for (const snapshot of snapshots) {
    if (snapshot.origin !== origin) continue;
    for (const horizon of EVALUATION_HORIZONS) {
      const target = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
      if (nowExchangeMs < target) {
        pending += 1;
      } else if (!resolvedKeys.has(`${snapshot.id}:${horizon}`)) {
        // Matured but unresolved: still an open slot (feed gap / orphan).
        pending += 1;
      }
    }
  }
  return pending;
}

/** Latest LIVE snapshot, or null. */
export function latestSnapshot(
  snapshots: readonly Paragraph2Snapshot[],
  origin: SnapshotOrigin = 'LIVE'
): Paragraph2Snapshot | null {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    if (snapshots[i].origin === origin) return snapshots[i];
  }
  return null;
}
