"""Thin smoke of the automated pipeline: the success path up to the automatic promotion and the
failed training, without the second round, the result.json path or containers.

It is scripts/verify_pipeline.py with fewer stages; the report goes to
artifacts/verification/<JST date>/pipeline-smoke/pipeline-smoke.json.
"""

from __future__ import annotations

import sys

from verify_pipeline import SMOKE_PROFILE, main

if __name__ == "__main__":
    sys.exit(main(SMOKE_PROFILE))
