/**
 * Orchestration hook for the Paragraph 2 multi-horizon accuracy widget.
 *
 * Pipeline order (MANAS : CIEL):
 *   [Blanche] exchange clock, real price observations, bar history, features
 *   [Jaune]   immutable snapshot computation (three components, 7 targets)
 *   [Noir]    commit gate, maturation gate, offline comparison queue, verdict
 *   [Rouge]   renders through <MultiHorizonAccuracyWidget />
 *
 * Two hard rules:
 *   1. **No fallback prices.** Every recorded price is a real venue observation
 *      (live tick or Kraken bar close) with a timestamp. If neither is fresh,
 *      no snapshot is created and the UI says so — nothing is invented.
 *   2. **No lost comparisons.** A horizon that matures while the feed is down
 *      becomes a queued comparison job; one batch request over the missed
 *      window resolves all of them (and only from real bar closes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_FEED_AGE_MS,
  MIN_BARS_FOR_SNAPSHOT,
  QUEUE_FLUSH_INTERVAL_MS,
  SNAPSHOT_CADENCE_MS,
  TICK_POLL_MS,
} from '../features/multiHorizon/config';
import { useExchangeClock } from '../features/multiHorizon/exchangeClock';
import {
  buildFeatureFrameFromBars,
  buildThreeComponentState,
  type PriceTick,
} from '../features/multiHorizon/featureEngine';
import {
  HISTORY_REFRESH_MS,
  emptyHistory,
  fetchHistoryBars,
  mergeBars,
  mergeBarsWithQuality,
  type HistoryState,
} from '../features/multiHorizon/historyFeed';
import {
  computeResolution,
  summariseHorizons,
  type ResolutionDraft,
} from '../features/multiHorizon/evaluation';
import { updateCalibration } from '../features/multiHorizon/calibration';
import {
  deriveM8Status,
  evaluateCommitGate,
  type GateDecision,
} from '../features/multiHorizon/riskGate';
import {
  appendResolution,
  appendSnapshot,
  clearPersistedLedger,
  countPendingHorizons,
  createLedger,
  createSnapshot,
  enqueueJob,
  latestSnapshot,
  loadLedger,
  pruneJobs,
  queuedJobs,
  recordGovernance,
  replaceCalibration,
  saveLedger,
  transitionJobs,
  type HorizonLedger,
  type LedgerLoadResult,
} from '../features/multiHorizon/snapshotStore';
import {
  backfillWindow,
  fetchBatchBars,
  resolveQueuedJobs,
  summariseQueue,
  type BatchBarsResult,
} from '../features/multiHorizon/batchBackfill';
import {
  feedStatusOf,
  selectReferencePrice,
  type FeedStatus,
  type ReferencePrice,
} from '../features/multiHorizon/referencePrice';
import { seedReplayLedger } from '../features/multiHorizon/replay';
import type {
  ErrorCode,
  ErrorSeverity,
  GovernanceEvent,
  HorizonAggregate,
  HorizonMinutes,
  HorizonResolution,
  Paragraph2Snapshot,
  PriceSource,
  SnapshotOrigin,
  SubAgentLayer,
} from '../features/multiHorizon/types';
import { EVALUATION_HORIZONS, HORIZON_MS } from '../features/multiHorizon/types';
import { observeLiveSpot, type LiveSpotObservation } from '../utils/liveSpot';

export type LogFn = (
  message: string,
  level: 'info' | 'warn' | 'error' | 'success',
  node?: string
) => void;

export interface QueueView {
  queued: number;
  oldestTargetMs: number | null;
  oldestAgeMs: number | null;
  unresolvable: number;
  resolvedByBackfill: number;
  byHorizon: Array<{ horizonMinutes: number; queued: number }>;
}

export interface BatchView {
  attemptedAtMs: number | null;
  fromMs: number | null;
  toMs: number | null;
  bars: number;
  resolved: number;
  error: string | null;
  isRunning: boolean;
}

export interface MultiHorizonAccuracy {
  ledger: HorizonLedger;
  latest: Paragraph2Snapshot | null;
  latestReplay: Paragraph2Snapshot | null;
  summary: ReturnType<typeof summariseHorizons>;
  liveSummary: ReturnType<typeof summariseHorizons>;
  ticks: readonly PriceTick[];
  clock: ReturnType<typeof useExchangeClock>;
  commitGate: GateDecision | null;
  showReplay: boolean;
  history: HistoryState;
  /** Real observed price only — `null` means the feed is genuinely missing. */
  livePrice: number | null;
  priceSource: PriceSource | null;
  priceAgeMs: number | null;
  feedStatus: FeedStatus;
  queue: QueueView;
  lastBatch: BatchView;
  totalLiveSnapshots: number;
  totalReplaySnapshots: number;
  resolutions: readonly HorizonResolution[];
  aggregates: HorizonAggregate[];
  governance: readonly GovernanceEvent[];
  commitNow: () => void;
  flushQueue: () => void;
  loadReplay: () => void;
  clearReplay: () => void;
  resetLedger: () => void;
  setShowReplay: (value: boolean) => void;
}

