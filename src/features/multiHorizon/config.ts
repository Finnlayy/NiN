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

/** |return| below this band counts as a neutral (0) move. */
export const NEUTRAL_BAND_PERCENT = 0.05;

/** Exchange clock drift above this value rejects the signal (E1200). */
export const MAX_CLOCK_SKEW_MS = 2_000;

/** Feed age above this value rejects the signal (E1000). */
export const MAX_FEED_AGE_MS = 45_000;

/** How often a new Paragraph 2 snapshot is frozen. */
export const SNAPSHOT_CADENCE_MS = 60_000;

/** Minimum tick history before features are considered usable. */
export const MIN_TICKS_FOR_SNAPSHOT = 8;

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

/** Ledger retention caps (append-only records only). */
export const MAX_STORED_SNAPSHOTS = 320;
export const MAX_STORED_RESOLUTIONS = 2_400;

/** Persistence key / schema version. */
export const LEDGER_STORAGE_KEY = 'nin:paragraph2:horizon-ledger:v1';
export const LEDGER_VERSION = 1;
