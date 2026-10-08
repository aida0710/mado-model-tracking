from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path

import httpx
import pytest

from mado_tracking.worker.container_outputs import (
    parse_output_index,
    read_output_chunk,
    read_output_index,
    validate_results,
)


def completed_result(root, *, content=b'[{"prediction":0.9}]'):
    (root / "predictions.json").write_bytes(content)
    manifest = {
        "version": 1,
        "complete": True,
        "artifacts": [
            {"path": "predictions.json", "sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
        ],
        "metrics": [{"name": "accuracy", "value": 0.9}],
    }
    (root / "result.json").write_text(json.dumps(manifest))
    return manifest


def test_completed_files_are_verified_and_read_in_bounded_chunks_with_stable_metric_timestamps(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    content = b"output" * 30_000
    completed_result(outputs, content=content)
    results = validate_results(outputs)
    assert results["metrics"][0]["step"] == 0
    assert results["metrics"][0]["timestamp"].endswith("Z")
    state = {"status": "finished", "results": results}
    offset, received = 0, bytearray()
    while offset < len(content):
        chunk = read_output_chunk(tmp_path, {"path": "predictions.json", "offset": offset}, state)
        assert chunk["nextOffset"] > offset
        received.extend(base64.b64decode(chunk["content"]))
        offset = chunk["nextOffset"]
    assert received == content
    with pytest.raises(ValueError, match="declared"):
        read_output_chunk(tmp_path, {"path": "../spec.json"}, state)


@pytest.mark.parametrize(
    "path", ["../private", "/etc/passwd", "nested/../../private", "x\\y", "predictions.partial"]
)
def test_result_manifest_rejects_paths_outside_outputs_or_unfinished_names(tmp_path, path):
    manifest = completed_result(tmp_path)
    manifest["artifacts"][0]["path"] = path
    (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Output path"):
        validate_results(tmp_path)


@pytest.mark.parametrize("link_kind", ["file-symlink", "directory-symlink", "hardlink", "fifo"])
def test_result_collection_never_follows_links_or_reads_special_files(tmp_path, link_kind):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    completed_result(outputs)
    private = tmp_path / "private"
    private.write_bytes(b"private bytes")
    path = outputs / "predictions.json"
    path.unlink()
    if link_kind == "file-symlink":
        path.symlink_to(private)
    elif link_kind == "directory-symlink":
        path.write_bytes(b"output")
        (outputs / "nested").symlink_to(tmp_path, target_is_directory=True)
    elif link_kind == "hardlink":
        os.link(private, path)
    else:
        os.mkfifo(path)
    with pytest.raises((ValueError, OSError)):
        validate_results(outputs)


@pytest.mark.parametrize(
    "change", ["no-manifest", "incomplete", "sha-mismatch", "size-mismatch", "undeclared", "partial"]
)
def test_missing_or_incomplete_outputs_cannot_be_reported_as_success(tmp_path, change):
    manifest = completed_result(tmp_path)
    if change == "no-manifest":
        (tmp_path / "result.json").unlink()
    else:
        if change == "incomplete":
            manifest["complete"] = False
        elif change == "sha-mismatch":
            manifest["artifacts"][0]["sha256"] = "0" * 64
        elif change == "size-mismatch":
            manifest["artifacts"][0]["size"] += 1
        else:
            (tmp_path / ("extra.txt" if change == "undeclared" else "download.partial")).write_text(
                "incomplete"
            )
        (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        validate_results(tmp_path)


@pytest.mark.parametrize(
    "metric",
    [
        {"name": "loss", "value": float("nan")},
        {"name": "loss", "value": float("inf")},
        {"name": "loss", "value": True},
        {"name": "loss", "value": 0, "step": -1},
        {"name": "loss", "value": 0, "timestamp": "2026-10-08"},
        {"name": "", "value": 0},
    ],
)
def test_invalid_metrics_fail_result_validation_before_any_file_is_uploaded(tmp_path, metric):
    manifest = completed_result(tmp_path)
    manifest["metrics"] = [metric]
    (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        validate_results(tmp_path)


def test_read_after_completion_rejects_new_symlinks_and_changed_file_sizes(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    completed_result(outputs)
    state = {"status": "finished", "results": validate_results(outputs)}
    path = outputs / "predictions.json"
    path.write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed"):
        read_output_chunk(tmp_path, {"path": "predictions.json"}, state)
    path.unlink()
    path.symlink_to(tmp_path / "spec.json")
    with pytest.raises(OSError):
        read_output_chunk(tmp_path, {"path": "predictions.json"}, state)


def write_file(outputs, path, content):
    (outputs / path).parent.mkdir(parents=True, exist_ok=True)
    (outputs / path).write_bytes(content)
    return {"path": path, "sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}


def version_two_outputs(tmp_path, **fields):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    weights = write_file(outputs, "model/weights.bin", b"weights")
    split = write_file(outputs, "data/test.jsonl", b'{"audio":"a.wav"}\n')
    result = {"version": 2, "complete": True, "artifacts": [weights, split], **fields}
    (outputs / "result.json").write_text(json.dumps(result))
    return outputs


def test_version_two_declarations_are_numbered_models_first_then_datasets(tmp_path):
    dataset_id = "8d4c4b2e-7f3a-4c55-9d61-0f5f8f0f3a11"
    outputs = version_two_outputs(
        tmp_path,
        models=[{"path": "model/weights.bin", "metadata": {"epoch": 3}}],
        datasets=[
            {"datasetId": dataset_id, "path": "data/test.jsonl", "digest": "sha256:abc"},
            {"datasetId": dataset_id, "uri": "s3://bucket/eval/", "digest": "etag-1", "schema": {"a": 1}},
        ],
    )
    results = validate_results(outputs)
    assert results["version"] == 2 and results["artifactCount"] == 2
    assert results["declarations"] == [
        {"index": 0, "kind": "model", "path": "model/weights.bin", "metadata": {"epoch": 3}},
        {
            "index": 1,
            "kind": "dataset",
            "datasetId": dataset_id,
            "path": "data/test.jsonl",
            "digest": "sha256:abc",
        },
        {
            "index": 2,
            "kind": "dataset",
            "datasetId": dataset_id,
            "uri": "s3://bucket/eval/",
            "digest": "etag-1",
            "schema": {"a": 1},
        },
    ]


DATASET_ID = "8d4c4b2e-7f3a-4c55-9d61-0f5f8f0f3a11"


@pytest.mark.parametrize(
    "fields",
    [
        {"models": [{"path": "model/missing.bin"}]},
        {"models": [{"path": "result.json"}]},
        {"datasets": [{"datasetId": DATASET_ID, "path": "data/other.jsonl", "digest": "d"}]},
        {"models": [{"path": "model/weights.bin"}] * 17},
        {"datasets": [{"datasetId": DATASET_ID, "uri": "s3://b/x", "digest": "d"}] * 65},
        {
            "datasets": [
                {"datasetId": DATASET_ID, "uri": "s3://b/x", "path": "data/test.jsonl", "digest": "d"}
            ]
        },
        {"datasets": [{"datasetId": DATASET_ID, "path": "data/test.jsonl"}]},
        {"models": [{"path": "model/weights.bin", "metadata": ["not", "an", "object"]}]},
        {"models": [{"path": "model/weights.bin", "registeredName": "unknown field"}]},
    ],
    ids=[
        "undeclared-model-path",
        "result-json-as-model",
        "undeclared-dataset-path",
        "too-many-models",
        "too-many-datasets",
        "uri-and-path",
        "missing-digest",
        "metadata-not-object",
        "unknown-field",
    ],
)
def test_invalid_version_two_declarations_fail_before_any_output_is_saved(tmp_path, fields):
    outputs = version_two_outputs(tmp_path, **fields)
    with pytest.raises(ValueError):
        validate_results(outputs)
    assert not (tmp_path / "output-index.jsonl").exists()


@pytest.mark.parametrize("field", ["models", "datasets", "artifactsManifest"])
def test_version_one_keeps_its_fields_and_rejects_version_two_fields(tmp_path, field):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    completed_result(outputs)
    manifest = json.loads((outputs / "result.json").read_text())
    assert validate_results(outputs)["declarations"] == []
    manifest[field] = "artifacts.jsonl" if field == "artifactsManifest" else []
    (outputs / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="version"):
        validate_results(outputs)


def test_json_lines_manifest_adds_outputs_beyond_result_json_and_is_not_an_output_itself(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    lines = [json.dumps(write_file(outputs, f"audio/{number}.wav", b"x" * number)) for number in range(300)]
    (outputs / "artifacts.jsonl").write_text("\n".join(lines) + "\n\n")
    (outputs / "result.json").write_text(
        json.dumps({"version": 2, "complete": True, "artifactsManifest": "artifacts.jsonl"})
    )
    results = validate_results(outputs)
    index = parse_output_index(read_output_index(tmp_path, results))
    assert results["artifactCount"] == 300 == len(index)
    assert index[299] == {
        "path": "audio/299.wav",
        "sha256": hashlib.sha256(b"x" * 299).hexdigest(),
        "size": 299,
        "mimeType": "application/octet-stream",
    }
    assert "artifacts.jsonl" not in {artifact["path"] for artifact in index}
    # The job state holds only the summary, whatever the number of files.
    assert "artifacts" not in results and len(json.dumps(results)) < 1024


@pytest.mark.parametrize("problem", ["not-json", "long-line", "lists-result-json", "duplicate"])
def test_invalid_json_lines_manifest_is_rejected(tmp_path, problem):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    entry = write_file(outputs, "a.wav", b"audio")
    lines = {
        "not-json": "{not json",
        "long-line": json.dumps({**entry, "mimeType": "audio/wav" + " " * 5000}),
        "lists-result-json": json.dumps({**entry, "path": "result.json"}),
        "duplicate": json.dumps(entry) + "\n" + json.dumps(entry),
    }[problem]
    (outputs / "artifacts.jsonl").write_text(lines + "\n")
    (outputs / "result.json").write_text(
        json.dumps({"version": 2, "complete": True, "artifactsManifest": "artifacts.jsonl"})
    )
    with pytest.raises(ValueError):
        validate_results(outputs)


def test_output_file_limit_comes_from_the_worker_setting_in_the_job_spec(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    artifacts = [write_file(outputs, f"{number}.wav", b"a") for number in range(5)]
    (outputs / "result.json").write_text(json.dumps({"version": 1, "complete": True, "artifacts": artifacts}))
    assert validate_results(outputs)["artifactCount"] == 5
    (tmp_path / "spec.json").write_text(json.dumps({"maxOutputFiles": 4}))
    with pytest.raises(ValueError, match="limit 4"):
        validate_results(outputs)
    assert validate_results(outputs, max_files=5)["artifactCount"] == 5


def test_worker_setting_rejects_an_invalid_output_file_limit(monkeypatch):
    from mado_tracking.errors import ConfigurationError
    from mado_tracking.worker.config import WorkerSettings

    monkeypatch.setenv("MMT_WORKER_ID", "limit-test")
    monkeypatch.setenv("MMT_API_URL", "http://localhost/api")
    monkeypatch.setenv("MMT_API_TOKEN", "test-token")
    monkeypatch.setenv("MMT_WORKER_MAX_OUTPUT_FILES", "50000")
    assert WorkerSettings.from_environment().max_output_files == 50000
    monkeypatch.setenv("MMT_WORKER_MAX_OUTPUT_FILES", "0")
    with pytest.raises(ConfigurationError, match="MMT_WORKER_MAX_OUTPUT_FILES"):
        WorkerSettings.from_environment()


def declaration_results():
    return {
        "artifactCount": 0,
        "metrics": [],
        "declarations": [
            {"index": 0, "kind": "model", "path": "model/weights.bin"},
            {"index": 1, "kind": "dataset", "datasetId": DATASET_ID, "uri": "s3://b/x", "digest": "d"},
        ],
    }


def forward_declarations(worker_job, serve, acknowledgments, persisted):
    from mado_tracking.worker.api import WorkerApi
    from mado_tracking.worker.session_outputs import forward_container_outputs

    async def scenario():
        api = WorkerApi(url="http://localhost/api", token="secret", transport=httpx.MockTransport(serve))
        try:
            await forward_container_outputs(
                worker_job,
                declaration_results(),
                api=api,
                executor=None,  # artifactCount=0: no archive is fetched
                acknowledgments=acknowledgments,
                persist=lambda: persisted.append(json.loads(json.dumps(acknowledgments))),
                temporary_path=Path("/nonexistent"),
            )
        finally:
            await api.close()

    asyncio.run(scenario())


def test_lost_declaration_response_is_resent_by_index_without_registering_twice(worker_job):
    registered: dict[int, str] = {}
    requests: list[list[int]] = []

    def serve(request):
        declarations = json.loads(request.content)["declarations"]
        requests.append([declaration["index"] for declaration in declarations])
        for declaration in declarations:
            registered.setdefault(declaration["index"], f"version-{len(registered)}")
        if len(requests) == 1:
            raise httpx.ReadError("response lost after the API saved the declarations", request=request)
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "index": index,
                        "kind": "model",
                        "modelVersionId": registered[index],
                        "datasetVersionId": None,
                        "createdAt": "2026-10-08T00:00:00Z",
                    }
                    for index in requests[-1]
                ]
            },
        )

    acknowledgments: dict = {}
    persisted: list[dict] = []
    forward_declarations(worker_job, serve, acknowledgments, persisted)
    assert requests == [[0, 1], [0, 1]]
    assert registered == {0: "version-0", 1: "version-1"}
    assert persisted[-1]["declarations"] == [0, 1]
    # A worker restarted after the journal write sends nothing again.
    forward_declarations(worker_job, serve, acknowledgments, persisted)
    assert len(requests) == 2


@pytest.mark.parametrize(
    ("status", "code", "lease_lost"),
    [(409, "invalid_lease", True), (403, "insufficient_scope", False), (404, "not_found", False)],
)
def test_declaration_errors_fail_the_run_unless_the_lease_itself_is_gone(
    worker_job, status, code, lease_lost
):
    from mado_tracking.errors import ApiError, LeaseRejected

    def serve(request):
        return httpx.Response(status, json={"error": "rejected", "code": code})

    with pytest.raises(ApiError) as raised:
        forward_declarations(worker_job, serve, {}, [])
    assert isinstance(raised.value, LeaseRejected) is lease_lost
