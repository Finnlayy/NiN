# Paragraph 2 — Multi-Horizon Prediction Accuracy & Live BTC Tracking

Overview widget in the Broker-Leitwarte (`NetworkDashboard`, default `NETWORK`
view) for the "Drei-Komponenten-Berechnung" (§2). Every confirmed Paragraph 2
output is frozen as an immutable snapshot, BTC is tracked live, and each
snapshot is evaluated across exactly seven forward horizons: **5, 15, 30, 60,
120, 180 and 300 minutes**.

## Architecture (MANAS : CIEL)

| Layer | Module | Responsibility |
| --- | --- | --- |
| `[Blanche]` | `featureEngine.ts`, `exchangeClock.ts`, `historyFeed.ts` | Exchange-clock sync, live ticks, 1-minute bar history (Kraken OHLC), RSI / ATR / CISD / Bollinger + EMA50-200 / ATR-percentile / Hurst |
| `[Jaune]` | `evaluation.ts`, `calibration.ts` | Composite, implied target fan, DA / MC / Accuracy, Brier, Bayesian + overlap-corrected confidence, temperature calibration |
| `[Noir]` | `riskGate.ts`, `snapshotStore.ts` | Stale-signal and clock-skew gates, zero-future-leak maturation gate, append-only ledger, checksum quarantine, feed-divergence guard, split-half validation |
| `[Rouge]` | `MultiHorizonAccuracyWidget.tsx`, `HorizonCharts.tsx` | Overview widget, dual charts, German verdict banner, component cards, graduation and governance panels |

Orchestration: `src/hooks/useMultiHorizonAccuracy.ts`.
Backend: `backend/exchangeClock.ts` (`GET /api/exchange/clock`) and
`backend/marketHistory.ts` (`GET /api/exchange/ohlc?pair=XBTUSD&interval=1`),
both Kraken-public and key-free.

## Point-in-time invariants

1. **Immutable snapshots** — `createSnapshot()` deep-freezes `t0`, `P(t0)`,
   the component state and the seven pending slots; every record carries an
   FNV-1a checksum.
2. **No repainting** — realised prices go to a **separate** `resolutions[]`
   collection keyed by `(snapshotId, horizon)`. Snapshots have no writable
   outcome field, so they cannot absorb future data.
3. **Monotonic t0** — `appendSnapshot()` rejects back-dated or duplicate
   snapshots (`E4100`) per origin.
4. **Maturation gate** — a horizon may only resolve once
   `nowExchangeMs >= t0 + h · 60_000`; both the target time and the resolution
   timestamp are re-checked (`E5000`).
5. **Authoritative time** — timestamps come from the exchange clock
   (`offset = krakenTime − (t_send + rtt/2)`), never `Date.now()` alone. Skew
   above 2 000 ms rejects the signal (`E1200`); an unreachable Kraken clock
   degrades to a visibly `THROTTLED` snapshot.
6. **No fabrication** — a matured horizon that lies before the observation
   window stays open and is reported as `E3000`; no price is interpolated.
7. **Feed-divergence guard** — if the live spot price differs from the last
   OHLC close by more than 3 %, the live overlay is dropped and reported
   (`E3000`) instead of injecting a phantom jump into ATR / volatility / regime
   detection. Without this guard a two-feed disagreement can fake a
   `HIGH_VOL_CRISIS`.

## Feature basis — 1-minute bars, not ticks

RSI(14) over 14 raw 4-second ticks is microstructure noise, and EMA50/200 over
3/13 minutes is not the indicator the specification describes. Ticks are
therefore resampled into **1-minute bars**, backfilled from Kraken OHLC (480
bars) and refreshed every three minutes; live ticks overlay the forming bar.

- `RSI(14)` — 14 bars, **ATR(14)** with true range, **Bollinger(20, 2σ)**
- `EMA50/200 delta` — SMA-seeded EMAs (a first-value seed biases a 200-period
  EMA towards its oldest sample and turns the delta into a lagged momentum
  proxy that flips sign on fast cycles)
- `ATR(14)/Close` percentile over the last 100 bars, **Hurst** (R/S) over ≥ 40
  return samples
- `σ` per minute — realised volatility with explicit interval scaling

If the OHLC route is unavailable the widget runs in a visible warm-up state and
finally falls back to the venue bar closes as the reference price (real prices,
just bar-sampled) — never to the built-in demo constant.

## Scoring

```
return_h      = (P(t0+h) − P(t0)) / P(t0)
neutral_h     = |return_h| < 0.25 · σ_h            // volatility-scaled band
DA_h          = hits / N_decisive                  // N_decisive = neutral_h = false
MC_h          = clamp(100 · (1 − sMAPE_h / (2 σ_h)), 0, 100)
Accuracy_h    = 0.55 · DA_h + 0.45 · MC_h
Brier         = (y_cal − outcome)²
N_eff_h       = N_h · min(1, median_snapshot_spacing / h)
w_h           = N_eff_h / (N_eff_h + 5)
rankedScore_h = w_h · Accuracy_h
```

Three deliberate choices, each measured:

- **Volatility-scaled neutral band.** A fixed 0.05 % band swallows ~68 % of
  5-minute BTC moves but only ~22 % of 60-minute moves, which caps a
  zero-skill model at ~41 % and rewards reckless calling. Scaling by `σ_h`
  keeps the class balance (≈ 20 % flat) horizon-independent.
- **Hit rate on decisive outcomes.** Abstentions are not charged against flat
  markets; coverage (`% of outcomes that actually moved`) is reported next to
  every hit rate so the basis stays visible.
