"""Host system metrics shared by SDK runs and worker telemetry.

Every probe is optional: a missing psutil, NVML or nvidia-smi only removes the metrics it would
have produced. Metric names follow the worker's historical `system.*` names so that existing run
history and Web charts keep matching.
"""

from __future__ import annotations

import csv
import importlib
import io
import logging
import math
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

from .timestamps import utc_timestamp

LOGGER = logging.getLogger(__name__)

# A missing or slow nvidia-smi must not stall the caller's polling loop.
NVIDIA_TIMEOUT_SECONDS = 3.0
# Busy/idle CPU time needs two samples; a fresh process waits this long once for the second one.
CPU_FIRST_SAMPLE_SECONDS = 0.1
# Comparable to W&B; sampling every second would multiply stored metric rows for little insight.
DEFAULT_SYSTEM_METRICS_SECONDS = 15.0
# Below one second the sampling cost and metric volume outweigh the resolution gained.
MIN_SYSTEM_METRICS_SECONDS = 1.0
# /proc/diskstats always counts in 512-byte sectors, independent of the device's sector size.
DISKSTATS_SECTOR_BYTES = 512
MEBIBYTE = 1024**2
# Module-level so tests can point the Linux fallbacks at a fake /proc tree.
PROC_ROOT = Path("/proc")
SYS_BLOCK_ROOT = Path("/sys/block")
# Values of CUDA_VISIBLE_DEVICES that CUDA treats as "no device visible".
CUDA_NO_DEVICE_VALUES = frozenset({"", "-1", "NoDevFiles"})
# Virtual or aggregate block devices whose traffic is already counted on the member disks.
AGGREGATE_DISK_PREFIXES = ("loop", "ram", "zram", "dm-", "md")
NVIDIA_SMI_QUERY = "index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"

Metric = dict[str, Any]
MetricSink = Callable[[list[Metric]], None]


@dataclass(frozen=True)
class CounterSample:
    """Monotonic counters read at `sampled_at` (wall-clock seconds, valid across processes)."""

    values: tuple[float, ...]
    sampled_at: float


@dataclass
class SystemMetricsState:
    """Previous counter samples, so rates and CPU usage can be computed from differences."""

    cpu: CounterSample | None = None
    disk_io: CounterSample | None = None
    network: CounterSample | None = None
    unavailable_gpu_backends: set[str] = field(default_factory=set)
    nvml: ModuleType | None = None

    def to_json(self) -> dict[str, Any]:
        """Counters only; GPU backend handles belong to the current process."""
        return {
            name: {"values": list(sample.values), "sampledAt": sample.sampled_at}
            for name, sample in (("cpu", self.cpu), ("diskIo", self.disk_io), ("network", self.network))
            if sample is not None
        }

    @classmethod
    def from_json(cls, content: object) -> SystemMetricsState:
        state = cls()
        if not isinstance(content, dict):
            return state
        state.cpu = _counter_sample_from_json(content.get("cpu"))
        state.disk_io = _counter_sample_from_json(content.get("diskIo"))
        state.network = _counter_sample_from_json(content.get("network"))
        return state

    def close(self) -> None:
        if self.nvml is None:
            return
        try:
            self.nvml.nvmlShutdown()
        except Exception:
            pass
        self.nvml = None


def _counter_sample_from_json(content: object) -> CounterSample | None:
    if not isinstance(content, dict):
        return None
    values = content.get("values")
    sampled_at = content.get("sampledAt")
    if not isinstance(values, list) or not isinstance(sampled_at, int | float):
        return None
    if not all(isinstance(value, int | float) for value in values):
        return None
    return CounterSample(tuple(float(value) for value in values), float(sampled_at))


class MetricBuilder:
    """Collects metrics of one sample with a shared step and timestamp."""

    def __init__(self, step: int):
        self.step = step
        self.timestamp = utc_timestamp()
        self.metrics: list[Metric] = []

    def add(self, name: str, value: float) -> None:
        if not math.isfinite(value):
            return
        self.metrics.append({"name": name, "value": value, "step": self.step, "timestamp": self.timestamp})


