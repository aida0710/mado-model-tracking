"""A tiny tracking workload that changes its file after execution starts."""

from __future__ import annotations

import json
from pathlib import Path

VERSION = 1
# A handful of points makes the native metric history visible in the browser.
DEMO_STEPS = 5


def main() -> None:
    from mado_tracking import start_run

    with start_run(kind="processing") as run:
        print(f"executed_code_version={VERSION}", flush=True)
        for step in range(DEMO_STEPS):
            run.log_metrics({"demo.loss": VERSION / (step + 1)}, step=step)
        output = Path("outputs/prediction.json")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps({"codeVersion": VERSION, "prediction": VERSION * 3})
        )
        run.log_artifact(
            output, path="results/prediction.json", mime_type="application/json"
        )
    # The saved source must describe what started, even if a workload edits itself.
    Path(__file__).write_text("# modified during execution\n", encoding="utf-8")


if __name__ == "__main__":
    main()
