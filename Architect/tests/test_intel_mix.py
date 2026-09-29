"""The third-component mix matches the shared fixture."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ARCHITECT = Path(__file__).resolve().parents[1]
if str(ARCHITECT) not in sys.path:
    sys.path.insert(0, str(ARCHITECT))

from limbs.math.intel_mix import mix_intel  # noqa: E402

FIXTURE = ARCHITECT / "tests" / "fixtures" / "intel_mix.json"


class IntelMixTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_fixture_cases(self):
        for case in self.fixture["cases"]:
            mix = mix_intel(case["sources"])
            with self.subTest(case=case["name"]):
                if case["value"] is None:
                    self.assertIsNone(mix["value"])
                else:
                    self.assertAlmostEqual(mix["value"], case["value"], places=9)
                self.assertEqual([item["id"] for item in mix["contributions"]], case["ids"])
                if mix["contributions"]:
                    self.assertAlmostEqual(sum(item["weight"] for item in mix["contributions"]), 1.0, places=9)


if __name__ == "__main__":
    unittest.main()
