from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest

from mado_tracking import Client, ConfigurationError

PROJECT_ID = str(uuid4())
EXPERIMENT_ID = str(uuid4())
TOKEN = "resume-test-secret"
PROJECT_PATH = f"/api/projects/{PROJECT_ID}"


class FakeResumeApi:
    """POST /runs/:r/resume, PUT /sync/runs/:r and the Run write endpoints."""

    def __init__(self):
        self.runs: dict[str, dict] = {}
        self.last_steps: dict[str, dict[str, int]] = {}
        self.job_run_ids: set[str] = set()
        self.metrics: list[dict] = []
        self.calls: list[tuple[str, str, dict | None]] = []

    def client(self) -> Client:
        return Client(api_url="http://mmt.test", api_token=TOKEN, transport=httpx.MockTransport(self.handle))

    def add_run(self, *, status: str = "finished", last_steps: dict[str, int] | None = None) -> str:
        run_id = str(uuid4())
        self.runs[run_id] = {"id": run_id, "experimentId": EXPERIMENT_ID, "name": "old", "status": status}
        self.last_steps[run_id] = dict(last_steps or {})
        return run_id

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        path = request.url.path.removeprefix(PROJECT_PATH)
        self.calls.append((request.method, path, body))
        segments = path.strip("/").split("/")
        if request.method == "POST" and segments[0] == "runs" and segments[2:] == ["resume"]:
            return self.resume(segments[1])
        if request.method == "PUT" and segments[:2] == ["sync", "runs"]:
            run_id = segments[2]
            self.runs[run_id] = {"id": run_id, "status": "running", **body}
            return httpx.Response(201, json=self.runs[run_id])
        if request.method == "POST" and path == "/runs":
            run_id = str(uuid4())
            self.runs[run_id] = {"id": run_id, "status": "queued", **body}
            return httpx.Response(201, json=self.runs[run_id])
        if request.method == "POST" and segments[2:] == ["metrics"]:
            self.metrics.extend(body["metrics"])
            return httpx.Response(200, json={})
        if request.method == "PATCH" and segments[0] == "runs":
            self.runs[segments[1]].update(body)
            return httpx.Response(200, json=self.runs[segments[1]])
        raise AssertionError(f"Unexpected request {request.method} {path}")

    def resume(self, run_id: str) -> httpx.Response:
        run = self.runs.get(run_id)
        if run is None:
            return httpx.Response(404, json={"error": "not found", "code": "not_found"})
        if run_id in self.job_run_ids:
            return httpx.Response(409, json={"error": "finalized", "code": "run_finalized"})
        resumed = run["status"] != "running"
        run["status"] = "running"
        return httpx.Response(
            200,
            json={
                "run": run,
                "resumed": resumed,
                "event": {"id": str(uuid4())} if resumed else None,
                "lastSteps": self.last_steps[run_id],
            },
        )

    def paths(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path, _body in self.calls]


@pytest.fixture(autouse=True)
def manual_environment(monkeypatch):
    for name in ("MMT_RUN_ID", "MMT_JOB_ID", "MMT_MODE", "MMT_EXPERIMENT_ID"):
        monkeypatch.delenv(name, raising=False)


def test_must_reopens_the_run_and_continues_each_metric_after_its_last_step():
    api = FakeResumeApi()
    run_id = api.add_run(last_steps={"loss": 10, "accuracy": 4})

    run = api.client().start_run(project_id=PROJECT_ID, run_id=run_id, resume="must")
    run.log_metrics({"loss": 0.5, "accuracy": 0.9, "f1": 0.7})
    run.log_metrics({"loss": 0.4})

    assert api.paths() == [
        ("POST", f"/runs/{run_id}/resume"),
        ("POST", f"/runs/{run_id}/metrics"),
        ("POST", f"/runs/{run_id}/metrics"),
    ]
    assert [(point["name"], point["step"]) for point in api.metrics] == [
        ("loss", 11),
        ("accuracy", 5),
        ("f1", 0),
        ("loss", 12),
    ]
    assert run.entity["status"] == "running"
    assert run.last_step("loss") == 12 and run.last_step("missing") is None


