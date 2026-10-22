/**
 * [Rouge] — dual SVG charts.
 *
 * Chart A: live BTC trajectory with immutable snapshot anchors, the seven
 *          implied target prices of the newest snapshot, and realised outcomes.
 * Chart B: per-horizon accuracy split into directional hit rate (DA) and
 *          trajectory closeness (MC), opacity-encoded by confidence weight.
 */

import type { PriceTick } from './featureEngine';
import {
  EVALUATION_HORIZONS,
  HORIZON_MS,
  type HorizonAggregate,
  type HorizonMinutes,
  type HorizonResolution,
  type Paragraph2Snapshot,
  type SnapshotOrigin,
} from './types';

export const HORIZON_COLORS: Record<HorizonMinutes, string> = {
  5: '#22d3ee',
  15: '#34d399',
  30: '#a3e635',
  60: '#fbbf24',
  120: '#fb923c',
  180: '#f472b6',
  300: '#c084fc',
};

const PAD = { left: 58, right: 18, top: 16, bottom: 26 };
const WIDTH = 780;
const HEIGHT = 250;

const formatPrice = (value: number): string =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

function buildSeries(
  ticks: readonly PriceTick[],
  snapshots: readonly Paragraph2Snapshot[],
  resolutions: readonly HorizonResolution[],
  origin: SnapshotOrigin
): Array<{ tsMs: number; price: number }> {
  if (origin === 'LIVE' && ticks.length > 0) {
    return ticks.map((tick) => ({ tsMs: tick.tsMs, price: tick.price }));
  }
  const points: Array<{ tsMs: number; price: number }> = [];
  const scopedSnapshots = snapshots.filter((snapshot) => snapshot.origin === origin);
  for (const snapshot of scopedSnapshots) {
    points.push({ tsMs: snapshot.t0ExchangeMs, price: snapshot.btcPriceAtT0 });
  }
  for (const resolution of resolutions) {
    if (resolution.origin !== origin) continue;
    points.push({ tsMs: resolution.targetTimestampMs, price: resolution.actualBtcPrice });
  }
  points.sort((a, b) => a.tsMs - b.tsMs);
  return points;
}

interface PriceTrackChartProps {
  ticks: readonly PriceTick[];
  snapshots: readonly Paragraph2Snapshot[];
  resolutions: readonly HorizonResolution[];
  latest: Paragraph2Snapshot | null;
  nowMs: number;
  origin: SnapshotOrigin;
}

