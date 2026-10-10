from __future__ import annotations

import shutil
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.contracts import WorkerJob


@pytest.fixture
def job_payload(tmp_path: Path) -> dict:
    project_id, run_id, target_id, code_id, job_id = [str(uuid4()) for _ in range(5)]
    return {
        "job": {
            "id": job_id,
            "projectId": project_id,
            "runId": run_id,
            "targetId": target_id,
            "status": "claimed",
            "gpuIds": [],
            "workerId": "test-worker",
            "leaseId": str(uuid4()),
            "cancelRequested": False,
        },
        "run": {
            "id": run_id,
            "projectId": project_id,
            "experimentId": str(uuid4()),
            "kind": "training",
            "status": "queued",
            "parameters": {"steps": 3},
            "tags": {},
            "modelVersionId": None,
            "codeVersionId": code_id,
            "inputDatasetVersionIds": [],
        },
        "target": {
            "id": target_id,
            "executor": "local",
            "host": "localhost",
            "port": 22,
            "username": "test",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": str(tmp_path / "compute"),
            "pythonExecutable": sys.executable,
            "gpuIds": [],
            "maxConcurrentJobs": 2,
            "enabled": True,
        },
        "codeVersion": {
            "id": code_id,
            "projectId": project_id,
            "source": {"kind": "inline", "files": {"main.py": "print('hello worker')\n"}},
            "version": "v1",
            "entrypoint": ["python", "main.py"],
            "requirements": [],
            "environment": {"MY_PASSWORD": "configured-secret"},
            "supportedModelFamilies": ["linear"],
            "taskTypes": ["training", "inference"],
        },
        "modelVersion": None,
        "inputDatasets": [],
        "jobToken": "mmtj_test-job-token",
    }


@pytest.fixture
def worker_job(job_payload: dict) -> WorkerJob:
    return WorkerJob.parse(job_payload)


@pytest.fixture
def worker_settings(tmp_path: Path) -> WorkerSettings:
    return WorkerSettings(
        api=ApiSettings("http://localhost/api", "test-api-secret"),
        worker_id="test-worker",
        target_ids=(),
        state_directory=tmp_path / "state",
        allow_local_executor=True,
        heartbeat_seconds=0.04,
        poll_seconds=0.02,
        telemetry_seconds=0.08,
        cancel_grace_seconds=0.15,
        install_dependencies=False,
    )


@pytest.fixture
def ssh_state_directory() -> Iterator[Path]:
    """A launcher state directory short enough for SSH control sockets, which tmp_path is often not."""
    directory = Path(tempfile.mkdtemp(prefix="mmt-", dir="/tmp"))
    yield directory
    shutil.rmtree(directory, ignore_errors=True)
