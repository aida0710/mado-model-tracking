"""Malformed instructions must not execute or release an uncertain active execution."""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest
from test_worker_claim import ClaimServer, gated_jobs, release_job, stop_worker

from mado_tracking.errors import ConfigurationError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.job_responses import InvalidWorkerJob, parse_worker_job_response
from mado_tracking.worker.journal import JobJournal
from mado_tracking.worker.service import Worker

# Fail missing process/monitoring notifications without leaving detached fixture processes behind.
SCENARIO_TIMEOUT_SECONDS = 15


def corrupt_source(payload):
    payload["codeVersion"]["source"] = {
        "kind": "git",
        "url": "https://example.invalid/review.git",
        "commit": "a" * 40,
        "files": {"config/main.py": "raise RuntimeError('must never execute')"},
        "deletedFiles": ["config"],
    }


class InvalidResponseServer(ClaimServer):
    def __init__(self, payloads, *, invalid_ids=(), invalid_resume_ids=()):
        super().__init__(payloads)
        self.invalid_ids = set(invalid_ids)
        self.invalid_resume_ids = set(invalid_resume_ids)
        self.failed_completions = []

    def serve(self, request):
        if request.url.path.endswith("/complete"):
            job_id = request.url.path.split("/")[-2]
            if job_id in self.invalid_ids:
                body = json.loads(request.content)
                assert body["leaseId"] == self.payloads[job_id]["job"]["leaseId"]
                assert body["status"] == "failed" and "exitCode" not in body
                self.failed_completions.append((job_id, body))
                self.payloads[job_id]["job"]["status"] = "failed"
                self.completed[job_id].set()
                return httpx.Response(200, json={})
        response = super().serve(request)
        if request.url.path.endswith("/resume"):
            payload = response.json()
            for item in payload["items"]:
                if item["job"]["id"] in self.invalid_resume_ids:
                    corrupt_source(item)
            return httpx.Response(200, json=payload)
        return response


def test_invalid_claim_is_failed_without_execution_and_the_next_job_runs(
    job_payload, worker_settings, tmp_path
):
    payloads = gated_jobs(job_payload, tmp_path, count=2)
    invalid_id, valid_id = [payload["job"]["id"] for payload in payloads]
    corrupt_source(payloads[0])
    server = InvalidResponseServer(payloads, invalid_ids=[invalid_id])

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(worker.run_forever())
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await server.completed[invalid_id].wait()
                await server.ready[valid_id].wait()
                release_job(tmp_path, valid_id)
                await server.completed[valid_id].wait()
        finally:
            release_job(tmp_path, valid_id)
            await stop_worker(worker, task)

    asyncio.run(scenario())
    assert len(server.failed_completions) == 1
    assert "validation failed" in server.failed_completions[0][1]["error"]
    assert "conflict" in server.failed_completions[0][1]["error"]
    assert not (Path(job_payload["target"]["workDirectory"]) / invalid_id).exists()
    assert not (worker_settings.state_directory / f"{invalid_id}.json").exists()


def test_invalid_resume_keeps_saved_monitoring_for_two_running_jobs_without_releasing_the_lease(
    job_payload, worker_settings, tmp_path, caplog
):
    payloads = gated_jobs(job_payload, tmp_path, count=2)
    invalid_id, valid_id = [payload["job"]["id"] for payload in payloads]
    server = InvalidResponseServer(payloads)

    async def scenario():
        first = Worker(worker_settings, api=server.client())
        first_task = asyncio.create_task(first.run_forever())
        second = second_task = None
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await asyncio.gather(*(event.wait() for event in server.ready.values()))
                await stop_worker(first, first_task)
                for event in server.monitoring.values():
                    event.clear()
                server.invalid_resume_ids.add(invalid_id)
                second = Worker(worker_settings, api=server.client())
                second_task = asyncio.create_task(second.run_forever())
                await asyncio.gather(*(event.wait() for event in server.monitoring.values()))
                assert invalid_id in second.tasks and valid_id in second.tasks
                assert not server.failed_completions and not any(
                    event.is_set() for event in server.completed.values()
                )
                for job_id in server.payloads:
                    release_job(tmp_path, job_id)
                await asyncio.gather(*(event.wait() for event in server.completed.values()))
        finally:
            for job_id in server.payloads:
                release_job(tmp_path, job_id)
            if not first_task.done():
                await stop_worker(first, first_task)
            if second is not None:
                await stop_worker(second, second_task)

    asyncio.run(scenario())
    assert "lease retained for monitoring/recovery" in caplog.text
    assert not server.failed_completions
    assert len(server.new_claims) == 2
    for payload in payloads:
        workspace = Path(payload["target"]["workDirectory"]) / payload["job"]["id"]
        assert (workspace / "starts.txt").read_text() == "started\n"


