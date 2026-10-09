"""Pick free GPUs on a host without a scheduler (gpu_assignment = "lease", Docker GPU servers).

One runner at a time chooses, under a host-wide lock. A GPU is busy while another live runner
leases it, or while a Docker container of a Mado Job holds it: containers outlive a runner that
crashed, so the lease files alone could hand the same GPU out twice.

    <work dir>/.mmt-cache/gpu-leases/<hostname>/lock
    <work dir>/.mmt-cache/gpu-leases/<hostname>/<index>.json   {"jobId", "pid", "identity"}
"""

from __future__ import annotations

import fcntl
import json
import shutil
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..errors import ConfigurationError
from ..worker.container_layout import host_environment
from ..worker.dataset_cache import CACHE_DIRECTORY
from ..worker.docker_container import JOB_ID_LABEL
from ..worker.host_state import is_same_process, process_identity, read_json, write_json

GPU_LISTING_ARGV = ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"]
LEASE_DIRECTORY = "gpu-leases"
LOCK_FILENAME = "lock"
# Docker states in which a container keeps (or is about to get) its GPUs.
HOLDING_CONTAINER_STATES = {"created", "running", "paused", "restarting", "removing"}
CONTAINER_DEVICES_FORMAT = "{{json .State.Status}}\t{{json .HostConfig.DeviceRequests}}"
HOST_COMMAND_TIMEOUT_SECONDS = 30.0

CommandRunner = Callable[[list[str]], str]


class GpuLeaseError(RuntimeError):
    """The host's GPUs or containers could not be listed, so no GPU can be proven free."""


@dataclass(frozen=True)
class GpuDevice:
    index: str
    uuid: str


def parse_gpu_listing(text: str) -> list[GpuDevice]:
    """`nvidia-smi --query-gpu=index,uuid --format=csv,noheader` lines: `0, GPU-...`."""
    devices = []
    for line in text.splitlines():
        if not line.strip():
            continue
        index, _separator, uuid = (part.strip() for part in line.partition(","))
        if not index.isdigit() or not uuid:
            raise GpuLeaseError(f"Unexpected nvidia-smi line: {line!r}")
        devices.append(GpuDevice(index, uuid))
    return devices


def parse_container_devices(text: str) -> set[str]:
    """GPU indexes and UUIDs held by containers, from CONTAINER_DEVICES_FORMAT lines."""
    held: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        raw_status, _separator, raw_requests = line.partition("\t")
        try:
            status, requests = json.loads(raw_status), json.loads(raw_requests or "null")
        except ValueError:
            raise GpuLeaseError("Docker returned unreadable container devices") from None
        if status not in HOLDING_CONTAINER_STATES:
            continue
        for request in requests or []:
            held.update(str(device) for device in (request or {}).get("DeviceIDs") or [])
    return held


def choose_gpus(
    devices: Sequence[GpuDevice], *, busy: set[str], count: int, candidates: Sequence[str] = ()
) -> list[str] | None:
    """The `count` lowest free GPU indexes among the candidates, or None when too few are free."""
    allowed = [
        device
        for device in devices
        if not candidates or device.index in candidates or device.uuid in candidates
    ]
    free = [device for device in allowed if device.index not in busy and device.uuid not in busy]
    if len(free) < count:
        return None
    return [device.index for device in sorted(free, key=lambda device: int(device.index))[:count]]


def run_host_command(argv: list[str]) -> str:
    try:
        completed = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            env=host_environment(),
            timeout=HOST_COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise GpuLeaseError(f"{argv[0]} could not be run") from None
    if completed.returncode:
        raise GpuLeaseError(f"{argv[0]} exited with status {completed.returncode}")
    return completed.stdout.decode("utf-8", "replace")


class GpuLeases:
    def __init__(
        self,
        work_directory: Path,
        *,
        hostname: str,
        job_id: str,
        pid: int,
        run_command: CommandRunner = run_host_command,
        docker_binary: str | None = None,
    ):
        self.directory = work_directory / CACHE_DIRECTORY.parent / LEASE_DIRECTORY / hostname
        self.job_id = job_id
        self.pid = pid
        self.run_command = run_command
        self.docker_binary = docker_binary if docker_binary is not None else shutil.which("docker")
        self.leased: list[str] = []

    def devices(self) -> list[GpuDevice]:
        return parse_gpu_listing(self.run_command(GPU_LISTING_ARGV))

    def container_devices(self) -> set[str]:
        if self.docker_binary is None:
            return set()
        identifiers = self.run_command(
            [self.docker_binary, "container", "ls", "--all", "--quiet", "--filter", f"label={JOB_ID_LABEL}"]
        ).split()
        if not identifiers:
            return set()
        return parse_container_devices(
            self.run_command(
                [
                    self.docker_binary,
                    "container",
                    "inspect",
                    "--format",
                    CONTAINER_DEVICES_FORMAT,
                    *identifiers,
                ]
            )
        )

    def leased_by_others(self) -> set[str]:
        busy = set()
        for path in self.directory.glob("*.json"):
            try:
                lease = read_json(path)
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                continue
            owner_alive = is_same_process(int(lease.get("pid", 0)), lease.get("identity"))
            if lease.get("jobId") == self.job_id or not owner_alive:
                # Our own earlier lease, or one whose runner is gone (its container is checked apart).
                path.unlink(missing_ok=True)
                continue
            busy.add(path.stem)
        return busy

    def try_acquire(self, count: int, candidates: Sequence[str] = ()) -> list[str] | None:
        """Lease `count` free GPUs, or return None when they are not free yet."""
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.directory / LOCK_FILENAME).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            devices = self.devices()
            allowed = [d for d in devices if not candidates or d.index in candidates or d.uuid in candidates]
            if len(allowed) < count:
                raise ConfigurationError(
                    f"The Job needs {count} GPUs but this host offers {len(allowed)}; it can never start here"
                )
            busy = self.leased_by_others() | self.container_devices()
            chosen = choose_gpus(devices, busy=busy, count=count, candidates=candidates)
            if chosen is None:
                return None
            identity = process_identity(self.pid)
            for index in chosen:
                write_json(
                    self.directory / f"{index}.json",
                    {"jobId": self.job_id, "pid": self.pid, "identity": identity},
                )
            self.leased = chosen
            return chosen

    def release(self) -> None:
        if not self.leased:
            return
        with (self.directory / LOCK_FILENAME).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for index in self.leased:
                path = self.directory / f"{index}.json"
                try:
                    if read_json(path).get("jobId") == self.job_id:
                        path.unlink(missing_ok=True)
                except (OSError, ValueError):
                    continue
        self.leased = []
