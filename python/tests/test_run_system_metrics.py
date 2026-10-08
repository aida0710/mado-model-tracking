from __future__ import annotations

import json
import os
import time
from uuid import uuid4

import httpx
import pytest

import mado_tracking
from mado_tracking import Client
from mado_tracking.offline.spool import list_batches, read_batch_body
from mado_tracking.system_metrics import DEFAULT_SYSTEM_METRICS_SECONDS

PROJECT_ID = str(uuid4())
EXPERIMENT_ID = str(uuid4())
TOKEN = "system-metrics-test-secret"
SAMPLE_WAIT_SECONDS = 10


class RecordingMonitor:
    """Stands in for SystemMetricsMonitor; tests push samples through its sink by hand."""

    instances: list[RecordingMonitor] = []

    def __init__(self, sink, *, interval_seconds, pid):
        self.sink = sink
        self.interval_seconds = interval_seconds
        self.pid = pid
        self.started = False
        self.stopped = False
        RecordingMonitor.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


@pytest.fixture(autouse=True)
def manual_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MMT_OFFLINE_DIR", str(tmp_path / "offline"))
    for name in ("MMT_RUN_ID", "MMT_JOB_ID", "MMT_MODE", "MMT_SYSTEM_METRICS"):
        monkeypatch.delenv(name, raising=False)
    RecordingMonitor.instances.clear()


@pytest.fixture
def recording_monitor(monkeypatch):
    monkeypatch.setattr("mado_tracking.run.SystemMetricsMonitor", RecordingMonitor)


def online_api():
    calls: list[tuple[str, str, dict]] = []
    runs: dict[str, dict] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}")
        calls.append((request.method, path, body))
        if path == "/runs":
            run_id = str(uuid4())
            runs[run_id] = {"id": run_id, "status": "queued", **body}
            return httpx.Response(201, json=runs[run_id])
        if path.endswith("/metrics"):
            return httpx.Response(200, json={})
        run = runs[path.split("/")[2]]
        run.update(body)
        return httpx.Response(200, json=run)

    client = Client(api_url="http://mmt.test", api_token=TOKEN, transport=httpx.MockTransport(handle))
    return client, calls


def test_monitor_starts_with_the_run_sends_to_the_api_and_stops_at_finish(recording_monitor):
    client, calls = online_api()

    run = client.start_run(
        project_id=PROJECT_ID,
        experiment_id=EXPERIMENT_ID,
        name="with-system",
        system_metrics=True,
        system_metrics_interval=5,
    )
    (monitor,) = RecordingMonitor.instances
    assert monitor.started and monitor.interval_seconds == 5 and monitor.pid == os.getpid()
    monitor.sink([{"name": "system.cpu.utilization", "value": 12.5, "step": 0, "timestamp": "t"}])
    run.finish()

    metric_posts = [body for method, path, body in calls if path.endswith("/metrics")]
    assert metric_posts == [
        {"metrics": [{"name": "system.cpu.utilization", "value": 12.5, "step": 0, "timestamp": "t"}]}
    ]
    assert monitor.stopped
    # The monitor stops before the terminal status, so no sample can follow it.
    assert calls[-1][2] == {"status": "finished"}


def test_default_interval_is_the_collector_default(recording_monitor):
    client, _calls = online_api()

    with client.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="x", system_metrics=True):
        pass

    (monitor,) = RecordingMonitor.instances
    assert monitor.interval_seconds == DEFAULT_SYSTEM_METRICS_SECONDS and monitor.stopped


def test_context_exit_with_an_exception_stops_the_monitor(recording_monitor):
    client, _calls = online_api()

    with pytest.raises(RuntimeError):
        with client.start_run(
            project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="x", system_metrics=True
        ):
            raise RuntimeError("training failed")

    assert RecordingMonitor.instances[0].stopped


def test_no_monitor_unless_requested(recording_monitor):
    client, _calls = online_api()

    client.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="x").finish()

    assert RecordingMonitor.instances == []


def test_mmt_system_metrics_false_turns_the_monitor_off(recording_monitor, monkeypatch):
    monkeypatch.setenv("MMT_SYSTEM_METRICS", "false")
    client, _calls = online_api()

    client.start_run(
        project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="x", system_metrics=True
    ).finish()

    assert RecordingMonitor.instances == []


def test_worker_jobs_do_not_start_a_second_monitor(recording_monitor, monkeypatch):
    client, _calls = online_api()
    run = client.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="seed")
    monkeypatch.setenv("MMT_RUN_ID", run.id)
    monkeypatch.setenv("MMT_JOB_ID", str(uuid4()))

    worker_run = client.start_run(project_id=PROJECT_ID, system_metrics=True)
    named_run = client.start_run(
        project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="child", system_metrics=True
    )

    assert worker_run.managed_by_worker and not named_run.managed_by_worker
    assert RecordingMonitor.instances == []


def test_real_monitor_writes_system_metrics_into_the_offline_spool():
    run = mado_tracking.start_run(
        project_id=PROJECT_ID,
        experiment_id=EXPERIMENT_ID,
        name="offline-system",
        mode="offline",
        system_metrics=True,
        system_metrics_interval=1,
    )
    # The first sample is taken right after start; wait for its line instead of sleeping blindly.
    deadline = time.monotonic() + SAMPLE_WAIT_SECONDS
    while not list_batches(run.offline_directory) and time.monotonic() < deadline:
        time.sleep(0.05)
    run.finish()

    names = {
        point["name"]
        for batch in list_batches(run.offline_directory)
        for point in read_batch_body(batch).get("metrics", [])
    }
    assert names and all(name.startswith("system.") for name in names)