const MAX_TICK_BUFFER = 1_500;
/** Only resolve a target if the app was already observing the feed then. */
const RESOLUTION_BUFFER_TOLERANCE_MS = 1_500;

const EMPTY_BATCH: BatchView = {
  attemptedAtMs: null,
  fromMs: null,
  toMs: null,
  bars: 0,
  resolved: 0,
  error: null,
  isRunning: false,
};

function pushGovernance(
  ledger: HorizonLedger,
  code: ErrorCode,
  message: string,
  severity: ErrorSeverity,
  layer: SubAgentLayer,
  atMs: number
): HorizonLedger {
  const last = ledger.governance[ledger.governance.length - 1];
  if (last && last.code === code && atMs - last.atMs < 30_000) {
    return ledger;
  }
  return recordGovernance(ledger, { code, message, severity, layer, atMs });
}

export function useMultiHorizonAccuracy(onLogEvent?: LogFn): MultiHorizonAccuracy {
  const clock = useExchangeClock();
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const logRef = useRef<LogFn | undefined>(onLogEvent);
  logRef.current = onLogEvent;

  const initialLoadRef = useRef<LedgerLoadResult | null>(null);
  const [ledger, setLedger] = useState<HorizonLedger>(() => {
    const loaded = loadLedger();
    initialLoadRef.current = loaded;
    return loaded.ledger;
  });
  const ledgerRef = useRef<HorizonLedger>(ledger);
  ledgerRef.current = ledger;

  const [ticks, setTicks] = useState<PriceTick[]>([]);
  const ticksRef = useRef<PriceTick[]>([]);
  const [history, setHistory] = useState<HistoryState>(() => emptyHistory());
  const historyRef = useRef<HistoryState>(history);
  historyRef.current = history;

  const [observation, setObservation] = useState<LiveSpotObservation | null>(null);
  const [commitGate, setCommitGate] = useState<GateDecision | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [lastBatch, setLastBatch] = useState<BatchView>(EMPTY_BATCH);
  const flushInFlightRef = useRef(false);
  const lastFlushAttemptRef = useRef(0);
  const lastTickRecordRef = useRef(0);

  const applyLedger = useCallback((next: HorizonLedger) => {
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Persistence                                                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    saveLedger(ledger);
  }, [ledger]);

  useEffect(() => {
    const loaded = initialLoadRef.current;
    if (!loaded?.restored) return;
    logRef.current?.(
      `Paragraph-2-Ledger wiederhergestellt: ${loaded.ledger.snapshots.length} Snapshots, ${loaded.ledger.resolutions.length} Auflösungen, ${queuedJobs(loaded.ledger).length} offene Vergleiche${
        loaded.corruptedRecords > 0 ? ` · ${loaded.corruptedRecords} korrupte Datensätze quarantänisiert (E4000)` : ''
      }.`,
      loaded.corruptedRecords > 0 ? 'warn' : 'info',
      'The Judge (M8)'
    );
  }, []);

  /* ---------------------------------------------------------------- */
  /* [Blanche] price observations                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const poll = () => {
      const next = observeLiveSpot('BTC');
      setObservation(next);
      const reference = selectReferencePrice({
        observation: next,
        lastBar: historyRef.current.bars[historyRef.current.bars.length - 1] ?? null,
        nowMs: clockRef.current.nowMs,
        maxAgeMs: MAX_FEED_AGE_MS,
      });
      // Only genuinely observed values enter the tick buffer.
      if (!reference) return;
      const tsMs = Math.round(reference.observedAtMs);
      const previous = ticksRef.current;
      const last = previous[previous.length - 1];
      if (last && tsMs <= last.tsMs) return;
      const nextTicks = [...previous, { tsMs, price: reference.price }].slice(-MAX_TICK_BUFFER);
      ticksRef.current = nextTicks;
      lastTickRecordRef.current = Date.now();
      setTicks(nextTicks);
    };

    poll();
    const timer = setInterval(poll, TICK_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /* ---------------------------------------------------------------- */
  /* [Blanche] 1-minute bar history backfill                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      setHistory((previous) => ({ ...previous, isLoading: true }));
      const next = await fetchHistoryBars();
      if (cancelled) return;
      setHistory(next);
      if (!next.authoritative) {
        logRef.current?.(
          `OHLC-Historie nicht verfügbar (${next.error ?? 'unbekannt'}) — Paragraph 2 arbeitet im Warm-up mit live beobachteten 1-Minuten-Bars.`,
          'warn',
          'Blanche'
        );
      }
    };

    void pull();
    const timer = setInterval(pull, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* [Jaune] reference + snapshot commit                              */
  /* ---------------------------------------------------------------- */

  const lastBar = history.bars[history.bars.length - 1] ?? null;
  const reference = useMemo(
    () =>
      selectReferencePrice({
        observation,
        lastBar,
        nowMs: clock.nowMs,
        maxAgeMs: MAX_FEED_AGE_MS,
      }),
    [observation, lastBar, clock.nowMs]
  );
  const referenceRef = useRef<ReferencePrice | null>(reference);
  referenceRef.current = reference;

  const feedStatus = feedStatusOf(reference);

  const attemptCommit = useCallback(
    (manual: boolean) => {
      const currentClock = clockRef.current;
      const nowExchangeMs = Math.round(currentClock.nowMs);
      const buffer = ticksRef.current;
      const currentReference = referenceRef.current;

      // No real observation → no snapshot. This is the whole point of the
      // no-fallback rule: a missing feed must never be papered over.
      if (!currentReference) {
        const gate: GateDecision = {
          allowed: false,
          code: 'E1000',
          severity: 'warn',
          message:
            'Keine echte Kursbeobachtung (weder Live-Tick noch frischer Börsen-Bar-Schluss) — kein Snapshot. Offene Vergleiche bleiben in der Warteschlange.',
          degraded: false,
        };
        setCommitGate(gate);
        const next = pushGovernance(
          ledgerRef.current,
          'E1000',
          gate.message,
          gate.severity,
          'NOIR',
          nowExchangeMs
        );
        if (next !== ledgerRef.current) {
          applyLedger(next);
          if (manual) logRef.current?.(`[NOIR] E1000: ${gate.message}`, 'warn', 'The Judge (M8)');
        }
        return;
      }

      const merged = mergeBarsWithQuality(historyRef.current.bars, buffer);
      const bars = merged.bars;
      if (merged.gapRejected) {
        applyLedger(
          pushGovernance(
            ledgerRef.current,
            'E3000',
            `Feed-Divergenz ${merged.gapPercent?.toFixed(2)} % zwischen Kraken-OHLC und Live-Preis — Live-Overlay verworfen, Historie unverändert (keine erfundenen Kurssprünge).`,
            'warn',
            'NOIR',
            nowExchangeMs
          )
        );
      }

      const gate = evaluateCommitGate({
        nowExchangeMs,
        price: currentReference.price,
        lastTickMs: currentReference.observedAtMs,
        clockState: currentClock.state,
        clockOffsetMs: currentClock.offsetMs,
        tickCount: bars.length,
      });
      setCommitGate(gate);

      const current = ledgerRef.current;
      if (!gate.allowed) {
        const next = pushGovernance(
          current,
          gate.code ?? 'E5000',
          gate.message,
          gate.severity,
          'NOIR',
          nowExchangeMs
        );
        if (next !== current) {
          applyLedger(next);
          logRef.current?.(`[NOIR] ${gate.code}: ${gate.message}`, 'warn', 'The Judge (M8)');
        }
        return;
      }

      const frame = buildFeatureFrameFromBars(bars, buffer.length);
      if (!frame || frame.barCount < MIN_BARS_FOR_SNAPSHOT) {
        return;
      }

      const components = buildThreeComponentState(frame, current.calibration);
      const snapshot = createSnapshot({
        t0ExchangeMs: nowExchangeMs,
        btcPriceAtT0: currentReference.price,
        components,
        priceSource: currentReference.source,
        origin: 'LIVE',
        m8EngineStatus: deriveM8Status(gate, components.regime, frame.barCount),
      });

      const appended = appendSnapshot(current, snapshot);
      if (appended.error) {
        applyLedger(
          pushGovernance(
            current,
            appended.error.code,
            appended.error.message,
            'warn',
            'NOIR',
            nowExchangeMs
          )
        );
        logRef.current?.(`[NOIR] ${appended.error.code}: ${appended.error.message}`, 'warn', 'The Judge (M8)');
        return;
      }

      applyLedger(appended.ledger);
      logRef.current?.(
        `Snapshot ${snapshot.id} versiegelt: BTC $${snapshot.btcPriceAtT0.toLocaleString('en-US', {
          maximumFractionDigits: 2,
        })} (${snapshot.priceSource === 'LIVE_TICK' ? 'Live-Tick' : 'Börsen-Bar-Schluss'}) · Komposit ${components.compositeScore.toFixed(3)} · Regime ${components.regime} · T=${components.temperatureT.toFixed(2)}${
          gate.degraded ? ' · Uhr degradiert' : ''
        }${manual ? ' · manuell' : ''}.`,
        gate.degraded ? 'warn' : 'success',
        'Paragraph 2'
      );
    },
    [applyLedger]
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const now = clockRef.current.nowMs;
      const latest = latestSnapshot(ledgerRef.current.snapshots, 'LIVE');
      if (latest && now - latest.t0ExchangeMs < SNAPSHOT_CADENCE_MS) return;
      if (!referenceRef.current) return;
      const availableBars = mergeBars(historyRef.current.bars, ticksRef.current).length;
      if (availableBars < MIN_BARS_FOR_SNAPSHOT) return;
      attemptCommit(false);
    }, 5_000);
    return () => clearInterval(timer);
  }, [attemptCommit]);

  /* ---------------------------------------------------------------- */
  /* [Noir] offline comparison queue + batch backfill                 */
  /* ---------------------------------------------------------------- */

  const flushQueue = useCallback(async () => {
    if (flushInFlightRef.current) return;
    const current = ledgerRef.current;
    const nowExchangeMs = Math.round(clockRef.current.nowMs);
    const pending = queuedJobs(current);
    if (pending.length === 0) return;

    const window = backfillWindow(pending, nowExchangeMs);
    if (!window) return;

    flushInFlightRef.current = true;
    lastFlushAttemptRef.current = Date.now();
    setLastBatch((previous) => ({
      ...previous,
      fromMs: window.fromMs,
      toMs: window.toMs,
      isRunning: true,
      error: null,
    }));

    // Exactly ONE request for the whole missed window.
    const result: BatchBarsResult = await fetchBatchBars(window.fromMs, window.toMs);
    const attemptedAtMs = Date.now();

    let working = current;
    if (!result.authoritative || result.bars.length === 0) {
      working = transitionJobs(
        working,
        pending.map((job) => ({
          id: job.id,
          status: 'queued' as const,
          attempts: job.attempts + 1,
          lastAttemptExchangeMs: nowExchangeMs,
          lastError: result.error ?? 'Batch ohne Bars.',
        }))
      );
      applyLedger(working);
      setLastBatch({
        attemptedAtMs,
        fromMs: window.fromMs,
        toMs: window.toMs,
        bars: 0,
        resolved: 0,
        error: result.error ?? 'Batch ohne Bars.',
        isRunning: false,
      });
      flushInFlightRef.current = false;
      return;
    }

    const flush = resolveQueuedJobs(working, result.bars, nowExchangeMs);
    working = flush.ledger;

    if (flush.resolved > 0) {
      const liveResolutions = working.resolutions.filter((resolution) => resolution.origin === 'LIVE');
      working = replaceCalibration(working, updateCalibration(working.calibration, liveResolutions));
      applyLedger(working);
      logRef.current?.(
        `Backfill: ${flush.resolved} aufgeschobene Vergleiche in EINEM Batch aufgelöst (${result.bars.length} Bars, ${window.fromMs}–${window.toMs}).`,
        'success',
        'Quant Engine'
      );
    } else if (flush.unresolvable > 0) {
      applyLedger(working);
      logRef.current?.(
        `Backfill: ${flush.unresolvable} Vergleich(e) endgültig nicht auflösbar — die Börsenhistorie hat für die Zielminute keine Bar (keine Schätzung).`,
        'warn',
        'The Judge (M8)'
      );
    } else {
      applyLedger(working);
    }

    setLastBatch({
      attemptedAtMs,
      fromMs: window.fromMs,
      toMs: window.toMs,
      bars: result.bars.length,
      resolved: flush.resolved,
      error: flush.unresolvable > 0 ? `${flush.unresolvable} nicht auflösbar` : null,
      isRunning: false,
    });
    flushInFlightRef.current = false;
  }, [applyLedger]);

  // Maturation: resolve from observed ticks while the feed is live, otherwise
  // queue the comparison for the next batch backfill.
  useEffect(() => {
    const timer = setInterval(() => {
      const current = ledgerRef.current;
      const nowExchangeMs = Math.round(clockRef.current.nowMs);
      const buffer = ticksRef.current;

      const resolvedKeys = new Set(
        current.resolutions.map(
          (resolution) => `${resolution.snapshotId}:${resolution.horizonMinutes}`
        )
      );

      let working = current;
      let resolvedFromTicks = 0;
      let enqueued = 0;

      for (const snapshot of current.snapshots) {
        if (snapshot.origin !== 'LIVE') continue;
        for (const horizon of EVALUATION_HORIZONS) {
          if (resolvedKeys.has(`${snapshot.id}:${horizon}`)) continue;
          const targetMs = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
          if (nowExchangeMs < targetMs) continue;

          const tick = buffer.find(
            (candidate) => candidate.tsMs >= targetMs && candidate.tsMs - targetMs <= RESOLUTION_BUFFER_TOLERANCE_MS
          );

          if (tick) {
            let draft: ResolutionDraft;
            try {
              draft = computeResolution(snapshot, horizon as HorizonMinutes, tick.price, tick.tsMs, {
                observedAtExchangeMs: tick.tsMs,
                verifiedAtExchangeMs: nowExchangeMs,
                verification: 'LIVE_TICK',
              });
            } catch {
              continue;
            }
            const appended = appendResolution(working, draft, nowExchangeMs);
            if (appended.error) continue;
            working = appended.ledger;
            resolvedKeys.add(`${snapshot.id}:${horizon}`);
            resolvedFromTicks += 1;
            continue;
          }

          // No observation at/after the target → queue it instead of guessing.
          const queued = enqueueJob(working, {
            snapshotId: snapshot.id,
            horizonMinutes: horizon as HorizonMinutes,
            targetMs,
            nowExchangeMs,
          });
          if (queued.added) {
            working = queued.ledger;
            enqueued += 1;
          } else if (queued.error) {
            working = pushGovernance(
              working,
              'E3000',
              queued.error,
              'warn',
              'NOIR',
              nowExchangeMs
            );
          }
        }
      }

      if (enqueued > 0) {
        working = pushGovernance(
          working,
          'E3000',
          `${enqueued} Vergleich(e) ohne Kursbeobachtung eingereiht — Auflösung erfolgt gesammelt per Batch, sobald Börsendaten wieder verfügbar sind.`,
          'warn',
          'NOIR',
          nowExchangeMs
        );
      }

      if (resolvedFromTicks > 0) {
        const liveResolutions = working.resolutions.filter((resolution) => resolution.origin === 'LIVE');
        working = replaceCalibration(working, updateCalibration(working.calibration, liveResolutions));
      }

      if (working !== current) {
        working = pruneJobs(working);
        applyLedger(working);
        if (resolvedFromTicks > 0) {
          logRef.current?.(
            `${resolvedFromTicks} Horizont-Slot(s) aus Live-Ticks aufgelöst (Punkt-in-Zeit, ohne Repainting).`,
            'info',
            'Quant Engine'
          );
        }
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [applyLedger]);

  // Batch flush: whenever jobs are waiting, retry on a fixed cadence. The first
  // attempt after an outage is exactly one request for the whole window.
  useEffect(() => {
    const timer = setInterval(() => {
      if (flushInFlightRef.current) return;
      if (queuedJobs(ledgerRef.current).length === 0) return;
      if (Date.now() - lastFlushAttemptRef.current < QUEUE_FLUSH_INTERVAL_MS) return;
      void flushQueue();
    }, 5_000);
    return () => clearInterval(timer);
  }, [flushQueue]);

  // Feed recovered → flush immediately instead of waiting for the cadence.
  useEffect(() => {
    if (feedStatus === 'MISSING') return;
    if (queuedJobs(ledgerRef.current).length === 0) return;
    if (Date.now() - lastFlushAttemptRef.current < 5_000) return;
    void flushQueue();
  }, [feedStatus, flushQueue, ledger]);

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const loadReplay = useCallback(() => {
    const current = ledgerRef.current;
    const now = Math.round(clockRef.current.nowMs);
    // A replay series needs a real anchor price; without one there is nothing
    // honest to anchor to, so the action is refused instead of defaulting.
    const anchor = referenceRef.current?.price ?? null;
    if (anchor === null) {
      logRef.current?.(
        'Replay-Vorschau nicht möglich: kein echter BTC-Kurs als Anker verfügbar (keine Fallback-Preise).',
        'error',
        'Rouge'
      );
      return;
    }
    const seeded = seedReplayLedger(current, {
      nowExchangeMs: now,
      anchorPrice: anchor,
      hours: 24,
      snapshotIntervalMinutes: 10,
    });
    applyLedger(seeded.ledger);
    setShowReplay(true);
    logRef.current?.(
      `Replay-Vorschau geladen: ${seeded.snapshots} synthetische Snapshots, ${seeded.resolutions} Auflösungen (klar als REPLAY markiert, von der Live-Graduation ausgeschlossen).`,
      'info',
      'Rouge'
    );
  }, [applyLedger]);

  const clearReplay = useCallback(() => {
    const current = ledgerRef.current;
    const next: HorizonLedger = {
      ...current,
      snapshots: current.snapshots.filter((snapshot) => snapshot.origin !== 'REPLAY'),
      resolutions: current.resolutions.filter((resolution) => resolution.origin !== 'REPLAY'),
      jobs: current.jobs.filter((job) => !job.snapshotId.startsWith('S2-') || !job.id.includes('-R-')),
    };
    applyLedger(next);
    setShowReplay(false);
    logRef.current?.('Replay-Daten entfernt. Live-Ledger unverändert.', 'info', 'Rouge');
  }, [applyLedger]);

  const resetLedger = useCallback(() => {
    clearPersistedLedger();
    applyLedger(createLedger());
    setShowReplay(false);
    logRef.current?.(
      'Paragraph-2-Ledger zurückgesetzt. Alle Snapshots, Auflösungen und Vergleiche verworfen (Audit-Trail gelöscht).',
      'warn',
      'The Judge (M8)'
    );
  }, [applyLedger]);

  const commitNow = useCallback(() => attemptCommit(true), [attemptCommit]);

  /* ---------------------------------------------------------------- */
  /* Derived view state                                               */
  /* ---------------------------------------------------------------- */

  const origin: SnapshotOrigin = showReplay ? 'REPLAY' : 'LIVE';
  const pendingHorizons = useMemo(
    () => countPendingHorizons(ledger.snapshots, ledger.resolutions, Math.round(clock.nowMs), origin),
    [ledger.snapshots, ledger.resolutions, clock.nowMs, origin]
  );

  const summary = useMemo(
    () => summariseHorizons(ledger.resolutions, pendingHorizons, ledger.calibration, origin),
    [ledger.resolutions, ledger.calibration, pendingHorizons, origin]
  );

  const livePending = useMemo(
    () =>
      countPendingHorizons(
        ledger.snapshots,
        ledger.resolutions,
        Math.round(clock.nowMs),
        'LIVE'
      ),
    [ledger.snapshots, ledger.resolutions, clock.nowMs]
  );

  const liveSummary = useMemo(
    () => summariseHorizons(ledger.resolutions, livePending, ledger.calibration, 'LIVE'),
    [ledger.resolutions, ledger.calibration, livePending]
  );

  const queue = useMemo(
    () => summariseQueue(ledger.jobs, Math.round(clock.nowMs)),
    [ledger.jobs, clock.nowMs]
  );

  const latestLive = useMemo(() => latestSnapshot(ledger.snapshots, 'LIVE'), [ledger.snapshots]);
  const latestReplay = useMemo(
    () => latestSnapshot(ledger.snapshots, 'REPLAY'),
    [ledger.snapshots]
  );
  const latest = origin === 'REPLAY' ? latestReplay : latestLive;

  return {
    ledger,
    latest,
    latestReplay,
    summary,
    liveSummary,
    ticks,
    clock,
    commitGate,
    showReplay,
    history,
    livePrice: reference?.price ?? null,
    priceSource: reference?.source ?? null,
    priceAgeMs: reference?.ageMs ?? null,
    feedStatus,
    queue,
    lastBatch,
    totalLiveSnapshots: ledger.snapshots.filter((snapshot) => snapshot.origin === 'LIVE').length,
    totalReplaySnapshots: ledger.snapshots.filter((snapshot) => snapshot.origin === 'REPLAY').length,
    resolutions: ledger.resolutions,
    aggregates: summary.horizons,
    governance: ledger.governance,
    commitNow,
    flushQueue: () => {
      void flushQueue();
    },
    loadReplay,
    clearReplay,
    resetLedger,
    setShowReplay,
  };
}
