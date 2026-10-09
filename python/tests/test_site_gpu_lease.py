"""GPU leasing on hosts without a scheduler: free GPUs, live leases and Mado containers."""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

from mado_tracking.errors import ConfigurationError
from mado_tracking.site.gpu_lease import (
    GpuDevice,
    GpuLeaseError,
    GpuLeases,
    choose_gpus,
    parse_container_devices,
    parse_gpu_listing,
)

DEVICES = [
    GpuDevice("0", "GPU-aaa"),
    GpuDevice("1", "GPU-bbb"),
    GpuDevice("2", "GPU-ccc"),
    GpuDevice("10", "GPU-ddd"),
]


def test_the_gpu_listing_and_container_devices_are_parsed():
    assert parse_gpu_listing("0, GPU-aaa\n1, GPU-bbb\n\n") == DEVICES[:2]
    with pytest.raises(GpuLeaseError):
        parse_gpu_listing("No devices were found\n")
    held = parse_container_devices(
        '"running"\t[{"Driver":"","DeviceIDs":["1"]}]\n'
        '"exited"\t[{"DeviceIDs":["0"]}]\n'
        '"created"\t[{"DeviceIDs":["GPU-ccc"]}]\n'
        '"running"\tnull\n'
    )
    assert held == {"1", "GPU-ccc"}


def test_free_gpus_are_chosen_lowest_index_first_among_the_candidates():
    assert choose_gpus(DEVICES, busy=set(), count=2) == ["0", "1"]
    assert choose_gpus(DEVICES, busy={"1", "GPU-aaa"}, count=2) == ["2", "10"]
    assert choose_gpus(DEVICES, busy={"0"}, count=2, candidates=("0", "GPU-bbb")) is None
    assert choose_gpus(DEVICES, busy=set(), count=1, candidates=("GPU-ddd",)) == ["10"]
    assert choose_gpus(DEVICES, busy={"0", "1", "2"}, count=2) is None


class Host:
    def __init__(self, listing: str, containers: str = ""):
        self.listing = listing
        self.containers = containers

    def __call__(self, argv: list[str]) -> str:
        if argv[0] == "nvidia-smi":
            return self.listing
        if argv[1:3] == ["container", "ls"]:
            return "c1\n" if self.containers else ""
        return self.containers


def leases(tmp_path, host: Host, job_id: str, *, pid: int | None = None) -> GpuLeases:
    return GpuLeases(
        tmp_path,
        hostname="gpu-1",
        job_id=job_id,
        pid=pid or os.getpid(),
        run_command=host,
        docker_binary="docker",
    )


def test_live_leases_and_mado_containers_keep_gpus_busy_until_released(tmp_path):
    host = Host("0, GPU-aaa\n1, GPU-bbb\n2, GPU-ccc\n", containers='"running"\t[{"DeviceIDs":["2"]}]\n')
    first, second, third = (leases(tmp_path, host, f"job-{name}") for name in "abc")
    assert first.try_acquire(1) == ["0"]
    # GPU 2 is held by a container that outlived its runner.
    assert second.try_acquire(1) == ["1"]
    assert third.try_acquire(1) is None
    first.release()
    assert third.try_acquire(1) == ["0"]
    assert sorted(path.name for path in (tmp_path / ".mmt-cache/gpu-leases/gpu-1").glob("*.json")) == [
        "0.json",
        "1.json",
    ]


def test_a_lease_whose_runner_died_is_reclaimed(tmp_path):
    finished = subprocess.run(
        [sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True, check=True
    )
    host = Host("0, GPU-aaa\n")
    crashed = leases(tmp_path, host, "job-crashed", pid=int(finished.stdout))
    assert crashed.try_acquire(1) == ["0"]
    assert leases(tmp_path, host, "job-next").try_acquire(1) == ["0"]


def test_a_job_asking_more_gpus_than_the_host_has_fails_at_once(tmp_path):
    with pytest.raises(ConfigurationError, match="can never start"):
        leases(tmp_path, Host("0, GPU-aaa\n"), "job").try_acquire(2)
