from __future__ import annotations

import importlib
import io
import os
import subprocess
import sys
import zipfile

from mado_tracking.worker.runtime import build_runtime_bundle
from mado_tracking.worker.telemetry import collect_system_metrics

REAL_IMPORT_MODULE = importlib.import_module


def test_selected_gpu_metrics_are_real_numeric_values_and_cpu_memory_are_present(monkeypatch):
    monkeypatch.setitem(sys.modules, "pynvml", None)
    monkeypatch.setattr(
        "mado_tracking.system_metrics.subprocess.check_output",
        lambda *_args, **_kwargs: "0, GPU-zero, 40, 512, 1024, 62\n1, GPU-one, 80, 900, 1024, 70\n",
    )
    metrics = collect_system_metrics(pid=os.getpid(), gpu_ids=["GPU-one"], step=7)
    assert any(point["name"] == "system.memory.used_bytes" and point["value"] > 0 for point in metrics)
    assert any(point["name"].startswith("system.cpu.") for point in metrics)
    assert any(point["name"] == "system.process.memory_bytes" and point["value"] > 0 for point in metrics)
    gpu_metrics = {
        point["name"]: point["value"] for point in metrics if point["name"].startswith("system.gpu.")
    }
    assert gpu_metrics["system.gpu.1.utilization_percent"] == 80
    assert gpu_metrics["system.gpu.1.memory_used_bytes"] == 900 * 1024**2
    assert gpu_metrics["system.gpu.1.memory_total_bytes"] == 1024 * 1024**2
    assert gpu_metrics["system.gpu.1.temperature_celsius"] == 70
    assert not any(name.startswith("system.gpu.0") for name in gpu_metrics)
    assert all(point["step"] == 7 and point["timestamp"].endswith("Z") for point in metrics)


def test_no_gpu_job_does_not_invoke_nvidia_smi(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("CPU job must not probe GPUs")

    monkeypatch.setattr("mado_tracking.system_metrics.subprocess.check_output", forbidden)
    monkeypatch.setattr("mado_tracking.system_metrics.importlib.import_module", _forbid_pynvml)
    assert collect_system_metrics(pid=0, gpu_ids=[], step=0)


def _forbid_pynvml(name: str):
    if name == "pynvml":
        raise AssertionError("CPU job must not load NVML")
    return REAL_IMPORT_MODULE(name)


def test_state_file_lets_separate_polls_report_network_and_disk_rates(tmp_path):
    state_path = tmp_path / "telemetry-state.json"
    first = {
        point["name"] for point in collect_system_metrics(pid=0, gpu_ids=[], step=0, state_path=state_path)
    }
    assert not any(name.startswith("system.network.") for name in first)
    assert state_path.stat().st_mode & 0o777 == 0o600
    second = {
        point["name"] for point in collect_system_metrics(pid=0, gpu_ids=[], step=1, state_path=state_path)
    }
    assert "system.network.sent_bytes_per_second" in second


def test_corrupt_state_file_is_ignored(tmp_path):
    state_path = tmp_path / "telemetry-state.json"
    state_path.write_text("{not json")
    assert collect_system_metrics(pid=0, gpu_ids=[], step=0, state_path=state_path)


def test_remote_runtime_bundle_imports_telemetry_with_the_shared_collector(tmp_path):
    with zipfile.ZipFile(io.BytesIO(build_runtime_bundle())) as archive:
        names = set(archive.namelist())
        assert {"runtime/system_metrics.py", "runtime/telemetry.py", "runtime/timestamps.py"} <= names
        archive.extractall(tmp_path)
    probe = (
        "from runtime.telemetry import collect_system_metrics;"
        "import json;print(json.dumps(collect_system_metrics(pid=0, gpu_ids=[], step=3)))"
    )
    output = subprocess.check_output(
        [sys.executable, "-I", "-c", f"import sys;sys.path.insert(0, {str(tmp_path)!r});{probe}"]
    )
    assert b'"system.memory.used_bytes"' in output
