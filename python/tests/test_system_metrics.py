from __future__ import annotations

import subprocess
import sys
import threading
import types
from collections import namedtuple
from pathlib import Path

import pytest

from mado_tracking import system_metrics
from mado_tracking.system_metrics import (
    SystemMetricsMonitor,
    SystemMetricsState,
    collect,
)

CpuTimes = namedtuple("CpuTimes", "user nice system idle iowait irq softirq steal guest guest_nice")
NetCounters = namedtuple("NetCounters", "bytes_sent bytes_recv")
DiskCounters = namedtuple("DiskCounters", "read_bytes write_bytes")
Memory = namedtuple("Memory", "used percent")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(system_metrics.time, "time", fake.time)
    monkeypatch.setattr(system_metrics.time, "sleep", fake.sleep)
    return fake


def install_fake_psutil(monkeypatch, counters: dict[str, float]):
    """psutil whose counters are read from `counters`, so tests advance them explicitly."""
    psutil = types.ModuleType("psutil")

    class NoSuchProcess(Exception):
        pass

    def cpu_times():
        busy = counters["cpu_busy"]
        return CpuTimes(busy, 0.0, 0.0, counters["cpu_idle"], 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    psutil.NoSuchProcess = NoSuchProcess
    psutil.AccessDenied = PermissionError
    psutil.cpu_times = cpu_times
    psutil.virtual_memory = lambda: Memory(4096.0, 25.0)
    psutil.disk_io_counters = lambda: DiskCounters(counters["disk_read"], counters["disk_write"])
    psutil.net_io_counters = lambda pernic: {
        "lo": NetCounters(10**9, 10**9),
        "eth0": NetCounters(counters["net_sent"], counters["net_received"]),
    }
    monkeypatch.setitem(sys.modules, "psutil", psutil)
    return psutil


def remove_module(monkeypatch, name: str) -> None:
    # A None entry in sys.modules makes `import name` raise ImportError.
    monkeypatch.setitem(sys.modules, name, None)


def fake_nvml(*, fail_init: bool = False, fail_query: bool = False, device_count: int = 2):
    nvml = types.ModuleType("pynvml")
    nvml.NVML_TEMPERATURE_GPU = 0
    nvml.shutdowns = 0

    def init():
        if fail_init:
            raise RuntimeError("NVML Shared Library Not Found")

    def device_count_or_fail():
        if fail_query:
            raise RuntimeError("Unknown Error")
        return device_count

    def shutdown():
        nvml.shutdowns += 1

    def power_usage(handle):
        raise RuntimeError("Not Supported")

    nvml.nvmlInit = init
    nvml.nvmlShutdown = shutdown
    nvml.nvmlDeviceGetCount = device_count_or_fail
    nvml.nvmlDeviceGetHandleByIndex = lambda index: index
    nvml.nvmlDeviceGetUUID = lambda handle: f"GPU-nvml-{handle}".encode()
    nvml.nvmlDeviceGetUtilizationRates = lambda handle: types.SimpleNamespace(gpu=30 + handle)
    nvml.nvmlDeviceGetMemoryInfo = lambda handle: types.SimpleNamespace(used=2 * 1024**3, total=8 * 1024**3)
    nvml.nvmlDeviceGetTemperature = lambda handle, sensor: 55
    nvml.nvmlDeviceGetPowerUsage = power_usage
    return nvml


NVIDIA_SMI_OUTPUT = "0, GPU-zero, 40, 512, 1024, 62, 120.5\n1, GPU-one, 80, 900, 1024, 70, [N/A]\n"


def fake_nvidia_smi(monkeypatch, output: str = NVIDIA_SMI_OUTPUT) -> list[list[str]]:
    calls: list[list[str]] = []

    def check_output(command, **_kwargs):
        calls.append(command)
        return output

    monkeypatch.setattr(system_metrics.subprocess, "check_output", check_output)
    return calls


def missing_nvidia_smi(monkeypatch) -> None:
    def check_output(*_args, **_kwargs):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(system_metrics.subprocess, "check_output", check_output)


def by_name(metrics):
    return {point["name"]: point["value"] for point in metrics}


def base_counters() -> dict[str, float]:
    return {
        "cpu_busy": 100.0,
        "cpu_idle": 900.0,
        "disk_read": 0.0,
        "disk_write": 0.0,
        "net_sent": 0.0,
        "net_received": 0.0,
    }


def test_psutil_metrics_use_worker_names_and_rates_start_from_the_second_sample(monkeypatch, clock, tmp_path):
    counters = base_counters()
    install_fake_psutil(monkeypatch, counters)
    remove_module(monkeypatch, "pynvml")
    missing_nvidia_smi(monkeypatch)
    state = SystemMetricsState()

    first = by_name(collect(state, step=0, disk_path=tmp_path))
    assert first["system.memory.used_bytes"] == 4096.0
    assert first["system.memory.percent"] == 25.0
    assert "system.disk.used_bytes" in first and 0 <= first["system.disk.percent"] <= 100
    assert not any(
        name.startswith(("system.network.", "system.disk.read", "system.disk.write")) for name in first
    )
    assert not any(name.startswith("system.gpu.") for name in first)

    clock.now += 10
    counters.update(cpu_busy=160.0, cpu_idle=940.0, disk_read=1000.0, disk_write=500.0)
    counters.update(net_sent=2000.0, net_received=4000.0)
    second = by_name(collect(state, step=1, disk_path=tmp_path))
    assert second["system.cpu.percent"] == pytest.approx(60.0)
    assert second["system.disk.read_bytes_per_second"] == 100.0
    assert second["system.disk.write_bytes_per_second"] == 50.0
    # Loopback traffic is excluded from network throughput.
    assert second["system.network.sent_bytes_per_second"] == 200.0
    assert second["system.network.received_bytes_per_second"] == 400.0


def test_counter_reset_skips_rates_instead_of_reporting_negative_throughput(monkeypatch, clock, tmp_path):
    counters = base_counters()
    counters["net_sent"] = 5000.0
    install_fake_psutil(monkeypatch, counters)
    state = SystemMetricsState()
    collect(state, gpu_ids=[], disk_path=tmp_path)
    clock.now += 5
    counters["net_sent"] = 10.0
    assert "system.network.sent_bytes_per_second" not in by_name(
        collect(state, gpu_ids=[], disk_path=tmp_path)
    )


def test_nvml_is_preferred_and_unsupported_fields_are_omitted(monkeypatch, clock, tmp_path):
    install_fake_psutil(monkeypatch, base_counters())
    monkeypatch.setitem(sys.modules, "pynvml", fake_nvml())
    nvidia_smi_calls = fake_nvidia_smi(monkeypatch)
    metrics = by_name(collect(SystemMetricsState(), gpu_ids=None, disk_path=tmp_path))
    assert metrics["system.gpu.0.utilization_percent"] == 30
    assert metrics["system.gpu.1.utilization_percent"] == 31
    assert metrics["system.gpu.1.memory_used_bytes"] == 2 * 1024**3
    assert metrics["system.gpu.1.memory_total_bytes"] == 8 * 1024**3
    assert metrics["system.gpu.1.temperature_celsius"] == 55
    assert "system.gpu.0.power_watts" not in metrics
    assert nvidia_smi_calls == []


@pytest.mark.parametrize("failure", ["init", "query"])
def test_nvml_failure_falls_back_to_nvidia_smi(monkeypatch, clock, tmp_path, failure):
    install_fake_psutil(monkeypatch, base_counters())
    monkeypatch.setitem(
        sys.modules, "pynvml", fake_nvml(fail_init=failure == "init", fail_query=failure == "query")
    )
    nvidia_smi_calls = fake_nvidia_smi(monkeypatch)
    state = SystemMetricsState()
    metrics = by_name(collect(state, gpu_ids=None, disk_path=tmp_path))
    assert metrics["system.gpu.0.power_watts"] == 120.5
    assert metrics["system.gpu.1.memory_used_bytes"] == 900 * 1024**2
    assert "system.gpu.1.power_watts" not in metrics
    assert len(nvidia_smi_calls) == 1
    # The failed backend is not retried on the next sample.
    collect(state, gpu_ids=None, disk_path=tmp_path)
    assert "nvml" in state.unavailable_gpu_backends and len(nvidia_smi_calls) == 2


def test_missing_gpu_tooling_still_reports_cpu_memory_and_disk(monkeypatch, clock, tmp_path, caplog):
    install_fake_psutil(monkeypatch, base_counters())
    remove_module(monkeypatch, "pynvml")
    missing_nvidia_smi(monkeypatch)
    state = SystemMetricsState()
    with caplog.at_level("DEBUG", logger="mado_tracking.system_metrics"):
        metrics = by_name(collect(state, gpu_ids=None, disk_path=tmp_path))
        collect(state, gpu_ids=None, disk_path=tmp_path)
    assert {"system.memory.used_bytes", "system.disk.used_bytes"} <= metrics.keys()
    assert not any(name.startswith("system.gpu.") for name in metrics)
    unavailable_logs = [record for record in caplog.records if "unavailable" in record.getMessage()]
    # The reason for each missing backend is logged once, not on every sample.
    assert len(unavailable_logs) == 2


def test_nvidia_smi_timeout_skips_gpus_for_one_sample_only(monkeypatch, clock, tmp_path):
    install_fake_psutil(monkeypatch, base_counters())
    remove_module(monkeypatch, "pynvml")
    responses = [subprocess.TimeoutExpired("nvidia-smi", 3), NVIDIA_SMI_OUTPUT]

    def check_output(*_args, timeout, **_kwargs):
        assert timeout == system_metrics.NVIDIA_TIMEOUT_SECONDS
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(system_metrics.subprocess, "check_output", check_output)
    state = SystemMetricsState()
    assert not any(name.startswith("system.gpu.") for name in by_name(collect(state, disk_path=tmp_path)))
    assert "system.gpu.0.utilization_percent" in by_name(collect(state, disk_path=tmp_path))


@pytest.mark.parametrize(
    ("visible", "expected"),
    [("1", {"1"}), ("GPU-zero", {"0"}), ("0,1", {"0", "1"}), ("", set()), ("-1", set())],
)
def test_cuda_visible_devices_narrows_gpus_when_no_ids_are_given(
    monkeypatch, clock, tmp_path, visible, expected
):
    install_fake_psutil(monkeypatch, base_counters())
    remove_module(monkeypatch, "pynvml")
    fake_nvidia_smi(monkeypatch)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", visible)
    metrics = by_name(collect(SystemMetricsState(), disk_path=tmp_path))
    reported = {name.split(".")[2] for name in metrics if name.startswith("system.gpu.")}
    assert reported == expected


def test_explicit_gpu_ids_take_precedence_and_empty_ids_skip_probing(monkeypatch, clock, tmp_path):
    install_fake_psutil(monkeypatch, base_counters())
    remove_module(monkeypatch, "pynvml")
    calls = fake_nvidia_smi(monkeypatch)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    metrics = by_name(collect(SystemMetricsState(), gpu_ids=["GPU-one"], disk_path=tmp_path))
    assert {name.split(".")[2] for name in metrics if name.startswith("system.gpu.")} == {"1"}
    collect(SystemMetricsState(), gpu_ids=[], disk_path=tmp_path)
    assert len(calls) == 1


def write_fake_proc(root: Path, *, cpu: tuple[int, int], disk_sectors: tuple[int, int], net: tuple[int, int]):
    busy, idle = cpu
    (root / "net").mkdir(parents=True, exist_ok=True)
    (root / "stat").write_text(f"cpu  {busy} 0 0 {idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n")
    (root / "meminfo").write_text("MemTotal:       1000 kB\nMemAvailable:    250 kB\n")
    read_sectors, write_sectors = disk_sectors
    (root / "diskstats").write_text(
        f"   8       0 sda 1 0 {read_sectors} 0 1 0 {write_sectors} 0 0 0 0\n"
        f"   8       1 sda1 1 0 {read_sectors} 0 1 0 {write_sectors} 0 0 0 0\n"
        f"   7       0 loop0 1 0 999999 0 1 0 999999 0 0 0 0\n"
    )
    received, sent = net
    (root / "net" / "dev").write_text(
        "Inter-|   Receive                            |  Transmit\n"
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n"
        "    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n"
        f"  eth0: {received} 1 0 0 0 0 0 0 {sent} 1 0 0 0 0 0 0\n"
    )


def test_proc_fallback_computes_cpu_from_stat_differences_and_counts_whole_disks(
    monkeypatch, clock, tmp_path
):
    remove_module(monkeypatch, "psutil")
    remove_module(monkeypatch, "pynvml")
    missing_nvidia_smi(monkeypatch)
    proc_root = tmp_path / "proc"
    sys_block = tmp_path / "sys-block"
    (sys_block / "sda").mkdir(parents=True)
    (sys_block / "loop0").mkdir()
    monkeypatch.setattr(system_metrics, "PROC_ROOT", proc_root)
    monkeypatch.setattr(system_metrics, "SYS_BLOCK_ROOT", sys_block)
    write_fake_proc(proc_root, cpu=(100, 900), disk_sectors=(0, 0), net=(0, 0))
    state = SystemMetricsState()
    state.cpu = system_metrics._read_cpu_times(None)

    first = by_name(collect(state, disk_path=tmp_path))
    assert first["system.memory.used_bytes"] == 750 * 1024
    assert first["system.memory.percent"] == 75.0
    assert "system.cpu.percent" not in first
    assert not any(name.startswith("system.network.") for name in first)

    clock.now += 4
    write_fake_proc(proc_root, cpu=(130, 970), disk_sectors=(8, 16), net=(800, 400))
    second = by_name(collect(state, disk_path=tmp_path))
    assert second["system.cpu.percent"] == pytest.approx(30.0)
    # Only sda counts: the partition and the loop device would double count.
    assert second["system.disk.read_bytes_per_second"] == 8 * 512 / 4
    assert second["system.disk.write_bytes_per_second"] == 16 * 512 / 4
    assert second["system.network.received_bytes_per_second"] == 200.0
    assert second["system.network.sent_bytes_per_second"] == 100.0


def test_unreadable_proc_and_missing_tools_never_raise(monkeypatch, clock, tmp_path):
    remove_module(monkeypatch, "psutil")
    remove_module(monkeypatch, "pynvml")
    missing_nvidia_smi(monkeypatch)
    monkeypatch.setattr(system_metrics, "PROC_ROOT", tmp_path / "missing")
    metrics = by_name(collect(SystemMetricsState(), pid=12345, disk_path=tmp_path))
    assert "system.disk.used_bytes" in metrics


def test_state_round_trips_through_json_for_runner_processes(monkeypatch, clock, tmp_path):
    counters = base_counters()
    install_fake_psutil(monkeypatch, counters)
    state = SystemMetricsState()
    collect(state, gpu_ids=[], disk_path=tmp_path)
    restored = SystemMetricsState.from_json(state.to_json())
    clock.now += 2
    counters["net_sent"] = 100.0
    assert (
        by_name(collect(restored, gpu_ids=[], disk_path=tmp_path))["system.network.sent_bytes_per_second"]
        == 50
    )
    assert SystemMetricsState.from_json({"cpu": {"values": "bad"}}).cpu is None


def test_monitor_counts_steps_survives_sink_errors_and_stop_waits(monkeypatch, tmp_path):
    install_fake_psutil(monkeypatch, base_counters())
    remove_module(monkeypatch, "pynvml")
    missing_nvidia_smi(monkeypatch)
    monkeypatch.setattr(system_metrics, "CPU_FIRST_SAMPLE_SECONDS", 0)
    monkeypatch.setattr(system_metrics, "MIN_SYSTEM_METRICS_SECONDS", 0.01)
    steps: list[int] = []
    three_samples = threading.Event()

    def sink(metrics):
        steps.append(metrics[0]["step"])
        if len(steps) == 3:
            three_samples.set()
        if len(steps) == 1:
            raise RuntimeError("upload failed")

    monitor = SystemMetricsMonitor(sink, interval_seconds=0.01, disk_path=tmp_path)
    monitor.start()
    assert three_samples.wait(5)
    monitor.stop()
    sent_after_stop = len(steps)
    assert monitor._thread is not None and not monitor._thread.is_alive()
    assert steps[:3] == [0, 1, 2]
    assert monitor.sink_failures == 1
    threading.Event().wait(0.05)
    assert len(steps) == sent_after_stop


def test_monitor_stop_does_not_send_a_sample_collected_during_shutdown(monkeypatch, tmp_path):
    collecting = threading.Event()
    release = threading.Event()

    def slow_collect(*_args, **_kwargs):
        collecting.set()
        release.wait(5)
        return [{"name": "system.cpu.percent", "value": 1.0, "step": 0, "timestamp": "t"}]

    monkeypatch.setattr(system_metrics, "collect", slow_collect)
    sent: list[object] = []
    monitor = SystemMetricsMonitor(sent.append, interval_seconds=1)
    monitor.start()
    assert collecting.wait(5)
    stopper = threading.Thread(target=monitor.stop)
    stopper.start()
    while not monitor._stop_requested.is_set():
        threading.Event().wait(0.001)
    release.set()
    stopper.join(5)
    assert not stopper.is_alive()
    assert sent == []


def test_monitor_rejects_intervals_below_the_minimum():
    with pytest.raises(ValueError):
        SystemMetricsMonitor(lambda _metrics: None, interval_seconds=0.5)
    with pytest.raises(ValueError):
        SystemMetricsMonitor(lambda _metrics: None, interval_seconds=float("nan"))
