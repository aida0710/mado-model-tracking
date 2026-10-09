"""SDK calls for driver Jobs, manual hooks and Job arrays."""

from __future__ import annotations

import json

import httpx
import pytest

from mado_tracking import ChildJobSpec, Client, map_shards, submit_child_job, wait_for_child_jobs
from mado_tracking.errors import ConfigurationError

PROJECT_ID, PARENT_JOB_ID = "project-1", "job-parent"
CHILDREN_PATH = f"/api/projects/{PROJECT_ID}/jobs/{PARENT_JOB_ID}/children"


class DriverApi:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.created: dict[str, dict] = {}
        self.fail_next_create = False
        self.wait_answers: list[bool] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == CHILDREN_PATH and request.method == "POST":
            if self.fail_next_create:
                self.fail_next_create = False
                return httpx.Response(503, json={"error": "busy"})
            body = json.loads(request.content)
            key = body["idempotencyKey"]
            created = key not in self.created
            self.created.setdefault(
                key, {"id": f"child-{len(self.created)}", "status": "queued", "body": body}
            )
            return httpx.Response(
                201 if created else 200,
                json={"created": created, "arrayGroupId": None, "jobs": [self.created[key]]},
            )
        if path == CHILDREN_PATH:
            return httpx.Response(
                200, json={"items": [{**job, "status": "finished"} for job in self.created.values()]}
            )
        if path == CHILDREN_PATH + "/wait":
            done = self.wait_answers.pop(0) if self.wait_answers else True
            return httpx.Response(200, json={"done": done, "counts": {"total": len(self.created)}})
        if path.endswith("/trigger"):
            return httpx.Response(
                201, json={"id": "execution-1", "status": "queued", **json.loads(request.content)}
            )
        if path.endswith("/job-arrays"):
            return httpx.Response(
                201, json={"arrayGroup": {"id": "array-1"}, "jobs": [], "body": json.loads(request.content)}
            )
        return httpx.Response(404, json={"error": path})

    def client(self) -> Client:
        return Client(
            api_url="http://api.invalid",
            api_token="mmtj_job-token",
            transport=httpx.MockTransport(self.serve),
        )


@pytest.fixture
def driver_environment(monkeypatch):
    monkeypatch.setenv("MMT_PROJECT_ID", PROJECT_ID)
    monkeypatch.setenv("MMT_JOB_ID", PARENT_JOB_ID)


SPEC = ChildJobSpec(
    name="shard", kind="processing", code_version_id="code-1", target_id="site-1", gpu_count=1
)


def test_a_child_is_created_once_per_key_even_when_resent(driver_environment):
    api = DriverApi()
    api.fail_next_create = True
    with api.client() as client:
        first = submit_child_job(client, SPEC, key="generate:0")
        again = client.submit_child_job(SPEC, key="generate:0")
    assert first["created"] is True and again["created"] is False
    bodies = [json.loads(request.content) for request in api.requests if request.method == "POST"]
    assert len(bodies) == 3 and all(body["idempotencyKey"] == "generate:0" for body in bodies)
    assert bodies[0] == {
        "idempotencyKey": "generate:0",
        "name": "shard",
        "kind": "processing",
        "codeVersionId": "code-1",
        "targetId": "site-1",
        "parameters": {},
        "tags": {},
        "gpuCount": 1,
    }


def test_waiting_long_polls_until_every_child_ended(driver_environment):
    api = DriverApi()
    api.wait_answers = [False, False, True]
    with api.client() as client:
        waited = wait_for_child_jobs(client)
    waits = [request for request in api.requests if request.url.path.endswith("/wait")]
    assert waited["done"] is True and len(waits) == 3
    assert all(request.url.params["timeoutSeconds"] == "60" for request in waits)


def test_map_shards_starts_one_keyed_child_per_shard_and_returns_them_in_order(driver_environment):
    api = DriverApi()
    spec = ChildJobSpec(
        name="shard",
        kind="processing",
        code_version_id="code-1",
        target_id="site-1",
        parameters={"model": "v3"},
    )
    with api.client() as client:
        jobs = map_shards(client, spec, [{"shard": index} for index in range(3)], key="generate-v1")
    bodies = [json.loads(request.content) for request in api.requests if request.method == "POST"]
    assert [body["idempotencyKey"] for body in bodies] == ["generate-v1:0", "generate-v1:1", "generate-v1:2"]
    assert [body["name"] for body in bodies] == ["shard-0", "shard-1", "shard-2"]
    assert [body["parameters"] for body in bodies] == [{"model": "v3", "shard": index} for index in range(3)]
    assert [job["id"] for job in jobs] == ["child-0", "child-1", "child-2"] and {
        job["status"] for job in jobs
    } == {"finished"}


def test_driver_calls_outside_a_job_say_what_is_missing(monkeypatch):
    monkeypatch.delenv("MMT_JOB_ID", raising=False)
    monkeypatch.delenv("MMT_PROJECT_ID", raising=False)
    with DriverApi().client() as client, pytest.raises(ConfigurationError, match="MMT_JOB_ID"):
        submit_child_job(client, SPEC, key="k")


def test_a_manual_hook_start_carries_its_payload_and_a_resendable_key():
    api = DriverApi()
    with api.client() as client:
        execution = client.trigger_hook(PROJECT_ID, "hook-1", {"ref": "main"}, idempotency_key="deploy-42")
        generated = client.trigger_hook(PROJECT_ID, "hook-1")
        with pytest.raises(ConfigurationError, match="at most"):
            client.trigger_hook(PROJECT_ID, "hook-1", {"blob": "x" * (300 * 1024)})
    assert execution["payload"] == {"ref": "main"} and execution["idempotencyKey"] == "deploy-42"
    assert "payload" not in generated and len(generated["idempotencyKey"]) == 36


def test_a_job_array_is_created_with_its_partition_and_size_checked():
    api = DriverApi()
    with api.client() as client:
        created = client.create_job_array(
            PROJECT_ID,
            experiment_id="experiment-1",
            name="generate",
            kind="processing",
            code_version_id="code-1",
            target_id="site-1",
            size=64,
            input_dataset_version_ids=["version-1"],
            dataset_partition_version_id="version-1",
            gpu_count=1,
            retry_on_timeout=True,
        )
        with pytest.raises(ConfigurationError, match="size"):
            client.create_job_array(
                PROJECT_ID,
                experiment_id="e",
                name="n",
                kind="processing",
                code_version_id="c",
                target_id="t",
                size=0,
            )
    body = created["body"]
    assert body["size"] == 64 and body["datasetPartitionVersionId"] == "version-1"
    assert body["gpuCount"] == 1 and body["retryOnTimeout"] is True and "walltimeSeconds" not in body
