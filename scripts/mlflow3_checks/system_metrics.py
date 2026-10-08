"""Check that official MLflow 3 system metrics logging produces readable `system/` metric histories.

Standalone: by default it logs to a temporary local MLflow store, which shows what the official
client records. With `--mado-api-url` it logs to Mado Model Tracking's MLflow API instead (dev
login, temporary project token revoked at the end) and reads the history back through it.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# Sample every second and flush every sample so a short run produces several history points.
SAMPLING_INTERVAL_SECONDS = 1
os.environ["MLFLOW_SYSTEM_METRICS_SAMPLING_INTERVAL"] = str(SAMPLING_INTERVAL_SECONDS)
os.environ["MLFLOW_SYSTEM_METRICS_SAMPLES_BEFORE_LOGGING"] = "1"
os.environ["MLFLOW_HTTP_REQUEST_MAX_RETRIES"] = "0"
os.environ["MLFLOW_DISABLE_AGENT_HINT"] = "1"

# MLflow reads these variables at import time, so the imports follow the environment setup.
import httpx  # noqa: E402
import mlflow  # noqa: E402
from mlflow import MlflowClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SYSTEM_METRIC_PREFIX = "system/"
# Long enough for at least two flushed samples after MLflow's monitor thread starts.
DEFAULT_RUN_SECONDS = 5.0
MINIMUM_HISTORY_POINTS = 2
TOKEN_LIFETIME = timedelta(hours=1)
# Same default as the API's MMT_WEB_ORIGIN; only sent as a header, never connected to.
DEFAULT_WEB_ORIGIN = "http://127.0.0.1:5182"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mado-api-url", help="Mado Model Tracking API origin, e.g. http://127.0.0.1:47160")
    parser.add_argument(
        "--web-origin",
        default=DEFAULT_WEB_ORIGIN,
        help="Origin header for the session API's CSRF check (the API's MMT_WEB_ORIGIN)",
    )
    parser.add_argument("--run-seconds", type=float, default=DEFAULT_RUN_SECONDS)
    parser.add_argument("--output", type=Path, help="Result JSON path")
    return parser.parse_args()


def default_output_path(target: str) -> Path:
    date = datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")
    return (
        ROOT
        / "artifacts/verification"
        / date
        / "system-metrics"
        / f"mlflow-{mlflow.__version__}-{target}.json"
    )


def gpu_environment() -> dict[str, object]:
    return {
        "nvidiaSmiOnPath": shutil.which("nvidia-smi") is not None,
        "pynvmlInstalled": importlib.util.find_spec("pynvml") is not None,
        "psutilInstalled": importlib.util.find_spec("psutil") is not None,
    }


def log_run_with_system_metrics(client: MlflowClient, *, run_seconds: float) -> dict[str, object]:
    mlflow.enable_system_metrics_logging()
    try:
        experiment_id = client.create_experiment(f"system-metrics-check-{time.time_ns()}")
        with mlflow.start_run(experiment_id=experiment_id) as run:
            # Busy work so CPU utilization is visibly non-zero while MLflow samples.
            deadline = time.monotonic() + run_seconds
            while time.monotonic() < deadline:
                sum(index * index for index in range(10_000))
        run_id = run.info.run_id
    finally:
        mlflow.disable_system_metrics_logging()
    latest = client.get_run(run_id).data.metrics
    names = sorted(name for name in latest if name.startswith(SYSTEM_METRIC_PREFIX))
    histories = {name: client.get_metric_history(run_id, name) for name in names}
    return {
        "runId": run_id,
        "systemMetricNames": names,
        "historyPoints": {name: len(points) for name, points in histories.items()},
        "historySteps": {name: [point.step for point in points] for name, points in histories.items()},
        "gpuMetricNames": [name for name in names if name.startswith(f"{SYSTEM_METRIC_PREFIX}gpu_")],
    }


def failures_of(result: dict[str, object]) -> list[str]:
    names = result["systemMetricNames"]
    points = result["historyPoints"]
    assert isinstance(names, list) and isinstance(points, dict)
    failures = []
    if f"{SYSTEM_METRIC_PREFIX}cpu_utilization_percentage" not in names:
        failures.append("system/cpu_utilization_percentage was not logged")
    failures.extend(
        f"{name} has {count} history points (expected >= {MINIMUM_HISTORY_POINTS})"
        for name, count in points.items()
        if count < MINIMUM_HISTORY_POINTS
    )
    return failures


def run_against_local_store(run_seconds: float) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="mmt-mlflow-system-metrics-") as directory:
        tracking_uri = f"sqlite:///{Path(directory) / 'mlflow.db'}"
        mlflow.set_tracking_uri(tracking_uri)
        result = log_run_with_system_metrics(MlflowClient(tracking_uri), run_seconds=run_seconds)
    return {"target": "local-sqlite", **result}


def run_against_mado(api_url: str, *, web_origin: str, run_seconds: float) -> dict[str, object]:
    with httpx.Client(
        base_url=f"{api_url.rstrip('/')}/api/", headers={"Origin": web_origin}, timeout=30
    ) as session:
        expect_success(session.post("auth/dev-login", json={}))
        project = expect_success(
            session.post(
                "projects",
                json={"name": f"System metrics check {time.time_ns()}", "artifactBackend": "filesystem"},
            )
        )
        expires_at = (datetime.now(UTC) + TOKEN_LIFETIME).isoformat().replace("+00:00", "Z")
        issued = expect_success(
            session.post(
                "tokens",
                json={
                    "name": "Temporary system metrics check",
                    "kind": "service",
                    "projectId": project["id"],
                    "scopes": ["read", "runs:write"],
                    "expiresAt": expires_at,
                },
            )
        )
        try:
            tracking_uri = f"{api_url.rstrip('/')}/api/mlflow/projects/{project['id']}"
            os.environ["MLFLOW_TRACKING_TOKEN"] = issued["token"]
            mlflow.set_tracking_uri(tracking_uri)
            result = log_run_with_system_metrics(MlflowClient(tracking_uri), run_seconds=run_seconds)
        finally:
            os.environ.pop("MLFLOW_TRACKING_TOKEN", None)
            expect_success(session.delete(f"tokens/{issued['item']['id']}"))
    return {"target": "mado-mlflow-api", "projectId": project["id"], **result}


def expect_success(response: httpx.Response) -> dict:
    if not response.is_success:
        raise AssertionError(
            f"{response.request.method} {response.request.url.path}: HTTP {response.status_code}"
        )
    return response.json() if response.content else {}


def main() -> int:
    arguments = parse_arguments()
    if arguments.mado_api_url:
        result = run_against_mado(
            arguments.mado_api_url, web_origin=arguments.web_origin, run_seconds=arguments.run_seconds
        )
    else:
        result = run_against_local_store(arguments.run_seconds)
    environment = gpu_environment()
    failures = failures_of(result)
    summary = {
        "mlflowVersion": mlflow.__version__,
        "pythonVersion": sys.version.split()[0],
        "checkedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "samplingIntervalSeconds": SAMPLING_INTERVAL_SECONDS,
        "gpuEnvironment": environment,
        "gpuMetricsExpected": bool(environment["nvidiaSmiOnPath"] and environment["pynvmlInstalled"]),
        **result,
        "failures": failures,
        "passed": not failures,
    }
    output = arguments.output or default_output_path("mado" if arguments.mado_api_url else "local")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "passed": summary["passed"], "failures": failures}))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
