"""A sweep trial: read lr / batch_size from the trial's parameters and log val_loss each epoch.

As a Task's entrypoint, each sweep trial runs this with its own parameters. val_loss is logged with
step=epoch so that hyperband (early_terminate) compares trials at the same epoch.
Run it locally with ``--offline`` to try the defaults without the tracking API.
"""

from __future__ import annotations

import argparse
import math
import random
from contextlib import nullcontext

from mado_tracking.sweeps import trial_parameters

DEFAULT_PARAMETERS = {"lr": 0.05, "batch_size": 4, "epochs": 9}
# y = 2x + 1 with noise; small enough to train in well under a second on CPU.
EXAMPLE_COUNT = 64
VALIDATION_FRACTION = 0.25
DATA_SEED = 0


def make_examples() -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    generator = random.Random(DATA_SEED)
    examples = []
    for _ in range(EXAMPLE_COUNT):
        x = generator.uniform(-2.0, 2.0)
        examples.append((x, 2.0 * x + 1.0 + generator.gauss(0.0, 0.1)))
    split = int(EXAMPLE_COUNT * (1 - VALIDATION_FRACTION))
    return examples[:split], examples[split:]


def mean_squared_error(weight: float, bias: float, examples: list[tuple[float, float]]) -> float:
    return sum((weight * x + bias - y) ** 2 for x, y in examples) / len(examples)


def train(*, lr: float, batch_size: int, epochs: int, run=None) -> float:
    training, validation = make_examples()
    weight = bias = 0.0
    val_loss = math.inf
    for epoch in range(1, epochs + 1):
        for start in range(0, len(training), batch_size):
            batch = training[start : start + batch_size]
            errors = [(weight * x + bias - y, x) for x, y in batch]
            weight -= lr * 2 * sum(error * x for error, x in errors) / len(batch)
            bias -= lr * 2 * sum(error for error, _ in errors) / len(batch)
        val_loss = mean_squared_error(weight, bias, validation)
        print(f"epoch={epoch} val_loss={val_loss:.6f}", flush=True)
        if run is not None:
            run.log_metrics({"val_loss": val_loss}, step=epoch)
    return val_loss


def main() -> None:
    parser = argparse.ArgumentParser(description="Sweep trial example (linear regression)")
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    parameters = trial_parameters(DEFAULT_PARAMETERS)
    # Parameters keep their JSON types, so convert explicitly where the code needs numbers.
    lr = float(parameters["lr"])
    batch_size = int(parameters["batch_size"])
    epochs = int(parameters["epochs"])
    if not 0 < lr < 1 or batch_size < 1 or epochs < 1:
        raise ValueError("lr must be between 0 and 1; batch_size and epochs must be positive")
    if arguments.offline:
        context = nullcontext(None)
    else:
        from mado_tracking import start_run

        context = start_run()
    with context as run:
        val_loss = train(lr=lr, batch_size=batch_size, epochs=epochs, run=run)
    print(f"final val_loss={val_loss:.6f}", flush=True)


if __name__ == "__main__":
    main()
