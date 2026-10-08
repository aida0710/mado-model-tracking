from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import pytest
from test_worker import WorkerServer

from mado_tracking.errors import ConfigurationError
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.journal import JobJournal, with_saved_job_token
from mado_tracking.worker.service import Worker
from mado_tracking.worker.tracking_environment import build_tracking_environment

WORKER_TOKEN = "test-api-secret"
JOB_TOKEN = "mmtj_test-job-token"


def test_sdk_environment_carries_the_job_token_and_never_the_worker_token(worker_job, worker_settings):
    environment = build_tracking_environment(worker_job, worker_settings.api)
    assert environment["MMT_API_TOKEN"] == JOB_TOKEN
    assert environment["MLFLOW_TRACKING_TOKEN"] == JOB_TOKEN
    assert all(WORKER_TOKEN not in value for value in environment.values())


def test_job_without_a_token_is_not_started_with_the_worker_token(job_payload, worker_settings):
    job_payload["jobToken"] = None
    with pytest.raises(ConfigurationError, match="no job token"):
        build_tracking_environment(WorkerJob.parse(job_payload), worker_settings.api)


def test_worker_token_shaped_values_are_rejected_as_job_tokens(job_payload):
    job_payload["jobToken"] = WORKER_TOKEN
    with pytest.raises(ConfigurationError, match="invalid job token"):
        WorkerJob.parse(job_payload)


def test_job_token_is_not_part_of_the_job_repr(worker_job):
    assert JOB_TOKEN not in repr(worker_job)


def test_journal_restores_the_saved_token_when_resume_returns_none(job_payload, tmp_path: Path):
    journal = JobJournal(tmp_path / "state")
    journal.save(WorkerJob.parse(job_payload))
    saved = tmp_path / "state" / f"{job_payload['job']['id']}.json"
    assert saved.stat().st_mode & 0o077 == 0
    assert [job.job_token for job in journal.pending()] == [JOB_TOKEN]

    resumed_payload = {**job_payload, "job": {**job_payload["job"], "status": "running"}, "jobToken": None}
    resumed = with_saved_job_token(WorkerJob.parse(resumed_payload), journal.load(job_payload["job"]["id"]))
    assert resumed.job_token == JOB_TOKEN


def test_saved_token_of_another_lease_is_not_reused(job_payload, tmp_path: Path):
    journal = JobJournal(tmp_path / "state")
    journal.save(WorkerJob.parse(job_payload))
    other_lease = {
        **job_payload,
        "job": {**job_payload["job"], "leaseId": "00000000-0000-4000-8000-000000000000"},
        "jobToken": None,
    }
    restored = with_saved_job_token(WorkerJob.parse(other_lease), journal.load(job_payload["job"]["id"]))
    assert restored.job_token is None


def test_reissued_token_replaces_the_saved_one(job_payload, tmp_path: Path):
    journal = JobJournal(tmp_path / "state")
    journal.save(WorkerJob.parse(job_payload))
    reissued = WorkerJob.parse({**job_payload, "jobToken": "mmtj_reissued"})
    assert with_saved_job_token(reissued, journal.load(reissued.id)).job_token == "mmtj_reissued"


def test_job_code_sees_only_the_job_token_and_logs_never_contain_tokens(
    job_payload, worker_settings, caplog
):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import os\n"
        f"print('worker-token-visible=' + str(any({WORKER_TOKEN!r} in v for v in os.environ.values())))\n"
        f"print('job-token-match=' + str(os.environ['MMT_API_TOKEN'] == {JOB_TOKEN!r}))\n"
        "print(os.environ['MLFLOW_TRACKING_TOKEN'], flush=True)\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert "worker-token-visible=False" in messages
    assert "job-token-match=True" in messages
    assert "[REDACTED]" in messages
    assert JOB_TOKEN not in messages and JOB_TOKEN not in caplog.text
    # The process is reported running right after launch, before the regular heartbeat interval.
    statuses = [body.get("status") for path, body in server.calls if path.endswith("/heartbeat")]
    assert "running" in statuses


def test_token_reissued_while_preparing_is_the_one_the_code_receives(job_payload, worker_settings):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import os\n"
        "print('reissued-match=' + str(os.environ['MMT_API_TOKEN'] == 'mmtj_reissued'), flush=True)\n"
        "print(os.environ['MMT_API_TOKEN'], flush=True)\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            worker.launch(WorkerJob.parse(job_payload))
            # A resume after a failed claim returns the same claimed Job with a new token.
            worker.launch(WorkerJob.parse({**job_payload, "jobToken": "mmtj_reissued"}))
            await asyncio.wait_for(worker.tasks[job_payload["job"]["id"]], 15)
            assert worker.reissued_job_tokens == {}
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert "reissued-match=True" in messages
    assert "mmtj_reissued" not in messages
