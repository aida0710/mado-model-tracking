"""Detached target-side runner. All credentials arrive via private stdin/spec files."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..execution_runtime import validate_runtime
from ..execution_snapshot import resolve_runner_execution_snapshot
from ..security import SecretMasker, secret_values
from .container_layout import host_environment
from .container_outputs import RESULT_FILENAME, read_output_chunk, validate_results
from .host_execution import CommandExecution, ExecutionCanceled, terminate_owned_process_group
from .host_state import is_same_process, process_identity, read_json, read_state, write_json
from .job_execution import execute_registered_code
from .runtime_capability import ContainerStateUncertain, RuntimeUnavailable
from .source_snapshot import read_source_snapshot_chunk
from .source_tree import MAX_SOURCE_ARCHIVE_BYTES
from .telemetry import collect_system_metrics

# A single status request returns bounded log output, regardless of job duration.
STATUS_LOG_BYTES = 64 * 1024
PROTOCOL_MAX_INPUT_BYTES = 32 * 1024**2
# An orphan still uses the same cancellation grace as a supervised process.
ORPHAN_CANCEL_GRACE_SECONDS = 10.0


def launch(workspace: Path, specification: dict[str, Any], runtime_path: Path) -> dict[str, Any]:
    specification["executionSnapshot"] = resolve_runner_execution_snapshot(specification)
    instructions_hash = hashlib.sha256(
        json.dumps(specification["executionSnapshot"], sort_keys=True, allow_nan=False).encode()
    ).hexdigest()
    with (workspace / "start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = workspace / "state.json"
        if state_path.exists():
            previous = read_json(state_path)
            if (
                previous.get("jobId") != specification["jobId"]
                or previous.get("codeVersionId") != specification["codeVersion"]["id"]
                or previous.get("leaseId") != specification.get("leaseId")
                or previous.get("executionMode", "run") != specification["executionSnapshot"]["mode"]
                or previous.get("runId", specification["context"]["runId"])
                != specification["context"]["runId"]
                or previous.get("instructionsHash", instructions_hash) != instructions_hash
            ):
                raise ValueError("Workspace belongs to a different pinned job")
            return read_state(workspace)
        write_json(workspace / "spec.json", specification)
        state: dict[str, Any] = {
            "jobId": specification["jobId"],
            "codeVersionId": specification["codeVersion"]["id"],
            "leaseId": specification.get("leaseId"),
            "runId": specification["context"]["runId"],
            "executionMode": specification["executionSnapshot"]["mode"],
            "instructionsHash": instructions_hash,
            "sourceSnapshotRequired": True,
            "status": "starting",
            "supervisorPid": 0,
            "processPid": 0,
        }
        write_json(state_path, state)
        with (workspace / "supervisor.log").open("ab") as diagnostic_output:
            supervisor = subprocess.Popen(
                [sys.executable, str(runtime_path), "serve", str(workspace)],
                stdin=subprocess.DEVNULL,
                stdout=diagnostic_output,
                stderr=diagnostic_output,
                start_new_session=True,
                close_fds=True,
            )
        state.update(supervisorPid=supervisor.pid, supervisorIdentity=process_identity(supervisor.pid))
        write_json(state_path, state)
    return state


def serve(workspace: Path) -> None:
    # Parent and supervisor share the launch lock; the parent publishes PID before setup can start.
    with (workspace / "start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_json(workspace / "state.json")
        specification = read_json(workspace / "spec.json")
        # A saved supervisor spec from before snapshots still needs cancellation/container cleanup.
        specification["executionSnapshot"] = resolve_runner_execution_snapshot(specification)
        if state.get("supervisorPid") not in {0, os.getpid()}:
            return
        if specification.get("recoverOnly") and not terminate_owned_process_group(
            state, grace_seconds=float(specification["cancelGraceSeconds"])
        ):
            return
        state.update(
            supervisorPid=os.getpid(), supervisorIdentity=process_identity(os.getpid()), status="running"
        )
        write_json(workspace / "state.json", state)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    def request_cancellation(_signal: int, _frame: Any) -> None:
        (workspace / "cancel.request").touch(mode=0o600)

    signal.signal(signal.SIGTERM, request_cancellation)
    signal.signal(signal.SIGINT, request_cancellation)
    runtime = validate_runtime(
        specification["codeVersion"].get("runtime"),
        source=specification["codeVersion"]["source"],
        requirements=specification["codeVersion"]["requirements"],
    )
    specification["codeVersion"]["runtime"] = runtime
    environment = _execution_environment(specification, workspace)
    masker = SecretMasker(secret_values(environment))
    execution = CommandExecution(
        workspace,
        state,
        environment=environment if runtime["kind"] == "python" else host_environment(),
        masker=masker,
        cancel_grace_seconds=float(specification["cancelGraceSeconds"]),
    )
    exit_code: int | None = None
    failure: str | None = None
    status = "failed"
    try:
        exit_code = execute_registered_code(workspace, specification, execution)
        status = "finished" if exit_code == 0 else "failed"
        if exit_code:
            failure = f"Entrypoint exited with status {exit_code}"
        else:
            state["results"] = validate_results(workspace / "outputs")
    except ExecutionCanceled:
        status = "canceled"
    except ContainerStateUncertain as error:
        status = "unknown"
        failure = masker.mask(str(error))
    except RuntimeUnavailable as error:
        state["runtimeCapability"] = {"kind": error.kind, "available": False}
        failure = masker.mask(str(error))
        if state.get("container") and not state["container"].get("released"):
            status = "unknown"
    except Exception as error:
        status = "unknown" if state.get("container") and not state["container"].get("released") else "failed"
        failure = masker.mask(str(error))
        with (workspace / "stderr.log").open("ab") as stderr_log:
            stderr_log.write((failure + "\n").encode())
    state.update(
        status=status, exitCode=exit_code, error=failure, endedAt=time.time() if status != "unknown" else None
    )
    write_json(workspace / "state.json", state)
    # Keep only nonsensitive execution metadata after terminal state has been persisted.
    if status in {"finished", "failed", "canceled"}:
        (workspace / "spec.json").unlink(missing_ok=True)
        (workspace / "container.env").unlink(missing_ok=True)


def resume_docker_supervisor(workspace: Path) -> None:
    with (workspace / "start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state(workspace)
        if (
            state.get("status") != "unknown"
            or not state.get("container")
            or is_same_process(int(state.get("supervisorPid", 0)), state.get("supervisorIdentity"))
            or not (workspace / "spec.json").exists()
        ):
            return
        specification = read_json(workspace / "spec.json")
        specification["recoverOnly"] = True
        write_json(workspace / "spec.json", specification)
        with (workspace / "supervisor.log").open("ab") as diagnostic_output:
            supervisor = subprocess.Popen(
                [sys.executable, str(Path(sys.argv[0]).resolve()), "serve", str(workspace)],
                stdin=subprocess.DEVNULL,
                stdout=diagnostic_output,
                stderr=diagnostic_output,
                start_new_session=True,
                close_fds=True,
            )
        state.update(
            supervisorPid=supervisor.pid,
            supervisorIdentity=process_identity(supervisor.pid),
            status="starting",
        )
        write_json(workspace / "state.json", state)


def _execution_environment(specification: dict[str, Any], workspace: Path) -> dict[str, str]:
    # A local development job must not inherit the worker's unrelated secrets or SSH credentials.
    allowed_host_names = {"PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "TMPDIR"}
    environment = {name: value for name, value in os.environ.items() if name in allowed_host_names}
    environment.update(specification["codeVersion"]["environment"])
    environment.update(specification["sdkEnvironment"])
    # Python jobs use the same outputs contract as containers, so code without the SDK can hand
    # files (for example Task output model weights) to the worker for upload.
    outputs = workspace / "outputs"
    if outputs.is_symlink():
        raise ValueError("Output directory must not be a symlink")
    outputs.mkdir(mode=0o700, exist_ok=True)
    environment.update(
        CUDA_VISIBLE_DEVICES=",".join(specification["gpuIds"]),
        PYTHONUNBUFFERED="1",
        MMT_JOB_KIND=specification["context"]["kind"],
        MMT_EXECUTION_MODE=specification["executionSnapshot"]["mode"],
        MMT_JOB_CONTEXT_FILE=str(workspace / "context.json"),
        MMT_PARAMETERS_FILE=str(workspace / "parameters.json"),
        MMT_MODEL_VERSION_FILE=str(workspace / "model-version.json"),
        MMT_DATASET_VERSIONS_FILE=str(workspace / "dataset-versions.json"),
        MMT_OUTPUTS_DIR=str(outputs),
        MMT_RESULT_FILE=str(outputs / RESULT_FILENAME),
        MMT_PARAMETERS_JSON=json.dumps(specification["context"]["parameters"]),
        MMT_MODEL_VERSION_ID=str((specification["context"]["modelVersion"] or {}).get("id", "")),
        MMT_INPUT_DATASET_VERSION_IDS=json.dumps(
            [dataset["id"] for dataset in specification["context"]["inputDatasets"]]
        ),
    )
    write_json(workspace / "context.json", specification["context"])
    write_json(workspace / "parameters.json", specification["context"]["parameters"])
    # Separate JSON files are objects even when a Run has no model / datasets.
    write_json(workspace / "model-version.json", {"modelVersion": specification["context"]["modelVersion"]})
    write_json(
        workspace / "dataset-versions.json", {"inputDatasets": specification["context"]["inputDatasets"]}
    )
    return environment


def poll(workspace: Path, request: dict[str, Any]) -> dict[str, Any]:
    state = read_state(workspace)
    if state.get("status") == "unknown" and state.get("container"):
        resume_docker_supervisor(workspace)
        state = read_state(workspace)
    logs = {}
    for stream_name in ("stdout", "stderr"):
        path = workspace / f"{stream_name}.log"
        offset = int(request.get("offsets", {}).get(stream_name, 0))
        if offset < 0:
            raise ValueError("Log offsets must be nonnegative")
        raw = b""
        if path.exists():
            with path.open("rb") as content:
                content.seek(offset)
                raw = content.read(STATUS_LOG_BYTES)
        # Retain any trailing incomplete UTF-8 sequence for the next status request.
        while raw:
            try:
                raw.decode("utf-8")
                break
            except UnicodeDecodeError as error:
                if error.reason != "unexpected end of data":
                    raise
                raw = raw[: error.start]
        logs[stream_name] = {
            "content": base64.b64encode(raw).decode(),
            "nextOffset": offset + len(raw),
            "size": path.stat().st_size if path.exists() else 0,
        }
    metrics = []
    if request.get("telemetry"):
        context_path = workspace / "context.json"
        context = read_json(context_path) if context_path.exists() else {}
        metrics = collect_system_metrics(
            pid=int(state.get("container", {}).get("pid", state.get("processPid", 0))),
            gpu_ids=context.get("gpuIds", []),
            step=int(request.get("step", 0)),
        )
    return {"state": state, "logs": logs, "metrics": metrics}


def cancel(workspace: Path) -> dict[str, Any]:
    (workspace / "cancel.request").touch(mode=0o600)
    state = read_state(workspace)
    if state.get("container") and state.get("status") not in {"finished", "failed", "canceled"}:
        resume_docker_supervisor(workspace)
        state = read_state(workspace)
    supervisor_pid = int(state.get("supervisorPid", 0))
    if is_same_process(supervisor_pid, state.get("supervisorIdentity")):
        os.kill(supervisor_pid, signal.SIGTERM)
    elif state.get("processAlive") and not state.get("container"):
        if not state.get("processPending") and terminate_owned_process_group(
            state, grace_seconds=ORPHAN_CANCEL_GRACE_SECONDS
        ):
            state.update(status="canceled", exitCode=None, error=None, endedAt=time.time())
            write_json(workspace / "state.json", state)
    return state


def receive_archive(workspace: Path, *, kind: str = "source") -> dict[str, Any]:
    destinations = {
        "source": workspace / "source.archive",
        "sif": workspace / "runtime.sif",
        "weights": workspace / "inputs/weights",
    }
    path = destinations[kind]
    path.parent.mkdir(mode=0o700, exist_ok=True)
    with (workspace / "upload.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (workspace / "state.json").exists():
            return {"uploaded": path.exists()}
        temporary_path = path.with_name(path.name + ".partial")
        checksum, size = hashlib.sha256(), 0
        with temporary_path.open("wb") as output:
            while chunk := sys.stdin.buffer.read(STATUS_LOG_BYTES):
                output.write(chunk)
                checksum.update(chunk)
                size += len(chunk)
                if kind == "source" and size > MAX_SOURCE_ARCHIVE_BYTES:
                    raise ValueError("Code archive exceeds its upload size limit")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    return {"uploaded": True, "sha256": checksum.hexdigest(), "size": size}


def main() -> None:
    os.umask(0o077)
    command, raw_workspace = sys.argv[1:3]
    workspace = Path(raw_workspace).expanduser().resolve()
    if not workspace.is_dir() or workspace.is_symlink():
        raise ValueError("Job workspace is unavailable")
    if command == "serve":
        serve(workspace)
        return
    if command in {"upload", "upload-sif", "upload-weights"}:
        response = receive_archive(
            workspace, kind=command.removeprefix("upload-") if command != "upload" else "source"
        )
    elif command == "cancel":
        response = cancel(workspace)
    else:
        raw = sys.stdin.buffer.read(PROTOCOL_MAX_INPUT_BYTES + 1)
        if len(raw) > PROTOCOL_MAX_INPUT_BYTES:
            raise ValueError("Control payload exceeds its size limit")
        request = json.loads(raw or b"{}")
        if command == "start":
            response = launch(workspace, request, Path(sys.argv[0]).resolve())
        elif command == "poll":
            response = poll(workspace, request)
        elif command == "output":
            try:
                response = read_output_chunk(workspace, request, read_state(workspace))
            except (OSError, ValueError, KeyError):
                response = {"error": "Container output failed validation"}
        elif command == "snapshot":
            try:
                response = read_source_snapshot_chunk(workspace, request, read_state(workspace))
            except (OSError, ValueError, KeyError, TypeError):
                response = {"error": "Source snapshot failed validation"}
        else:
            raise ValueError("Unknown runner command")
    print(json.dumps(response, allow_nan=False))


if __name__ == "__main__":
    main()
