import numpy as np

class MicrostructureEngine:
    def __init__(self):
        self.bins = 26

    def calculate_obi(self, bids, asks, depth_pct=0.02, current_price=None):
        """Calculate Orderbook Imbalance in 2% depth."""
        if not bids or not asks or not current_price:
            return 0.0

        lower_bound = current_price * (1 - depth_pct)
        upper_bound = current_price * (1 + depth_pct)

        bid_vol = sum(v for p, v in bids if p >= lower_bound)
        ask_vol = sum(v for p, v in asks if p <= upper_bound)

        total_vol = bid_vol + ask_vol
        if total_vol == 0:
            return 0.0

        return (bid_vol - ask_vol) / total_vol

    def calculate_footprint_map(self, trades, min_price, max_price):
        """Intra-Bar Volume Delta Footprint Map (Zeiierman Port)."""
        if max_price == min_price:
            return np.zeros(self.bins)

        bins = np.linspace(min_price, max_price, self.bins + 1)
        delta_map = np.zeros(self.bins)

        for price, volume, is_buyer_maker in trades:
            bin_idx = np.digitize(price, bins) - 1
            if 0 <= bin_idx < self.bins:
                if is_buyer_maker: # Maker was buyer -> seller hit bid -> negative delta
                    delta_map[bin_idx] -= volume
                else:
                    delta_map[bin_idx] += volume

        return delta_map
