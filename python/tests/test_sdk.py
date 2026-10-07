from __future__ import annotations

import io
import json

import httpx
import pytest

from mado_tracking import ApiError, Client
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
