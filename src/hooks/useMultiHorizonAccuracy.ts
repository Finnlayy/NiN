/**
 * Orchestration hook for the Paragraph 2 multi-horizon accuracy widget.
 *
 * Pipeline order (MANAS : CIEL):
 *   [Blanche] exchange clock + live ticks + features
 *   [Jaune]   immutable snapshot computation (three components, 7 targets)
 *   [Noir]    commit gate, maturation gate, calibration + verdict
 *   [Rouge]   renders through <MultiHorizonAccuracyWidget />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MIN_BARS_FOR_SNAPSHOT,
  SNAPSHOT_CADENCE_MS,
  TICK_POLL_MS,
} from '../features/multiHorizon/config';
import { useExchangeClock } from '../features/multiHorizon/exchangeClock';
import {
  buildFeatureFrameFromBars,
  buildThreeComponentState,
  ticksFromBars,
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
  latestSnapshot,
  loadLedger,
  recordGovernance,
  type LedgerLoadResult,
  replaceCalibration,
  saveLedger,
  type HorizonLedger,
} from '../features/multiHorizon/snapshotStore';
import { seedReplayLedger } from '../features/multiHorizon/replay';
import type {
  ErrorCode,
  ErrorSeverity,
  GovernanceEvent,
  HorizonAggregate,
  HorizonMinutes,
  HorizonResolution,
  Paragraph2Snapshot,
  SnapshotOrigin,
  SubAgentLayer,
} from '../features/multiHorizon/types';
import { EVALUATION_HORIZONS, HORIZON_MS } from '../features/multiHorizon/types';
import { getLiveSpot, onLiveSpotReady } from '../utils/liveSpot';

export type LogFn = (
  message: string,
  level: 'info' | 'warn' | 'error' | 'success',
  node?: string
) => void;

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
  livePrice: number;
  totalLiveSnapshots: number;
  totalReplaySnapshots: number;
  resolutions: readonly HorizonResolution[];
  aggregates: HorizonAggregate[];
  governance: readonly GovernanceEvent[];
  commitNow: () => void;
  loadReplay: () => void;
  clearReplay: () => void;
  resetLedger: () => void;
  setShowReplay: (value: boolean) => void;
}

const MAX_TICK_BUFFER = 1_500;
/** Only resolve a target if the app was already observing the feed then. */
const RESOLUTION_BUFFER_TOLERANCE_MS = 1_500;

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
  const [commitGate, setCommitGate] = useState<GateDecision | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [livePrice, setLivePrice] = useState<number>(() => getLiveSpot('BTC'));
  // Ticks are only recorded once the venue feed delivered a real quote; the
  // built-in fallback price would otherwise look like a 30 % feed divergence.
  const feedReadyRef = useRef(false);

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
      `Paragraph-2-Ledger wiederhergestellt: ${loaded.ledger.snapshots.length} Snapshots, ${loaded.ledger.resolutions.length} Auflösungen${
        loaded.corruptedRecords > 0 ? ` · ${loaded.corruptedRecords} korrupte Datensätze quarantänisiert (E4000)` : ''
      }.`,
      loaded.corruptedRecords > 0 ? 'warn' : 'info',
      'The Judge (M8)'
    );
  }, []);

  /* ---------------------------------------------------------------- */
  /* [Blanche] live ticks                                             */
  /* ---------------------------------------------------------------- */

  useEffect(
    () =>
      onLiveSpotReady(() => {
        feedReadyRef.current = true;
      }),
    []
  );

  useEffect(() => {
    const poll = () => {
      const price = getLiveSpot('BTC');
      setLivePrice(price);
      if (!feedReadyRef.current) return;
      if (!Number.isFinite(price) || price <= 0) return;
      const tsMs = Math.round(clockRef.current.nowMs);
      const previous = ticksRef.current;
      const last = previous[previous.length - 1];
      // Do not push duplicate prices at the same exchange millisecond.
      if (last && last.tsMs === tsMs) return;
      const next = [...previous, { tsMs, price }].slice(-MAX_TICK_BUFFER);
      ticksRef.current = next;
      setTicks(next);
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
          `OHLC-Historie nicht verfügbar (${next.error ?? 'unbekannt'}) — Paragraph 2 arbeitet im Warm-up mit den live beobachteten 1-Minuten-Bars.`,
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
  /* [Jaune] snapshot commit                                          */
  /* ---------------------------------------------------------------- */

  const attemptCommit = useCallback(
    (manual: boolean) => {
      const currentClock = clockRef.current;
      const nowExchangeMs = Math.round(currentClock.nowMs);
      const buffer = ticksRef.current;
      const price = getLiveSpot('BTC');

      const merged = mergeBarsWithQuality(historyRef.current.bars, buffer);
      const bars = merged.bars;
      // Reference-price fallback: without a live spot route the venue's own bar
      // closes are the freshest real prices available (never a synthetic value).
      const ticks = buffer.length > 0 ? buffer : ticksFromBars(bars);
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
      const referenceTick = ticks[ticks.length - 1] ?? null;
      const referencePrice = referenceTick?.price ?? price;
      const gate = evaluateCommitGate({
        nowExchangeMs,
        price: referencePrice,
        lastTickMs: referenceTick?.tsMs ?? null,
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

      const frame = buildFeatureFrameFromBars(bars, ticks.length);
      if (!frame || frame.barCount < MIN_BARS_FOR_SNAPSHOT) {
        return;
      }

      const components = buildThreeComponentState(frame, current.calibration);
      const snapshot = createSnapshot({
        t0ExchangeMs: nowExchangeMs,
        btcPriceAtT0: referencePrice,
        components,
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
        })} · Komposit ${components.compositeScore.toFixed(3)} · Regime ${components.regime} · T=${components.temperatureT.toFixed(2)}${
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
      const availableBars = mergeBars(historyRef.current.bars, ticksRef.current).length;
      if (availableBars < MIN_BARS_FOR_SNAPSHOT) return;
      attemptCommit(false);
    }, 5_000);
    return () => clearInterval(timer);
  }, [attemptCommit]);

  /* ---------------------------------------------------------------- */
  /* [Noir] horizon maturation + resolution                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const timer = setInterval(() => {
      const current = ledgerRef.current;
      const nowExchangeMs = Math.round(clockRef.current.nowMs);
      const buffer = ticksRef.current;
      if (buffer.length === 0) return;

      const bufferStart = buffer[0].tsMs;
      const resolvedKeys = new Set(
        current.resolutions.map(
          (resolution) => `${resolution.snapshotId}:${resolution.horizonMinutes}`
        )
      );

      let working = current;
      let added = 0;

      for (const snapshot of current.snapshots) {
        for (const horizon of EVALUATION_HORIZONS) {
          if (resolvedKeys.has(`${snapshot.id}:${horizon}`)) continue;
          const targetMs = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
          if (nowExchangeMs < targetMs) continue;
          if (targetMs < bufferStart - RESOLUTION_BUFFER_TOLERANCE_MS) continue;

          const tick = buffer.find((candidate) => candidate.tsMs >= targetMs);
          if (!tick) continue;

          let draft: ResolutionDraft;
          try {
            draft = computeResolution(snapshot, horizon as HorizonMinutes, tick.price, tick.tsMs);
          } catch {
            continue;
          }
          const appended = appendResolution(working, draft, nowExchangeMs);
          if (appended.error) continue;
          working = appended.ledger;
          resolvedKeys.add(`${snapshot.id}:${horizon}`);
          added += 1;
        }
      }

      // Matured slots older than the observation window cannot be resolved
      // without inventing a price — report them instead of fabricating one.
      const unscopedResolved = new Set(
        working.resolutions.map(
          (resolution) => `${resolution.snapshotId}:${resolution.horizonMinutes}`
        )
      );
      const orphans = working.snapshots.reduce((count, snapshot) => {
        if (snapshot.origin !== 'LIVE') return count;
        return (
          count +
          EVALUATION_HORIZONS.filter((horizon) => {
            const targetMs = snapshot.t0ExchangeMs + HORIZON_MS(horizon);
            return (
              nowExchangeMs >= targetMs &&
              targetMs < bufferStart - RESOLUTION_BUFFER_TOLERANCE_MS &&
              !unscopedResolved.has(`${snapshot.id}:${horizon}`)
            );
          }).length
        );
      }, 0);
      if (orphans > 0) {
        working = pushGovernance(
          working,
          'E3000',
          `${orphans} gereifte(r) Horizont-Slot(s) liegen vor dem Beobachtungsfenster — keine Auflösung ohne realisierten Preis (keine Erfindung).`,
          'warn',
          'NOIR',
          nowExchangeMs
        );
      }

      if (added > 0) {
        const liveResolutions = working.resolutions.filter((resolution) => resolution.origin === 'LIVE');
        const calibration = updateCalibration(working.calibration, liveResolutions);
        working = replaceCalibration(working, calibration);
        applyLedger(working);
        logRef.current?.(
          `${added} Horizont-Slot(s) aufgelöst (Punkt-in-Zeit, ohne Repainting). ${liveResolutions.length} Live-Stichproben im Ledger.`,
          'info',
          'Quant Engine'
        );
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [applyLedger]);

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const loadReplay = useCallback(() => {
    const current = ledgerRef.current;
    const now = Math.round(clockRef.current.nowMs);
    const anchor = getLiveSpot('BTC');
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
      'Paragraph-2-Ledger zurückgesetzt. Alle Snapshots und Auflösungen verworfen (Audit-Trail gelöscht).',
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

  // Display price: live tick → venue bar close → built-in fallback.
  const effectivePrice = useMemo(() => {
    const lastTick = ticks[ticks.length - 1];
    if (lastTick && Number.isFinite(lastTick.price)) return lastTick.price;
    const lastBar = history.bars[history.bars.length - 1];
    if (lastBar && Number.isFinite(lastBar.close)) return lastBar.close;
    return livePrice;
  }, [ticks, history.bars, livePrice]);

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
    livePrice: effectivePrice,
    totalLiveSnapshots: ledger.snapshots.filter((snapshot) => snapshot.origin === 'LIVE').length,
    totalReplaySnapshots: ledger.snapshots.filter((snapshot) => snapshot.origin === 'REPLAY').length,
    resolutions: ledger.resolutions,
    aggregates: summary.horizons,
    governance: ledger.governance,
    commitNow,
    loadReplay,
    clearReplay,
    resetLedger,
    setShowReplay,
  };
}
