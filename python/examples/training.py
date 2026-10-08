"""Train a CPU linear model, or fine-tune a pinned model's real input weights.

The optimizer is SGD with momentum. With --checkpoint-every N (or the checkpoint_every parameter)
the weights, the momentum buffers and the step are saved as a checkpoint every N steps, and a Job
that resumes from one continues with exactly the saved state, so its result equals an
uninterrupted run.

When the Run belongs to a Task with an output model setting, the Task registers the version once
the Run has finished; the script then only saves the weights at the Task's ``artifactPath`` instead
of registering them itself (registering both would make the Task skip its registration).
"""

from __future__ import annotations

import argparse
import json
import math
import os
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path

# Every Run adds the next numbered version (1, 2, 3, ...) to this one Model; the Run lists it
# in outputModelVersionIds.
OUTPUT_MODEL_NAME = "cpu-linear"
WEIGHTS_ARTIFACT_PATH = "model/weights.json"
EXAMPLES = [(-1.0, -1.0), (0.0, 1.0), (1.0, 3.0), (2.0, 5.0)]
# 0.5 converges in the default 40 steps; momentum close to 1 would still oscillate there.
DEFAULT_MOMENTUM = 0.5
# 0 saves no checkpoints, so a plain run needs no upload sessions.
DEFAULT_CHECKPOINT_EVERY = 0
MODEL_STATE_FILE = "model.json"
OPTIMIZER_STATE_FILE = "optimizer.json"
CHECKPOINT_FRAMEWORK = "python-sgd-momentum"


@dataclass
class TrainingState:
    weight: float
    bias: float
    velocity_weight: float = 0.0
    velocity_bias: float = 0.0
    # Number of completed optimizer steps; a resumed run continues with this step index.
    step: int = 0

    def optimizer_state(self) -> dict:
        return {"velocity_weight": self.velocity_weight, "velocity_bias": self.velocity_bias}


def save_checkpoint(state: TrainingState, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / MODEL_STATE_FILE).write_text(
        json.dumps({"family": "linear", "weight": state.weight, "bias": state.bias})
    )
    write_optimizer_state(state, directory / OPTIMIZER_STATE_FILE)


def write_optimizer_state(state: TrainingState, path: Path) -> None:
    path.write_text(json.dumps({**state.optimizer_state(), "step": state.step}))


def load_checkpoint(directory: Path, *, step: int) -> TrainingState:
    model = json.loads((directory / MODEL_STATE_FILE).read_text())
    optimizer = json.loads((directory / OPTIMIZER_STATE_FILE).read_text())
    if optimizer.get("step") != step:
        raise ValueError("Checkpoint optimizer step does not match the resume step")
    return TrainingState(
        weight=float(model["weight"]),
        bias=float(model["bias"]),
        velocity_weight=float(optimizer["velocity_weight"]),
        velocity_bias=float(optimizer["velocity_bias"]),
        step=step,
    )


def resume_checkpoint(run=None):
    if run is not None:
        return run.resume_checkpoint()
    from mado_tracking.checkpoints import resume_checkpoint_from_environment

    return resume_checkpoint_from_environment()


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
    *,
    steps: int,
    learning_rate: float,
    momentum: float,
    output: Path,
    state: TrainingState,
    checkpoint_every: int,
    fail_at_step: int | None = None,
    run=None,
    task_output_model: dict | None = None,
) -> dict:
    initial_weight, initial_bias = state.weight, state.bias
    print(f"start_step={state.step} weight={state.weight:.6f} bias={state.bias:.6f}", flush=True)
    for step in range(state.step, steps):
        if step == fail_at_step:
            raise RuntimeError(f"Simulated interruption at step {step}")
        errors = [state.weight * x + state.bias - y for x, y in EXAMPLES]
        loss = sum(error * error for error in errors) / len(EXAMPLES)
        gradient_weight = 2 * sum(error * pair[0] for error, pair in zip(errors, EXAMPLES, strict=True))
        gradient_weight /= len(EXAMPLES)
        gradient_bias = 2 * sum(errors) / len(EXAMPLES)
        state.velocity_weight = momentum * state.velocity_weight + gradient_weight
        state.velocity_bias = momentum * state.velocity_bias + gradient_bias
        state.weight -= learning_rate * state.velocity_weight
        state.bias -= learning_rate * state.velocity_bias
        state.step = step + 1
        print(f"step={step} loss={loss:.6f}", flush=True)
        if run is not None:
            # The metric step continues the saved one after a resume, so the curve has no restart.
            run.log_metrics({"train.loss": loss}, step=step)
        if checkpoint_every and state.step % checkpoint_every == 0 and state.step < steps:
            write_checkpoint(state, output=output, run=run)
    model = {"family": "linear", "weight": state.weight, "bias": state.bias, "steps": steps}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model), encoding="utf-8")
    # Kept next to the weights so a continuation (or a comparison) has the full training state.
    write_optimizer_state(state, output.parent / OPTIMIZER_STATE_FILE)
    if run is not None and task_output_model is not None:
        run.log_artifact(output, path=task_output_model["artifactPath"], mime_type="application/json")
        print(f"output model: the Task registers {task_output_model['artifactPath']}", flush=True)
    elif run is not None:
        artifact = run.log_artifact(output, path=WEIGHTS_ARTIFACT_PATH, mime_type="application/json")
        run.register_output_model(
            model_name=OUTPUT_MODEL_NAME,
            family="linear",
            artifact_id=artifact["id"],
            metadata={
                "algorithm": "gradient descent with momentum",
                "steps": steps,
                "initial_weight": initial_weight,
                "initial_bias": initial_bias,
            },
        )
    return model


