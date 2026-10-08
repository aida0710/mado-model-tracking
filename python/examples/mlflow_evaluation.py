"""Evaluate a registered model with mlflow.models.evaluate and record the result in MLflow.

Inside an evaluation automation rule the worker sets MLFLOW_TRACKING_URI, MLFLOW_TRACKING_TOKEN,
MLFLOW_RUN_ID and MMT_MODEL_VERSION_FILE, so ``mlflow.start_run()`` attaches to the Job's Run and
the pinned ModelVersion is evaluated. Outside a Job, pass ``--model-uri models:/NAME@ALIAS``.

The reference rows are inlined to keep the example self-contained; real evaluation code reads
its reference Dataset instead.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import mlflow
import pandas as pd
from mlflow.metrics import MetricValue
from mlflow.models import EvaluationResult, make_metric

# Rows of y = 2a + 3b + 1, matching the linear model that scripts/verify_mlflow3.py registers.
REFERENCE_ROWS = pd.DataFrame(
    {"a": [0.0, 1.0, 0.0, 2.0], "b": [0.0, 0.0, 1.0, 1.0], "target": [1.0, 3.0, 4.0, 8.0]}
)
TARGET_COLUMN = "target"


def absolute_error(predictions: pd.Series, targets: pd.Series, metrics: dict) -> MetricValue:
    scores = [
        abs(float(prediction) - float(target))
        for prediction, target in zip(predictions, targets, strict=True)
    ]
    return MetricValue(scores=scores, aggregate_results={"mean": sum(scores) / len(scores)})


# The default evaluator writes eval_results_table.json only when a metric has per-row scores.
ABSOLUTE_ERROR = make_metric(eval_fn=absolute_error, greater_is_better=False, name="absolute_error")


def pinned_model_version() -> tuple[str, str | None]:
    """Return the pinned ModelVersion's model URI and the Logged Model it was registered from."""
    descriptor = json.loads(Path(os.environ["MMT_MODEL_VERSION_FILE"]).read_text())
    model_version = descriptor["modelVersion"]
    logged_model_id = model_version.get("metadata", {}).get("mlflow", {}).get("loggedModelId")
    return f"mlflow-artifacts:/model-versions/{model_version['id']}/artifacts", logged_model_id


def evaluate_model(model_uri: str, *, logged_model_id: str | None = None) -> EvaluationResult:
    """Evaluate in the active Run. A Logged Model id also records the metrics on that model."""
    return mlflow.models.evaluate(
        model_uri,
        REFERENCE_ROWS,
        targets=TARGET_COLUMN,
        model_type="regressor",
        evaluators=["default"],
        extra_metrics=[ABSOLUTE_ERROR],
        model_id=logged_model_id,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a registered model with mlflow.models.evaluate")
    parser.add_argument("--model-uri", help="models:/NAME@ALIAS etc. Defaults to the Job's pinned version")
    arguments = parser.parse_args()
    if arguments.model_uri:
        model_uri, logged_model_id = arguments.model_uri, None
    else:
        model_uri, logged_model_id = pinned_model_version()
    with mlflow.start_run() as run:
        expected_run_id = os.environ.get("MMT_RUN_ID")
        if expected_run_id and run.info.run_id != expected_run_id:
            raise RuntimeError("mlflow.start_run() did not attach to the Job's Run")
        result = evaluate_model(model_uri, logged_model_id=logged_model_id)
    print(json.dumps({"runId": run.info.run_id, "metrics": result.metrics}, default=float), flush=True)


if __name__ == "__main__":
    main()
