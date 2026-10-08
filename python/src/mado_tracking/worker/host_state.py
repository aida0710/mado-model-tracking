"""Atomic durable job state and Linux process identity checks on the compute target."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def write_json(path: Path, document: dict[str, Any]) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(document, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
        directory_descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def read_json(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("Job state must be a JSON object")
    return document


def process_identity(pid: int) -> str | None:
    if pid <= 0:
        return None
    try:
        process_stat = Path(f"/proc/{pid}/stat").read_text()
        # comm can contain spaces or ')'; fields after its final ')' start at field 3.
        process_fields = process_stat[process_stat.rfind(")") + 2 :].split()
        if process_fields[0] == "Z":
            return None
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return f"{boot_id}:{process_fields[19]}"
    except (OSError, IndexError):
        return None


def is_same_process(pid: int, expected_identity: str | None) -> bool:
    return expected_identity is not None and process_identity(pid) == expected_identity


def is_process_group_present(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Absence cannot be proven; retain the lease rather than risk another execution on this GPU.
        return True


def is_owned_process_group(pid: int, expected_identity: str | None) -> bool:
    if expected_identity is None or pid <= 0:
        return False
    if is_same_process(pid, expected_identity):
        return True
    # A dead leader can leave children in its session. A reused live leader invalidates ownership.
    if process_identity(pid) is not None:
        return False
    try:
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        if not expected_identity.startswith(boot_id + ":"):
            return False
        for process_directory in Path("/proc").iterdir():
            if not process_directory.name.isdigit():
                continue
            try:
                process_stat = (process_directory / "stat").read_text()
                fields = process_stat[process_stat.rfind(")") + 2 :].split()
                if fields[0] not in {"Z", "X"} and int(fields[2]) == pid and int(fields[3]) == pid:
                    return True
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return False
    return False


def read_state(workspace: Path) -> dict[str, Any]:
    state_path = workspace / "state.json"
    if not state_path.exists():
        return {"status": "missing"}
    state = read_json(state_path)
    if state["status"] not in {"finished", "failed", "canceled"}:
        supervisor_alive = is_same_process(
            int(state.get("supervisorPid", 0)), state.get("supervisorIdentity")
        )
        process_alive = is_same_process(int(state.get("processPid", 0)), state.get("processIdentity"))
        if not supervisor_alive:
            state["status"] = "unknown"
            state["error"] = "Supervisor disappeared; the existing execution must not be restarted"
        if state["status"] == "unknown":
            # A supervisor interrupted between intent and PID publication may have spawned a child.
            state["processAlive"] = (
                supervisor_alive
                or process_alive
                or is_process_group_present(int(state.get("processPid", 0)))
                or state.get("processPending", False)
                or not state.get("supervisorPid")
                or bool(state.get("container") and state["container"].get("released") is not True)
            )
    return state