def output_model_of_task(run) -> dict | None:
    """The output model setting of the Run's Task, or None when the script registers the weights."""
    task_id = run.entity.get("taskId")
    if not task_id:
        return None
    return run.client.get_task(run.project_id, task_id).get("outputModel")


def write_checkpoint(state: TrainingState, *, output: Path, run=None) -> None:
    """Save locally under checkpoints/step-N; a tracked Run also uploads it as its checkpoint."""
    directory = output.parent / "checkpoints" / f"step-{state.step}"
    save_checkpoint(state, directory)
    if run is not None:
        run.log_checkpoint(
            directory,
            step=state.step,
            includes_optimizer=True,
            framework=CHECKPOINT_FRAMEWORK,
            metadata={"momentum": True},
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Short CPU training / finetuning example")
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--learning-rate", type=float, default=0.1)
    parser.add_argument("--output", type=Path, default=Path("outputs/weights.json"))
    parser.add_argument("--momentum", type=float, default=DEFAULT_MOMENTUM)
    parser.add_argument("--checkpoint-every", type=int, default=DEFAULT_CHECKPOINT_EVERY)
    parser.add_argument(
        "--fail-at-step", type=int, default=None, help="Stop with an error at this step (resume demo)"
    )
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    parameters = {}
    if os.environ.get("MMT_PARAMETERS_FILE"):
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    steps = int(parameters.get("steps", arguments.steps))
    learning_rate = float(parameters.get("learning_rate", arguments.learning_rate))
    momentum = float(parameters.get("momentum", arguments.momentum))
    checkpoint_every = int(parameters.get("checkpoint_every", arguments.checkpoint_every))
    fail_at_step = parameters.get("fail_at_step", arguments.fail_at_step)
    if steps <= 0 or not 0 < learning_rate < 0.5:
        raise ValueError("steps must be positive; learning_rate must be between 0 and 0.5")
    if not 0 <= momentum < 1 or checkpoint_every < 0:
        raise ValueError("momentum must be in [0, 1); checkpoint_every must not be negative")
    if arguments.offline:
        context = nullcontext(None)
    else:
        from mado_tracking import start_run

        context = start_run(
            name=None if os.environ.get("MMT_RUN_ID") else "CPU linear training / finetuning",
            kind=os.environ.get("MMT_JOB_KIND", "training"),
            model_version_id=os.environ.get("MMT_MODEL_VERSION_ID") or None,
            parameters={"steps": steps, "learning_rate": learning_rate, "momentum": momentum},
        )
    with context as run:
        kind = run.entity["kind"] if run is not None else os.environ.get("MMT_JOB_KIND", "training")
        if os.environ.get("MMT_JOB_KIND") and kind != os.environ["MMT_JOB_KIND"]:
            raise ValueError("MMT_JOB_KIND does not match Run.kind")
        checkpoint = resume_checkpoint(run)
        if checkpoint is not None:
            state = load_checkpoint(checkpoint.path, step=checkpoint.step)
        else:
            weight, bias = initial_weights(kind=kind, directory=arguments.output.parent, run=run)
            state = TrainingState(weight=weight, bias=bias)
        model = train(
            steps=steps,
            learning_rate=learning_rate,
            momentum=momentum,
            output=arguments.output,
            state=state,
            checkpoint_every=checkpoint_every,
            fail_at_step=None if fail_at_step is None else int(fail_at_step),
            run=run,
            task_output_model=output_model_of_task(run) if run is not None else None,
        )
    print(f"weight={model['weight']:.6f} bias={model['bias']:.6f}", flush=True)


if __name__ == "__main__":
    main()
