"""Fixtures and HTTP helpers shared by the MLflow 3 SDK checks."""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
import mlflow
import numpy as np
import requests
from mlflow.exceptions import MlflowException
from verify_worker import run_next_job, session_request

from mado_tracking import Client
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings

# MLflow 3.0 sends Tracing requests to the 2.0 path and later releases to 3.0; both are deferred.
TRACES_PATH_PREFIXES = ("api/2.0/mlflow/traces", "api/3.0/mlflow/traces")
ARTIFACT_TRANSFER_PATH = "api/2.0/mlflow-artifacts/artifacts"
HTTP_TIMEOUT_SECONDS = 30
# Evaluation Jobs run unmodified SDK code; these only keep failures short and the log quiet.
EVALUATION_JOB_ENVIRONMENT = {"MLFLOW_DISABLE_AGENT_HINT": "1", "MLFLOW_HTTP_REQUEST_MAX_RETRIES": "0"}
# Native workers report final state only after the child process and output collection finish.
WORKER_HEARTBEAT_SECONDS = 0.2
WORKER_POLL_SECONDS = 0.1
WORKER_TELEMETRY_SECONDS = 1


def linear_fixture() -> tuple[np.ndarray, np.ndarray]:
    """Four points of y = 2a + 3b + 1, small enough that every check stays on CPU."""
    features = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [2.0, 1.0]])
    return features, features[:, 0] * 2 + features[:, 1] * 3 + 1


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expect_mlflow_error(action: Callable[[], object], error_code: str) -> MlflowException:
    try:
        action()
    except MlflowException as error:
        assert error.error_code == error_code, (error.error_code, error.message)
        return error
    raise AssertionError(f"Expected MlflowException {error_code}")


@dataclass
class RestCallLog:
    """Requests the SDK sent, as (method, path relative to the tracking URI)."""

    calls: list[tuple[str, str]] = field(default_factory=list)

    @property
    def traces_requests(self) -> list[str]:
        return [f"{method} {path}" for method, path in self.calls if path.startswith(TRACES_PATH_PREFIXES)]


@contextmanager
def record_rest_calls() -> Iterator[RestCallLog]:
    """Record every SDK request, including artifact transfers, without changing the response.

    The SDK routes REST and artifact traffic through requests.Session, so patching the class
    observes calls made from helper threads too.
    """
    log = RestCallLog()
    tracking_path = urlsplit(mlflow.get_tracking_uri()).path.rstrip("/") + "/"
    original_request = requests.Session.request

    def recording_request(session: requests.Session, method: str, url: str, *args: Any, **options: Any):
        path = urlsplit(url).path
        log.calls.append((method.upper(), path.removeprefix(tracking_path)))
        return original_request(session, method, url, *args, **options)

    requests.Session.request = recording_request  # type: ignore[method-assign]
    try:
        yield log
    finally:
        requests.Session.request = original_request  # type: ignore[method-assign]


def tracking_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ['MLFLOW_TRACKING_TOKEN']}"}


def native_project_url() -> str:
    """The native API base of the Project that the MLflow tracking URI points at."""
    return mlflow.get_tracking_uri().replace("/api/mlflow/projects/", "/api/projects/", 1)


def run_artifact_response(run_id: str, path: str, *, byte_range: str | None = None) -> httpx.Response:
    """GET one Run artifact through the same transfer route the SDK downloads from."""
    encoded = "/".join(quote(part, safe="") for part in path.split("/"))
    headers = tracking_headers() | ({"Range": byte_range} if byte_range else {})
    return httpx.get(
        f"{mlflow.get_tracking_uri()}/{ARTIFACT_TRANSFER_PATH}/runs/{run_id}/artifacts/{encoded}",
        headers=headers,
        timeout=HTTP_TIMEOUT_SECONDS,
    )


@dataclass(frozen=True)
class AutomationEnvironment:
    """The verification Project, its CPU target and the write token shared by automation checks."""

    session: httpx.Client
    api_url: str
    project_id: str
    token: str
    experiment_id: str
    target_id: str
    work_directory: Path

    def native_client(self) -> Client:
        return Client(api_url=self.api_url, api_token=self.token)

    def run_one_worker_job(self) -> None:
        run_one_worker_job(
            api_url=self.api_url,
            token=self.token,
            target_id=self.target_id,
            state_directory=self.work_directory / "state" / self.project_id,
        )


@contextmanager
def evaluation_rule(
    environment: AutomationEnvironment, *, name: str, main_source: str, model_family: str
) -> Iterator[dict]:
    """Register inline evaluation code and an enabled rule for the family; disable it on exit."""
    with environment.native_client() as native:
        code = native.register_code(
            environment.project_id,
            name=name,
            version="v1",
            source={"kind": "inline", "files": {"main.py": main_source}},
            entrypoint=[sys.executable, "main.py"],
            supported_model_families=[model_family],
            task_types=["evaluation"],
            environment=EVALUATION_JOB_ENVIRONMENT,
        )
    rule = session_request(
        environment.session,
        "POST",
        f"projects/{environment.project_id}/automation-rules",
        json={
            "name": name,
            "enabled": True,
            "modelFamilies": [model_family],
            "kind": "evaluation",
            "experimentId": environment.experiment_id,
            "codeVersionId": code["id"],
            "targetId": environment.target_id,
            "gpuIds": [],
            "inputDatasetVersionIds": [],
            "parameters": {"evaluation": "mlflow-registry"},
            "tags": {"source": "mlflow3"},
            "maxAttempts": 1,
        },
    )
    try:
        yield rule
    finally:
        session_request(
            environment.session,
            "PATCH",
            f"projects/{environment.project_id}/automation-rules/{rule['id']}",
            json={"enabled": False},
        )


def create_local_cpu_target(session: httpx.Client, *, name: str, work_directory: Path) -> dict:
    """Register a ComputeTarget that runs Jobs with this interpreter on the local executor."""
    return session_request(
        session,
        "POST",
        "targets",
        json={
            "name": name,
            "host": "127.0.0.1",
            "port": 22,
            "username": "local",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": str(work_directory / "jobs"),
            "pythonExecutable": sys.executable,
            "gpuIds": [],
            "maxConcurrentJobs": 1,
            "enabled": True,
            "executor": "local",
        },
    )


def run_one_worker_job(*, api_url: str, token: str, target_id: str, state_directory: Path) -> None:
    """Claim and finish exactly one queued Job for the target, as a real worker process would."""
    settings = WorkerSettings(
        api=ApiSettings.from_environment(url=api_url, token=token),
        worker_id=f"mlflow3-{state_directory.name}",
        target_ids=(target_id,),
        state_directory=state_directory,
        allow_local_executor=True,
        install_dependencies=False,
        heartbeat_seconds=WORKER_HEARTBEAT_SECONDS,
        poll_seconds=WORKER_POLL_SECONDS,
        telemetry_seconds=WORKER_TELEMETRY_SECONDS,
    )
    asyncio.run(run_next_job(settings))
