/**
 * [Rouge] — Overview widget: Multi-Horizon Prediction Accuracy & Live BTC Tracking.
 *
 * Placement: Broker-Leitwarte → Übersicht → Paragraph 2
 * ("Drei-Komponenten-Berechnung").
 */

import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Beaker,
  Brain,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  Layers,
  Minus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import { useMultiHorizonAccuracy, type LogFn } from '../../hooks/useMultiHorizonAccuracy';
import {
  EVALUATION_HORIZONS,
  HORIZON_MS,
  type M8EngineStatus,
  type VerdictSeverity,
} from './types';
import { HORIZON_COLORS, HorizonAccuracyChart, PriceTrackChart } from './HorizonCharts';
import { REGIME_LABELS, REGIME_TONE } from './evaluation';
import { calibrationQuality } from './calibration';
import { GRADUATION_SAMPLES_STRICT } from './config';

interface MultiHorizonAccuracyWidgetProps {
  onLogEvent?: LogFn;
  className?: string;
}

const formatUsd = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatSigned = (value: number, digits = 2): string =>
  `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const verdictStyles: Record<VerdictSeverity, { wrapper: string; icon: ReactNode; label: string }> = {
  success: {
    wrapper: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    icon: <CheckCircle2 className="w-4 h-4" />,
    label: 'HANDELBAR',
  },
  warn: {
    wrapper: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    icon: <AlertTriangle className="w-4 h-4" />,
    label: 'EINGESCHRÄNKT',
  },
  info: {
    wrapper: 'border-slate-600/50 bg-slate-500/10 text-slate-300',
    icon: <Clock3 className="w-4 h-4" />,
    label: 'SAMMELN',
  },
  error: {
    wrapper: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
    icon: <AlertTriangle className="w-4 h-4" />,
    label: 'GESPERRT',
  },
};

export default function MultiHorizonAccuracyWidget({
  onLogEvent,
  className = '',
}: MultiHorizonAccuracyWidgetProps) {
  const data = useMultiHorizonAccuracy(onLogEvent);
  const {
    ledger,
    latest,
    summary,
    ticks,
    clock,
    commitGate,
    showReplay,
    history,
    livePrice,
    priceSource,
    priceAgeMs,
    feedStatus,
    queue,
    lastBatch,
    flushQueue,
    totalLiveSnapshots,
    totalReplaySnapshots,
    resolutions,
    aggregates,
    governance,
    commitNow,
    loadReplay,
    clearReplay,
    resetLedger,
    setShowReplay,
  } = data;

  const components = latest?.components;
  const calibration = ledger.calibration;
  const calibrationState = calibrationQuality(calibration);
  const verdict = verdictStyles[summary.verdict.severity];
  const scopeOrigin = showReplay ? 'REPLAY' : 'LIVE';
  const scopedResolutions = resolutions.filter((resolution) => resolution.origin === scopeOrigin);

  const priceDelta =
    latest !== null && latest.btcPriceAtT0 > 0 && livePrice !== null
      ? ((livePrice - latest.btcPriceAtT0) / latest.btcPriceAtT0) * 100
      : null;
  const hasLivePrice = livePrice !== null;
  const directionIcon =
    priceDelta === null || Math.abs(priceDelta) < 0.01 ? (
      <Minus className="w-4 h-4 text-slate-400" />
    ) : priceDelta > 0 ? (
      <ArrowUpRight className="w-4 h-4 text-emerald-400" />
    ) : (
      <ArrowDownRight className="w-4 h-4 text-rose-400" />
    );

  const clockBadge =
    clock.state === 'SYNCED'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : clock.state === 'DEGRADED'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-slate-600/50 bg-slate-500/10 text-slate-300';

  const clockLabel =
    clock.state === 'SYNCED'
      ? 'KRAKEN-UHR SYNCHRON'
      : clock.state === 'DEGRADED'
        ? 'UHR-DRIFT / STALE'
        : 'LOKALE UHR (FALLBACK)';

  const latestResolvedMap = new Map(
    scopedResolutions
      .filter((resolution) => latest && resolution.snapshotId === latest.id)
      .map((resolution) => [resolution.horizonMinutes, resolution] as const)
  );

  const resolvedForLatest = latestResolvedMap.size;
  const graduation = summary.graduation;
  const m8Status: M8EngineStatus | null =
    latest?.m8EngineStatus ?? (commitGate ? (commitGate.allowed ? 'THROTTLED' : 'QUARANTINED') : null);

  return (
    <section
      className={`relative bg-[#0b0e14] border border-cyan-500/25 rounded-2xl overflow-hidden shadow-2xl shadow-cyan-500/5 ${className}`}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />

      {/* Header */}
      <div className="p-5 border-b border-slate-800/80 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 shrink-0">
            <Target className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-white tracking-wide">
                Multi-Horizont-Prognosegenauigkeit &amp; Live-BTC-Tracking
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                §2 · DREI-KOMPONENTEN
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                  showReplay
                    ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                }`}
              >
                {showReplay ? 'REPLAY (SYNTHETISCH)' : 'LIVE'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1 max-w-2xl">
              Punkt-in-Zeit-Ledger: jeder bestätigte Paragraph-2-Ausgang wird bei t₀ unveränderlich
              versiegelt und über exakt sieben Vorwärtshorizonte bewertet — ohne zukünftige Daten und
              ohne Repainting.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap font-mono text-[10px]">
          <span className={`px-2.5 py-1 rounded-lg border flex items-center gap-1.5 ${clockBadge}`}>
            <Clock3 className="w-3 h-3" />
            {clockLabel}
            <span className="opacity-70">Δ {clock.offsetMs.toFixed(0)}ms</span>
          </span>
          <span
            className={`px-2.5 py-1 rounded-lg border flex items-center gap-1.5 ${
              feedStatus === 'LIVE'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : feedStatus === 'BAR_ONLY'
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                  : 'border-rose-500/50 bg-rose-500/10 text-rose-300'
            }`}
            title="Jeder Kurs stammt aus einer echten Börsenbeobachtung. Ohne frische Beobachtung wird kein Preis angezeigt und kein Snapshot erzeugt (keine Fallback-Preise)."
          >
            <Radio className="w-3 h-3" />
            {feedStatus === 'LIVE'
              ? 'LIVE-TICK'
              : feedStatus === 'BAR_ONLY'
                ? 'BAR-SCHLUSS'
                : 'KEINE KURSDATEN'}
          </span>
          {queue.queued > 0 ? (
            <span className="px-2.5 py-1 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 flex items-center gap-1.5">
              <Clock3 className="w-3 h-3" />
              {queue.queued} Vergleich(e) in Warteschlange
            </span>
          ) : null}
          <span className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-800/60 text-slate-300 flex items-center gap-1.5">
            <Radio className="w-3 h-3" />
            M8: {m8Status ?? '—'}
          </span>
          <span className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-800/60 text-slate-300 flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            {totalLiveSnapshots} LIVE · {totalReplaySnapshots} REPLAY
          </span>
          <span
            className={`px-2.5 py-1 rounded-lg border flex items-center gap-1.5 ${
              history.authoritative
                ? 'border-slate-700 bg-slate-800/60 text-slate-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
            }`}
            title={
              history.error ??
              `Kraken OHLC 1-Minuten-Bars für die Feature-Berechnung${
                history.fetchedAtMs
                  ? ` (Alter ${Math.round((clock.nowMs - history.fetchedAtMs) / 1000)} s)`
                  : ''
              }`
            }
          >
            <Layers className="w-3 h-3" />
            {history.bars.length > 0 ? `${history.bars.length} Bars` : 'Bars: Warm-up'}
            {history.authoritative ? ' · Kraken' : ''}
          </span>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Verdict banner */}
        <div className={`rounded-xl border p-4 ${verdict.wrapper}`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5">{verdict.icon}</div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold tracking-wide">{summary.verdict.headline}</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border border-current/40 opacity-80">
                    {verdict.label}
                  </span>
                  {summary.verdict.code ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-black/30 border border-current/30">
                      {summary.verdict.code}
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] mt-1 opacity-85 leading-relaxed">{summary.verdict.detail}</p>
              </div>
            </div>
            <div className="font-mono text-right">
              <div className="text-[10px] uppercase opacity-60">Rollierender Brier</div>
              <div className="text-lg font-bold">{summary.rollingBrier.toFixed(3)}</div>
            </div>
          </div>
        </div>

        {/* Live price + charts */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2 bg-[#0f1420] border border-slate-800 rounded-xl p-3">
            <div className="flex items-start justify-between gap-3 mb-1 px-1 flex-wrap">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-mono flex items-center gap-1.5">
                  <Activity className="w-3 h-3 text-cyan-400" /> Live BTC/USD · Kursvektor &amp; 7 Zielfächer
                </div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className={`text-2xl font-bold font-mono ${hasLivePrice ? 'text-white' : 'text-slate-500'}`}>
                    {hasLivePrice ? formatUsd(livePrice) : '—'}
                  </span>
                  {!hasLivePrice ? (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300">
                      KEIN LIVE-PREIS · keine Erfindung
                    </span>
                  ) : null}
                  <span
                    className={`text-xs font-mono flex items-center gap-0.5 ${
                      priceDelta === null || Math.abs(priceDelta) < 0.01
                        ? 'text-slate-400'
                        : priceDelta > 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                    }`}
                  >
                    {directionIcon}
                    {priceDelta === null ? '—' : `${formatSigned(priceDelta, 3)}%`}
                    <span className="text-slate-500">seit t₀</span>
                  </span>
                </div>
              </div>
              <div className="text-right font-mono text-[10px] text-slate-400 space-y-0.5">
                <div>
                  Referenz P(t₀):{' '}
                  <span className="text-slate-200">
                    {latest ? formatUsd(latest.btcPriceAtT0) : '—'}
                  </span>
                </div>
                <div>
                  t₀:{' '}
                  <span className="text-slate-200">
                    {latest
                      ? new Date(latest.t0ExchangeMs).toLocaleTimeString('de-DE', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })
                      : '—'}
                  </span>
                </div>
                <div className="text-slate-500">
                  Preis-Alter: {priceAgeMs !== null ? `${(priceAgeMs / 1000).toFixed(1)}s` : '—'}
                  {priceSource ? ` · ${priceSource === 'LIVE_TICK' ? 'Tick' : 'Bar'}` : ''}
                </div>
              </div>
            </div>
            <PriceTrackChart
              ticks={ticks}
              snapshots={ledger.snapshots}
              resolutions={resolutions}
              latest={latest}
              nowMs={clock.nowMs}
              origin={scopeOrigin}
            />
            <div className="flex items-center justify-between gap-3 px-1 pt-1 flex-wrap text-[9px] font-mono text-slate-500">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-0.5 bg-cyan-400 inline-block" /> BTC-Pfad
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Treffer
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block" /> Fehltreffer
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {EVALUATION_HORIZONS.map((horizon) => (
                  <span key={horizon} className="flex items-center gap-1">
                    <span
                      className="w-2 h-2 rounded-sm inline-block"
                      style={{ backgroundColor: HORIZON_COLORS[horizon] }}
                    />
                    {horizon}m
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-[#0f1420] border border-slate-800 rounded-xl p-3 flex flex-col">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-mono flex items-center justify-between gap-2 px-1">
              <span className="flex items-center gap-1.5">
                <Gauge className="w-3 h-3 text-emerald-400" /> Genauigkeit je Horizont
              </span>
              <span className="text-[9px] text-slate-600">DA / MC</span>
            </div>
            <div className="flex-1 flex items-center">
              <HorizonAccuracyChart aggregates={aggregates} origin={scopeOrigin} />
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[10px] pt-2 border-t border-slate-800/70">
              <div>
                <div className="text-slate-500 uppercase text-[9px]">Bester Rang</div>
                <div className="text-slate-100">
                  {summary.best ? `${summary.best.horizonMinutes} min · ${summary.best.rankedScore.toFixed(1)}%` : '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-500 uppercase text-[9px]">N_eff · OOS</div>
                <div className="text-slate-100">
                  {summary.best ? summary.best.effectiveSamples.toFixed(1) : '—'} ·{' '}
                  {summary.best ? (summary.best.isOutOfSampleConsistent ? 'OK' : 'offen') : '—'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Horizon ledger table */}
        <div className="bg-[#0f1420] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800/80 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono flex items-center gap-1.5">
              <Layers className="w-3 h-3 text-cyan-400" /> Horizont-Ledger · letzter Snapshot
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              {latest ? `ID ${latest.id}` : 'noch kein Snapshot'} · {resolvedForLatest}/7 aufgelöst
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-slate-500 text-[9px] uppercase tracking-wider">
                  <th className="text-left px-3 py-2 font-medium">Horizont</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-right px-3 py-2 font-medium">Ziel P̂</th>
                  <th className="text-right px-3 py-2 font-medium">Ist P</th>
                  <th className="text-right px-3 py-2 font-medium">Dir.</th>
                  <th className="text-right px-3 py-2 font-medium">MC</th>
                  <th className="text-right px-3 py-2 font-medium">Accuracy</th>
                  <th className="text-right px-3 py-2 font-medium">N_eff / w</th>
                  <th className="text-right px-3 py-2 font-medium">Rang</th>
                </tr>
              </thead>
              <tbody>
                {EVALUATION_HORIZONS.map((horizon) => {
                  const aggregate = aggregates.find((entry) => entry.horizonMinutes === horizon);
                  const resolution = latestResolvedMap.get(horizon);
                  const targetMs = latest ? latest.t0ExchangeMs + HORIZON_MS(horizon) : null;
                  const isMatured = targetMs !== null && clock.nowMs >= targetMs;
                  const statusLabel = resolution
                    ? 'AUFGELÖST'
                    : targetMs === null
                      ? 'WARTET'
                      : isMatured
                        ? 'OFFEN (E3000)'
                        : 'PENDING';
                  const statusTone = resolution
                    ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                    : isMatured
                      ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
                      : 'text-slate-400 border-slate-700 bg-slate-800/60';

                  return (
                    <tr key={horizon} className="border-t border-slate-800/60 hover:bg-slate-800/20">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-sm"
                            style={{ backgroundColor: HORIZON_COLORS[horizon] }}
                          />
                          {horizon} min
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded border text-[9px] ${statusTone}`}>
                          {statusLabel}
                        </span>
                        {!resolution && targetMs ? (
                          <span className="ml-2 text-slate-500 text-[9px]">
                            {isMatured ? 'Feed-Lücke' : formatCountdown(targetMs - clock.nowMs)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">
                        {latest ? formatUsd(latest.components.impliedTargetPrices[horizon]) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-100">
                        {resolution ? formatUsd(resolution.actualBtcPrice) : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          resolution
                            ? resolution.directionalHit
                              ? 'text-emerald-300'
                              : 'text-rose-300'
                            : 'text-slate-500'
                        }`}
                      >
                        {resolution
                          ? `${resolution.actualDirection === 1 ? '▲' : resolution.actualDirection === -1 ? '▼' : '•'} ${
                              resolution.directionalHit ? 'HIT' : 'MISS'
                            }`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">
                        {resolution ? `${resolution.magnitudeClosenessPercent.toFixed(0)}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-100">
                        {resolution ? `${resolution.accuracyPercent.toFixed(0)}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-400">
                        {aggregate
                          ? `${aggregate.effectiveSamples.toFixed(1)} · ${(aggregate.confidenceWeight * 100).toFixed(0)}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {aggregate && aggregate.samples > 0 ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] border ${
                              aggregate.rank === 1
                                ? 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10'
                                : 'text-slate-400 border-slate-700 bg-slate-800/40'
                            }`}
                          >
                            #{aggregate.rank}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Three component cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ComponentCard
            index="01"
            title="ONNX Inference"
            subtitle="Selbst-optimierende Kalibrierung"
            icon={<Brain className="w-4 h-4" />}
            accent="text-cyan-300 border-cyan-500/30"
            rows={[
              ['y_cal (sigmoid)', components ? components.onnxCalibratedY.toFixed(4) : '—'],
              ['y_hat (roh)', components ? components.onnxRawYHat.toFixed(4) : '—'],
              ['Temperatur T', components ? components.temperatureT.toFixed(3) : calibration.temperatureT.toFixed(3)],
              ['Bias', components ? components.bias.toFixed(3) : calibration.bias.toFixed(3)],
              ['Brier (rollierend)', summary.rollingBrier.toFixed(3)],
            ]}
            footer={
              <span
                className={
                  calibrationState.isHealthy ? 'text-emerald-300' : 'text-amber-300'
                }
              >
                Kalibrierung: {calibrationState.label} · {calibration.calibrationSamples} Stichproben
              </span>
            }
          />

          <ComponentCard
            index="02"
            title="JEV 1.13 Gate"
            subtitle="System-1-Gating &amp; Regime-FSM"
            icon={<Sparkles className="w-4 h-4" />}
            accent="text-violet-300 border-violet-500/30"
            rows={[
              ['Regime', components ? REGIME_LABELS[components.regime] : '—'],
              ['Gate-Konfidenz', components ? `${(components.jevGateConfidence * 100).toFixed(1)}%` : '—'],
              ['Hurst H', components ? components.hurstExponent.toFixed(3) : '—'],
              ['ATR-Perzentil', components ? `${(components.atrPercentile * 100).toFixed(0)}%` : '—'],
              ['EMA50/200 Δ', components ? `${formatSigned(components.emaDeltaPercent, 3)}%` : '—'],
            ]}
            footer={
              components ? (
                <span
                  className={`inline-flex px-2 py-0.5 rounded border text-[9px] font-mono ${REGIME_TONE[components.regime]}`}
                >
                  {components.regime}
                </span>
              ) : (
                <span className="text-slate-500">Kein Regime — Feature-Fenster leer.</span>
              )
            }
          />

          <ComponentCard
            index="03"
            title="Kraken Paper-Exec"
            subtitle="Forward-Test · Sizing-Impuls"
            icon={<Beaker className="w-4 h-4" />}
            accent="text-emerald-300 border-emerald-500/30"
            rows={[
              ['Signal', components ? formatSigned(components.krakenPaperSignal, 3) : '—'],
              ['Sizing-Impuls', components ? `${(components.paperSizingImpulse * 100).toFixed(0)}%` : '—'],
              ['Stichproben N', `${graduation.samples} / ≥${graduation.requiredSamples}`],
              ['Win Rate', `${graduation.winRate.toFixed(1)}% / ≥${graduation.winRateTarget.toFixed(0)}%`],
              ['Profit Factor', `${graduation.profitFactor.toFixed(2)} / ≥${graduation.profitFactorTarget.toFixed(1)}`],
            ]}
            footer={
              <span className={graduation.isGraduated ? 'text-emerald-300' : 'text-amber-300'}>
                {graduation.isGraduated
                  ? 'GRADUIERT — Paper-Modus bestanden'
                  : 'Sammelphase — noch keine Live-Freigabe'}
              </span>
            }
          />
        </div>

        {/* Offline comparison queue / batch backfill */}
        <div
          className={`rounded-xl border p-4 ${
            queue.queued > 0
              ? 'border-amber-500/40 bg-amber-500/5'
              : 'border-slate-800 bg-[#0f1420]'
          }`}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2.5">
              <span
                className={`p-1.5 rounded-lg border ${
                  queue.queued > 0
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    : 'border-slate-700 bg-slate-800/60 text-slate-400'
                }`}
              >
                <Clock3 className="w-4 h-4" />
              </span>
              <div>
                <div className="text-[11px] font-semibold text-slate-100 flex items-center gap-2 flex-wrap">
                  Vergleichs-Warteschlange · Offline-Backfill
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border border-slate-700 bg-slate-800/60 text-slate-300">
                    {queue.queued} offen · {queue.resolvedByBackfill} per Batch gelöst
                  </span>
                  {queue.unresolvable > 0 ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border border-rose-500/30 bg-rose-500/10 text-rose-300">
                      {queue.unresolvable} nicht auflösbar (E3000)
                    </span>
                  ) : null}
                </div>
                <p className="text-[10px] text-slate-400 mt-1 max-w-2xl leading-relaxed">
                  Fehlt der Live-Feed zur Zielzeit, wird der Vergleich <strong>eingereiht</strong> statt
                  geschätzt. Sobald Börsendaten wieder erreichbar sind, holt <em>ein einziger</em>{' '}
                  Batch-Request (<code className="text-[10px] text-cyan-300">/api/exchange/ohlc/batch</code>)
                  das gesamte verpasste Fenster und löst alle wartenden Vergleiche gegen die echten
                  Bar-Schlusskurse auf — pro Datenpunkt wird nichts interpoliert.
                </p>
                <div className="flex flex-wrap items-center gap-1.5 mt-2 font-mono text-[9px]">
                  {queue.oldestAgeMs !== null ? (
                    <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900/60 text-slate-300">
                      ältester offener Vergleich: {formatCountdown(queue.oldestAgeMs)} alt
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                      Warteschlange leer — alle reifen Vergleiche aufgelöst
                    </span>
                  )}
                  {queue.byHorizon.map((entry) => (
                    <span
                      key={entry.horizonMinutes}
                      className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900/60 text-slate-300"
                    >
                      {entry.horizonMinutes}m × {entry.queued}
                    </span>
                  ))}
                </div>
                {lastBatch.attemptedAtMs !== null ? (
                  <p className="text-[9px] font-mono text-slate-500 mt-2">
                    Letzter Batch:{' '}
                    {new Date(lastBatch.attemptedAtMs).toLocaleTimeString('de-DE')} ·{' '}
                    {lastBatch.bars} Bars · {lastBatch.resolved} aufgelöst
                    {lastBatch.fromMs !== null && lastBatch.toMs !== null
                      ? ` · Fenster ${formatCountdown(
                          Math.max(0, lastBatch.toMs - lastBatch.fromMs)
                        )}`
                      : ''}
                    {lastBatch.error ? ` · ${lastBatch.error}` : ''}
                  </p>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={flushQueue}
              disabled={lastBatch.isRunning || queue.queued === 0}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border transition-colors flex items-center gap-1.5 ${
                queue.queued === 0
                  ? 'border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${lastBatch.isRunning ? 'animate-spin' : ''}`} />
              {lastBatch.isRunning ? 'Batch läuft…' : 'Verpasste Daten per Batch nachladen'}
            </button>
          </div>
        </div>

        {/* Graduation progress + governance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0f1420] border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3 text-emerald-400" /> Kraken Paper-Graduation (nur LIVE)
              </div>
              <span className="text-[10px] font-mono text-slate-500">
                {graduation.samples}/{graduation.requiredSamples}
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-800 overflow-hidden mb-3">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all"
                style={{ width: `${Math.min(100, (graduation.samples / graduation.requiredSamples) * 100)}%` }}
              />
            </div>
            <div className="grid grid-cols-3 gap-3 font-mono text-[10px]">
              <Metric
                label="N (LIVE)"
                value={`${graduation.samples}`}
                target={`≥${graduation.requiredSamples} · strikt ${GRADUATION_SAMPLES_STRICT}`}
                ok={graduation.samples >= graduation.requiredSamples}
              />
              <Metric label="Win Rate" value={`${graduation.winRate.toFixed(1)}%`} target={`≥${graduation.winRateTarget.toFixed(0)}%`} ok={graduation.winRate >= graduation.winRateTarget} />
              <Metric label="Profit Factor" value={graduation.profitFactor.toFixed(2)} target={`≥${graduation.profitFactorTarget.toFixed(1)}`} ok={graduation.profitFactor >= graduation.profitFactorTarget} />
            </div>
            <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
              Auflösungen: {scopedResolutions.length} im aktiven Scope · {summary.pendingHorizons} offene
              Slots · Kalibrierung T={calibration.temperatureT.toFixed(2)} / b={calibration.bias.toFixed(2)}
              {graduation.isGraduatedStrict ? ' · strikte Stufe erreicht' : ''}.
              {summary.best
                ? ` Bester Horizont: ${summary.best.coveragePercent.toFixed(0)}% der Ausgänge mit Bewegung (N_eff ${summary.best.effectiveSamples.toFixed(1)}).`
                : ''}
              {feedStatus === 'MISSING'
                ? ' Keine frischen Kursdaten — es werden keine neuen Snapshots erzeugt.'
                : ''}
            </p>
          </div>

          <div className="bg-[#0f1420] border border-slate-800 rounded-xl p-4">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono flex items-center gap-1.5 mb-2">
              <AlertTriangle className="w-3 h-3 text-amber-400" /> Fehler-Taxonomie &amp; Gate-Status
            </div>
            <div className="space-y-1.5 max-h-[132px] overflow-y-auto pr-1">
              {governance.length === 0 ? (
                <p className="text-[10px] font-mono text-slate-500">
                  Keine Verstöße im aktuellen Ledger — Gate geschlossen und sauber.
                </p>
              ) : (
                governance
                  .slice(-4)
                  .reverse()
                  .map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-[10px] font-mono">
                      <span
                        className={`px-1.5 py-0.5 rounded border shrink-0 ${
                          event.severity === 'error'
                            ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
                            : event.severity === 'warn'
                              ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
                              : 'text-slate-300 border-slate-700 bg-slate-800/50'
                        }`}
                      >
                        {event.code}
                      </span>
                      <span className="text-slate-500 shrink-0">[{event.layer}]</span>
                      <span className="text-slate-300 leading-relaxed">{event.message}</span>
                    </div>
                  ))
              )}
            </div>
            {commitGate ? (
              <p className="text-[10px] font-mono text-slate-500 mt-3 border-t border-slate-800/70 pt-2 leading-relaxed">
                <span className={commitGate.allowed ? 'text-emerald-400' : 'text-rose-400'}>
                  {commitGate.allowed ? 'GATE OPEN' : 'GATE CLOSED'}
                </span>{' '}
                · {commitGate.message}
              </p>
            ) : null}
          </div>
        </div>

        {/* Sub-agent layers + actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
            {[
              ['Blanche', 'Daten & Features', 'text-cyan-300 border-cyan-500/30'],
              ['Jaune', 'Quant & Horizonte', 'text-amber-300 border-amber-500/30'],
              ['Noir', 'Validierung & Gate', 'text-rose-300 border-rose-500/30'],
              ['Rouge', 'Präsentation', 'text-violet-300 border-violet-500/30'],
            ].map(([name, role, tone]) => (
              <span key={name} className={`px-2 py-1 rounded border bg-slate-900/60 ${tone}`}>
                [{name}] {role}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {totalReplaySnapshots > 0 ? (
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 px-2">
                <input
                  type="checkbox"
                  checked={showReplay}
                  onChange={(event) => setShowReplay(event.target.checked)}
                  className="accent-fuchsia-500"
                />
                Replay anzeigen
              </label>
            ) : null}
            <button
              type="button"
              onClick={commitNow}
              className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Snapshot jetzt
            </button>
            {totalReplaySnapshots > 0 ? (
              <button
                type="button"
                onClick={clearReplay}
                className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700/70 transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-3 h-3" /> Replay entfernen
              </button>
            ) : (
              <button
                type="button"
                onClick={loadReplay}
                className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300 hover:bg-fuchsia-500/20 transition-colors flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3" /> Replay-Vorschau laden
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (typeof window === 'undefined' || window.confirm('Gesamtes Paragraph-2-Ledger inklusive Audit-Trail löschen?')) {
                  resetLedger();
                }
              }}
              className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border border-rose-500/30 bg-rose-500/5 text-rose-300/80 hover:bg-rose-500/10 transition-colors flex items-center gap-1.5"
            >
              <Trash2 className="w-3 h-3" /> Ledger zurücksetzen
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ComponentCard({
  index,
  title,
  subtitle,
  icon,
  accent,
  rows,
  footer,
}: {
  index: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  accent: string;
  rows: Array<[string, string]>;
  footer: ReactNode;
}) {
  return (
    <div className="bg-[#0f1420] border border-slate-800 rounded-xl p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <span className={`p-1.5 rounded-lg border bg-slate-900/60 ${accent}`}>{icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-slate-100 flex items-center gap-1.5">
            <span className="text-[9px] font-mono text-slate-500">{index}</span>
            {title}
          </div>
          <div className="text-[9px] font-mono text-slate-500 truncate">{subtitle}</div>
        </div>
      </div>
      <div className="space-y-1 font-mono text-[10px] flex-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-slate-500">{label}</span>
            <span className="text-slate-200 truncate text-right">{value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-2 border-t border-slate-800/70 text-[9px] font-mono leading-relaxed">
        {footer}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  target,
  ok,
}: {
  label: string;
  value: string;
  target: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-bold ${ok ? 'text-emerald-300' : 'text-slate-200'}`}>{value}</div>
      <div className="text-[9px] text-slate-500">{target}</div>
    </div>
  );
}
