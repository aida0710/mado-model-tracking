from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from test_worker import WorkerServer

from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.host_state import process_identity, read_state, write_json
from mado_tracking.worker.journal import JobJournal
from mado_tracking.worker.runtime import JobExecutor
from mado_tracking.worker.service import Worker
from mado_tracking.worker.session import JobSession


@pytest.mark.parametrize("supervisor_alive", [False, True])
@pytest.mark.parametrize("resource", ["container", "process", "group", "pending", "supervisor-only"])
def test_saved_unknown_keeps_reservations_while_a_supervisor_or_resource_can_still_be_alive(
    tmp_path, monkeypatch, supervisor_alive, resource
):
    state = {
        "status": "unknown",
        "supervisorPid": os.getpid() if supervisor_alive else 999_999_999,
        "supervisorIdentity": process_identity(os.getpid()) if supervisor_alive else "gone",
        "processPid": 0,
    }
    if resource == "container":
        state["container"] = {"id": "owned-container", "phase": "started"}
    elif resource == "process":
        state.update(processPid=os.getpid(), processIdentity=process_identity(os.getpid()))
    elif resource == "group":
        state.update(processPid=999_999_998, processIdentity="gone")
        monkeypatch.setattr("mado_tracking.worker.host_state.is_process_group_present", lambda _pid: True)
    elif resource == "pending":
        state["processPending"] = True
    write_json(tmp_path / "state.json", state)
    observed = read_state(tmp_path)
    assert observed["status"] == "unknown"
    assert observed["processAlive"] is (supervisor_alive or resource != "supervisor-only")


def test_unknown_container_is_not_released_between_daemon_cleanup_and_supervisor_exit(tmp_path):
    state = {
        "status": "unknown",
        "supervisorPid": os.getpid(),
        "supervisorIdentity": process_identity(os.getpid()),
        "processPid": 0,
        "container": {"id": "owned-container", "released": False},
    }
    write_json(tmp_path / "state.json", state)
    assert read_state(tmp_path)["processAlive"] is True
    state["container"]["released"] = True
    write_json(tmp_path / "state.json", state)
    assert read_state(tmp_path)["processAlive"] is True
    state.update(supervisorPid=999_999_999, supervisorIdentity="gone")
    write_json(tmp_path / "state.json", state)
    assert read_state(tmp_path)["processAlive"] is False


@pytest.mark.parametrize(
    "held_state",
    [
        {"status": "unknown"},
        {"status": "unknown", "processAlive": False, "container": {"id": "owned-container"}},
        {"status": "unknown", "processAlive": False, "processPending": True},
        {"status": "unknown", "processAlive": True, "container": {"released": True}},
    ],
    ids=["missing-proof", "unreleased-container", "pending-spawn", "live-supervisor"],
)
def test_monitor_does_not_complete_unknown_until_resource_absence_is_explicit(
    job_payload, worker_job, worker_settings, held_state
):
    server = WorkerServer(job_payload)

    async def scenario():
        observed_held, release_resources = asyncio.Event(), asyncio.Event()

        class StateExecutor(JobExecutor):
            polls = 0

            async def poll(self, _offsets, **_options):
                self.polls += 1
                if self.polls >= 3:
                    observed_held.set()
                    await release_resources.wait()
                    state = {"status": "unknown", "processAlive": False, "container": {"released": True}}
                else:
                    state = held_state
                return {
                    "state": state,
                    "logs": {
                        name: {"content": "", "nextOffset": 0, "size": 0} for name in ("stdout", "stderr")
                    },
                    "metrics": [],
                }

        api = server.client()
        journal = JobJournal(worker_settings.state_directory)
        journal.save(worker_job, offsets={"stdout": 0, "stderr": 0})
        session = JobSession(
            worker_job,
            api=api,
            settings=worker_settings,
            journal=journal,
            executor=StateExecutor(worker_job, worker_settings),
        )
        task = asyncio.create_task(session.monitor())
        try:
            async with asyncio.timeout(5):
                await observed_held.wait()
                assert not server.completions and not task.done()
                assert journal.pending() and journal.load(worker_job.id).get("completion") is None
                release_resources.set()
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            journal.close()
            await api.close()

    asyncio.run(scenario())
    assert [completion["status"] for completion in server.completions] == ["failed"]


def test_disappeared_python_execution_completes_failed_without_restarting_known_dead_processes(
    job_payload, worker_settings
):
    job_payload["job"]["status"] = "running"
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    workspace.mkdir(parents=True)
    write_json(
        workspace / "state.json",
        {
            "status": "running",
            "supervisorPid": 999_999_999,
            "supervisorIdentity": "gone",
            "processPid": 999_999_998,
            "processIdentity": "gone",
            "processPending": False,
        },
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            async with asyncio.timeout(5):
                await worker.run_job(WorkerJob.parse(job_payload))
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert [completion["status"] for completion in server.completions] == ["failed"]
    assert not (workspace / "source").exists() and not (workspace / "venv").exists()
