# Paragraph 2 — Multi-Horizon Prediction Accuracy & Live BTC Tracking

Overview widget in the Broker-Leitwarte (`NetworkDashboard`, default `NETWORK`
view) for the "Drei-Komponenten-Berechnung" (§2). It freezes every confirmed
Paragraph 2 output, tracks BTC live, and evaluates each snapshot across exactly
seven forward horizons: **5, 15, 30, 60, 120, 180, 300 minutes**.

## Architecture (MANAS : CIEL)

| Layer | Module | Responsibility |
| --- | --- | --- |
| `[Blanche]` | `src/features/multiHorizon/featureEngine.ts`, `exchangeClock.ts` | Kraken-synchronised exchange clock, live BTC ticks, RSI / ATR / CISD / Bollinger + Hurst / EMA-delta / ATR-percentile features |
| `[Jaune]` | `evaluation.ts`, `calibration.ts` | Snapshot → component composite, implied target fan, DA / MC / Accuracy, Brier, Bayesian confidence weighting, temperature-scaled calibration |
| `[Noir]` | `riskGate.ts`, `snapshotStore.ts` | Stale-signal rejection, clock-skew gate, zero-future-leak maturation gate, append-only ledger + checksum quarantine, unified error taxonomy |
| `[Rouge]` | `MultiHorizonAccuracyWidget.tsx`, `HorizonCharts.tsx` | Overview widget, dual charts, German verdict banner, three component cards, graduation panel |

Orchestration: `src/hooks/useMultiHorizonAccuracy.ts`.
Backend clock proxy: `backend/exchangeClock.ts` → `GET /api/exchange/clock`.

## Point-in-time invariants

1. **Immutable snapshots** — `createSnapshot()` deep-freezes `t0`, `P(t0)`,
   components and the seven pending slots; every record carries an FNV-1a
   checksum.
2. **No repainting** — realised prices are written to a **separate**
   `resolutions[]` collection keyed by `(snapshotId, horizon)`. The snapshot has
   no writable outcome field, so it cannot absorb future data.
3. **Monotonic t0** — `appendSnapshot()` rejects back-dated or duplicate
   snapshots (`E4100`) per origin.
4. **Maturation gate** — a horizon may only resolve once
   `nowExchangeMs >= t0 + h · 60_000`; `appendResolution()` re-checks both the
   target time and the resolution timestamp (`E5000`).
5. **Authoritative time** — snapshots use the exchange clock
   (`offset = krakenTime − (t_send + rtt/2)`), never `Date.now()` alone. Skew
   above 2 000 ms rejects the signal (`E1200`); a missing Kraken clock degrades
   to a `THROTTLED` snapshot instead of inventing an exchange timestamp.
6. **No fabrication** — a matured horizon that lies before the observation
   window stays open and is reported as `E3000`; no price is interpolated.

## Scoring

```
return_h      = (P(t0+h) − P(t0)) / P(t0)
DA_h          = hits_h / N_h
MC_h          = clamp(100 · (1 − sMAPE_h / tolerance_h), 0, 100)
Accuracy_h    = 0.55 · DA_h + 0.45 · MC_h
Brier         = (y_cal − outcome)²
w_h           = N_h / (N_h + 5)          // Bayesian shrinkage
rankedScore_h = w_h · Accuracy_h          // conservative horizon ranking
```

`tolerance_h` is derived from the snapshot's own ATR (never from future data).
A horizon is *provisional* at `N ≥ 3`, *graduated* at `N ≥ 20` for the paper
strategy (`WR ≥ 55 %`, `PF ≥ 1.6`). Wilson 95 % lower bounds are shown next to
the hit rate so a single lucky sample cannot dominate.

Verdict logic (German banner): no data → `E2000`, `< 3` samples → provisional,
confidence-weighted score `< 55 %` → `E2100` (no trade release), otherwise the
best horizon is named with DA, Wilson bound, MC, N and weight.

## Components (Paragraph 2)

1. `onnxCalibratedScore` — feature head → raw logit → temperature scaling
   `y_cal = sigmoid(logit(y_hat)/T + bias)`; `T` and `bias` are re-fitted
   online from realised outcomes (gradient on log-loss, bounded `T ∈ [0.5, 3]`).
2. `jevSystem1RegimeGate` — EMA50/200 delta, ATR(14)/close percentile, Hurst
   exponent (`< 0.45` mean reversion, `0.45–0.55` random walk, `> 0.55`
   persistent) → `STRONG_BULL | WEAK_BULL | STRONG_BEAR | WEAK_BEAR |
   RANGING_CHOP | HIGH_VOL_CRISIS` plus gate confidence.
3. `krakenPaperExecSignal` — signed execution/sizing impulse with graduation
   metrics.

## Error taxonomy

| Code | Meaning |
| --- | --- |
| `E1000` | stale feed / `STALE_SIGNAL_REJECT` |
| `E1200` | exchange clock skew / non-authoritative clock |
| `E2000` | insufficient samples |
| `E2100` | low confidence weight / unproven horizon |
| `E3000` | price feed unavailable for resolution |
| `E4000` | snapshot checksum / integrity violation |
| `E4100` | schema, duplicate or monotonicity reject |
| `E5000` | future-leak guard / UI fallback |

## Replay data

`Replay-Vorschau laden` seeds deterministic synthetic history tagged
`origin: 'REPLAY'`. Replay records live in the same append-only ledger but are
excluded from every LIVE aggregate, from the verdict used for trading, and from
the Kraken graduation panel; the UI shows a `REPLAY (SYNTHETISCH)` badge and a
toggle. Remove them at any time without touching LIVE history.

## Tests

```bash
npm run test:horizon   # 14 invariant tests (immutability, future leak, ranking, calibration, replay, clock)
npm run typecheck
npm run build
```

## Notes / limits

- The ledger persists in `localStorage` (`nin:paragraph2:horizon-ledger:v1`);
  hydration verifies every checksum and quarantines corrupted records. For a
  multi-operator deployment, point `saveLedger`/`loadLedger` at the existing
  Upstash/`stateStore` backend.
- Resolutions require the app to observe the feed at the target time. Horizons
  that matured while the app was closed stay open by design (`E3000`).
- The 1 s clock render and 3–5 s feed poll keep the widget live without
  additional dependencies.
