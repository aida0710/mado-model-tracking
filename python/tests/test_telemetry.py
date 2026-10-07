from __future__ import annotations

import os

from mado_tracking.worker.telemetry import collect_system_metrics


def test_selected_gpu_metrics_are_real_numeric_values_and_cpu_memory_are_present(monkeypatch):
    monkeypatch.setattr(
        "mado_tracking.worker.telemetry.subprocess.check_output",
        lambda *_args, **_kwargs: "0, GPU-zero, 40, 512, 1024, 62\n1, GPU-one, 80, 900, 1024, 70\n",
    )
    metrics = collect_system_metrics(pid=os.getpid(), gpu_ids=["GPU-one"], step=7)
    assert any(point["name"] == "system.memory.used_bytes" and point["value"] > 0 for point in metrics)
    assert any(point["name"].startswith("system.cpu.") for point in metrics)
    gpu_metrics = {
        point["name"]: point["value"] for point in metrics if point["name"].startswith("system.gpu.")
    }
    assert gpu_metrics["system.gpu.1.utilization_percent"] == 80
    assert gpu_metrics["system.gpu.1.memory_used_bytes"] == 900 * 1024**2
    assert not any(name.startswith("system.gpu.0") for name in gpu_metrics)
    assert all(point["step"] == 7 and point["timestamp"].endswith("Z") for point in metrics)


def test_no_gpu_job_does_not_invoke_nvidia_smi(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("CPU job must not probe GPUs")

    monkeypatch.setattr("mado_tracking.worker.telemetry.subprocess.check_output", forbidden)
    assert collect_system_metrics(pid=0, gpu_ids=[], step=0)
