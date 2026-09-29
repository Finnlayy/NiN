import numpy as np

#: Blueprint §2 prior. Kept here (not imported from ``core.config``) so this
#: module stays usable with only numpy — ``core.config`` pulls in pydantic.
DEFAULT_WEIGHTS = (0.25, 0.35, 0.40)
#: Matches ``OmegaConfig.VIA_NEGATIVA_QUANTILE`` in ``core/config.py``.
DEFAULT_QUANTILE = 0.999
DEFAULT_HISTORY_WINDOW = 512
QUANTILE_FLOOR = 0.5
QUANTILE_CEIL = 0.9999
SIMPLEX_TOLERANCE = 1e-6


def _validate_window(history_window):
    if isinstance(history_window, bool) or not isinstance(history_window, (int, np.integer)):
        raise ValueError("history_window must be an int, got %r" % (history_window,))
    window = int(history_window)
    if window < 2:
        raise ValueError("history_window must be >= 2, got %d" % (window,))
    return window


def _validate_simplex(weights):
    """Three strictly positive weights that sum to 1."""
    try:
        values = tuple(float(w) for w in weights)
    except (TypeError, ValueError) as exc:
        raise ValueError("weights must be three finite numbers") from exc
    if len(values) != 3:
        raise ValueError("weights must have length 3, got %d" % (len(values),))
    if any(w != w or w in (float("inf"), float("-inf")) or w <= 0.0 for w in values):
        raise ValueError("weights must be finite and > 0, got %r" % (values,))
    total = sum(values)
    if abs(total - 1.0) > SIMPLEX_TOLERANCE:
        raise ValueError("weights must sum to 1 (got %.6f)" % (total,))
    # Renormalize tiny residual so downstream sums stay exact.
    return tuple(w / total for w in values)


def _validate_quantile(quantile):
    try:
        value = float(quantile)
    except (TypeError, ValueError) as exc:
        raise ValueError("quantile must be a float") from exc
    if value != value or value < QUANTILE_FLOOR or value > QUANTILE_CEIL:
        raise ValueError(
            "quantile must be in [%.4f, %.4f], got %r" % (QUANTILE_FLOOR, QUANTILE_CEIL, quantile)
        )
    return value


class ACGravityEngine:
    def __init__(self, weights=DEFAULT_WEIGHTS, quantile=DEFAULT_QUANTILE, history_window=DEFAULT_HISTORY_WINDOW):
        self.history_window = _validate_window(history_window)
        self.weights = DEFAULT_WEIGHTS
        self.quantile = DEFAULT_QUANTILE
        self.set_weights(weights)
        self.set_quantile(quantile)

    def set_weights(self, weights):
        self.weights = _validate_simplex(weights)
        return self.weights

    def set_quantile(self, quantile):
        self.quantile = _validate_quantile(quantile)
        return self.quantile

    def params(self):
        w_vis, w_blind, w_poly = self.weights
        return {
            "w_vis": w_vis,
            "w_blind": w_blind,
            "w_poly": w_poly,
            "quantile": self.quantile,
            "history_window": self.history_window,
        }

    def calculate_power(self, p, q):
        # AC Active Power P, Reactive Power Q
        S = np.sqrt(p**2 + q**2)
        power_factor = p / S if S != 0 else 0
        return p, q, power_factor

    def compute_gravity_field(self, l2_depth, l3_iceberg, polymarket_prob):
        # w_vis * L2 + w_blind * L3 Iceberg + w_poly * Polymarket
        w_vis, w_blind, w_poly = self.weights
        return w_vis * l2_depth + w_blind * l3_iceberg + w_poly * polymarket_prob

    def is_in_forbidden_zone(self, current_value, historical_data):
        if not historical_data:
            return False
        upper_bound = np.quantile(historical_data, self.quantile)
        lower_bound = np.quantile(historical_data, 1.0 - self.quantile)
        return current_value > upper_bound or current_value < lower_bound