export function PriceTrackChart({
  ticks,
  snapshots,
  resolutions,
  latest,
  nowMs,
  origin,
}: PriceTrackChartProps) {
  const series = buildSeries(ticks, snapshots, resolutions, origin);
  const scopedSnapshots = snapshots.filter((snapshot) => snapshot.origin === origin);
  const scopedResolutions = resolutions.filter((resolution) => resolution.origin === origin);

  const targetTimes = latest
    ? EVALUATION_HORIZONS.map((horizon) => latest.t0ExchangeMs + HORIZON_MS(horizon))
    : [];
  const allTimes = [
    ...series.map((point) => point.tsMs),
    ...scopedSnapshots.map((snapshot) => snapshot.t0ExchangeMs),
    ...targetTimes,
    nowMs,
  ];
  const allPrices = [
    ...series.map((point) => point.price),
    ...scopedResolutions.map((resolution) => resolution.actualBtcPrice),
    ...(latest ? Object.values(latest.components.impliedTargetPrices) : []),
  ];

  if (allTimes.length === 0 || allPrices.length === 0) {
    return (
      <div className="h-[250px] flex items-center justify-center text-xs font-mono text-slate-500 border border-dashed border-slate-800 rounded-xl">
        Keine Kursdaten — warte auf den Kraken-Feed (E5000 Fallback-Render).
      </div>
    );
  }

  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const timeSpan = Math.max(maxTime - minTime, 60_000);
  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const pricePad = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.0004);
  const minPrice = rawMin - pricePad;
  const maxPrice = rawMax + pricePad;

  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (tsMs: number) => PAD.left + ((tsMs - minTime) / timeSpan) * innerWidth;
  const y = (price: number) => PAD.top + innerHeight - ((price - minPrice) / (maxPrice - minPrice)) * innerHeight;

  const pricePath = series
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.tsMs).toFixed(2)},${y(point.price).toFixed(2)}`)
    .join(' ');

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    price: minPrice + (maxPrice - minPrice) * ratio,
    y: PAD.top + innerHeight * (1 - ratio),
  }));

  const lastPrice = series.length > 0 ? series[series.length - 1].price : latest?.btcPriceAtT0 ?? 0;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-[250px]" role="img" aria-label="BTC-Kursverlauf mit Multi-Horizont-Zielen">
      <defs>
        <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>

      {gridLines.map((line, index) => (
        <g key={`grid-${index}`}>
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={line.y}
            y2={line.y}
            stroke="#1e293b"
            strokeWidth="1"
            strokeDasharray={index === 0 || index === gridLines.length - 1 ? '0' : '3 5'}
          />
          <text x={PAD.left - 8} y={line.y + 3} textAnchor="end" fill="#64748b" fontSize="9" fontFamily="ui-monospace, monospace">
            {formatPrice(line.price)}
          </text>
        </g>
      ))}

      {pricePath ? (
        <>
          <path
            d={`${pricePath} L${x(series[series.length - 1].tsMs).toFixed(2)},${PAD.top + innerHeight} L${x(series[0].tsMs).toFixed(2)},${PAD.top + innerHeight} Z`}
            fill="url(#price-fill)"
          />
          <path d={pricePath} fill="none" stroke="#22d3ee" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      ) : null}

      {scopedSnapshots.map((snapshot) => (
        <line
          key={`anchor-${snapshot.id}`}
          x1={x(snapshot.t0ExchangeMs)}
          x2={x(snapshot.t0ExchangeMs)}
          y1={PAD.top}
          y2={PAD.top + innerHeight}
          stroke="#475569"
          strokeWidth="0.8"
          strokeDasharray="2 4"
        />
      ))}

      {latest
        ? EVALUATION_HORIZONS.map((horizon) => {
            const targetMs = latest.t0ExchangeMs + HORIZON_MS(horizon);
            const targetPrice = latest.components.impliedTargetPrices[horizon];
            return (
              <g key={`target-${horizon}`}>
                <line
                  x1={x(latest.t0ExchangeMs)}
                  y1={y(latest.btcPriceAtT0)}
                  x2={x(targetMs)}
                  y2={y(targetPrice)}
                  stroke={HORIZON_COLORS[horizon]}
                  strokeWidth="1.4"
                  strokeOpacity="0.8"
                />
                <circle cx={x(targetMs)} cy={y(targetPrice)} r="3" fill={HORIZON_COLORS[horizon]} />
                <text
                  x={x(targetMs)}
                  y={y(targetPrice) - 6}
                  fill={HORIZON_COLORS[horizon]}
                  fontSize="9"
                  fontFamily="ui-monospace, monospace"
                  textAnchor="middle"
                >
                  {horizon}m
                </text>
              </g>
            );
          })
        : null}

      {scopedResolutions.map((resolution) => (
        <circle
          key={`resolved-${resolution.snapshotId}-${resolution.horizonMinutes}`}
          cx={x(resolution.targetTimestampMs)}
          cy={y(resolution.actualBtcPrice)}
          r="2.6"
          fill={resolution.directionalHit ? '#34d399' : '#f87171'}
          fillOpacity="0.9"
        />
      ))}

      <line
        x1={x(nowMs)}
        x2={x(nowMs)}
        y1={PAD.top}
        y2={PAD.top + innerHeight}
        stroke="#e2e8f0"
        strokeWidth="0.9"
        strokeDasharray="4 4"
        strokeOpacity="0.5"
      />
      <circle cx={x(nowMs)} cy={y(lastPrice)} r="3.4" fill="#e2e8f0" />

      {latest ? (
        <circle cx={x(latest.t0ExchangeMs)} cy={y(latest.btcPriceAtT0)} r="4" fill="#22d3ee" stroke="#0b0e14" strokeWidth="1.5" />
      ) : null}

      <text x={PAD.left} y={HEIGHT - 8} fill="#64748b" fontSize="9" fontFamily="ui-monospace, monospace">
        {formatTime(minTime)}
      </text>
      <text x={WIDTH - PAD.right} y={HEIGHT - 8} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="ui-monospace, monospace">
        {formatTime(maxTime)}
      </text>
      <text x={x(nowMs) + 4} y={PAD.top + 10} fill="#94a3b8" fontSize="8" fontFamily="ui-monospace, monospace">
        jetzt
      </text>
    </svg>
  );
}

interface HorizonAccuracyChartProps {
  aggregates: readonly HorizonAggregate[];
  origin: SnapshotOrigin;
}

export function HorizonAccuracyChart({ aggregates, origin }: HorizonAccuracyChartProps) {
  const rowHeight = 26;
  const height = EVALUATION_HORIZONS.length * rowHeight + 34;
  const width = 720;
  const labelWidth = 46;
  const rightPad = 64;
  const barMaxWidth = width - labelWidth - rightPad;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Genauigkeit je Horizont">
      {[0, 25, 50, 75, 100].map((tick) => {
        const position = labelWidth + (tick / 100) * barMaxWidth;
        return (
          <g key={`acc-tick-${tick}`}>
            <line
              x1={position}
              x2={position}
              y1={10}
              y2={height - 22}
              stroke={tick === 50 ? '#64748b' : '#1e293b'}
              strokeWidth="0.8"
              strokeDasharray={tick === 50 ? '4 4' : '0'}
            />
            <text x={position} y={height - 8} fill="#64748b" fontSize="8" textAnchor="middle" fontFamily="ui-monospace, monospace">
              {tick}%
            </text>
          </g>
        );
      })}

      {aggregates.map((aggregate, index) => {
        const yTop = 14 + index * rowHeight;
        const daWidth = (aggregate.directionalAccuracyPercent / 100) * barMaxWidth;
        const mcWidth = (aggregate.magnitudeClosenessPercent / 100) * barMaxWidth;
        const opacity = 0.3 + 0.7 * aggregate.confidenceWeight;
        return (
          <g key={`acc-${aggregate.horizonMinutes}`}>
            <text
              x={0}
              y={yTop + 13}
              fill={HORIZON_COLORS[aggregate.horizonMinutes]}
              fontSize="10"
              fontFamily="ui-monospace, monospace"
            >
              {aggregate.horizonMinutes}m
            </text>
            <rect x={labelWidth} y={yTop + 2} width={barMaxWidth} height={7} rx="3.5" fill="#111827" />
            <rect
              x={labelWidth}
              y={yTop + 2}
              width={Math.max(daWidth, aggregate.samples > 0 ? 2 : 0)}
              height={7}
              rx="3.5"
              fill={HORIZON_COLORS[aggregate.horizonMinutes]}
              fillOpacity={opacity}
            />
            <rect x={labelWidth} y={yTop + 12} width={barMaxWidth} height={4} rx="2" fill="#111827" />
            <rect
              x={labelWidth}
              y={yTop + 12}
              width={Math.max(mcWidth, aggregate.samples > 0 ? 2 : 0)}
              height={4}
              rx="2"
              fill="#64748b"
              fillOpacity={opacity}
            />
            <text
              x={labelWidth + barMaxWidth + 8}
              y={yTop + 12}
              fill={aggregate.samples > 0 ? '#e2e8f0' : '#475569'}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              {aggregate.samples > 0
                ? `${aggregate.accuracyPercent.toFixed(0)}% · N${aggregate.samples}`
                : origin === 'REPLAY'
                  ? '— · N0'
                  : '— · N0'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
