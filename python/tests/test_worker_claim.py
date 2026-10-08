"""Exercise claim/resume scheduling with real detached local jobs and the updated API contract."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import socket
from importlib import metadata
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import TERMINAL_STATUSES
from mado_tracking.worker.service import Worker

# A missing scheduling/recovery notification must fail without leaving a hanging test.
SCENARIO_TIMEOUT_SECONDS = 15


class ClaimServer:
    def __init__(self, payloads: list[dict], *, lose_claim_number: int | None = None):
        self.payloads = {payload["job"]["id"]: copy.deepcopy(payload) for payload in payloads}
        self.lose_claim_number = lose_claim_number
        self.calls: list[tuple[str, dict]] = []
        self.claims: list[dict] = []
        self.resumed_leases: list[tuple[str, str]] = []
        self.new_claims: list[tuple[str, str]] = []
        self.ready = {job_id: asyncio.Event() for job_id in self.payloads}
        self.monitoring = {job_id: asyncio.Event() for job_id in self.payloads}
        self.completed = {job_id: asyncio.Event() for job_id in self.payloads}
        self.completion_leases: dict[str, str] = {}
        self.max_active = 0
        for payload in self.payloads.values():
            payload["job"].update(status="queued", workerId=None, leaseId=None)

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-api-secret"
        if request.method == "PUT":
            run_id = request.url.path.split("/")[-2]
            assert any(payload["run"]["id"] == run_id for payload in self.payloads.values())
            assert request.url.params["path"].startswith(".mmt/")
            return httpx.Response(
                200,
                json={"sha256": hashlib.sha256(request.content).hexdigest(), "size": len(request.content)},
            )
        body = json.loads(request.content)
        path = request.url.path
        self.calls.append((path, body))
        active = [
            payload
            for payload in self.payloads.values()
            if payload["job"]["status"] in {"claimed", "running"}
        ]
        if path.endswith("/resume"):
            self.resumed_leases.extend(
                (payload["job"]["id"], payload["job"]["leaseId"]) for payload in active
            )
            return httpx.Response(200, json={"items": active})
        if path.endswith("/claim"):
            self.claims.append(body)
            monitored_ids = body.get("activeJobIds", [])
            assert len(monitored_ids) == len(set(monitored_ids))
            assert all(
                self.payloads[job_id]["job"]["workerId"] == body["workerId"] for job_id in monitored_ids
            )
            selected = next(
                (payload for payload in active if payload["job"]["id"] not in monitored_ids), None
            )
            if selected is None:
                selected = next(
                    (payload for payload in self.payloads.values() if payload["job"]["status"] == "queued"),
                    None,
                )
                if selected is not None:
                    selected["job"].update(status="claimed", workerId=body["workerId"], leaseId=str(uuid4()))
                    self.new_claims.append((selected["job"]["id"], selected["job"]["leaseId"]))
                    self.max_active = max(self.max_active, len(active) + 1)
            if len(self.claims) == self.lose_claim_number:
                raise httpx.ReadError("response lost after claim transaction", request=request)
            return httpx.Response(200, json={"item": selected})
        job_id = path.split("/")[-2]
        job = self.payloads[job_id]["job"]
        assert body["leaseId"] == job["leaseId"]
        if path.endswith("/heartbeat"):
            if job["status"] in TERMINAL_STATUSES:
                return httpx.Response(409, json={"error": "already completed"})
            if "status" in body:
                job["status"] = body["status"]
                self.monitoring[job_id].set()
            return httpx.Response(200, json={"cancelRequested": False})
        if path.endswith("/logs") and any(
            "ready-for-release" in entry["message"] for entry in body["entries"]
        ):
            self.ready[job_id].set()
        if path.endswith("/complete"):
            assert body["status"] == "finished" and body["exitCode"] == 0
            job["status"] = body["status"]
            self.completion_leases[job_id] = body["leaseId"]
            self.completed[job_id].set()
        return httpx.Response(200, json={})

    def client(self) -> WorkerApi:
        return WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(self.serve)
        )


def gated_jobs(template: dict, directory: Path, *, count: int) -> list[dict]:
    payloads = []
    for _ in range(count):
        payload = copy.deepcopy(template)
        job_id, run_id = str(uuid4()), str(uuid4())
        payload["job"].update(id=job_id, runId=run_id)
        payload["run"]["id"] = run_id
        gate = directory / f"{job_id}.release"
        payload["codeVersion"]["source"]["files"]["main.py"] = (
            "from pathlib import Path\nimport time\n"
            "with Path('../starts.txt').open('a') as output: output.write('started\\n')\n"
            "print('ready-for-release', flush=True)\n"
            f"gate = Path({str(gate)!r})\n"
            "while not gate.exists(): time.sleep(0.02)\n"
            "print('released', flush=True)\n"
        )
        payloads.append(payload)
    return payloads


def release_job(directory: Path, job_id: str) -> None:
    (directory / f"{job_id}.release").touch()


async def stop_worker(worker: Worker, task: asyncio.Task) -> None:
    worker.stopping.set()
    await task


def assert_single_start(payloads: list[dict]) -> None:
    for payload in payloads:
        workspace = Path(payload["target"]["workDirectory"]) / payload["job"]["id"]
        assert (workspace / "starts.txt").read_text() == "started\n"
        assert json.loads((workspace / "state.json").read_text())["status"] in TERMINAL_STATUSES


@pytest.mark.parametrize("lose_claim_number", [None, 2], ids=["normal", "lost-second-claim-response"])
def test_two_jobs_run_in_parallel_and_lost_claim_resumes_the_same_lease(
    job_payload, worker_settings, tmp_path, *, lose_claim_number
):
    payloads = gated_jobs(job_payload, tmp_path, count=3)
    first_id, second_id, third_id = [payload["job"]["id"] for payload in payloads]
    server = ClaimServer(payloads, lose_claim_number=lose_claim_number)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(worker.run_forever())
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await asyncio.gather(server.ready[first_id].wait(), server.ready[second_id].wait())
                # Both subprocesses reached their gates before either can finish.
                assert len(worker.tasks) == 2
                assert server.payloads[third_id]["job"]["status"] == "queued"
                assert server.claims[0]["activeJobIds"] == []
                assert server.claims[1]["activeJobIds"] == [first_id]
                if lose_claim_number is not None:
                    second_lease = server.payloads[second_id]["job"]["leaseId"]
                    assert (second_id, second_lease) in server.resumed_leases
                    assert [
                        path.rsplit("/", 1)[-1]
                        for path, _ in server.calls
                        if path.endswith(("claim", "resume"))
                    ][:4] == ["resume", "claim", "claim", "resume"]
                release_job(tmp_path, first_id)
                await server.completed[first_id].wait()
                await server.ready[third_id].wait()
                assert not server.completed[second_id].is_set()
                assert (
                    second_id in server.claims[2]["activeJobIds"]
                    and first_id not in server.claims[2]["activeJobIds"]
                )
                release_job(tmp_path, second_id)
                release_job(tmp_path, third_id)
                await asyncio.gather(*(event.wait() for event in server.completed.values()))
        finally:
            for job_id in server.payloads:
                release_job(tmp_path, job_id)
            await stop_worker(worker, task)

    asyncio.run(scenario())
    assert server.max_active == 2
    assert_single_start(payloads)
    assert server.completion_leases == {
        job_id: payload["job"]["leaseId"] for job_id, payload in server.payloads.items()
    }


def test_restarted_worker_resumes_two_running_jobs_without_new_claims_or_duplicate_processes(
    job_payload, worker_settings, tmp_path
):
    payloads = gated_jobs(job_payload, tmp_path, count=2)
    server = ClaimServer(payloads)

    async def scenario():
        first_worker = Worker(worker_settings, api=server.client())
        first_task = asyncio.create_task(first_worker.run_forever())
        second_worker = second_task = None
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await asyncio.gather(*(event.wait() for event in server.ready.values()))
                leases = {job_id: payload["job"]["leaseId"] for job_id, payload in server.payloads.items()}
                await stop_worker(first_worker, first_task)
                assert len(first_worker.journal.pending()) == 2
                for event in server.monitoring.values():
                    event.clear()
                second_worker = Worker(worker_settings, api=server.client())
                second_task = asyncio.create_task(second_worker.run_forever())
                await asyncio.gather(*(event.wait() for event in server.monitoring.values()))
                assert len(second_worker.tasks) == 2 and len(server.claims) == 2
                for job_id in server.payloads:
                    release_job(tmp_path, job_id)
                await asyncio.gather(*(event.wait() for event in server.completed.values()))
                assert all((job_id, lease) in server.resumed_leases for job_id, lease in leases.items())
                assert server.completion_leases == leases
                assert server.new_claims == list(leases.items())
        finally:
            for job_id in server.payloads:
                release_job(tmp_path, job_id)
            if not first_task.done():
                await stop_worker(first_worker, first_task)
            if second_worker is not None and second_task is not None:
                await stop_worker(second_worker, second_task)

    asyncio.run(scenario())
    assert_single_start(payloads)


def test_claim_and_resume_report_installed_version_and_hostname():
    requests: list[tuple[str, dict]] = []

    def serve(request: httpx.Request) -> httpx.Response:
        requests.append((request.url.path.rsplit("/", 1)[-1], json.loads(request.content)))
        return httpx.Response(
            200, json={"item": None} if request.url.path.endswith("/claim") else {"items": []}
        )

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        try:
            await api.resume("presence-worker", [])
            assert await api.claim("presence-worker", []) is None
        finally:
            await api.close()

    asyncio.run(scenario())
    expected = {"version": metadata.version("mado-tracking"), "hostname": socket.gethostname()}
    assert [(path, body["workerInfo"]) for path, body in requests] == [
        ("resume", expected),
        ("claim", expected),
    ]
