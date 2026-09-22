import numpy as np

class ACGravityEngine:
    def __init__(self):
        self.quantile = 0.999

    def calculate_power(self, p, q):
        # AC Active Power P, Reactive Power Q
        S = np.sqrt(p**2 + q**2)
        power_factor = p / S if S != 0 else 0
        return p, q, power_factor

    def compute_gravity_field(self, l2_depth, l3_iceberg, polymarket_prob):
        # 0.25 L2 + 0.35 L3 Iceberg + 0.40 Polymarket
        return 0.25 * l2_depth + 0.35 * l3_iceberg + 0.40 * polymarket_prob

    def is_in_forbidden_zone(self, current_value, historical_data):
        if not historical_data:
            return False
        upper_bound = np.quantile(historical_data, self.quantile)
        lower_bound = np.quantile(historical_data, 1.0 - self.quantile)
        return current_value > upper_bound or current_value < lower_bound
