class TheJudgeM8:
    def __init__(self, config):
        self.config = config

    def check_invariants(self, leverage, slippage, power_factor, vault_ratio, in_forbidden_zone, feed_live):
        # Axiom 1: Feed Integrity
        if not feed_live:
            return False, "Feed disconnected"

        # Axiom 2: Forbidden Zone
        if in_forbidden_zone:
            return False, "In forbidden zone"

        # Axiom 3: Max Leverage 5x
        if leverage > self.config.MAX_TOTAL_LEVERAGE:
            return False, f"Leverage {leverage}x exceeds max {self.config.MAX_TOTAL_LEVERAGE}x"

        # Axiom 4: Slippage Budget 15 bps
        if slippage > self.config.MAX_SLIPPAGE_BPS:
            return False, f"Slippage {slippage} bps exceeds max {self.config.MAX_SLIPPAGE_BPS} bps"

        # Axiom 5: AC Resonance (Power factor >= 0.89)
        if power_factor < 0.89:
            return False, f"Power factor {power_factor} < 0.89"

        # Axiom 6: 10% Vault Reserve
        if vault_ratio < self.config.MIN_VAULT_RESERVE_RATIO:
            return False, f"Vault reserve {vault_ratio} < min {self.config.MIN_VAULT_RESERVE_RATIO}"

        return True, "All invariants passed"
