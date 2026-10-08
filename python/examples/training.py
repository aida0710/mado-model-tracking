"""Train a CPU linear model, or fine-tune a pinned model's real input weights."""

from __future__ import annotations

import argparse
import json
import math
import os
from contextlib import nullcontext
from pathlib import Path

# Every Run adds the next numbered version (1, 2, 3, ...) to this one Model; the Run lists it
# in outputModelVersionIds.
OUTPUT_MODEL_NAME = "cpu-linear"


def initial_weights(*, kind: str, directory: Path, run=None) -> tuple[float, float]:
    if kind == "training":
        return 0.0, 0.0
    if kind != "finetuning":
        raise ValueError("CPU training example supports training and finetuning Runs")
    if run is not None and not run.entity.get("modelVersionId"):
        raise ValueError("finetuning requires a pinned Run.modelVersionId")
    model_file = os.environ.get("MMT_MODEL_FILE")
    if model_file:
        weights_path = Path(model_file)
    elif run is not None:
        weights_path = run.download_input_model(directory / "input-weights.json")
    else:
        raise ValueError("Offline finetuning requires MMT_MODEL_FILE with input weights")
    try:
        model = json.loads(weights_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("finetuning input weights must be a readable JSON model") from None
    if not isinstance(model, dict) or model.get("family") != "linear":
        raise ValueError("finetuning input model must have family linear")
    coefficients = [model.get(name) for name in ("weight", "bias")]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in coefficients):
        raise ValueError("finetuning input model requires numeric weight and bias")
    try:
        weight, bias = (float(value) for value in coefficients)
    except OverflowError:
        raise ValueError("finetuning input weight and bias must be finite") from None
    if not math.isfinite(weight) or not math.isfinite(bias):
        raise ValueError("finetuning input weight and bias must be finite")
    return weight, bias


def train(
    *, steps: int, learning_rate: float, output: Path, initial_weight: float, initial_bias: float, run=None
) -> dict:
    examples = [(-1.0, -1.0), (0.0, 1.0), (1.0, 3.0), (2.0, 5.0)]
    weight, bias = initial_weight, initial_bias
    print(f"initial_weight={weight:.6f} initial_bias={bias:.6f}", flush=True)
    for step in range(steps):
        errors = [weight * x + bias - y for x, y in examples]
        loss = sum(error * error for error in errors) / len(examples)
        weight -= (
            learning_rate
            * 2
            * sum(error * pair[0] for error, pair in zip(errors, examples, strict=True))
            / len(examples)
        )
        bias -= learning_rate * 2 * sum(errors) / len(examples)
        print(f"step={step} loss={loss:.6f}", flush=True)
        if run is not None:
            run.log_metrics({"train.loss": loss}, step=step)
    model = {"family": "linear", "weight": weight, "bias": bias, "steps": steps}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model), encoding="utf-8")
    if run is not None:
        artifact = run.log_artifact(output, path="model/weights.json", mime_type="application/json")
        run.register_output_model(
            model_name=OUTPUT_MODEL_NAME,
            family="linear",
            artifact_id=artifact["id"],
            metadata={
                "algorithm": "gradient descent",
                "steps": steps,
                "initial_weight": initial_weight,
                "initial_bias": initial_bias,
            },
        )
    return model


def main() -> None:
    parser = argparse.ArgumentParser(description="Short CPU training / finetuning example")
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--learning-rate", type=float, default=0.1)
    parser.add_argument("--output", type=Path, default=Path("outputs/weights.json"))
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    parameters = {}
    if os.environ.get("MMT_PARAMETERS_FILE"):
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    steps = int(parameters.get("steps", arguments.steps))
    learning_rate = float(parameters.get("learning_rate", arguments.learning_rate))
    if steps <= 0 or not 0 < learning_rate < 0.5:
        raise ValueError("steps must be positive; learning_rate must be between 0 and 0.5")
    if arguments.offline:
        context = nullcontext(None)
    else:
        from mado_tracking import start_run

        context = start_run(
            name=None if os.environ.get("MMT_RUN_ID") else "CPU linear training / finetuning",
            kind=os.environ.get("MMT_JOB_KIND", "training"),
            model_version_id=os.environ.get("MMT_MODEL_VERSION_ID") or None,
            parameters={"steps": steps, "learning_rate": learning_rate},
        )
    with context as run:
        kind = run.entity["kind"] if run is not None else os.environ.get("MMT_JOB_KIND", "training")
        if os.environ.get("MMT_JOB_KIND") and kind != os.environ["MMT_JOB_KIND"]:
            raise ValueError("MMT_JOB_KIND does not match Run.kind")
        weight, bias = initial_weights(kind=kind, directory=arguments.output.parent, run=run)
        model = train(
            steps=steps,
            learning_rate=learning_rate,
            output=arguments.output,
            initial_weight=weight,
            initial_bias=bias,
            run=run,
        )
    print(f"weight={model['weight']:.6f} bias={model['bias']:.6f}", flush=True)


if __name__ == "__main__":
    main()
