/**
 * [Noir] — Validation & Risk Gate.
 *
 * Nothing reaches the ledger or the tradeable verdict without passing here.
 * All rejections are expressed in the Unified Error Taxonomy (E1000–E5000) so
 * the UI can render a precise reason instead of an empty panel.
 */

import { MAX_CLOCK_SKEW_MS, MAX_FEED_AGE_MS, MIN_BARS_FOR_SNAPSHOT } from './config';
import type { ErrorCode, ErrorSeverity, MarketRegime, M8EngineStatus } from './types';
import type { ClockState } from './exchangeClock';

export interface CommitGateInput {
  nowExchangeMs: number;
  price: number | null;
  lastTickMs: number | null;
  clockState: ClockState;
  clockOffsetMs: number;
  tickCount: number;
}

export interface GateDecision {
  allowed: boolean;
  code: ErrorCode | null;
  severity: ErrorSeverity;
  message: string;
  /** Snapshot is still written but flagged / degraded. */
  degraded: boolean;
}

const pass = (message: string, degraded = false): GateDecision => ({
  allowed: true,
  code: degraded ? 'E1200' : null,
  severity: degraded ? 'warn' : 'info',
  message,
  degraded,
});

const reject = (code: ErrorCode, message: string, severity: ErrorSeverity = 'error'): GateDecision => ({
  allowed: false,
  code,
  message,
  severity,
  degraded: false,
});

/**
 * Pre-commit gate. Rejects stale signals (E1000) and clock drift (E1200);
 * allows a non-authoritative local clock only in degraded mode.
 */
export function evaluateCommitGate(input: CommitGateInput): GateDecision {
  if (input.clockState === 'DEGRADED' || Math.abs(input.clockOffsetMs) > MAX_CLOCK_SKEW_MS) {
    return reject(
      'E1200',
      `Börsenuhr-Abweichung ${input.clockOffsetMs.toFixed(0)} ms überschreitet die Toleranz von ${MAX_CLOCK_SKEW_MS} ms — Signal verworfen.`
    );
  }
  if (input.price === null || !Number.isFinite(input.price) || input.price <= 0) {
    return reject('E3000', 'Kein gültiger BTC-Preis vom Kraken-Feed — Snapshot verworfen.');
  }
  if (input.tickCount < MIN_BARS_FOR_SNAPSHOT) {
    return reject(
      'E2000',
      `Nur ${input.tickCount} 1-Minuten-Bar${input.tickCount === 1 ? '' : 's'} im Puffer (Minimum ${MIN_BARS_FOR_SNAPSHOT}) — Feature-Fenster noch nicht belastbar.`,
      'warn'
    );
  }
  if (input.lastTickMs === null) {
    return reject('E1000', 'STALE_SIGNAL_REJECT: kein Tick-Zeitstempel vorhanden.');
  }
  const feedAgeMs = input.nowExchangeMs - input.lastTickMs;
  if (!Number.isFinite(feedAgeMs) || Math.abs(feedAgeMs) > MAX_FEED_AGE_MS) {
    return reject(
      'E1000',
      `STALE_SIGNAL_REJECT: Feed-Alter ${Math.round(feedAgeMs / 1000)} s überschreitet ${MAX_FEED_AGE_MS / 1000} s.`
    );
  }
  if (input.clockState === 'LOCAL') {
    return pass(
      'Lokale Uhr als Fallback aktiv (Kraken-Zeit nicht erreichbar) — Snapshot als THROTTLED markiert.',
      true
    );
  }
  return pass('Signalintegrität bestätigt: Börsenuhr synchron, Feed frisch, Feature-Fenster belegt.');
}

/** Bars required before EMA200 / ATR-percentile / Hurst are all warm. */
export const WARMUP_BARS = 200;

export function deriveM8Status(
  gate: GateDecision,
  regime: MarketRegime,
  barCount: number
): M8EngineStatus {
  if (!gate.allowed) return 'QUARANTINED';
  if (gate.degraded || barCount < WARMUP_BARS) return 'THROTTLED';
  if (regime === 'HIGH_VOL_CRISIS') return 'THROTTLED';
  return 'ACTIVE';
}

export interface ResolutionGateInput {
  targetMs: number;
  resolvedAtMs: number;
  nowExchangeMs: number;
  actualPrice: number | null;
}

/** Pre-resolution gate: no future leak, no fabricated price. */
export function evaluateResolutionGate(input: ResolutionGateInput): GateDecision {
  if (input.nowExchangeMs < input.targetMs) {
    return reject('E5000', 'Zielzeit noch nicht erreicht — Auflösung verweigert (Zero Future Leak).');
  }
  if (input.resolvedAtMs < input.targetMs) {
    return reject('E5000', 'Auflösungszeitstempel liegt vor der Zielzeit — verworfen.');
  }
  if (input.actualPrice === null || !Number.isFinite(input.actualPrice) || input.actualPrice <= 0) {
    return reject('E3000', 'Kein realisierter Preis für die Zielzeit verfügbar — Slot bleibt offen.');
  }
  return pass('Horizont gereift; realisierter Preis aus dem Feed übernommen.');
}
