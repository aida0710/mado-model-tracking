"""Custom pyfunc models with several artifact files: alias load, models:/ download, search_runs."""

from __future__ import annotations

import json
from pathlib import Path

import mlflow
import numpy as np
import pandas as pd
from mlflow import MlflowClient

from mlflow3_checks.common import sha256_file

REGISTERED_NAME = "multi-file-pyfunc"
ALIAS = "candidate"
SCALE = 2.5
SAMPLE_INPUT = pd.DataFrame({"a": [0.0, 1.0, 2.0], "b": [1.0, 0.0, 3.0]})


class ScaledLinearModel(mlflow.pyfunc.PythonModel):
    """Reads coefficients and an offset from separate artifact files, like a split checkpoint."""

    def load_context(self, context: mlflow.pyfunc.PythonModelContext) -> None:
        self.coefficients = json.loads(Path(context.artifacts["coefficients"]).read_text())
        bundle = Path(context.artifacts["bundle"])
        self.offset = float((bundle / "nested/offset.txt").read_text())
        self.scale = float((bundle / "scale.txt").read_text())

    def predict(self, context, model_input: pd.DataFrame, params=None) -> np.ndarray:
        weighted = sum(model_input[column] * weight for column, weight in self.coefficients.items())
        return ((weighted + self.offset) * self.scale).to_numpy()


def expected_predictions() -> np.ndarray:
    return ((SAMPLE_INPUT["a"] * 2 + SAMPLE_INPUT["b"] * 3 + 1) * SCALE).to_numpy()


def write_model_files(directory: Path) -> dict[str, Path]:
    """Lay out one JSON file and a directory tree, so the version must keep the whole set."""
    coefficients = directory / "coefficients.json"
    coefficients.write_text(json.dumps({"a": 2.0, "b": 3.0}))
    bundle = directory / "bundle"
    (bundle / "nested").mkdir(parents=True)
    (bundle / "nested/offset.txt").write_text("1.0")
    (bundle / "scale.txt").write_text(str(SCALE))
    return {"coefficients": coefficients, "bundle": bundle}


def verify_pyfunc_model(client: MlflowClient, temporary: Path, *, experiment_id: str) -> dict:
    sources = write_model_files(temporary)
    with mlflow.start_run(run_name="Custom multi-file pyfunc", tags={"check": "pyfunc"}) as run:
        mlflow.log_param("scale", SCALE)
        logged = mlflow.pyfunc.log_model(
            name="scaled-linear",
            python_model=ScaledLinearModel(),
            artifacts={name: str(path) for name, path in sources.items()},
            input_example=SAMPLE_INPUT,
        )
        mlflow.log_metric("prediction_sum", float(expected_predictions().sum()))
    registered = mlflow.register_model(logged.model_uri, REGISTERED_NAME)
    client.set_registered_model_alias(REGISTERED_NAME, ALIAS, registered.version)
    alias_uri = f"models:/{REGISTERED_NAME}@{ALIAS}"
    np.testing.assert_allclose(
        mlflow.pyfunc.load_model(alias_uri).predict(SAMPLE_INPUT), expected_predictions()
    )

    downloaded = Path(
        mlflow.artifacts.download_artifacts(artifact_uri=alias_uri, dst_path=str(temporary / "alias"))
    )
    files = sorted(str(path.relative_to(downloaded)) for path in downloaded.rglob("*") if path.is_file())
    assert {"MLmodel", "python_model.pkl"} <= set(files), files
    for relative in ("coefficients.json", "bundle/nested/offset.txt", "bundle/scale.txt"):
        assert sha256_file(downloaded / "artifacts" / relative) == sha256_file(temporary / relative), relative

    found = mlflow.search_runs([experiment_id], filter_string="tags.check = 'pyfunc'")
    assert isinstance(found, pd.DataFrame) and list(found["run_id"]) == [run.info.run_id], found
    row = found.iloc[0]
    assert row["params.scale"] == str(SCALE) and row["status"] == "FINISHED"
    assert row["metrics.prediction_sum"] == float(expected_predictions().sum())
    return {
        "runId": run.info.run_id,
        "loggedModelId": logged.model_id,
        "version": registered.version,
        "aliasUri": alias_uri,
        "downloadedFiles": files,
        "searchRunsColumns": sorted(found.columns),
    }
