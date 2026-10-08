from __future__ import annotations

import io
import json

import httpx
import pytest

from mado_tracking import ApiError, Client, ConfigurationError
from mado_tracking.run import ARTIFACT_CHUNK_BYTES


def sdk_server(*, fail_finish: bool = False):
    calls = []
    entity = {
        "id": "run-one",
        "kind": "training",
        "status": "queued",
        "modelVersionId": "parent-version",
        "inputDatasetVersionIds": ["input-version"],
        "parameters": {},
    }

    def serve(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer sdk-test-secret"
        body = (
            json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        )
        calls.append((request.method, request.url.path, body, request.content))
        if request.method == "PATCH":
            if fail_finish and body.get("status") == "failed":
                return httpx.Response(403, json={"error": "rejected sdk-test-secret"})
            entity.update(body)
        if request.method == "PUT":
            return httpx.Response(200, json={"id": "artifact-one", "size": len(request.content)})
        if request.url.path.endswith("/versions"):
            return httpx.Response(201, json={"id": "output-version", **body})
        return httpx.Response(200, json=dict(entity))

    return Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    ), calls


def test_exception_marks_run_failed_and_preserves_original_exception():
    client, calls = sdk_server()
    with client, pytest.raises(ValueError, match="training broke"):
        with client.start_run(project_id="p", experiment_id="e", name="cpu training") as run:
            run.log_metrics({"loss": 0.8}, step=1)
            raise ValueError("training broke")
    statuses = [body["status"] for method, _, body, _ in calls if method == "PATCH" and "status" in body]
    assert statuses == ["running", "failed"]
    metrics = next(body["metrics"] for _, path, body, _ in calls if path.endswith("/metrics"))
    assert metrics[0]["name"] == "loss" and metrics[0]["step"] == 1 and metrics[0]["timestamp"].endswith("Z")


def test_reporting_failure_is_visible_without_hiding_the_training_exception():
    client, _calls = sdk_server(fail_finish=True)
    with client, pytest.raises(ValueError) as captured:
        with client.start_run(project_id="p", experiment_id="e", name="failed report"):
            raise ValueError("original")
    assert "Failed to report" in captured.value.__notes__[0]
    assert "sdk-test-secret" not in captured.value.__notes__[0]


def test_worker_owned_context_logs_without_changing_worker_status(monkeypatch):
    client, calls = sdk_server()
    monkeypatch.setenv("MMT_RUN_ID", "run-one")
    with client, client.start_run(project_id="p") as run:
        run.log("api token sdk-test-secret")
    assert not any(method == "PATCH" for method, *_ in calls)
    assert "sdk-test-secret" not in next(
        body["entries"][0]["message"] for _, path, body, _ in calls if path.endswith("/logs")
    )


def test_artifact_upload_reads_bounded_chunks_and_sends_raw_bytes():
    client, calls = sdk_server()

    class BoundedStream(io.BytesIO):
        def read(self, size=-1):
            assert 0 < size <= ARTIFACT_CHUNK_BYTES
            return super().read(size)

    content = b"model-binary\x00" * 150_000
    with client:
        run = client.get_run("p", "run-one")
        artifact = run.log_artifact(BoundedStream(content), path="weights/model.bin")
    assert artifact["size"] == len(content)
    assert next(raw for method, _, _, raw in calls if method == "PUT") == content


def test_output_registration_preserves_parent_versions_and_source_run():
    client, calls = sdk_server()
    with client:
        run = client.get_run("p", "run-one")
        run.register_output_model(model_id="m", version="v2", artifact_id="a")
        run.register_output_dataset(
            dataset_id="d", version="v2", uri="file:///output", digest="sha256:digest"
        )
    versions = [body for _, path, body, _ in calls if path.endswith("/versions")]
    assert versions[0]["parentModelVersionIds"] == ["parent-version"]
    assert versions[1]["parentDatasetVersionIds"] == ["input-version"]
    assert all(version["sourceRunId"] == "run-one" for version in versions)


def test_http_permission_failure_is_sanitized_and_not_retried():
    count = 0

    def reject(_request):
        nonlocal count
        count += 1
        return httpx.Response(403, json={"error": "denied sdk-test-secret", "code": "FORBIDDEN"})

    with (
        Client(
            api_url="http://localhost/api", api_token="sdk-test-secret", transport=httpx.MockTransport(reject)
        ) as client,
        pytest.raises(ApiError) as captured,
    ):
        client.request("GET", "projects", retryable=True)
    assert count == 1 and captured.value.status_code == 403
    assert "sdk-test-secret" not in str(captured.value)


