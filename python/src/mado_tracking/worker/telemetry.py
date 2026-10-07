"""CPU/memory and selected NVIDIA GPU telemetry; no secrets or command environments."""

from __future__ import annotations

import csv
import io
import os
import subprocess
from typing import Any

from ..timestamps import utc_timestamp

# Telemetry is optional; a missing/slow nvidia-smi must not fail an otherwise valid job.
NVIDIA_TIMEOUT_SECONDS = 3.0


def metric(name: str, value: float, step: int) -> dict[str, Any]:
    return {
        "name": name,
        "value": value,
        "step": step,
        "timestamp": utc_timestamp(),
    }


def collect_system_metrics(*, pid: int, gpu_ids: list[str], step: int) -> list[dict[str, Any]]:
    metrics: list[dict[str, Any]] = []
    try:
        import psutil  # type: ignore[import-untyped]

        metrics.append(metric("system.cpu.percent", psutil.cpu_percent(interval=None), step))
        memory = psutil.virtual_memory()
        metrics.append(metric("system.memory.used_bytes", float(memory.used), step))
        metrics.append(metric("system.memory.percent", float(memory.percent), step))
        if pid:
            process = psutil.Process(pid)
            processes = [process, *process.children(recursive=True)]
            memory_bytes = sum(child.memory_info().rss for child in processes if child.is_running())
            metrics.append(metric("system.process.memory_bytes", float(memory_bytes), step))
    except (ImportError, OSError, ProcessLookupError):
        _collect_linux_memory(metrics, step)
    except Exception:
        # A process can disappear between enumerating its children and reading /proc.
        _collect_linux_memory(metrics, step)
    if not gpu_ids:
        return metrics
    try:
        output = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=NVIDIA_TIMEOUT_SECONDS,
        )
        for row in csv.reader(io.StringIO(output)):
            values = [value.strip() for value in row]
            if len(values) != 6 or not ({values[0], values[1]} & set(gpu_ids)):
                continue
            prefix = f"system.gpu.{values[0]}"
            for name, raw_value, scale in (
                ("utilization_percent", values[2], 1),
                ("memory_used_bytes", values[3], 1024**2),
                ("memory_total_bytes", values[4], 1024**2),
                ("temperature_celsius", values[5], 1),
            ):
                try:
                    metrics.append(metric(f"{prefix}.{name}", float(raw_value) * scale, step))
                except ValueError:
                    continue
    except (OSError, subprocess.SubprocessError):
        pass
    return metrics


def _collect_linux_memory(metrics: list[dict[str, Any]], step: int) -> None:
    try:
        from pathlib import Path

        memory_fields = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            memory_fields[name] = float(value.strip().split()[0]) * 1024
        used = memory_fields["MemTotal"] - memory_fields["MemAvailable"]
        metrics.append(metric("system.memory.used_bytes", used, step))
        metrics.append(metric("system.memory.percent", used / memory_fields["MemTotal"] * 100, step))
        load = os.getloadavg()[0]
        metrics.append(metric("system.cpu.load1", load, step))
    except (OSError, KeyError, ValueError, AttributeError):
        pass