def collect(
    state: SystemMetricsState,
    *,
    step: int = 0,
    pid: int | None = None,
    gpu_ids: list[str] | None = None,
    disk_path: str | Path | None = None,
) -> list[Metric]:
    """Return one sample of system metrics; never raises.

    `gpu_ids=None` reads every GPU (narrowed by CUDA_VISIBLE_DEVICES), `[]` skips GPU probing.
    Rates (disk/network) appear from the second sample on, since they need a previous sample.
    """
    builder = MetricBuilder(step)
    psutil = _import_optional("psutil")
    collectors: list[Callable[[], None]] = [
        lambda: _collect_cpu(builder, state, psutil),
        lambda: _collect_memory(builder, psutil),
        lambda: _collect_process_memory(builder, psutil, pid),
        lambda: _collect_disk_usage(builder, disk_path),
        lambda: _collect_disk_io(builder, state, psutil),
        lambda: _collect_network(builder, state, psutil),
        lambda: _collect_gpus(builder, state, gpu_ids),
    ]
    for collector in collectors:
        try:
            collector()
        except Exception:
            # A process can exit or a pseudo-file can vanish mid-read; skip only that group.
            LOGGER.debug("System metric collector failed", exc_info=True)
    return builder.metrics


def _import_optional(name: str) -> ModuleType | None:
    try:
        return importlib.import_module(name)
    except Exception:
        return None


def _rate_values(previous: CounterSample | None, current: CounterSample) -> tuple[float, ...] | None:
    """Per-second differences, or None on the first sample, a clock jump or a counter reset."""
    if previous is None or len(previous.values) != len(current.values):
        return None
    elapsed = current.sampled_at - previous.sampled_at
    if elapsed <= 0:
        return None
    deltas = [now - before for now, before in zip(current.values, previous.values, strict=True)]
    if any(delta < 0 for delta in deltas):
        return None
    return tuple(delta / elapsed for delta in deltas)


def _collect_cpu(builder: MetricBuilder, state: SystemMetricsState, psutil: ModuleType | None) -> None:
    if psutil is None:
        _collect_load_average(builder)
    current = _read_cpu_times(psutil)
    if current is None:
        return
    previous = state.cpu
    if previous is None:
        time.sleep(CPU_FIRST_SAMPLE_SECONDS)
        previous, current = current, _read_cpu_times(psutil)
        if current is None:
            return
    state.cpu = current
    busy = current.values[0] - previous.values[0]
    total = current.values[1] - previous.values[1]
    if total > 0 and busy >= 0:
        builder.add("system.cpu.percent", min(100.0, busy / total * 100))


def _read_cpu_times(psutil: ModuleType | None) -> CounterSample | None:
    """(busy, total) CPU time; iowait counts as idle, guest time is already inside user time."""
    if psutil is not None:
        times = psutil.cpu_times()
        idle = times.idle + getattr(times, "iowait", 0.0)
        total = sum(times) - getattr(times, "guest", 0.0) - getattr(times, "guest_nice", 0.0)
        return CounterSample((total - idle, total), time.time())
    try:
        first_line = (PROC_ROOT / "stat").read_text().splitlines()[0]
    except (OSError, IndexError):
        return None
    fields = first_line.split()
    if not fields or fields[0] != "cpu":
        return None
    # user nice system idle iowait irq softirq steal; guest columns are included in user/nice.
    values = [float(value) for value in fields[1:9]]
    if len(values) < 4:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0.0)
    total = sum(values)
    return CounterSample((total - idle, total), time.time())


def _collect_load_average(builder: MetricBuilder) -> None:
    # Kept for continuity with history recorded by workers without psutil.
    try:
        builder.add("system.cpu.load1", os.getloadavg()[0])
    except (OSError, AttributeError):
        pass


def _collect_memory(builder: MetricBuilder, psutil: ModuleType | None) -> None:
    if psutil is not None:
        memory = psutil.virtual_memory()
        builder.add("system.memory.used_bytes", float(memory.used))
        builder.add("system.memory.percent", float(memory.percent))
        return
    memory_fields: dict[str, float] = {}
    for line in (PROC_ROOT / "meminfo").read_text().splitlines():
        name, value = line.split(":", 1)
        memory_fields[name] = float(value.strip().split()[0]) * 1024
    used = memory_fields["MemTotal"] - memory_fields["MemAvailable"]
    builder.add("system.memory.used_bytes", used)
    builder.add("system.memory.percent", used / memory_fields["MemTotal"] * 100)


