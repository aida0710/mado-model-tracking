"""Detached target-side runner. All credentials arrive via private stdin/spec files."""

from __future__ import annotations

import base64
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..security import SecretMasker, secret_values
from .host_execution import CommandExecution, ExecutionCanceled
from .host_state import is_same_process, process_identity, read_json, read_state, write_json
from .source import materialize_source
from .telemetry import collect_system_metrics

# A single status request returns bounded log output, regardless of job duration.
STATUS_LOG_BYTES = 64 * 1024
PROTOCOL_MAX_INPUT_BYTES = 32 * 1024**2
# An orphan still uses the same cancellation grace as a supervised process.
ORPHAN_CANCEL_GRACE_SECONDS = 10.0
ORPHAN_CANCEL_POLL_SECONDS = 0.1


def launch(workspace: Path, specification: dict[str, Any], runtime_path: Path) -> dict[str, Any]:
    with (workspace / "start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = workspace / "state.json"
        if state_path.exists():
            previous = read_json(state_path)
            if (
                previous.get("jobId") != specification["jobId"]
                or previous.get("codeVersionId") != specification["codeVersion"]["id"]
            ):
                raise ValueError("Workspace belongs to a different pinned job")
            return read_state(workspace)
        write_json(workspace / "spec.json", specification)
        state: dict[str, Any] = {
            "jobId": specification["jobId"],
            "codeVersionId": specification["codeVersion"]["id"],
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
        if state.get("supervisorPid") not in {0, os.getpid()}:
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
    environment = _execution_environment(specification, workspace)
    masker = SecretMasker(secret_values(environment))
    execution = CommandExecution(
        workspace,
        state,
        environment=environment,
        masker=masker,
        cancel_grace_seconds=float(specification["cancelGraceSeconds"]),
    )
    exit_code: int | None = None
    failure: str | None = None
    status = "failed"
    try:
        source_directory = workspace / "source"
        source_directory.mkdir(mode=0o700, exist_ok=True)
        artifact_path = workspace / "source.archive"
        materialize_source(
            specification["codeVersion"]["source"],
            source_directory,
            artifact=artifact_path if artifact_path.exists() else None,
            command_runner=execution.checked,
        )
        python = execution.create_environment(
            sdk_directory=workspace / "sdk",
            requirements=specification["codeVersion"]["requirements"],
            install_dependencies=specification["installDependencies"],
        )
        entrypoint = list(specification["codeVersion"]["entrypoint"])
        if entrypoint[0] in {"python", "python3", "${PYTHON}", "{python}"}:
            entrypoint[0] = str(python)
        exit_code, _captured = execution.run(entrypoint, cwd=source_directory)
        status = "finished" if exit_code == 0 else "failed"
        if exit_code:
            failure = f"Entrypoint exited with status {exit_code}"
    except ExecutionCanceled:
        status = "canceled"
    except Exception as error:
        failure = masker.mask(str(error))
        with (workspace / "stderr.log").open("ab") as stderr_log:
            stderr_log.write((failure + "\n").encode())
    state.update(status=status, exitCode=exit_code, error=failure, endedAt=time.time())
    write_json(workspace / "state.json", state)
    # Keep only nonsensitive execution metadata after terminal state has been persisted.
    (workspace / "spec.json").unlink(missing_ok=True)


def _execution_environment(specification: dict[str, Any], workspace: Path) -> dict[str, str]:
    # A local development job must not inherit the worker's unrelated secrets or SSH credentials.
    allowed_host_names = {"PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "TMPDIR"}
    environment = {name: value for name, value in os.environ.items() if name in allowed_host_names}
    environment.update(specification["codeVersion"]["environment"])
    environment.update(specification["sdkEnvironment"])
    environment.update(
        CUDA_VISIBLE_DEVICES=",".join(specification["gpuIds"]),
        PYTHONUNBUFFERED="1",
        MMT_JOB_KIND=specification["context"]["kind"],
        MMT_JOB_CONTEXT_FILE=str(workspace / "context.json"),
        MMT_PARAMETERS_FILE=str(workspace / "parameters.json"),
        MMT_MODEL_VERSION_FILE=str(workspace / "model-version.json"),
        MMT_DATASET_VERSIONS_FILE=str(workspace / "dataset-versions.json"),
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
            pid=int(state.get("processPid", 0)),
            gpu_ids=context.get("gpuIds", []),
            step=int(request.get("step", 0)),
        )
    return {"state": state, "logs": logs, "metrics": metrics}


def cancel(workspace: Path) -> dict[str, Any]:
    (workspace / "cancel.request").touch(mode=0o600)
    state = read_state(workspace)
    supervisor_pid = int(state.get("supervisorPid", 0))
    if is_same_process(supervisor_pid, state.get("supervisorIdentity")):
        os.kill(supervisor_pid, signal.SIGTERM)
    elif state.get("processAlive"):
        process_pid = int(state.get("processPid", 0))
        if is_same_process(process_pid, state.get("processIdentity")):
            os.killpg(process_pid, signal.SIGTERM)
            # Recovery cannot determine success; cancellation terminates the known group.
            deadline = time.monotonic() + ORPHAN_CANCEL_GRACE_SECONDS
            while is_same_process(process_pid, state.get("processIdentity")) and time.monotonic() < deadline:
                time.sleep(ORPHAN_CANCEL_POLL_SECONDS)
            try:
                os.killpg(process_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            state.update(status="canceled", exitCode=None, error=None, endedAt=time.time())
            write_json(workspace / "state.json", state)
    return state


def receive_archive(workspace: Path) -> dict[str, Any]:
    path = workspace / "source.archive"
    with (workspace / "upload.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (workspace / "state.json").exists():
            return {"uploaded": path.exists()}
        temporary_path = workspace / "source.archive.partial"
        with temporary_path.open("wb") as output:
            while chunk := sys.stdin.buffer.read(STATUS_LOG_BYTES):
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    return {"uploaded": True}


def main() -> None:
    os.umask(0o077)
    command, raw_workspace = sys.argv[1:3]
    workspace = Path(raw_workspace).expanduser().resolve()
    if not workspace.is_dir() or workspace.is_symlink():
        raise ValueError("Job workspace is unavailable")
    if command == "serve":
        serve(workspace)
        return
    if command == "upload":
        response = receive_archive(workspace)
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
        else:
            raise ValueError("Unknown runner command")
    print(json.dumps(response, allow_nan=False))


if __name__ == "__main__":
    main()
