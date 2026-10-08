"""Verify official MLflow 3 clients against the local Mado Model Tracking API."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

# Keep protocol failures short and avoid unrelated collection during local verification.
os.environ["MLFLOW_HTTP_REQUEST_MAX_RETRIES"] = "0"
os.environ["MLFLOW_HTTP_REQUEST_TIMEOUT"] = "20"
os.environ["MLFLOW_DISABLE_AGENT_HINT"] = "1"
os.environ["MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING"] = "false"

import mlflow
import mlflow.sklearn
import numpy as np
from mlflow import MlflowClient
from mlflow.environment_variables import (
    MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD,
    MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE,
)
from mlflow.exceptions import MlflowException, _UnsupportedMultipartUploadException
from mlflow3_checks.common import (
    AutomationEnvironment,
    create_local_cpu_target,
    evaluation_rule,
    expect_mlflow_error,
    linear_fixture,
    record_rest_calls,
)
from mlflow3_checks.evaluation import verify_evaluation, verify_evaluation_automation
from mlflow3_checks.pyfunc_model import verify_pyfunc_model
from mlflow3_checks.rich_artifacts import verify_rich_artifacts
from sklearn.linear_model import LinearRegression
from verify_worker import session_request

ROOT = Path(__file__).resolve().parents[1]
WEB_URL = os.environ.get("MMT_VERIFY_WEB_ORIGIN", "http://127.0.0.1:5182").rstrip("/")
API_URL = os.environ.get("MMT_VERIFY_API_URL", WEB_URL).rstrip("/")
ARTIFACT_DIRECTORY = (
    ROOT / "artifacts/verification" / datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d") / "mlflow3"
)
WORK_DIRECTORY = ROOT / "var/verification-mlflow3"
# Exceed the JSON body limit to exercise streamed binary transfer through the Web proxy.
LARGE_ARTIFACT_BYTES = 6 * 1024 * 1024
TOKEN_LIFETIME = timedelta(hours=1)


def configure_mlflow(*, project_id: str, token: str) -> MlflowClient:
    tracking_uri = f"{API_URL}/api/mlflow/projects/{project_id}"
    os.environ["MLFLOW_TRACKING_TOKEN"] = token
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_registry_uri(tracking_uri)
    return MlflowClient(tracking_uri=tracking_uri, registry_uri=tracking_uri)


def verify_tracking(client: MlflowClient, temporary: Path) -> dict:
    experiment = mlflow.set_experiment("MLflow 3 SDK verification")
    with mlflow.start_run(run_name="Official SDK training", tags={"source": "mlflow3"}) as run:
        run_id = run.info.run_id
        mlflow.log_params({"learning_rate": 0.01, "epochs": 3})
        mlflow.log_param("epochs", 3)
        client.log_metric(run_id, "loss", 0.9, timestamp=1000, step=0)
        client.log_metric(run_id, "loss", 0.1, timestamp=3000, step=10)
        client.log_metric(run_id, "loss", 0.5, timestamp=2000, step=3)
        with mlflow.start_run(run_name="Nested evaluation", nested=True) as child:
            child_id = child.info.run_id
            mlflow.log_metric("accuracy", 0.95)
        artifact_source = temporary / "source"
        artifact_source.mkdir()
        (artifact_source / "日本語.json").write_text('{"value": 42}', encoding="utf-8")
        (artifact_source / "empty.txt").write_bytes(b"")
        (artifact_source / "weights.bin").write_bytes(b"weights\x00" * (LARGE_ARTIFACT_BYTES // 8))
        mlflow.log_artifacts(str(artifact_source), artifact_path="inputs")
        mlflow.set_tag("checkpoint", "ready")
    recorded = client.get_run(run_id)
    assert recorded.info.status == "FINISHED"
    assert recorded.data.params == {"learning_rate": "0.01", "epochs": "3"}
    assert recorded.data.metrics["loss"] == 0.1
    assert client.get_run(child_id).data.tags["mlflow.parentRunId"] == run_id
    history = client.get_metric_history(run_id, "loss")
    assert {(point.step, point.timestamp) for point in history} == {
        (0, 1000),
        (3, 2000),
        (10, 3000),
    }
    matching = client.search_runs(
        [experiment.experiment_id],
        filter_string="params.epochs = '3' AND metrics.loss < 0.2",
    )
    assert run_id in [entry.info.run_id for entry in matching]
    listing = client.list_artifacts(run_id, "inputs")
    assert {entry.path for entry in listing} == {
        "inputs/日本語.json",
        "inputs/empty.txt",
        "inputs/weights.bin",
    }
    downloaded = Path(client.download_artifacts(run_id, "inputs", str(temporary)))
    for artifact_file in artifact_source.iterdir():
        assert (
            hashlib.sha256((downloaded / artifact_file.name).read_bytes()).digest()
            == hashlib.sha256(artifact_file.read_bytes()).digest()
        )
    try:
        client.log_param(run_id, "epochs", "99")
        raise AssertionError("Immutable parameter unexpectedly changed")
    except MlflowException as error:
        assert error.error_code == "INVALID_PARAMETER_VALUE", error.error_code
    client.delete_run(child_id)
    assert client.get_run(child_id).info.lifecycle_stage == "deleted"
    client.restore_run(child_id)
    assert client.get_run(child_id).info.lifecycle_stage == "active"
    return {
        "experimentId": experiment.experiment_id,
        "runId": run_id,
        "nestedRunId": child_id,
    }


def verify_multipart_fallback(client: MlflowClient, temporary: Path, *, token: str) -> dict | None:
    """Check that opt-in proxy multipart uploads fall back to one streamed PUT."""
    if not MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD.get():
        return None
    minimum_size = MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE.get()
    source = temporary / "multipart-fallback.bin"
    # Just over the threshold so the SDK tries mpu/create before falling back to the plain PUT.
    source.write_bytes(b"multipart" * (minimum_size // 9 + 1))
    with mlflow.start_run(run_name="Multipart fallback upload") as run:
        run_id = run.info.run_id
        mlflow.log_artifact(str(source), artifact_path="multipart")
    probe = httpx.post(
        f"{mlflow.get_tracking_uri()}/api/2.0/mlflow-artifacts/mpu/create/runs/{run_id}/artifacts/probe.bin",
        json={"path": "probe.bin", "num_parts": 1},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert probe.status_code == 501, probe.status_code
    assert probe.json()["message"].startswith(_UnsupportedMultipartUploadException.MESSAGE)
    downloaded = Path(
        client.download_artifacts(run_id, "multipart/multipart-fallback.bin", str(temporary / "download"))
    )
    assert hashlib.sha256(downloaded.read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest()
    return {"runId": run_id, "bytes": source.stat().st_size, "minimumFileSize": minimum_size}


def verify_models(client: MlflowClient) -> dict:
    features, targets = linear_fixture()
    model = LinearRegression().fit(features, targets)
    with mlflow.start_run(run_name="Logged model and dataset") as run:
        mlflow.log_input(
            mlflow.data.from_numpy(features, targets=targets, name="linear-training"),
            context="training",
        )
        logged = mlflow.sklearn.log_model(model, name="linear-model", input_example=features[:2])
        model_id = logged.model_id
        run_id = run.info.run_id
    assert client.get_logged_model(model_id).status.name == "READY"
    restored = mlflow.pyfunc.load_model(logged.model_uri)
    np.testing.assert_allclose(restored.predict(features), targets, rtol=1e-10)
    client.create_registered_model("linear-regression", tags={"mmt.model_family": "linear"})
    registered = mlflow.register_model(logged.model_uri, "linear-regression")
    client.set_registered_model_alias("linear-regression", "candidate", registered.version)
    alias_model = mlflow.pyfunc.load_model("models:/linear-regression@candidate")
    np.testing.assert_allclose(alias_model.predict(features), targets, rtol=1e-10)
    assert client.get_model_version_by_alias("linear-regression", "candidate").run_id == run_id
    found = client.search_logged_models(
        [mlflow.get_experiment_by_name("MLflow 3 SDK verification").experiment_id]
    )
    assert model_id in [entry.model_id for entry in found]
    return {
        "runId": run_id,
        "loggedModelId": model_id,
        "modelUri": logged.model_uri,
        "version": registered.version,
    }


def verify_autolog(client: MlflowClient) -> dict:
    features, targets = linear_fixture()
    mlflow.sklearn.autolog(log_models=True, log_datasets=True, silent=False)
    try:
        with record_rest_calls() as calls, mlflow.start_run(run_name="Unmodified sklearn autolog") as run:
            LinearRegression().fit(features, targets)
            run_id = run.info.run_id
        recorded = client.get_run(run_id)
        assert recorded.info.status == "FINISHED"
        assert "fit_intercept" in recorded.data.params
        assert "training_score" in recorded.data.metrics
        assert recorded.inputs.dataset_inputs
        models = client.search_logged_models(
            [recorded.info.experiment_id], filter_string=f"source_run_id = '{run_id}'"
        )
        assert models and all(model.status.name == "READY" for model in models)
        return {
            "runId": run_id,
            "loggedModelIds": [model.model_id for model in models],
            "tracesRequests": calls.traces_requests,
        }
    finally:
        mlflow.sklearn.autolog(disable=True)


def verify_deferred_webhooks(client: MlflowClient) -> dict | str:
    if not hasattr(client, "create_webhook"):
        return "not available in this SDK version"
    error = expect_mlflow_error(
        lambda: client.create_webhook(
            name="deferred-webhook",
            url="https://example.invalid/hook",
            events=["registered_model.created"],
        ),
        "ENDPOINT_NOT_FOUND",
    )
    return {"errorCode": error.error_code, "httpStatus": error.get_http_status_code()}


def verify_deferred_tracing(experiment_id: str) -> dict:
    """Tracing is deferred: searches fail clearly, and a traced call inside a Run still completes."""

    @mlflow.trace
    def traced_double(value: int) -> int:
        return value * 2

    with record_rest_calls() as calls:
        error = expect_mlflow_error(
            lambda: mlflow.search_traces(experiment_ids=[experiment_id]), "ENDPOINT_NOT_FOUND"
        )
        with mlflow.start_run(run_name="Traced call while Tracing is deferred") as run:
            assert traced_double(21) == 42
        # Trace export may run on a background thread; wait for it so its request is recorded.
        if hasattr(mlflow, "flush_trace_async_logging"):
            mlflow.flush_trace_async_logging()
    assert MlflowClient().get_run(run.info.run_id).info.status == "FINISHED"
    return {
        "searchTraces": {"errorCode": error.error_code, "httpStatus": error.get_http_status_code()},
        "tracedRunId": run.info.run_id,
        "tracesRequests": calls.traces_requests,
    }


def verify_deferred_apis(client: MlflowClient, *, experiment_id: str) -> dict:
    """Record how the SDK reports APIs this server deliberately omits (docs/mlflow.md)."""
    return {"webhooks": verify_deferred_webhooks(client), "tracing": verify_deferred_tracing(experiment_id)}


def verify_authorization(
    *,
    session: httpx.Client,
    project_id: str,
    readonly_token: str,
    other_project_id: str,
) -> list[str]:
    checks = []
    origin_uri = mlflow.get_tracking_uri()
    original_token = os.environ["MLFLOW_TRACKING_TOKEN"]
    try:
        os.environ["MLFLOW_TRACKING_TOKEN"] = readonly_token
        read_only = MlflowClient(tracking_uri=origin_uri)
        assert read_only.get_experiment_by_name("MLflow 3 SDK verification")
        try:
            read_only.create_experiment("Forbidden write")
            raise AssertionError("Read-only token wrote an experiment")
        except MlflowException as error:
            assert error.error_code == "PERMISSION_DENIED", error.error_code
        checks.append("read-only-token")
        os.environ["MLFLOW_TRACKING_TOKEN"] = original_token
        foreign = MlflowClient(tracking_uri=f"{API_URL}/api/mlflow/projects/{other_project_id}")
        try:
            foreign.search_experiments()
            raise AssertionError("Project-bound token read another project")
        except MlflowException as error:
            assert error.error_code == "PERMISSION_DENIED", error.error_code
        checks.append("project-bound-token")
    finally:
        os.environ["MLFLOW_TRACKING_TOKEN"] = original_token
    response = session.get(
        f"mlflow/projects/{project_id}/api/2.0/mlflow/runs/search",
        headers={"Authorization": "Bearer invalidtoken"},
    )
    assert response.status_code == 401 and response.json()["error_code"] == "UNAUTHENTICATED"
    checks.append("invalid-token")
    return checks


def verify_native_automation(
    environment: AutomationEnvironment, *, models: dict, client: MlflowClient
) -> dict:
    with evaluation_rule(
        environment,
        name="Evaluate MLflow registered models",
        main_source=(ROOT / "scripts/fixtures/mlflowEvaluation.py").read_text(),
        model_family="linear",
    ):
        registered = mlflow.register_model(models["modelUri"], "linear-regression")
        with environment.native_client() as native:
            executions = native.list_automation_executions(environment.project_id)
            assert len(executions) == 1 and executions[0]["status"] == "queued", executions
            execution = executions[0]
            environment.run_one_worker_job()
            recorded = native.get_run(environment.project_id, execution["runId"]).entity
            assert recorded["status"] == "finished", recorded
            assert abs(recorded["latestMetrics"]["evaluation.prediction"] - 9) < 1e-8
            assert client.get_run(recorded["id"]).info.status == "FINISHED"
            lineage = native.request("GET", native.project_path(environment.project_id, "lineage"))
            assert models["runId"] in json.dumps(lineage) and recorded["id"] in json.dumps(lineage)
    return {
        "runId": recorded["id"],
        "modelVersion": registered.version,
        "automationExecutionId": execution["id"],
    }


def main() -> None:
    assert mlflow.__version__.split(".")[0] == "3", "This verification requires MLflow 3"
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    summary = {"mlflowVersion": mlflow.__version__, "checks": []}
    with httpx.Client(base_url=f"{API_URL}/api/", headers={"Origin": WEB_URL}, timeout=30) as session:
        session_request(session, "POST", "auth/dev-login", json={})
        project = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": f"MLflow 3 verification {datetime.now(ZoneInfo('Asia/Tokyo')).isoformat()}",
                "description": "公式MLflow SDKとautologで作成した実API検証記録",
                "artifactBackend": "filesystem",
            },
        )
        other = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": "MLflow token isolation fixture",
                "artifactBackend": "filesystem",
            },
        )
        issued_tokens = []
        try:
            for label, scopes in [
                (
                    "write",
                    [
                        "read",
                        "runs:write",
                        "registry:write",
                        "artifacts:write",
                        "jobs:write",
                        "worker:execute",
                    ],
                ),
                ("read", ["read"]),
            ]:
                issued = session_request(
                    session,
                    "POST",
                    "tokens",
                    json={
                        "name": f"Temporary MLflow verification {label}",
                        "kind": "service",
                        "projectId": project["id"],
                        "scopes": scopes,
                        "expiresAt": (datetime.now(UTC) + TOKEN_LIFETIME).isoformat().replace("+00:00", "Z"),
                    },
                )
                issued_tokens.append(issued)
            token = issued_tokens[0]["token"]
            client = configure_mlflow(project_id=project["id"], token=token)
            summary["projectId"] = project["id"]
            summary["trackingUri"] = mlflow.get_tracking_uri()
            with tempfile.TemporaryDirectory(prefix="mmt-mlflow3-") as directory:
                summary["tracking"] = verify_tracking(client, Path(directory))
            summary["checks"].append(
                "tracking, nested runs, metric history, search, streamed artifact upload/download"
            )
            with tempfile.TemporaryDirectory(prefix="mmt-mlflow3-multipart-") as directory:
                multipart_fallback = verify_multipart_fallback(client, Path(directory), token=token)
            if multipart_fallback:
                summary["multipartFallback"] = multipart_fallback
                summary["checks"].append("proxy multipart upload falls back to streamed PUT on 501")
            summary["models"] = verify_models(client)
            summary["checks"].append("logged models, native registry, alias, pyfunc load, dataset lineage")
            summary["autolog"] = verify_autolog(client)
            summary["checks"].append("sklearn autolog with model and dataset logging")
            summary["evaluation"] = verify_evaluation(
                client,
                model_uri=summary["models"]["modelUri"],
                logged_model_id=summary["models"]["loggedModelId"],
            )
            summary["checks"].append("mlflow.models.evaluate metrics on the Run and Logged Model, eval table")
            with tempfile.TemporaryDirectory(prefix="mmt-mlflow3-rich-") as directory:
                summary["richArtifacts"] = verify_rich_artifacts(client, Path(directory))
            summary["checks"].append("log_table/image/dict/text/figure, audio Content-Type and Range 206")
            with tempfile.TemporaryDirectory(prefix="mmt-mlflow3-pyfunc-") as directory:
                summary["pyfuncModel"] = verify_pyfunc_model(
                    client, Path(directory), experiment_id=summary["tracking"]["experimentId"]
                )
            summary["checks"].append(
                "custom multi-file pyfunc via alias, models:/ download, pandas search_runs"
            )
            summary["deferredApis"] = verify_deferred_apis(
                client, experiment_id=summary["tracking"]["experimentId"]
            )
            summary["checks"].append(
                "deferred webhooks/Tracing return ENDPOINT_NOT_FOUND without stopping Runs"
            )
            summary["authorization"] = verify_authorization(
                session=session,
                project_id=project["id"],
                readonly_token=issued_tokens[1]["token"],
                other_project_id=other["id"],
            )
            summary["checks"].append("read-only, project isolation and invalid API tokens")
            target = create_local_cpu_target(
                session, name=f"MLflow verification CPU {project['id'][:8]}", work_directory=WORK_DIRECTORY
            )
            automation = AutomationEnvironment(
                session=session,
                api_url=API_URL,
                project_id=project["id"],
                token=token,
                experiment_id=summary["tracking"]["experimentId"],
                target_id=target["id"],
                work_directory=WORK_DIRECTORY,
            )
            summary["automation"] = verify_native_automation(
                automation, models=summary["models"], client=client
            )
            summary["checks"].append(
                "registry-triggered CPU evaluation and recording into the worker-owned Run"
            )
            summary["evaluationAutomation"] = verify_evaluation_automation(
                automation, client=client, models=summary["models"], registered_name="linear-regression"
            )
            summary["checks"].append(
                "registry-triggered mlflow.models.evaluate recorded once in the Job's Run"
            )
            summary["verifiedAt"] = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat()
            summary_json = json.dumps(summary, ensure_ascii=False, indent=2)
            sdk_series = ".".join(mlflow.__version__.split(".")[:2])
            for filename in ("sdk-integration.json", f"sdk-{sdk_series}-integration.json"):
                (ARTIFACT_DIRECTORY / filename).write_text(summary_json + "\n")
            print(summary_json)
        finally:
            for issued in issued_tokens:
                session_request(session, "DELETE", f"tokens/{issued['item']['id']}")
            os.environ.pop("MLFLOW_TRACKING_TOKEN", None)


if __name__ == "__main__":
    main()
