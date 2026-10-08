"""A smoke command that can also exercise a failed test Run."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from main import VERSION


class CodeSmokeTest(unittest.TestCase):
    def test_saved_code_has_the_requested_version(self) -> None:
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
        print(f"tested_code_version={VERSION}", flush=True)
        self.assertEqual(VERSION, parameters["expected_version"])
        self.assertFalse(parameters.get("fail_test", False), "intentional test failure")


if __name__ == "__main__":
    unittest.main()