- **Overlap correction.** Consecutive 1-minute snapshots share up to
  `h` minutes of the same price path. `N_eff` discounts that; the Wilson bound,
  the confidence weight and the provisional/graduation flags all use it. Raw
  counts are shown as `N`, corrected ones as `N_eff`.

Implied targets use `κ = 0.8 + 2.2 · persistence(Hurst)` in horizon sigmas:
measured κ\* is 2.8–8 on trending tapes and ≈ 0 on a random walk, so
persistence (not conviction alone) sets the fan width.

## Verdict gates (German banner, conservative by construction)

| Condition | Code | Meaning |
| --- | --- | --- |
| no resolutions | `E2000` | data basis too thin |
| `N_eff < 3` | `E2000` | provisional only |
| Wilson lower bound < 50 % | `E2100` | hit rate not distinguishable from a coin flip |
| best horizon fails split-half | `E2100` | edge does not hold out of sample |
| `rankedScore < 55 %` | `E2100` | unproven / low confidence |
| all gates pass | — | "HORIZONT h MIN IST DER ZUVERLÄSSIGSTE" |

Graduation for the paper strategy follows the specification literally
(`N ≥ 20`, `WR ≥ 55 %`, `PF ≥ 1.6`, strict tier at `N ≥ 30`). Graduation is a
raw-count metric; the *tradeable* verdict additionally requires statistical
significance and out-of-sample consistency.

## Components

1. `onnxCalibratedScore` — head over **RSI / ATR / CISD / BB** →
   `y_cal = sigmoid(logit(y_hat)/T + bias)`. `T` and `bias` are re-fitted
   online from realised outcomes (gradient on log-loss, `T ∈ [0.5, 3]`), with
   the bias shrunk toward zero (`n/(n+30)`, clamped to ±0.4): calibration
   corrects a probability offset, it must not become a permanent directional
   bet (an unshrunk bias lets a random walk look skilful by luck).
2. `jevSystem1RegimeGate` — EMA50/200 delta + `ATR(14)/Close` percentile +
   Hurst → `STRONG_BULL | WEAK_BULL | STRONG_BEAR | WEAK_BEAR | RANGING_CHOP |
   HIGH_VOL_CRISIS`, with gate confidence. The gate acts as a **risk veto**
   (counter-regime calls are damped), not as a second forecast: the 50/200 gap
   is a regime descriptor, phase-lagged at 5–60 minute horizons.
3. `krakenPaperExecSignal` — signed execution and sizing impulse plus
   graduation metrics.

### Deliberate deviation: no OpenRouter call in the gate

The specification describes the System-1 gate as "via OpenRouter". Here it is a
deterministic rule-based gate instead: an LLM call per snapshot would make the
ledger non-reproducible (the same ticks could produce different component
values on replay), break the point-in-time checksum contract and add an
external failure mode to a 1-minute cadence. The adapter point is isolated —
wire `src/features/multiHorizon/featureEngine.ts#classifyRegime` /
`jevGateConfidence` to the existing `backend/multiProvider.ts` if an LLM
annotation is wanted, but keep the frozen snapshot values rule-derived.

## Error taxonomy

| Code | Meaning |
| --- | --- |
| `E1000` | stale feed / `STALE_SIGNAL_REJECT` |
| `E1200` | exchange clock skew / non-authoritative clock |
| `E2000` | insufficient bars or samples |
| `E2100` | low confidence, not significant, or not out-of-sample |
| `E3000` | price feed unavailable, matured slot without observation, feed divergence |
| `E4000` | checksum / integrity violation |
| `E4100` | duplicate, back-dated or schema reject |
| `E5000` | future-leak guard / UI fallback |

## Replay data

`Replay-Vorschau laden` seeds deterministic synthetic history (24 h, 10-minute
snapshots, 400/180-minute trend cycles) tagged `origin: 'REPLAY'`. Replay
records live in the same append-only ledger but are excluded from every LIVE
aggregate, from the tradeable verdict and from the Kraken graduation; the UI
shows a `REPLAY (SYNTHETISCH)` badge plus a toggle. They can be removed at any
time without touching LIVE history.

## Verification

```bash
npm run test:horizon   # 24 invariant, metric and statistical-honesty tests
npm run typecheck
npm run build
```

The suite includes two behavioural guarantees rather than snapshot assertions:

- *a random walk is never declared tradeable* — no edge is invented;
- *a genuinely trending tape is detected and ranked* — a real edge is not
  hidden by the conservative gates.

Both run the production code path (snapshot → resolution → calibration →
verdict). A 20-seed Monte-Carlo over both tape types measures **0/20 false
positives and 20/20 true positives**; the earlier, unguarded implementation
scored 10/20 false positives, which is why the overlap correction, the
effective-count Wilson bound, the bias shrinkage and the split-half gate exist.

## Notes / limits

- The ledger persists in `localStorage` (`nin:paragraph2:horizon-ledger:v2`);
  hydration verifies every checksum and quarantines corrupted records. For a
  multi-operator deployment point `saveLedger`/`loadLedger` at the existing
  Upstash/`stateStore` backend. The schema version was bumped, so v1 ledgers
  from an earlier build are discarded instead of being mis-scored.
- Resolutions require the app to observe the feed at the target time. Horizons
  that matured while the app was closed stay open by design (`E3000`).
- LIVE evidence accrues slowly by construction: at one snapshot per minute a
  5-minute horizon reaches `N_eff ≈ 96` after eight hours, a 300-minute horizon
  needs considerably longer. That is the point of the overlap correction.
