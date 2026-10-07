from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from background_process import entrypoint_with_background_child

from mado_tracking.security import SecretMasker
from mado_tracking.worker.host_execution import CommandExecution
from mado_tracking.worker.host_state import process_identity

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