def registry_server(*, existing_models=(), lose_create_race=False):
    """Serve the native Model registry with name lookup and automatic version numbering."""
    models = {model["name"]: dict(model) for model in existing_models}
    versions: list[dict] = []
    calls = []

    def serve(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, dict(request.url.params), body))
        if request.url.path == "/api/projects/p/models" and request.method == "GET":
            name = request.url.params.get("name")
            return httpx.Response(200, json={"items": [models[name]] if name in models else []})
        if request.url.path == "/api/projects/p/models" and request.method == "POST":
            if lose_create_race:
                # Another worker created the same Model between our lookup and POST.
                models[body["name"]] = {"id": "model-race", "name": body["name"], "family": body["family"]}
            if body["name"] in models:
                return httpx.Response(409, json={"error": "exists", "code": "already_exists"})
            models[body["name"]] = {"id": f"model-{len(models) + 1}", **body}
            return httpx.Response(201, json=models[body["name"]])
        if request.url.path.endswith("/versions"):
            model_id = request.url.path.split("/")[-2]
            number = sum(version["modelId"] == model_id for version in versions) + 1
            version = {
                "id": f"version-{len(versions) + 1}",
                "modelId": model_id,
                "version": str(number),
                **body,
            }
            versions.append(version)
            return httpx.Response(201, json=version)
        return httpx.Response(404, json={"error": "unexpected"})

    client = Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    )
    return client, calls


def test_model_name_reuses_one_model_and_lets_the_api_number_versions():
    client, calls = registry_server()
    with client:
        first = client.register_model("p", model_name="cpu-linear", family="linear", artifact_id="a1")
        second = client.register_model("p", model_name="cpu-linear", family="linear", artifact_id="a2")
    assert first["modelId"] == second["modelId"]
    assert [first["version"], second["version"]] == ["1", "2"]
    assert [method for method, path, *_ in calls if path == "/api/projects/p/models"] == [
        "GET",
        "POST",
        "GET",
    ]
    assert all("version" not in body for _, path, _, body in calls if path.endswith("/versions"))


def test_model_creation_conflict_is_resolved_by_reading_the_winner():
    client, calls = registry_server(lose_create_race=True)
    with client:
        version = client.register_model("p", model_name="shared", family="linear")
    assert version["modelId"] == "model-race"
    assert [method for method, path, *_ in calls if path == "/api/projects/p/models"] == [
        "GET",
        "POST",
        "GET",
    ]


def test_existing_model_with_another_family_is_not_reused():
    client, calls = registry_server(existing_models=[{"id": "m1", "name": "qwen", "family": "qwen3"}])
    with client, pytest.raises(ConfigurationError, match="family"):
        client.register_model("p", model_name="qwen", family="linear")
    assert not any(path.endswith("/versions") for _, path, *_ in calls)


def test_output_model_with_model_name_keeps_source_run_and_explicit_version():
    client, calls = sdk_server()
    with client:
        run = client.get_run("p", "run-one")
        run.register_output_model(model_id="m", artifact_id="a")
        run.register_output_model(model_id="m", version="7", artifact_id="a")
    versions = [body for _, path, body, _ in calls if path.endswith("/versions")]
    assert "version" not in versions[0] and versions[1]["version"] == "7"
    assert all(version["sourceRunId"] == "run-one" for version in versions)


def run_search_server(pages: list[dict]):
    requests = []

    def serve(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST" and request.url.path.endswith("/projects/p/runs/search")
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json=pages[len(requests) - 1])

    client = Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    )
    return client, requests


def test_search_runs_follows_cursors_lazily_with_the_same_conditions():
    client, requests = run_search_server(
        [
            {"items": [{"id": "run-3"}, {"id": "run-2"}], "nextCursor": "cursor-a"},
            {"items": [{"id": "run-1"}], "nextCursor": None},
        ]
    )
    with client:
        runs = client.search_runs(
            "p",
            filter="metrics.loss < 0.1",
            order_by=["metrics.loss ASC"],
            experiment_ids=["e"],
            page_size=2,
        )
        assert requests == []
        assert next(runs)["id"] == "run-3"
        assert len(requests) == 1
        assert [run["id"] for run in runs] == ["run-2", "run-1"]
    condition = {
        "filter": "metrics.loss < 0.1",
        "orderBy": ["metrics.loss ASC"],
        "experimentIds": ["e"],
        "limit": 2,
    }
    assert requests == [condition, {**condition, "cursor": "cursor-a"}]


def test_search_runs_rejects_repeated_cursor_and_invalid_page_size():
    client, _requests = run_search_server(
        [
            {"items": [{"id": "run-2"}], "nextCursor": "same"},
            {"items": [{"id": "run-1"}], "nextCursor": "same"},
        ]
    )
    with client:
        with pytest.raises(ConfigurationError, match="repeated pagination cursor"):
            list(client.search_runs("p"))
        with pytest.raises(ConfigurationError, match="page_size"):
            list(client.search_runs("p", page_size=501))
        with pytest.raises(ConfigurationError, match="sequences"):
            list(client.search_runs("p", order_by="metrics.loss ASC"))
