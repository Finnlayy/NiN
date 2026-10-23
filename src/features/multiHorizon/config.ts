/**
 * Central tuning constants for the multi-horizon accuracy pipeline.
 * Values are deliberately conservative: a horizon must prove itself before it
 * is allowed to influence a trading verdict.
 */

/** Bayesian sample-confidence shrinkage factor: w = N / (N + k). */
export const CONFIDENCE_K = 5;

/** Minimum samples before a horizon leaves "unproven" status. */
export const MIN_SAMPLES_PROVISIONAL = 3;

/** Kraken paper-mode graduation targets. */
export const GRADUATION_SAMPLES = 20;
export const GRADUATION_SAMPLES_STRICT = 30;
export const GRADUATION_WIN_RATE = 0.55;
export const GRADUATION_PROFIT_FACTOR = 1.6;

/**
 * Neutral (flat) outcome band, expressed in horizon sigmas.
 *
 * A fixed percentage band is horizon-blind: on 1-minute BTC volatility a flat
 * 0.05 % band swallows ~68 % of 5-minute moves but only ~22 % of 60-minute
 * moves, which drags the directional hit rate far below the 50 % zero-skill
 * baseline at short horizons. Scaling by the snapshot's own σ_h keeps the
 * class balance stable across horizons and volatility regimes.
 */
export const NEUTRAL_BAND_SIGMA = 0.25;

/** Absolute floor for the neutral band (percent) so it never collapses. */
export const NEUTRAL_BAND_FLOOR_PERCENT = 0.005;

/** Exchange clock drift above this value rejects the signal (E1200). */
export const MAX_CLOCK_SKEW_MS = 2_000;

/**
 * Feed age above this value rejects the signal (E1000). Sized for the 1-minute
 * bar cadence: when the live tick route is unavailable the reference price is
 * derived from the last venue bar (up to 60 s old), which is still a real price.
 */
export const MAX_FEED_AGE_MS = 90_000;

/** How often a new Paragraph 2 snapshot is frozen. */
export const SNAPSHOT_CADENCE_MS = 60_000;

/**
 * Minimum 1-minute bars before a snapshot is allowed. RSI(14) needs 15 bars and
 * the Bollinger window 20; EMA200/ATR-percentile/Hurst mark the snapshot
 * THROTTLED until WARMUP_BARS are available.
 */
export const MIN_BARS_FOR_SNAPSHOT = 20;

/** Live tick polling cadence. */
export const TICK_POLL_MS = 4_000;

/** Clock re-sync cadence. */
export const CLOCK_SYNC_MS = 15_000;

/** Accuracy blend: direction hit rate vs trajectory closeness. */
export const ACCURACY_DIRECTION_WEIGHT = 0.55;
export const ACCURACY_MAGNITUDE_WEIGHT = 0.45;

/** Verdict threshold on the confidence-weighted score. */
export const MIN_TRADEABLE_RANK_SCORE = 55;

/** Rolling Brier target used by the calibration optimiser. */
export const TARGET_BRIER = 0.2;

/** Magnitude-closeness tolerance in horizon sigmas (MC = 100 - sMAPE/tol). */
export const MC_TOLERANCE_SIGMA = 2.0;

/**
 * Target displacement in horizon sigmas at full conviction. The effective
 * displacement grows with measured persistence (Hurst), because a persistent
 * trend carries further than a random walk: κ = BASE + GAIN · persistence.
 * On a random walk (H ≈ 0.5) persistence is 0, so no conviction is inflated.
 */
export const TARGET_DISPLACEMENT_SIGMA = 0.8;
export const TARGET_DISPLACEMENT_PERSISTENCE_GAIN = 2.2;

/** Reference per-minute volatility (%) used to z-score the volatility feature. */
export const REFERENCE_SIGMA_PER_MINUTE_PERCENT = 0.15;

/** Realised-volatility clamps (percent per minute). */
export const MIN_SIGMA_PER_MINUTE_PERCENT = 0.01;
export const MAX_SIGMA_PER_MINUTE_PERCENT = 0.8;

/** Ledger retention caps (append-only records only). */
export const MAX_STORED_SNAPSHOTS = 320;
export const MAX_STORED_RESOLUTIONS = 2_400;

/** Persistence key / schema version. */
export const LEDGER_STORAGE_KEY = 'nin:paragraph2:horizon-ledger:v2';
export const LEDGER_VERSION = 2;
