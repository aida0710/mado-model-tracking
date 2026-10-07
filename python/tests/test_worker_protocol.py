from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from mado_tracking.errors import ApiError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.host_state import read_state, write_json
from mado_tracking.worker.journal import JobJournal
from mado_tracking.worker.service import Worker


def test_empty_target_filter_is_omitted_and_optional_completion_fields_are_omitted(worker_job):
    calls = []

    def serve(request):
        body = json.loads(request.content)
        calls.append(body)
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json={"item": None})
        if request.url.path.endswith("/resume"):
            return httpx.Response(200, json={"items": []})
        return httpx.Response(200, json={})

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        try:
            await api.claim("worker", ())
            await api.resume("worker", ())
            await api.complete(worker_job, status="canceled")
        finally:
            await api.close()

    asyncio.run(scenario())
    assert all("targetIds" not in body for body in calls)
    assert calls[-1] == {"leaseId": worker_job.lease_id, "status": "canceled"}


def test_claim_sends_monitored_job_ids_and_target_filter(worker_job):
    calls = []

    def serve(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"item": None})

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        try:
            await api.claim("worker", [worker_job.target["id"]], active_job_ids=[worker_job.id])
        finally:
            await api.close()

    asyncio.run(scenario())
    assert calls == [
        {"workerId": "worker", "targetIds": [worker_job.target["id"]], "activeJobIds": [worker_job.id]}
    ]


def test_temporary_worker_api_failure_retries_with_backoff_and_preserves_lease(worker_job, monkeypatch):
    calls = []

    async def serve(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return httpx.Response(503, json={"error": "temporary"})
        return httpx.Response(200, json={"cancelRequested": False})

    monkeypatch.setattr("mado_tracking.http.retry_delay", lambda *_args: 0.001)

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        try:
            assert await api.heartbeat(worker_job) is False
        finally:
            await api.close()

    asyncio.run(scenario())
    assert len(calls) == 2 and all(call["leaseId"] == worker_job.lease_id for call in calls)


def test_claim_is_not_replayed_after_response_loss():
    calls = 0

    def serve(request):
        nonlocal calls
        calls += 1
        raise httpx.ReadError("connection lost", request=request)

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        try:
            with pytest.raises(ApiError):
                await api.claim("worker", ())
        finally:
            await api.close()

    asyncio.run(scenario())
    assert calls == 1


def test_pending_completion_is_retried_without_remote_restart(worker_job, worker_settings):
    journal = JobJournal(worker_settings.state_directory)
    journal.save(worker_job, completion={"status": "finished", "exit_code": 0, "error": None})
    completed = []

    def serve(request):
        assert request.url.path.endswith("/complete")
        completed.append(json.loads(request.content))
        return httpx.Response(200, json={})

    async def scenario():
        worker = Worker(
            worker_settings,
            api=WorkerApi(
                url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
            ),
        )
        try:
            await worker.run_job(worker_job)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert completed[0]["status"] == "finished"
    assert not Path(worker_job.target["workDirectory"]).exists()
    assert not journal.pending()


def test_worker_state_directory_excludes_a_second_worker(tmp_path):
    first, second = JobJournal(tmp_path), JobJournal(tmp_path)
    first.acquire_worker_lock()
    try:
        with pytest.raises(ValueError, match="Another worker"):
            second.acquire_worker_lock()
    finally:
        first.close()
        second.close()


def test_uncertain_spawn_window_is_retained_and_never_reported_as_not_running(tmp_path):
    write_json(tmp_path / "state.json", {"status": "starting", "supervisorPid": 0, "processPid": 0})
    state = read_state(tmp_path)
    assert state["status"] == "unknown" and state["processAlive"] is True
    write_json(
        tmp_path / "state.json",
        {"status": "running", "supervisorPid": 999_999_999, "processPid": 0, "processPending": True},
    )
    state = read_state(tmp_path)
    assert state["status"] == "unknown" and state["processAlive"] is True
