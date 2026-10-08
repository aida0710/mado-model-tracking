"""mlflow.models.evaluate: metrics on the Run and Logged Model, the eval table, and automation."""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
from types import ModuleType

import mlflow
from mlflow import MlflowClient

from mlflow3_checks.common import AutomationEnvironment, evaluation_rule, record_rest_calls

ROOT = Path(__file__).resolve().parents[2]
# The published example doubles as the automation's evaluation code, so the check runs what users copy.
EVALUATION_EXAMPLE = ROOT / "python/examples/mlflow_evaluation.py"
EVALUATION_TABLE = "eval_results_table.json"
# Built-in regressor metrics plus the example's per-row metric aggregate.
EXPECTED_METRICS = ("mean_squared_error", "r2_score", "absolute_error/mean")


def load_evaluation_example() -> ModuleType:
    specification = importlib.util.spec_from_file_location("mlflow_evaluation_example", EVALUATION_EXAMPLE)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def assert_evaluation_recorded(client: MlflowClient, *, run_id: str, logged_model_id: str) -> dict:
    """Check one Run's evaluate() output and return how many points each metric received."""
    recorded = client.get_run(run_id)
    assert recorded.info.status == "FINISHED", recorded.info.status
    for key in EXPECTED_METRICS:
        assert key in recorded.data.metrics, (key, recorded.data.metrics)
    assert math.isclose(recorded.data.metrics["r2_score"], 1.0, abs_tol=1e-9)
    model_metrics = {
        metric.key for metric in client.get_logged_model(logged_model_id).metrics if metric.run_id == run_id
    }
    assert set(EXPECTED_METRICS) <= model_metrics, model_metrics
    artifact_paths = [entry.path for entry in client.list_artifacts(run_id)]
    assert artifact_paths.count(EVALUATION_TABLE) == 1, artifact_paths
    table = json.loads(Path(client.download_artifacts(run_id, EVALUATION_TABLE)).read_text())
    assert len(table["data"]) == 4 and "absolute_error/score" in table["columns"], table["columns"]
    return {key: len(client.get_metric_history(run_id, key)) for key in EXPECTED_METRICS}


def verify_evaluation(client: MlflowClient, *, model_uri: str, logged_model_id: str) -> dict:
    """Evaluate a Logged Model in a fresh Run and watch which endpoints the SDK calls."""
    example = load_evaluation_example()
    with record_rest_calls() as calls, mlflow.start_run(run_name="mlflow.models.evaluate") as run:
        result = example.evaluate_model(model_uri, logged_model_id=logged_model_id)
    assert "eval_results_table" in result.artifacts
    metric_points = assert_evaluation_recorded(
        client, run_id=run.info.run_id, logged_model_id=logged_model_id
    )
    return {
        "runId": run.info.run_id,
        "metricKeys": sorted(result.metrics),
        # evaluate() logs once from the evaluator and again with model_id (mlflow/models/evaluation/base.py).
        "metricPointsPerKey": metric_points,
        "tracesRequests": calls.traces_requests,
    }


def verify_evaluation_automation(
    environment: AutomationEnvironment, *, client: MlflowClient, models: dict, registered_name: str
) -> dict:
    """Registering a version queues one evaluation Job whose evaluate() writes into the Job's Run."""
    experiment_id = environment.experiment_id
    with evaluation_rule(
        environment,
        name="Evaluate with mlflow.models.evaluate",
        main_source=EVALUATION_EXAMPLE.read_text(),
        model_family="linear",
    ) as rule:
        registered = mlflow.register_model(models["modelUri"], registered_name)
        with environment.native_client() as native:
            executions = [
                execution
                for execution in native.list_automation_executions(environment.project_id)
                if execution["ruleId"] == rule["id"]
            ]
            assert len(executions) == 1 and executions[0]["status"] == "queued", executions
            execution = executions[0]
            runs_before_job = {run.info.run_id for run in client.search_runs([experiment_id])}
            environment.run_one_worker_job()
            recorded = native.get_run(environment.project_id, execution["runId"]).entity
        assert recorded["status"] == "finished", recorded
        runs_after_job = {run.info.run_id for run in client.search_runs([experiment_id])}
        # evaluate() must reuse the Job's Run rather than open a second one.
        assert runs_after_job == runs_before_job, runs_after_job - runs_before_job
        # The SDK's ModelVersion.from_proto drops model_id, so use the Logged Model that was registered.
        metric_points = assert_evaluation_recorded(
            client, run_id=recorded["id"], logged_model_id=models["loggedModelId"]
        )
    return {
        "runId": recorded["id"],
        "modelVersion": registered.version,
        "automationExecutionId": execution["id"],
        "metricPointsPerKey": metric_points,
    }
