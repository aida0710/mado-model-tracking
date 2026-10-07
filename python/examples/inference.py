"""Load the registered linear model (or a local weights file) and produce CPU predictions."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from contextlib import nullcontext
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Short CPU inference example")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--values", nargs="+", type=float, default=[0.0, 1.0, 2.0])
    parser.add_argument("--output", type=Path, default=Path("outputs/predictions.json"))
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    if arguments.offline:
        context = nullcontext(None)
    else:
        from mado_tracking import start_run

        context = start_run(
            name=None if os.environ.get("MMT_RUN_ID") else "CPU linear inference",
            kind="inference",
            parameters={"values": arguments.values},
        )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with context as run:
        weights_path = arguments.weights
        if weights_path is None and run is not None:
            weights_path = run.download_input_model(arguments.output.parent / "input-weights.json")
        if weights_path is None:
            raise ValueError("--weights is required in offline mode")
        model = json.loads(weights_path.read_text())
        predictions = [{"x": x, "prediction": model["weight"] * x + model["bias"]} for x in arguments.values]
        arguments.output.write_text(json.dumps(predictions), encoding="utf-8")
        print(json.dumps(predictions), flush=True)
        if run is not None:
            run.log_metrics({"inference.predictions": len(predictions)})
            artifact = run.log_artifact(arguments.output, path="inference/predictions.json")
            digest = hashlib.sha256(arguments.output.read_bytes()).hexdigest()
            run.register_output_dataset(
                name=f"cpu-predictions-{run.id}",
                version="v1",
                digest=f"sha256:{digest}",
                uri=f"mmt://{run.project_id}/artifacts/{artifact['id']}",
                schema={"x": "number", "prediction": "number"},
            )


if __name__ == "__main__":
    main()
