"""Execute each setup/entrypoint command in its own cancelable process group."""

from __future__ import annotations

import codecs
import os
import selectors
import signal
import subprocess
import sys
import time
import venv
from pathlib import Path
from typing import Any, BinaryIO, cast

from ..security import SecretMasker, StreamMasker
from .host_state import process_identity, write_json

# Bounded reads and selector wakeups detect entrypoint exit/cancel independently of pipe EOF.
READ_CHUNK_BYTES = 64 * 1024
CANCEL_POLL_SECONDS = 0.1


class ExecutionCanceled(Exception):
    pass


class CommandExecution:
    def __init__(
        self,
        workspace: Path,
        state: dict[str, Any],
        *,
        environment: dict[str, str],
        masker: SecretMasker,
        cancel_grace_seconds: float,
    ):
        self.workspace = workspace
        self.state = state
        self.environment = environment
        self.masker = masker
        self.cancel_grace_seconds = cancel_grace_seconds

    def is_canceled(self) -> bool:
        return (self.workspace / "cancel.request").exists()

    def run(self, argv: list[str], *, cwd: Path | None = None, capture: bool = False) -> tuple[int, str]:
        if self.is_canceled():
            raise ExecutionCanceled()
        with (
            (self.workspace / "stdout.log").open("ab", buffering=0) as stdout_log,
            (self.workspace / "stderr.log").open("ab", buffering=0) as stderr_log,
        ):
            self.state["processPending"] = True
            write_json(self.workspace / "state.json", self.state)
            try:
                process = subprocess.Popen(
                    argv,
                    cwd=cwd or self.workspace,
                    env=self.environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                    close_fds=True,
                )
            except OSError:
                self.state["processPending"] = False
                write_json(self.workspace / "state.json", self.state)
                raise
            self.state.update(
                processPid=process.pid, processIdentity=process_identity(process.pid), processPending=False
            )
            write_json(self.workspace / "state.json", self.state)
            captured = self._drain(process, stdout_log, stderr_log, capture=capture)
            exit_code = process.wait()
        if self.is_canceled():
            raise ExecutionCanceled()
        return exit_code, captured

    def _terminate_descendants(self, process_group: int, *, terminate_started: float | None) -> None:
        # Closed pipes do not prove that redirected background children have stopped.
        # Reuse the first SIGTERM deadline so cleanup never adds a second grace period.
        if terminate_started is None:
            terminate_started = time.monotonic()
            _signal_process_group(process_group, signal.SIGTERM)
        deadline = terminate_started + self.cancel_grace_seconds
        while _has_live_process_group_members(process_group):
            if time.monotonic() >= deadline:
                _signal_process_group(process_group, signal.SIGKILL)
            # Signal delivery is asynchronous; do not release the job while a child is still alive.
            time.sleep(CANCEL_POLL_SECONDS)

    def checked(self, argv: list[str], *, cwd: Path | None = None) -> str:
        exit_code, captured = self.run(argv, cwd=cwd, capture=True)
        if exit_code:
            # Command arguments can carry secrets; the command itself is intentionally omitted.
            raise RuntimeError(f"Source/setup command exited with status {exit_code}")
        return captured

    def _drain(
        self, process: subprocess.Popen[bytes], stdout_log: Any, stderr_log: Any, *, capture: bool
    ) -> str:
        if process.stdout is None or process.stderr is None:
            raise RuntimeError("Process output was not connected")
        streams = {process.stdout: stdout_log, process.stderr: stderr_log}
        decoders = {stream: codecs.getincrementaldecoder("utf-8")("replace") for stream in streams}
        maskers = {stream: StreamMasker(self.masker) for stream in streams}
        captured_parts: list[str] = []
        capture_size = 0
        terminate_started: float | None = None
        with selectors.DefaultSelector() as selector:
            for stream in streams:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                if terminate_started is None and (self.is_canceled() or process.poll() is not None):
                    # Children can keep output pipes open after the leader exits; do not wait for EOF.
                    terminate_started = time.monotonic()
                    _signal_process_group(process.pid, signal.SIGTERM)
                if (
                    terminate_started is not None
                    and time.monotonic() - terminate_started >= self.cancel_grace_seconds
                ):
                    _signal_process_group(process.pid, signal.SIGKILL)
                for event, _mask in selector.select(CANCEL_POLL_SECONDS):
                    stream = cast(BinaryIO, event.fileobj)
                    raw = os.read(stream.fileno(), READ_CHUNK_BYTES)
                    decoded = decoders[stream].decode(raw, final=not raw)
                    text = maskers[stream].feed(decoded, final=not raw)
                    if text:
                        streams[stream].write(text.encode("utf-8"))
                        if capture and stream is process.stdout:
                            # Only rev-parse needs captured stdout; bound setup output in memory.
                            capture_size += len(text)
                            if capture_size < READ_CHUNK_BYTES:
                                captured_parts.append(text)
                    if not raw:
                        selector.unregister(stream)
                        stream.close()
                if not selector.get_map() and process.poll() is None:
                    time.sleep(CANCEL_POLL_SECONDS)
            self._terminate_descendants(process.pid, terminate_started=terminate_started)
        return "".join(captured_parts)

    def create_environment(
        self, *, sdk_directory: Path, requirements: list[str], install_dependencies: bool
    ) -> Path:
        environment_directory = self.workspace / "venv"
        venv.EnvBuilder(with_pip=False).create(environment_directory)
        python = environment_directory / "bin/python"
        if install_dependencies:
            import importlib.util

            if importlib.util.find_spec("pip") is None:
                self.checked([str(python), "-m", "ensurepip", "--upgrade"])
                pip_prefix = [str(python), "-m", "pip"]
            else:
                # --python can install into a venv created without pip (e.g. Debian's minimal Python).
                pip_prefix = [sys.executable, "-m", "pip", "--python", str(python)]
            if not all(
                isinstance(value, str)
                and value
                and not value.startswith("-")
                and "\n" not in value
                and "\x00" not in value
                for value in requirements
            ):
                raise ValueError("Requirements must be dependency specifications, not pip options")
            self.checked(
                [*pip_prefix, "install", "--disable-pip-version-check", "httpx>=0.27,<1", *requirements],
                cwd=self.workspace / "source",
            )
        self.environment.update(
            VIRTUAL_ENV=str(environment_directory),
            PATH=f"{environment_directory / 'bin'}:{self.environment.get('PATH', '')}",
        )
        self.environment["PYTHONPATH"] = str(sdk_directory)
        return python


def _signal_process_group(pid: int, signal_number: signal.Signals) -> None:
    try:
        os.killpg(pid, signal_number)
    except ProcessLookupError:
        pass


def _has_live_process_group_members(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    # Orphan zombies can keep killpg(0) true; they no longer execute or own GPU resources.
    for process_directory in Path("/proc").iterdir():
        if not process_directory.name.isdigit():
            continue
        try:
            process_stat = (process_directory / "stat").read_text()
            # comm may contain spaces or ')'; state and pgrp follow its final ')'.
            process_fields = process_stat[process_stat.rfind(")") + 2 :].split()
            if int(process_fields[2]) == process_group and process_fields[0] not in {"Z", "X"}:
                return True
        except (OSError, IndexError, ValueError):
            continue
    return False
