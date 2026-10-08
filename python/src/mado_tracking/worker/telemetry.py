"""Worker job telemetry on top of the shared system metrics collector; no secrets or environments."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..system_metrics import SystemMetricsState, collect


def collect_system_metrics(
    *, pid: int, gpu_ids: list[str], step: int, state_path: Path | None = None
) -> list[dict[str, Any]]:
    """One telemetry sample for a job; jobs without GPUs never probe NVML or nvidia-smi.

    Each runner poll is a new process, so disk/network rates need `state_path` to persist the
    previous counters between polls. Without it only instantaneous values are reported.
    """
    state = _read_state(state_path)
    try:
        return collect(state, step=step, pid=pid or None, gpu_ids=gpu_ids)
    finally:
        state.close()
        _write_state(state_path, state)


def _read_state(path: Path | None) -> SystemMetricsState:
    if path is None:
        return SystemMetricsState()
    try:
        return SystemMetricsState.from_json(json.loads(path.read_text()))
    except (OSError, ValueError):
        return SystemMetricsState()


def _write_state(path: Path | None, state: SystemMetricsState) -> None:
    if path is None:
        return
    temporary_path = path.with_name(f".{path.name}.tmp")
    try:
        descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as content:
            json.dump(state.to_json(), content)
        os.replace(temporary_path, path)
    except OSError:
        # Losing the previous counters only drops rates from the next sample.
        pass