def _collect_process_memory(builder: MetricBuilder, psutil: ModuleType | None, pid: int | None) -> None:
    """Resident memory of `pid` and all of its descendants."""
    if not pid:
        return
    if psutil is not None:
        process = psutil.Process(pid)
        processes = [process, *process.children(recursive=True)]
        total = 0
        for member in processes:
            try:
                total += member.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        builder.add("system.process.memory_bytes", float(total))
        return
    total_bytes = sum(_proc_resident_bytes(member) for member in _proc_process_tree(pid))
    if total_bytes:
        builder.add("system.process.memory_bytes", float(total_bytes))


def _proc_process_tree(pid: int) -> list[int]:
    pending, seen = [pid], []
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.append(current)
        for children_file in (PROC_ROOT / str(current) / "task").glob("*/children"):
            try:
                pending.extend(int(child) for child in children_file.read_text().split())
            except (OSError, ValueError):
                continue
    return seen


def _proc_resident_bytes(pid: int) -> int:
    try:
        for line in (PROC_ROOT / str(pid) / "status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def _collect_disk_usage(builder: MetricBuilder, disk_path: str | Path | None) -> None:
    usage = shutil.disk_usage(disk_path if disk_path is not None else os.getcwd())
    builder.add("system.disk.used_bytes", float(usage.used))
    if usage.total > 0:
        builder.add("system.disk.percent", usage.used / usage.total * 100)


def _collect_disk_io(builder: MetricBuilder, state: SystemMetricsState, psutil: ModuleType | None) -> None:
    current = _read_disk_io(psutil)
    if current is None:
        return
    rates = _rate_values(state.disk_io, current)
    state.disk_io = current
    if rates is None:
        return
    builder.add("system.disk.read_bytes_per_second", rates[0])
    builder.add("system.disk.write_bytes_per_second", rates[1])


def _read_disk_io(psutil: ModuleType | None) -> CounterSample | None:
    if psutil is not None:
        counters = psutil.disk_io_counters()
        if counters is None:
            return None
        return CounterSample((float(counters.read_bytes), float(counters.write_bytes)), time.time())
    read_bytes = write_bytes = 0.0
    for line in (PROC_ROOT / "diskstats").read_text().splitlines():
        fields = line.split()
        if len(fields) < 10 or not _is_physical_disk(fields[2]):
            continue
        read_bytes += float(fields[5]) * DISKSTATS_SECTOR_BYTES
        write_bytes += float(fields[9]) * DISKSTATS_SECTOR_BYTES
    return CounterSample((read_bytes, write_bytes), time.time())


def _is_physical_disk(name: str) -> bool:
    # Partitions have no /sys/block entry, so counting only these avoids double counting.
    return not name.startswith(AGGREGATE_DISK_PREFIXES) and (SYS_BLOCK_ROOT / name).exists()


def _collect_network(builder: MetricBuilder, state: SystemMetricsState, psutil: ModuleType | None) -> None:
    current = _read_network(psutil)
    if current is None:
        return
    rates = _rate_values(state.network, current)
    state.network = current
    if rates is None:
        return
    builder.add("system.network.sent_bytes_per_second", rates[0])
    builder.add("system.network.received_bytes_per_second", rates[1])


def _read_network(psutil: ModuleType | None) -> CounterSample | None:
    """Bytes sent/received over every interface except loopback (local traffic is not network I/O)."""
    sent = received = 0.0
    if psutil is not None:
        for name, counters in psutil.net_io_counters(pernic=True).items():
            if not _is_loopback(name):
                sent += counters.bytes_sent
                received += counters.bytes_recv
        return CounterSample((sent, received), time.time())
    for line in (PROC_ROOT / "net" / "dev").read_text().splitlines()[2:]:
        name, _, values = line.partition(":")
        fields = values.split()
        if len(fields) < 9 or _is_loopback(name.strip()):
            continue
        received += float(fields[0])
        sent += float(fields[8])
    return CounterSample((sent, received), time.time())


def _is_loopback(interface_name: str) -> bool:
    return interface_name == "lo" or interface_name.startswith("lo0")


@dataclass(frozen=True)
class GpuReading:
    index: str
    uuid: str
    utilization_percent: float | None = None
    memory_used_bytes: float | None = None
    memory_total_bytes: float | None = None
    temperature_celsius: float | None = None
    power_watts: float | None = None


def _collect_gpus(builder: MetricBuilder, state: SystemMetricsState, gpu_ids: list[str] | None) -> None:
    selected = _selected_gpu_ids(gpu_ids)
    if selected is not None and not selected:
        return
    readings = _read_gpus(state)
    for reading in readings:
        if selected is not None and not ({reading.index, reading.uuid} & selected):
            continue
        prefix = f"system.gpu.{reading.index}"
        for name in (
            "utilization_percent",
            "memory_used_bytes",
            "memory_total_bytes",
            "temperature_celsius",
            "power_watts",
        ):
            value = getattr(reading, name)
            if value is not None:
                builder.add(f"{prefix}.{name}", value)


def _selected_gpu_ids(gpu_ids: list[str] | None) -> set[str] | None:
    """GPU indexes/UUIDs to report; None means every GPU."""
    if gpu_ids is not None:
        return {gpu_id.strip() for gpu_id in gpu_ids}
    visible = os.environ.get("CUDA_VISIBLE_DEVICES")
    if visible is None:
        return None
    if visible.strip() in CUDA_NO_DEVICE_VALUES:
        return set()
    return {device.strip() for device in visible.split(",") if device.strip()}


def _read_gpus(state: SystemMetricsState) -> list[GpuReading]:
    """NVML first, then nvidia-smi; a backend that fails is not retried in this state."""
    for backend, reader in (("nvml", _read_gpus_nvml), ("nvidia-smi", _read_gpus_nvidia_smi)):
        if backend in state.unavailable_gpu_backends:
            continue
        try:
            return reader(state)
        except GpuBackendUnavailable as error:
            state.unavailable_gpu_backends.add(backend)
            LOGGER.debug("GPU metrics via %s are unavailable: %s", backend, error)
        except TransientGpuReadError as error:
            LOGGER.debug("GPU metrics via %s were skipped for this sample: %s", backend, error)
            return []
    return []


class GpuBackendUnavailable(Exception):
    """The backend cannot work in this environment; fall through to the next one."""


class TransientGpuReadError(Exception):
    """The backend exists but this one sample failed (for example a timeout)."""


def _read_gpus_nvml(state: SystemMetricsState) -> list[GpuReading]:
    if state.nvml is None:
        nvml = _import_optional("pynvml")
        if nvml is None:
            raise GpuBackendUnavailable("pynvml (nvidia-ml-py) is not installed")
        try:
            nvml.nvmlInit()
        except Exception as error:
            raise GpuBackendUnavailable(f"nvmlInit failed: {error}") from None
        state.nvml = nvml
    nvml = state.nvml
    try:
        readings = []
        for index in range(nvml.nvmlDeviceGetCount()):
            handle = nvml.nvmlDeviceGetHandleByIndex(index)
            readings.append(_read_nvml_device(nvml, handle, index))
        return readings
    except Exception as error:
        state.close()
        raise GpuBackendUnavailable(f"NVML device query failed: {error}") from None


def _read_nvml_device(nvml: ModuleType, handle: object, index: int) -> GpuReading:
    uuid = _decode(nvml.nvmlDeviceGetUUID(handle))
    utilization = _optional_nvml(lambda: float(nvml.nvmlDeviceGetUtilizationRates(handle).gpu))
    memory = _optional_nvml(lambda: nvml.nvmlDeviceGetMemoryInfo(handle))
    temperature = _optional_nvml(
        lambda: float(nvml.nvmlDeviceGetTemperature(handle, nvml.NVML_TEMPERATURE_GPU))
    )
    power_milliwatts = _optional_nvml(lambda: float(nvml.nvmlDeviceGetPowerUsage(handle)))
    return GpuReading(
        index=str(index),
        uuid=uuid,
        utilization_percent=utilization,
        memory_used_bytes=float(memory.used) if memory is not None else None,
        memory_total_bytes=float(memory.total) if memory is not None else None,
        temperature_celsius=temperature,
        power_watts=power_milliwatts / 1000 if power_milliwatts is not None else None,
    )


def _optional_nvml(read: Callable[[], Any]) -> Any:
    # Consumer GPUs and MIG devices report NVML_ERROR_NOT_SUPPORTED for some fields.
    try:
        return read()
    except Exception:
        return None


def _decode(value: object) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _read_gpus_nvidia_smi(_state: SystemMetricsState) -> list[GpuReading]:
    try:
        output = subprocess.check_output(
            ["nvidia-smi", f"--query-gpu={NVIDIA_SMI_QUERY}", "--format=csv,noheader,nounits"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=NVIDIA_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        raise GpuBackendUnavailable("nvidia-smi is not on PATH") from None
    except subprocess.TimeoutExpired:
        raise TransientGpuReadError("nvidia-smi timed out") from None
    except (OSError, subprocess.SubprocessError) as error:
        raise TransientGpuReadError(str(error)) from None
    return list(_parse_nvidia_smi_rows(csv.reader(io.StringIO(output))))


def _parse_nvidia_smi_rows(rows: Iterable[list[str]]) -> Iterable[GpuReading]:
    for row in rows:
        values = [value.strip() for value in row]
        # Older drivers or callers may omit power.draw; its column is optional.
        if len(values) not in (6, 7):
            continue
        yield GpuReading(
            index=values[0],
            uuid=values[1],
            utilization_percent=_parse_number(values[2]),
            memory_used_bytes=_scaled(_parse_number(values[3]), MEBIBYTE),
            memory_total_bytes=_scaled(_parse_number(values[4]), MEBIBYTE),
            temperature_celsius=_parse_number(values[5]),
            power_watts=_parse_number(values[6]) if len(values) == 7 else None,
        )


def _parse_number(raw_value: str) -> float | None:
    # nvidia-smi prints "[N/A]" or "[Not Supported]" for fields the device cannot report.
    try:
        return float(raw_value)
    except ValueError:
        return None


def _scaled(value: float | None, scale: int) -> float | None:
    return value * scale if value is not None else None


class SystemMetricsMonitor:
    """Samples system metrics on a daemon thread and hands each sample to `sink`.

    Steps count up from 0 like worker telemetry. A failing sink is logged and counted; sampling
    continues so a temporary upload error does not end monitoring for the rest of the run.
    """

    def __init__(
        self,
        sink: MetricSink,
        *,
        interval_seconds: float = DEFAULT_SYSTEM_METRICS_SECONDS,
        pid: int | None = None,
        gpu_ids: list[str] | None = None,
        disk_path: str | Path | None = None,
    ):
        if not math.isfinite(interval_seconds) or interval_seconds < MIN_SYSTEM_METRICS_SECONDS:
            raise ValueError(f"interval_seconds must be at least {MIN_SYSTEM_METRICS_SECONDS}")
        self.sink = sink
        self.interval_seconds = interval_seconds
        self.pid = pid
        self.gpu_ids = gpu_ids
        self.disk_path = disk_path
        self.sink_failures = 0
        self._state = SystemMetricsState()
        self._stop_requested = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("System metrics monitor was already started")
        self._thread = threading.Thread(target=self._run, name="mado-tracking-system-metrics", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop sampling and wait for the thread; no extra sample is sent after this call."""
        self._stop_requested.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join()

    def _run(self) -> None:
        step = 0
        try:
            while not self._stop_requested.is_set():
                metrics = collect(
                    self._state, step=step, pid=self.pid, gpu_ids=self.gpu_ids, disk_path=self.disk_path
                )
                if self._stop_requested.is_set():
                    break
                if metrics:
                    self._send(metrics)
                step += 1
                self._stop_requested.wait(self.interval_seconds)
        finally:
            self._state.close()

    def _send(self, metrics: list[Metric]) -> None:
        try:
            self.sink(metrics)
        except Exception:
            self.sink_failures += 1
            LOGGER.warning(
                "System metrics sink failed (%d failures so far)", self.sink_failures, exc_info=True
            )
