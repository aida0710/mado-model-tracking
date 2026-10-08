"""Connection checks: the fixed probe, its parsing into TargetCheckResult, and the worker loop."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from collections.abc import Callable, Iterator, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from mado_tracking.errors import TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.service import Worker
from mado_tracking.worker.target_probe import (
    CONTAINER_EXEC_FLAGS,
    PROBE_SCRIPT,
    PYTHON_IDENTITY,
    check_target,
    parse_gpu_rows,
    probe_target,
)
from mado_tracking.worker.transport import CommandTransport, LocalTransport

API_TOKEN = "mmt_test-worker-secret-value"
SSH_KEY_PATH = "/home/worker/.ssh/id_gpu_host"
# A missing completion must fail the test instead of hanging it.
SCENARIO_TIMEOUT_SECONDS = 20


def ssh_target(**overrides: Any) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "executor": "ssh",
        "host": "gpu-host.internal",
        "port": 22,
        "username": "mmt",
        "sshKeyPath": SSH_KEY_PATH,
        "knownHostsPath": "/home/worker/.ssh/known_hosts",
        "workDirectory": "/srv/mmt",
        "pythonExecutable": "python3",
        "gpuIds": ["0"],
        **overrides,
    }


def healthy_facts(**overrides: Any) -> dict[str, Any]:
    flags = list(CONTAINER_EXEC_FLAGS)
    return {
        "venv": True,
        "ensurepip": True,
        "pip": {"found": True, "version": "pip 24.0 from /usr/lib/python3/dist-packages/pip"},
        "git": {"found": True, "exitCode": 0, "version": "git version 2.43.0"},
        "docker": {
            "found": True,
            "exitCode": 0,
            "version": "Docker version 27.1.1",
            "serverReachable": True,
            "serverVersion": "27.1.1",
            "socket": {"exists": True, "accessible": True},
        },
        "containers": {
            "apptainer": {
                "found": True,
                "exitCode": 0,
                "version": "apptainer version 1.3.4",
                "execFlags": flags,
            },
            "singularity": {"found": False},
        },
        "nvidia": {
            "found": True,
            "exitCode": 0,
            "rows": [
                "0, GPU-11111111-2222-3333-4444-555555555555, NVIDIA A100-SXM4-80GB, 81920",
                "1, GPU-66666666-7777-8888-9999-000000000000, NVIDIA RTX 6000 Ada, Generation, 49140",
            ],
        },
        "workDirectory": {"exists": True, "writable": True, "freeBytes": 500_000_000_000},
        "api": {"reachable": True, "status": 200},
        **overrides,
    }


class ScriptedSSHTransport(CommandTransport):
    """Answers the three probe steps as a remote host would, without opening a connection."""

    def __init__(
        self,
        *,
        identity: tuple[list[int], str] = ([3, 11, 9], "/usr/bin/python3"),
        facts: dict[str, Any] | None = None,
        fail_step: str | None = None,
        failure: str = "ssh: connect to host gpu-host.internal port 22: Connection refused",
    ):
        super().__init__(masker=SecretMasker([API_TOKEN]))
        self.identity = identity
        self.facts = facts if facts is not None else healthy_facts()
        self.fail_step = fail_step
        self.failure = failure
        self.commands: list[list[str]] = []

    async def run(
        self,
        command: Sequence[str],
        *,
        stdin: bytes | Path = b"",
        timeout: float | None = None,  # noqa: ASYNC109 -- mirrors CommandTransport.run
    ) -> bytes:
        self.commands.append(list(command))
        step = (
            "connection"
            if list(command) == ["true"]
            else "identity"
            if PYTHON_IDENTITY in command
            else "probe"
        )
        if step == self.fail_step:
            raise TransportError(f"Compute transport exited (255): {self.failure}")
        if step == "connection":
            return b""
        if step == "identity":
            return json.dumps([self.identity[0], self.identity[1]]).encode()
        return json.dumps(self.facts).encode()


def run_probe(transport: CommandTransport, target: dict[str, Any] | None = None) -> dict[str, Any]:
    return asyncio.run(
        probe_target(
            target or ssh_target(),
            transport=transport,
            health_url="http://mmt.internal:4182/api/health",
            masker=SecretMasker([API_TOKEN]),
        )
    )


def items_by_name(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["name"]: entry for entry in result["items"]}


def test_healthy_ssh_target_reports_every_item_and_offers_detected_gpus_and_runtimes():
    transport = ScriptedSSHTransport()
    result = run_probe(transport)
    items = items_by_name(result)
    assert list(items) == [
        "connection",
        "python",
        "venv",
        "pip",
        "git",
        "docker",
        "apptainer",
        "singularity",
        "gpu",
        "work_directory",
        "api",
    ]
    assert {name: entry["status"] for name, entry in items.items()} == {
        "connection": "ok",
        "python": "ok",
        "venv": "ok",
        "pip": "ok",
        "git": "ok",
        "docker": "ok",
        "apptainer": "ok",
        "singularity": "unavailable",
        "gpu": "ok",
        "work_directory": "ok",
        "api": "ok",
    }
    assert items["python"]["detail"] == "3.11.9 /usr/bin/python3"
    assert items["singularity"]["code"] == "container_cli_missing"
    # The GPU name containing a comma is kept whole.
    assert result["gpus"] == [
        {
            "index": "0",
            "uuid": "GPU-11111111-2222-3333-4444-555555555555",
            "name": "NVIDIA A100-SXM4-80GB",
            "memoryTotalMiB": 81920,
        },
        {
            "index": "1",
            "uuid": "GPU-66666666-7777-8888-9999-000000000000",
            "name": "NVIDIA RTX 6000 Ada, Generation",
            "memoryTotalMiB": 49140,
        },
    ]
    assert result["runtimeKinds"] == ["python", "docker", "apptainer"]
    assert result["workDirectoryFreeBytes"] == 500_000_000_000
    probe_command = transport.commands[-1]
    assert probe_command[:3] == ["python3", "-c", PROBE_SCRIPT]
    assert probe_command[3:5] == ["/srv/mmt", "http://mmt.internal:4182/api/health"]


def test_missing_nvidia_smi_old_python_and_denied_docker_socket_are_ng_without_guessed_values():
    facts = healthy_facts(
        nvidia={"found": False},
        docker={
            "found": True,
            "exitCode": 0,
            "version": "Docker version 24.0.7",
            "serverReachable": False,
            "serverVersion": None,
            "socket": {"exists": True, "accessible": False},
        },
    )
    result = run_probe(ScriptedSSHTransport(identity=([3, 10, 12], "/usr/bin/python3.10"), facts=facts))
    items = items_by_name(result)
    assert items["python"] == {
        "name": "python",
        "status": "ng",
        "code": "python_too_old",
        "detail": "3.10.12 /usr/bin/python3.10",
    }
    assert items["gpu"] == {"name": "gpu", "status": "ng", "code": "nvidia_smi_missing", "detail": None}
    assert result["gpus"] is None
    assert items["docker"]["status"] == "ng"
    assert items["docker"]["code"] == "docker_socket_denied"
    # Neither the too-old Python nor the unusable docker is offered as a runtime candidate.
    assert result["runtimeKinds"] == ["apptainer"]


def test_cpu_only_target_without_nvidia_smi_is_not_an_error_and_failed_nvidia_smi_is():
    without_tool = run_probe(
        ScriptedSSHTransport(facts=healthy_facts(nvidia={"found": False})), ssh_target(gpuIds=[])
    )
    assert items_by_name(without_tool)["gpu"]["status"] == "unavailable"
    broken = run_probe(
        ScriptedSSHTransport(facts=healthy_facts(nvidia={"found": True, "exitCode": 9, "rows": []}))
    )
    assert items_by_name(broken)["gpu"] == {
        "name": "gpu",
        "status": "ng",
        "code": "nvidia_smi_failed",
        "detail": None,
    }
    assert broken["gpus"] is None


def test_daemon_down_unwritable_directory_unreachable_api_and_missing_exec_flags_are_ng():
    facts = healthy_facts(
        docker={
            "found": True,
            "exitCode": 0,
            "version": "Docker version 27.1.1",
            "serverReachable": False,
            "serverVersion": None,
            "socket": {"exists": False, "accessible": False},
        },
        containers={
            "apptainer": {
                "found": True,
                "exitCode": 0,
                "version": "apptainer version 1.0.0",
                "execFlags": ["--cleanenv"],
            },
            "singularity": {"found": False},
        },
        workDirectory={"exists": False, "writable": False, "freeBytes": None},
        api={"reachable": False, "status": 502},
        venv=False,
        ensurepip=False,
        pip={"found": False, "version": None},
        git={"found": False},
    )
    items = items_by_name(run_probe(ScriptedSSHTransport(facts=facts)))
    assert {name: (entry["status"], entry["code"]) for name, entry in items.items()} == {
        "connection": ("ok", None),
        "python": ("ok", None),
        "venv": ("ng", "venv_missing"),
        "pip": ("ng", "pip_missing"),
        "git": ("unavailable", "git_missing"),
        "docker": ("ng", "docker_daemon_unreachable"),
        "apptainer": ("ng", "container_flags_missing"),
        "singularity": ("unavailable", "container_cli_missing"),
        "gpu": ("ok", None),
        "work_directory": ("ng", "work_directory_not_writable"),
        "api": ("ng", "api_unreachable"),
    }
    assert items["api"]["detail"] == "HTTP 502"


@pytest.mark.parametrize(
    ("fail_step", "expected"),
    [
        ("connection", [("connection", "ng", "ssh_failed")]),
        ("identity", [("connection", "ok", None), ("python", "ng", "python_missing")]),
        ("probe", [("connection", "ok", None), ("python", "ng", "probe_failed")]),
    ],
)
def test_failed_steps_report_codes_and_never_the_transport_error_text(fail_step, expected):
    failure = f"Warning: Identity file {SSH_KEY_PATH} not accessible; token {API_TOKEN}"
    result = run_probe(ScriptedSSHTransport(fail_step=fail_step, failure=failure))
    assert [(entry["name"], entry["status"], entry["code"]) for entry in result["items"]] == expected
    serialized = json.dumps(result)
    assert SSH_KEY_PATH not in serialized and API_TOKEN not in serialized
    assert result["gpus"] is None and result["runtimeKinds"] == []


def test_details_naming_key_files_are_dropped_and_tokens_are_masked():
    facts = healthy_facts(
        git={"found": True, "exitCode": 0, "version": f"git version 2.43.0 (config {SSH_KEY_PATH})"},
        pip={"found": True, "version": f"pip 24.0 {API_TOKEN}"},
    )
    items = items_by_name(run_probe(ScriptedSSHTransport(facts=facts)))
    assert items["git"]["detail"] is None
    assert items["pip"]["detail"] == "pip 24.0 [REDACTED]"


def test_missing_ssh_key_on_the_worker_fails_the_check_without_connecting(tmp_path: Path):
    status, result = asyncio.run(
        check_target(
            ssh_target(sshKeyPath=str(tmp_path / "missing"), knownHostsPath=str(tmp_path / "known_hosts")),
            allow_local_executor=False,
            health_url="http://mmt.internal/api/health",
            masker=SecretMasker([API_TOKEN]),
        )
    )
    assert status == "failed"
    assert result["items"] == [
        {"name": "connection", "status": "ng", "code": "ssh_configuration", "detail": None}
    ]
    assert str(tmp_path) not in json.dumps(result)


def test_gpu_rows_that_are_not_nvidia_smi_csv_are_ignored():
    assert parse_gpu_rows(["", "No devices were found", "0, GPU-a, A100, N/A"]) == []


@pytest.fixture
def health_url() -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_arguments: Any) -> None:
            pass

        def do_GET(self) -> None:
            status = 200 if self.path == "/api/health" else 404
            self.send_response(status)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/api/health"
    finally:
        server.shutdown()
        server.server_close()


def test_local_transport_runs_the_real_probe_on_this_host(tmp_path: Path, health_url: str):
    transport = LocalTransport(allow_local_executor=True, masker=SecretMasker([API_TOKEN]))
    target = {
        "id": str(uuid4()),
        "executor": "local",
        "workDirectory": str(tmp_path / "not-created-yet"),
        "pythonExecutable": sys.executable,
        "gpuIds": [],
        "sshKeyPath": "",
        "knownHostsPath": "",
    }
    result = asyncio.run(
        probe_target(target, transport=transport, health_url=health_url, masker=SecretMasker([API_TOKEN]))
    )
    items = items_by_name(result)
    version = ".".join(str(part) for part in sys.version_info[:3])
    assert items["python"]["status"] == "ok"
    assert items["python"]["detail"].startswith(version)
    assert items["venv"]["status"] == "ok"
    # A missing work directory counts as writable when the worker could create it.
    assert items["work_directory"]["status"] == "ok"
    assert not (tmp_path / "not-created-yet").exists()
    assert list(tmp_path.iterdir()) == []
    assert isinstance(result["workDirectoryFreeBytes"], int)
    assert items["api"]["status"] == "ok"
    assert "python" in result["runtimeKinds"]
    # Whatever this host has, GPU values are either nvidia-smi rows or absent.
    assert result["gpus"] is None or all(gpu["uuid"] for gpu in result["gpus"])


class TargetCheckServer:
    def __init__(self, claimed: dict[str, Any]):
        self.claimed = claimed
        self.target_check_claims: list[dict[str, Any]] = []
        self.completions: list[dict[str, Any]] = []
        self.completed = asyncio.Event()

    def serve(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        path = request.url.path
        if path.endswith("/worker/target-checks/claim"):
            self.target_check_claims.append(body)
            item = self.claimed if len(self.target_check_claims) == 1 else None
            return httpx.Response(200, json={"item": item})
        if path.endswith("/complete") and "/target-checks/" in path:
            self.completions.append(body)
            self.completed.set()
            return httpx.Response(200, json={**self.claimed["check"], "status": body["status"]})
        if path.endswith("/resume"):
            return httpx.Response(200, json={"items": []})
        return httpx.Response(200, json={"item": None})


def worker_for(server: TargetCheckServer, tmp_path: Path, target_ids: tuple[str, ...]) -> Worker:
    settings = WorkerSettings(
        api=ApiSettings("http://localhost/api", API_TOKEN),
        worker_id="probe-worker",
        target_ids=target_ids,
        state_directory=tmp_path / "state",
        allow_local_executor=True,
        poll_seconds=0.01,
    )
    api = WorkerApi(url=settings.api.url, token=API_TOKEN, transport=httpx.MockTransport(server.serve))
    return Worker(settings, api=api)


def run_until(worker: Worker, condition: Callable[[], Any]) -> None:
    async def scenario() -> None:
        task = asyncio.create_task(worker.run_forever())
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await condition()
        finally:
            worker.stopping.set()
            await task

    asyncio.run(scenario())


def test_idle_worker_claims_a_check_for_its_target_and_reports_the_probe_result(tmp_path: Path):
    target = {
        "id": str(uuid4()),
        "executor": "local",
        "workDirectory": str(tmp_path / "work"),
        "pythonExecutable": sys.executable,
        "gpuIds": [],
        "sshKeyPath": "",
        "knownHostsPath": "",
    }
    claimed = {
        "check": {"id": str(uuid4()), "targetId": target["id"]},
        "leaseId": str(uuid4()),
        "target": target,
    }
    server = TargetCheckServer(claimed)
    worker = worker_for(server, tmp_path, (target["id"],))
    run_until(worker, server.completed.wait)
    assert server.target_check_claims[0] == {"workerId": "probe-worker", "targetIds": [target["id"]]}
    [completion] = server.completions
    assert completion["leaseId"] == claimed["leaseId"]
    assert completion["status"] == "finished"
    items = items_by_name(completion["result"])
    assert items["connection"]["status"] == "ok"
    assert items["python"]["status"] == "ok"
    assert API_TOKEN not in json.dumps(completion)


def test_worker_without_target_ids_never_polls_for_checks(tmp_path: Path):
    server = TargetCheckServer({"check": {}, "leaseId": "", "target": {}})
    worker = worker_for(server, tmp_path, ())
    # Several idle loop iterations, each of which would poll for checks if it were enabled.
    idle_iterations = 3
    claims_seen = asyncio.Event()
    job_claims = 0
    original_claim = worker.api.claim

    async def counting_claim(*arguments: Any, **keywords: Any) -> Any:
        nonlocal job_claims
        job_claims += 1
        if job_claims >= idle_iterations:
            claims_seen.set()
        return await original_claim(*arguments, **keywords)

    worker.api.claim = counting_claim  # type: ignore[method-assign]
    run_until(worker, claims_seen.wait)
    assert server.target_check_claims == []
