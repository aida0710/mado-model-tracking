from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from background_process import entrypoint_with_background_child

from mado_tracking.security import SecretMasker
from mado_tracking.worker import host_runner
from mado_tracking.worker.container_outputs import parse_output_index, read_output_chunk, read_output_index
from mado_tracking.worker.host_execution import CommandExecution
from mado_tracking.worker.host_state import process_identity, read_json, write_json
from mado_tracking.worker.runtime import execution_specification

# A successful fixture finishes after a short grace; a leaked 60-second child must fail promptly.
COMMAND_TIMEOUT_SECONDS = 5
TEST_GRACE_SECONDS = 0.15
TEST_SECRET = "background-fixture-secret"


@pytest.mark.parametrize(
    ("ignore_sigterm", "redirected", "exit_code"),
    [(False, False, 0), (True, False, 0), (True, True, 0), (True, False, 7)],
    ids=["inherited-pipes", "inherited-pipes-ignore-term", "redirected-pipes", "failed-entrypoint"],
)
def test_entrypoint_exit_stops_background_children_drains_logs_and_preserves_its_exit_code(
    tmp_path, ignore_sigterm, redirected, *, exit_code
):
    environment = dict(os.environ, TEST_SECRET=TEST_SECRET)
    execution = CommandExecution(
        tmp_path,
        {"status": "running"},
        environment=environment,
        masker=SecretMasker([TEST_SECRET]),
        cancel_grace_seconds=TEST_GRACE_SECONDS,
    )
    source = entrypoint_with_background_child(
        ignore_sigterm=ignore_sigterm, redirected=redirected, exit_code=exit_code
    )
    with ThreadPoolExecutor(max_workers=1) as executor:
        command = executor.submit(execution.run, [sys.executable, "-c", source], capture=True)
        try:
            actual_exit_code, captured = command.result(timeout=COMMAND_TIMEOUT_SECONDS)
        finally:
            if not command.done():
                # The old bug still supports cancel; clean up a regression's real child process.
                (tmp_path / "cancel.request").touch()
    assert actual_exit_code == exit_code
    child_pid = int((tmp_path / "child.pid").read_text())
    assert process_identity(child_pid) is None
    stdout, stderr = [(tmp_path / f"{stream}.log").read_text() for stream in ("stdout", "stderr")]
    assert f"entrypoint exit={exit_code}" in stdout and "entrypoint stderr" in stderr
    assert captured == stdout and TEST_SECRET not in stdout + stderr
    if not redirected:
        assert "child stdout [REDACTED]" in stdout and "child stderr [REDACTED]" in stderr
    if not ignore_sigterm:
        assert "child cleanup stdout" in stdout and "child cleanup stderr [REDACTED]" in stderr


def _serve_python_job(tmp_path, monkeypatch, worker_job, worker_settings, entrypoint):
    """Run host_runner.serve for a Python job whose entrypoint is replaced by ``entrypoint``."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    specification = execution_specification(worker_job, worker_settings)
    assert specification["codeVersion"]["runtime"]["kind"] == "python"
    write_json(workspace / "spec.json", specification)
    write_json(workspace / "state.json", {"status": "starting", "supervisorPid": 0, "processPid": 0})
    seen: dict[str, str] = {}

    def run_entrypoint(_workspace, _specification, execution):
        seen.update(execution.environment)
        return entrypoint(Path(execution.environment["MMT_OUTPUTS_DIR"]))

    monkeypatch.setattr(host_runner, "execute_registered_code", run_entrypoint)
    # serve() installs supervisor signal handlers; keep pytest's own handlers intact.
    monkeypatch.setattr(host_runner.signal, "signal", lambda *_arguments: None)
    host_runner.serve(workspace)
    return workspace, read_json(workspace / "state.json"), seen


def test_python_job_outputs_and_result_json_are_collected_like_container_outputs(
    tmp_path, monkeypatch, worker_job, worker_settings
):
    weights = b"python-trained-weights"

    def write_outputs(outputs: Path) -> int:
        (outputs / "model").mkdir()
        (outputs / "model/weights.bin").write_bytes(weights)
        manifest = {
            "version": 1,
            "complete": True,
            "artifacts": [
                {
                    "path": "model/weights.bin",
                    "sha256": hashlib.sha256(weights).hexdigest(),
                    "size": len(weights),
                }
            ],
            "metrics": [{"name": "loss", "value": 0.5, "step": 1}],
        }
        (outputs / "result.json").write_text(json.dumps(manifest))
        return 0

    workspace, state, environment = _serve_python_job(
        tmp_path, monkeypatch, worker_job, worker_settings, write_outputs
    )
    assert environment["MMT_OUTPUTS_DIR"] == str(workspace / "outputs")
    assert environment["MMT_RESULT_FILE"] == str(workspace / "outputs/result.json")
    assert state["status"] == "finished"
    index = parse_output_index(read_output_index(workspace, state["results"]))
    assert [artifact["path"] for artifact in index] == ["model/weights.bin"]
    assert state["results"]["metrics"][0]["name"] == "loss"
    chunk = read_output_chunk(workspace, {"path": "model/weights.bin"}, state)
    assert base64.b64decode(chunk["content"]) == weights


def test_python_job_without_outputs_finishes_without_results(
    tmp_path, monkeypatch, worker_job, worker_settings
):
    _workspace, state, _environment = _serve_python_job(
        tmp_path, monkeypatch, worker_job, worker_settings, lambda outputs: 0
    )
    assert state["status"] == "finished"
    assert state["results"] is None
    assert state["error"] is None


def test_python_job_with_undeclared_outputs_fails_instead_of_uploading_partial_files(
    tmp_path, monkeypatch, worker_job, worker_settings
):
    def write_without_manifest(outputs: Path) -> int:
        (outputs / "weights.bin").write_bytes(b"partial")
        return 0

    _workspace, state, _environment = _serve_python_job(
        tmp_path, monkeypatch, worker_job, worker_settings, write_without_manifest
    )
    assert state["status"] == "failed"
    assert "result.json" in state["error"]
    assert "results" not in state