def test_an_explicit_step_is_kept_after_resuming_and_moves_the_next_default():
    api = FakeResumeApi()
    run_id = api.add_run(last_steps={"loss": 10})
    run = api.client().start_run(project_id=PROJECT_ID, run_id=run_id, resume="must")

    run.log_metrics({"loss": 0.5}, step=50)
    run.log_metrics({"loss": 0.4})

    assert [point["step"] for point in api.metrics] == [50, 51]


def test_must_fails_without_creating_when_the_run_does_not_exist():
    api = FakeResumeApi()
    missing = str(uuid4())

    with pytest.raises(ConfigurationError, match="does not exist"):
        api.client().start_run(project_id=PROJECT_ID, run_id=missing, resume="must")

    assert api.paths() == [("POST", f"/runs/{missing}/resume")]


def test_allow_creates_a_missing_run_under_the_given_id_through_sync():
    api = FakeResumeApi()
    run_id = str(uuid4())

    run = api.client().start_run(
        project_id=PROJECT_ID,
        experiment_id=EXPERIMENT_ID,
        name="chosen-id",
        run_id=run_id,
        resume="allow",
        parameters={"lr": 0.1},
    )
    run.log_metrics({"loss": 1.0})

    assert api.paths() == [
        ("POST", f"/runs/{run_id}/resume"),
        ("PUT", f"/sync/runs/{run_id}"),
        ("POST", f"/runs/{run_id}/metrics"),
    ]
    created = api.calls[1][2]
    assert created["experimentId"] == EXPERIMENT_ID and created["name"] == "chosen-id"
    assert created["parameters"] == {"lr": 0.1} and created["startedAt"].endswith("Z")
    assert run.id == run_id and api.metrics[0]["step"] == 0


def test_allow_reopens_an_existing_run_without_creating_one():
    api = FakeResumeApi()
    run_id = api.add_run(last_steps={"loss": 3})

    run = api.client().start_run(
        project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="ignored", run_id=run_id, resume="allow"
    )

    assert api.paths() == [("POST", f"/runs/{run_id}/resume")]
    assert run.last_step("loss") == 3


def test_never_creates_a_new_run_and_keeps_step_zero_when_omitted():
    api = FakeResumeApi()

    run = api.client().start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="fresh")
    run.log_metrics({"loss": 1.0})
    run.log_metrics({"loss": 0.5})

    assert [method_path[1] for method_path in api.paths()[:2]] == ["/runs", f"/runs/{run.id}"]
    assert [point["step"] for point in api.metrics] == [0, 0]


def test_run_id_without_resume_and_resume_without_run_id_are_refused():
    api = FakeResumeApi()
    client = api.client()

    with pytest.raises(ConfigurationError, match="run_id needs resume"):
        client.start_run(project_id=PROJECT_ID, run_id=str(uuid4()))
    with pytest.raises(ConfigurationError, match="needs run_id"):
        client.start_run(project_id=PROJECT_ID, resume="must")
    with pytest.raises(ConfigurationError, match="resume must be one of"):
        client.start_run(project_id=PROJECT_ID, run_id=str(uuid4()), resume="always")
    assert api.calls == []


@pytest.mark.parametrize("variable", ["MMT_RUN_ID", "MMT_JOB_ID"])
def test_worker_managed_runs_are_not_resumed(monkeypatch, variable):
    api = FakeResumeApi()
    run_id = api.add_run()
    monkeypatch.setenv(variable, run_id)

    with pytest.raises(ConfigurationError, match="checkpoint"):
        api.client().start_run(project_id=PROJECT_ID, run_id=run_id, resume="must")

    assert api.calls == []


def test_a_run_owned_by_a_job_points_to_checkpoint_retry():
    api = FakeResumeApi()
    run_id = api.add_run()
    api.job_run_ids.add(run_id)

    with pytest.raises(ConfigurationError, match="retry the Job from a checkpoint"):
        api.client().start_run(project_id=PROJECT_ID, run_id=run_id, resume="allow")

    assert ("PUT", f"/sync/runs/{run_id}") not in api.paths()


def test_finishing_a_resumed_run_sends_the_terminal_status_again():
    api = FakeResumeApi()
    run_id = api.add_run(last_steps={"loss": 1})

    with api.client().start_run(project_id=PROJECT_ID, run_id=run_id, resume="must") as run:
        run.log_metrics({"loss": 0.1})

    assert api.calls[-1] == ("PATCH", f"/runs/{run_id}", {"status": "finished"})
    assert api.runs[run_id]["status"] == "finished"
