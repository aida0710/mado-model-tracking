"""Site Jobs, spec directories and a fake Apptainer CLI for the site runner tests.

The fake CLI runs the registered entrypoint for real with the bind mounts translated to host
paths, so the runner's staging, execution and output collection all run unmodified.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

from fake_site_api import JOB_TOKEN

from mado_tracking.site.file_archive import PRIVATE_DIRECTORY_MODE
from mado_tracking.site.runner import RunnerTimings
from mado_tracking.site.spec_directory import RunnerSettings, spec_files

FAST_TIMINGS = RunnerTimings(
    heartbeat_seconds=0.05,
    log_forward_seconds=0.05,
    gpu_wait_seconds=0.05,
    telemetry_seconds=3600.0,
    api_retry_seconds=0.01,
)
FAKE_SIF_CLI = r"""
import json, os, sys
from pathlib import Path
calls = Path(__file__).resolve().parent / "calls.jsonl"
def record(entry):
    with calls.open("a") as log:
        log.write(json.dumps(entry) + "\n")
if sys.argv[1:] == ["--version"]:
    print("fake SIF CLI")
    sys.exit(0)
if sys.argv[1:] == ["exec", "--help"]:
    print("--cleanenv --containall --no-eval --no-home --no-mount --pwd --nv")
    sys.exit(0)
prefix = "APPTAINER" if Path(sys.argv[0]).name == "apptainer" else "SINGULARITY"
if sys.argv[1] == "pull":
    arch, destination, source = sys.argv[3], sys.argv[4], sys.argv[5]
    assert sys.argv[2] == "--arch" and source.startswith("docker://")
    record({
        "command": "pull", "arch": arch, "image": source,
        "username": os.environ.get(prefix + "_DOCKER_USERNAME"),
        "password": os.environ.get(prefix + "_DOCKER_PASSWORD"),
        "cacheDirectory": os.environ.get(prefix + "_CACHEDIR"),
    })
    print("pulling " + source, flush=True)
    Path(destination).write_bytes(("fake SIF of " + source + " for " + arch).encode())
    sys.exit(0)
assert sys.argv[1] == "exec"
assert "--cleanenv" in sys.argv and "--containall" in sys.argv and "--no-eval" in sys.argv
mounts = {}
for index, value in enumerate(sys.argv):
    if value == "--bind":
        source, destination, permission = sys.argv[index + 1].split(":")
        assert permission == ("rw" if destination == "/mmt/outputs" else "ro")
        mounts[destination] = source
def translate(value):
    for destination, source in sorted(mounts.items(), key=lambda item: -len(item[0])):
        if value == destination or value.startswith(destination + "/"):
            return source + value[len(destination):]
    return value
environment = {
    name[len(prefix) + 4:]: translate(value)
    for name, value in os.environ.items() if name.startswith(prefix + "ENV_")
}
environment["PATH"] = os.environ["PATH"]
datasets = json.loads(environment.get("MMT_INPUT_DATASET_DIRS", "{}"))
environment["MMT_FAKE_DATASET_DIRS"] = json.dumps({key: translate(value) for key, value in datasets.items()})
sif_index = next(index for index, value in enumerate(sys.argv) if value.endswith("runtime.sif"))
record({
    "command": "exec", "nv": "--nv" in sys.argv, "cuda": os.environ.get("CUDA_VISIBLE_DEVICES"),
    "sif": Path(sys.argv[sif_index]).read_text(errors="replace"), "mounts": sorted(mounts),
})
if "--pwd" in sys.argv:
    os.chdir(translate(sys.argv[sys.argv.index("--pwd") + 1]))
argv = [sys.executable, *[translate(value) for value in sys.argv[sif_index + 2:]]]
os.execve(sys.executable, argv, environment)
"""


def install_fake_sif_cli(tmp_path: Path, monkeypatch: Any, kind: str = "apptainer") -> Path:
    directory = tmp_path / "bin"
    directory.mkdir(exist_ok=True)
    executable = directory / kind
    executable.write_text(f"#!{sys.executable}\n" + FAKE_SIF_CLI)
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", f"{directory}:{os.environ.get('PATH', '')}")
    return directory


def recorded_cli_calls(directory: Path) -> list[dict[str, Any]]:
    path = directory / "calls.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def site_job(
    *,
    project_id: str,
    source_files: dict[str, str],
    runtime: dict[str, Any],
    runtime_kinds: list[str],
    gpu_count: int = 0,
    kind: str = "processing",
    array_index: int | None = None,
    array_size: int | None = None,
    partition_version_id: str | None = None,
    input_datasets: list[dict[str, Any]] | None = None,
    cpu_arch: str = "amd64",
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """A WorkerJob as a site submission carries it, with its Job token."""
    run_id, target_id, code_id, job_id = (str(uuid4()) for _ in range(4))
    datasets = input_datasets or []
    return {
        "job": {
            "id": job_id,
            "projectId": project_id,
            "runId": run_id,
            "targetId": target_id,
            "status": "claimed",
            "gpuIds": [],
            "workerId": "launcher-test",
            "leaseId": str(uuid4()),
            "cancelRequested": False,
            "phase": "submitted",
            "gpuCount": gpu_count,
            "walltimeSeconds": 3600,
            "arrayGroupId": str(uuid4()) if array_index is not None else None,
            "arrayIndex": array_index,
            "arraySize": array_size,
            "datasetPartitionVersionId": partition_version_id,
        },
        "run": {
            "id": run_id,
            "projectId": project_id,
            "experimentId": str(uuid4()),
            "kind": kind,
            "status": "queued",
            "parameters": {"steps": 2},
            "tags": {},
            "modelVersionId": None,
            "codeVersionId": code_id,
            "inputDatasetVersionIds": [dataset["id"] for dataset in datasets],
        },
        "target": {
            "id": target_id,
            "name": "test site",
            "executor": "site",
            "host": "",
            "port": 22,
            "username": "",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": "",
            "pythonExecutable": "",
            "runtimeKinds": runtime_kinds,
            "gpuIds": [],
            "maxConcurrentJobs": 10,
            "enabled": True,
            "datasetCacheMaxBytes": 1024**3,
            "datasetTransfer": "direct",
            "submissionMode": "automatic",
            "cpuArch": cpu_arch,
            "supportsArray": array_index is not None,
            "queueTimeoutSeconds": None,
        },
        "codeVersion": {
            "id": code_id,
            "projectId": project_id,
            "version": "v1",
            "source": {"kind": "inline", "files": source_files},
            "runtime": runtime,
            "entrypoint": ["python", "/mmt/source/main.py"],
            "requirements": [],
            "environment": environment or {"MY_PASSWORD": "configured-site-secret"},
            "supportedModelFamilies": [],
            "taskTypes": [kind],
        },
        "modelVersion": None,
        "inputDatasets": datasets,
        "jobToken": JOB_TOKEN,
    }


def submission_for(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "target": jobs[0]["target"],
        "arrayGroupId": jobs[0]["job"]["arrayGroupId"],
        "requester": {"id": str(uuid4()), "email": "alice@example.org", "username": "alice"},
        "jobs": jobs,
    }


def write_spec_directory(
    directory: Path,
    submission: dict[str, Any],
    *,
    api_url: str,
    settings: RunnerSettings,
    secrets: dict[str, Any] | None = None,
) -> Path:
    for path, (content, mode) in spec_files(
        submission, api_url=api_url, settings=settings, secrets=secrets
    ).items():
        target = directory / path
        target.parent.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(mode)
    directory.chmod(PRIVATE_DIRECTORY_MODE)
    return directory