@pytest.mark.parametrize("saved_state", ["journal", "inflight", "running", "resume"])
def test_invalid_response_never_completes_a_job_whose_execution_may_exist(
    job_payload, worker_settings, saved_state, caplog
):
    valid_job = WorkerJob.parse(copy.deepcopy(job_payload))
    corrupt_source(job_payload)
    if saved_state == "running":
        job_payload["job"]["status"] = "running"
    invalid = parse_worker_job_response(job_payload, worker_id=worker_settings.worker_id)
    assert isinstance(invalid, InvalidWorkerJob)
    calls = []

    def serve(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={})

    async def scenario():
        worker = Worker(
            worker_settings,
            api=WorkerApi(
                url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
            ),
        )
        gate = asyncio.Event()
        if saved_state == "journal":
            worker.journal.save(valid_job)
        if saved_state == "inflight":
            worker.tasks[valid_job.id] = asyncio.create_task(gate.wait())
        try:
            await worker.reject_invalid_job(invalid, resumed=saved_state == "resume")
            assert valid_job.id in worker.retained_job_ids
        finally:
            for task in worker.tasks.values():
                task.cancel()
            await asyncio.gather(*worker.tasks.values(), return_exceptions=True)
            await worker.api.close()

    asyncio.run(scenario())
    assert not calls and "lease retained" in caplog.text
    if saved_state == "journal":
        assert JobJournal(worker_settings.state_directory).pending() == [valid_job]


@pytest.mark.parametrize(
    "field,value", [("id", "../../outside"), ("leaseId", ""), ("workerId", "other-worker")]
)
def test_unverified_claim_identity_cannot_authorize_a_failure_completion(
    job_payload, worker_settings, field, value
):
    corrupt_source(job_payload)
    job_payload["job"][field] = value
    with pytest.raises(ConfigurationError):
        parse_worker_job_response(job_payload, worker_id=worker_settings.worker_id)


def test_unidentified_resume_item_does_not_hide_the_other_valid_job(job_payload, worker_settings, caplog):
    invalid = copy.deepcopy(job_payload)
    corrupt_source(invalid)
    invalid["job"]["leaseId"] = "invalid lease"

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api",
            token="test-api-secret",
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json={"items": [invalid, job_payload]})
            ),
        )
        try:
            resumed = await api.resume(worker_settings.worker_id, ())
            assert resumed == [WorkerJob.parse(job_payload)]
        finally:
            await api.close()

    asyncio.run(scenario())
    assert "no verified lease; no completion sent" in caplog.text


def test_corrupt_saved_journal_does_not_hide_a_valid_pending_job(job_payload, worker_settings, caplog):
    journal = JobJournal(worker_settings.state_directory)
    job = WorkerJob.parse(job_payload)
    journal.save(job)
    damaged = journal.directory / "damaged.json"
    damaged.write_text('{"snapshot":')
    assert journal.pending() == [job]
    assert damaged.exists() and "journal and lease retained" in caplog.text


@pytest.mark.parametrize("status", ["claimed", "running"])
def test_unrecoverable_invalid_resume_retains_its_lease_and_does_not_block_the_next_valid_claim(
    job_payload, worker_settings, tmp_path, status
):
    payloads = gated_jobs(job_payload, tmp_path, count=2)
    invalid_id, valid_id = [payload["job"]["id"] for payload in payloads]
    corrupt_source(payloads[0])
    server = InvalidResponseServer(payloads, invalid_ids=[invalid_id])
    server.payloads[invalid_id]["job"].update(
        status=status, workerId=worker_settings.worker_id, leaseId=payloads[0]["job"]["leaseId"]
    )

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(worker.run_forever())
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await server.ready[valid_id].wait()
                assert invalid_id in server.claims[0]["activeJobIds"]
                assert not server.failed_completions
                release_job(tmp_path, valid_id)
                await server.completed[valid_id].wait()
        finally:
            release_job(tmp_path, valid_id)
            await stop_worker(worker, task)

    asyncio.run(scenario())
    assert server.payloads[invalid_id]["job"]["status"] == status
    assert not server.failed_completions
    assert not (Path(job_payload["target"]["workDirectory"]) / invalid_id).exists()


def test_invalid_saved_instructions_retain_the_claimed_lease_and_allow_other_jobs_to_run(
    job_payload, worker_settings, tmp_path, caplog
):
    payloads = gated_jobs(job_payload, tmp_path, count=2)
    invalid_id, valid_id = [payload["job"]["id"] for payload in payloads]
    journal = JobJournal(worker_settings.state_directory)
    journal.save(WorkerJob.parse(payloads[0]))
    path = journal.directory / f"{invalid_id}.json"
    saved = json.loads(path.read_text())
    corrupt_source(saved["snapshot"])
    path.write_text(json.dumps(saved))
    original = path.read_bytes()
    server = InvalidResponseServer(payloads, invalid_ids=[invalid_id])

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(worker.run_forever())
        try:
            async with asyncio.timeout(SCENARIO_TIMEOUT_SECONDS):
                await server.ready[valid_id].wait()
                assert invalid_id in worker.retained_job_ids
                release_job(tmp_path, valid_id)
                await server.completed[valid_id].wait()
        finally:
            release_job(tmp_path, valid_id)
            await stop_worker(worker, task)

    asyncio.run(scenario())
    assert path.read_bytes() == original and not server.failed_completions
    assert server.payloads[invalid_id]["job"]["status"] == "claimed"
    assert "monitoring stopped; durable state remains for recovery" in caplog.text
    assert not (Path(job_payload["target"]["workDirectory"]) / invalid_id).exists()
