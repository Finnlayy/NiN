"""Shared fixture for the Polymarket strike-ladder density."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ARCHITECT = Path(__file__).resolve().parents[1]
if str(ARCHITECT) not in sys.path:
    sys.path.insert(0, str(ARCHITECT))

from limbs.math.polymarket_density import density_from_ladder  # noqa: E402

FIXTURE = ARCHITECT / "tests" / "fixtures" / "polymarket_density.json"


class PolymarketDensityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_mass_above_spot_matches_fixture(self) -> None:
        result = density_from_ladder(self.fixture["ladder"], self.fixture["spot"])
        self.assertIsNotNone(result)
        assert result is not None
        masses = [row["mass"] for row in result["bins"]]
        self.assertEqual(len(masses), len(self.fixture["masses"]))
        for actual, expected in zip(masses, self.fixture["masses"]):
            self.assertAlmostEqual(actual, expected, places=9)
        self.assertAlmostEqual(result["poly"], self.fixture["poly"], places=9)
        self.assertAlmostEqual(sum(masses), 1.0, places=9)

    def test_rising_ladder_is_unusable(self) -> None:
        self.assertIsNone(density_from_ladder(self.fixture["rising"], self.fixture["spot"]))

    def test_short_ladder_is_unusable(self) -> None:
        self.assertIsNone(density_from_ladder(self.fixture["short"], self.fixture["spot"]))


if __name__ == "__main__":
    unittest.main()
