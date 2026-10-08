"""Input DatasetVersion files reach the target's cache, verified, before a Job starts."""

from __future__ import annotations

import asyncio
import copy
import datetime
import hashlib
import io
import json
import os
import threading
import time
from collections import Counter
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
from test_docker_worker import docker_image as docker_image  # noqa: F401
from test_docker_worker import docker_job, workspace_for
from test_worker import WorkerServer

from mado_tracking.dataset_upload import manifest_entries_digest
from mado_tracking.settings import ApiSettings
from mado_tracking.worker import dataset_downloads, dataset_staging
from mado_tracking.worker.container_layout import container_environment, prepare_container_layout
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.dataset_cache import (
    COMPLETE_MARKER,
    LAST_USED_FILE,
    DatasetCache,
    DatasetCacheError,
)
from mado_tracking.worker.dataset_downloads import S3Location, fetch_s3, sign_s3_request
from mado_tracking.worker.service import Worker

JOB_TIMEOUT_SECONDS = 20
READER_SCRIPT = (
    "import json, os, pathlib\n"
    "dirs = json.loads(os.environ['MMT_INPUT_DATASET_DIRS'])\n"
    "for version_id, directory in sorted(dirs.items()):\n"
    "    root = pathlib.Path(directory)\n"
    "    for path in sorted(root.rglob('*')):\n"
    "        if path.is_file():\n"
    "            name = path.relative_to(root).as_posix()\n"
    "            print('file=' + name + ':' + path.read_bytes().decode(), flush=True)\n"
    "    try:\n"
    "        (root / 'new.txt').write_text('x')\n"
    "        print('writable', flush=True)\n"
    "    except OSError:\n"
    "        print('read-only', flush=True)\n"
)
AUDIO_FILES = {"audio/0001.wav": b"RIFF-first", "audio/nested/0002.wav": b"RIFF-second", "meta.jsonl": b"{}"}


class DatasetContent:
    """Stored Artifacts of 'artifacts' DatasetVersions; shared by the fake APIs of several Jobs."""

    def __init__(self) -> None:
        self.files: dict[str, list[dict[str, Any]]] = {}
        self.contents: dict[str, bytes] = {}
        self.downloads: Counter[str] = Counter()
        self.corrupt = False

    def add_version(self, project_id: str, files: dict[str, bytes]) -> dict[str, Any]:
        version_id = str(uuid4())
        entries = []
        for path, content in files.items():
            artifact_id = str(uuid4())
            self.contents[artifact_id] = content
            entries.append(
                {
                    "path": path,
                    "artifactId": artifact_id,
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "mimeType": "audio/wav",
                }
            )
        self.files[version_id] = entries
        return {
            "id": version_id,
            "datasetId": str(uuid4()),
            "projectId": project_id,
            "uri": f"mmt-dataset://{version_id}",
            "digest": manifest_entries_digest(entries),
            "contentKind": "artifacts",
            "fileCount": len(entries),
            "totalSize": sum(entry["size"] for entry in entries),
            "metadata": {},
        }

    def artifact_content(self, artifact_id: str) -> bytes:
        self.downloads[artifact_id] += 1
        content = self.contents[artifact_id]
        return b"X" + content[1:] if self.corrupt else content


class DatasetServer(WorkerServer):
    def __init__(self, payload: dict, content: DatasetContent):
        super().__init__(payload)
        self.content = content

    def serve(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and "/versions/" in path and path.endswith("/files"):
            assert request.headers["Authorization"] == "Bearer test-api-secret"
            items = self.content.files[path.split("/")[-2]]
            # One file per page, so the worker must follow nextCursor.
            start = int(request.url.params.get("cursor", "0"))
            page: dict[str, Any] = {"items": items[start : start + 1]}
            if start + 1 < len(items):
                page["nextCursor"] = str(start + 1)
            return httpx.Response(200, json=page)
        if request.method == "GET" and path.endswith("/content"):
            assert request.headers["Authorization"] == "Bearer test-api-secret"
            return httpx.Response(200, content=self.content.artifact_content(path.split("/")[-2]))
        return super().serve(request)

    def messages(self) -> str:
        return "".join(
            entry["message"]
            for path, body in self.calls
            if path.endswith("/logs")
            for entry in body["entries"]
        )


def reader_job(payload: dict, datasets: list[dict], *, gpu_ids: tuple[str, ...] = ()) -> dict:
    payload["run"]["kind"] = "inference"
    payload["run"]["inputDatasetVersionIds"] = [dataset["id"] for dataset in datasets]
    payload["inputDatasets"] = datasets
    payload["codeVersion"]["source"]["files"]["main.py"] = READER_SCRIPT
    payload["target"]["gpuIds"] = list(gpu_ids)
    payload["job"]["gpuIds"] = list(gpu_ids)
    return payload


def another_job(payload: dict) -> dict:
    """The same pinned inputs in a new Job and Run on the same target."""
    copied = copy.deepcopy(payload)
    run_id = str(uuid4())
    copied["job"].update(id=str(uuid4()), runId=run_id, leaseId=str(uuid4()))
    copied["run"]["id"] = run_id
    return copied


async def run_jobs(settings, servers: list[DatasetServer]) -> None:
    workers = [Worker(settings, api=server.client()) for server in servers]
    try:
        await asyncio.wait_for(
            asyncio.gather(
                *(
                    worker.run_job(WorkerJob.parse(server.payload))
                    for worker, server in zip(workers, servers, strict=True)
                )
            ),
            JOB_TIMEOUT_SECONDS,
        )
    finally:
        for worker in workers:
            await worker.api.close()


def cache_root(payload: dict) -> Path:
    return Path(payload["target"]["workDirectory"]) / ".mmt-cache" / "datasets"


def test_relayed_files_are_verified_read_only_and_a_second_job_hits_the_cache(job_payload, worker_settings):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    first = DatasetServer(reader_job(job_payload, [dataset]), content)
    asyncio.run(run_jobs(worker_settings, [first]))

    assert first.completions[-1]["status"] == "finished", first.completions[-1]
    messages = first.messages()
    for path, data in AUDIO_FILES.items():
        assert f"file={path}:{data.decode()}" in messages
    assert "read-only" in messages and "writable" not in messages
    link = workspace_for(job_payload) / "inputs" / "datasets" / dataset["id"]
    assert link.is_symlink()
    assert link.resolve() == cache_root(job_payload) / dataset["digest"].removeprefix("sha256:") / "data"
    assert sum(content.downloads.values()) == len(AUDIO_FILES)

    second = DatasetServer(another_job(first.payload), content)
    asyncio.run(run_jobs(worker_settings, [second]))
    assert second.completions[-1]["status"] == "finished"
    assert "file=meta.jsonl:{}" in second.messages()
    # The cache entry is complete, so nothing was downloaded again.
    assert sum(content.downloads.values()) == len(AUDIO_FILES)


def test_two_parallel_jobs_with_the_same_digest_download_each_file_once(job_payload, worker_settings):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    first = DatasetServer(reader_job(job_payload, [dataset]), content)
    second = DatasetServer(another_job(first.payload), content)
    asyncio.run(run_jobs(worker_settings, [first, second]))

    assert [server.completions[-1]["status"] for server in (first, second)] == ["finished", "finished"]
    assert set(content.downloads.values()) == {1}


def test_a_sha256_mismatch_fails_the_job_before_its_code_starts(job_payload, worker_settings):
    content = DatasetContent()
    content.corrupt = True
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    server = DatasetServer(reader_job(job_payload, [dataset], gpu_ids=("0",)), content)
    asyncio.run(run_jobs(worker_settings, [server]))

    completion = server.completions[-1]
    assert completion["status"] == "failed" and "sha256" in completion["error"]
    assert not (workspace_for(job_payload) / "state.json").exists()
    assert "Job inputs could not be prepared" in server.messages()
    assert not any(entry.is_dir() for entry in cache_root(job_payload).glob("*"))


def test_a_file_list_that_does_not_match_the_digest_fails_before_download(job_payload, worker_settings):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    dataset["digest"] = "sha256:" + "0" * 64
    server = DatasetServer(reader_job(job_payload, [dataset]), content)
    asyncio.run(run_jobs(worker_settings, [server]))

    assert server.completions[-1]["status"] == "failed"
    assert "do not match its digest" in server.completions[-1]["error"]
    assert not content.downloads


def test_an_unsupported_scheme_fails_before_start_and_completes_so_the_api_frees_the_gpus(
    job_payload, worker_settings
):
    project_id = job_payload["job"]["projectId"]
    dataset = {
        "id": str(uuid4()),
        "datasetId": str(uuid4()),
        "projectId": project_id,
        "uri": "gs://bucket/corpus",
        "digest": "abc",
        "contentKind": "reference",
        "fileCount": None,
    }
    server = DatasetServer(reader_job(job_payload, [dataset], gpu_ids=("0",)), DatasetContent())
    asyncio.run(run_jobs(worker_settings, [server]))

    # complete(failed) is what releases the Job's GPU reservation on the API side.
    completion = server.completions[-1]
    assert completion["status"] == "failed" and "gs" in completion["error"]
    assert "supported: file://, https://, s3://" in server.messages()
    assert not (workspace_for(job_payload) / "state.json").exists()


def test_descriptor_only_references_start_without_a_directory(job_payload, worker_settings):
    dataset = {
        "id": str(uuid4()),
        "datasetId": str(uuid4()),
        "projectId": job_payload["job"]["projectId"],
        "uri": "mmt-artifact://runs/upstream/inference",
        "digest": "abc",
        "contentKind": "reference",
        "fileCount": None,
    }
    server = DatasetServer(reader_job(job_payload, [dataset]), DatasetContent())
    asyncio.run(run_jobs(worker_settings, [server]))

    assert server.completions[-1]["status"] == "finished"
    assert "is a descriptor only" in server.messages()


def test_a_file_reference_is_linked_in_place_and_a_missing_path_fails(job_payload, worker_settings, tmp_path):
    corpus = tmp_path / "corpus"
    (corpus / "clips").mkdir(parents=True)
    (corpus / "clips" / "a.wav").write_bytes(b"RIFF-local")
    dataset = {
        "id": str(uuid4()),
        "datasetId": str(uuid4()),
        "projectId": job_payload["job"]["projectId"],
        "uri": corpus.as_uri(),
        "digest": "local",
        "contentKind": "reference",
        "fileCount": None,
    }
    server = DatasetServer(reader_job(job_payload, [dataset]), DatasetContent())
    asyncio.run(run_jobs(worker_settings, [server]))
    assert server.completions[-1]["status"] == "finished"
    assert "file=clips/a.wav:RIFF-local" in server.messages()
    assert (workspace_for(job_payload) / "inputs/datasets" / dataset["id"]).resolve() == corpus

    missing = another_job(server.payload)
    missing["inputDatasets"][0]["uri"] = (tmp_path / "absent").as_uri()
    failed = DatasetServer(missing, DatasetContent())
    asyncio.run(run_jobs(worker_settings, [failed]))
    assert failed.completions[-1]["status"] == "failed"
    assert "does not exist on the target" in failed.completions[-1]["error"]


class JobTokenArtifactHandler(BaseHTTPRequestHandler):
    """The API as the target sees it in 'direct' transfer: only the Job token may read."""

    content: DatasetContent
    authorizations: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's method name
        self.authorizations.append(self.headers.get("Authorization", ""))
        if self.headers.get("Authorization") != "Bearer mmtj_test-job-token":
            self.send_response(401)
            self.end_headers()
            return
        body = self.content.artifact_content(urlsplit(self.path).path.split("/")[-2])
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_arguments: object) -> None:
        pass


def test_direct_transfer_downloads_on_the_target_with_the_job_token(job_payload, worker_settings):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    JobTokenArtifactHandler.content = content
    JobTokenArtifactHandler.authorizations = []
    http_server = ThreadingHTTPServer(("127.0.0.1", 0), JobTokenArtifactHandler)
    threading.Thread(target=http_server.serve_forever, daemon=True).start()
    payload = reader_job(job_payload, [dataset])
    payload["target"]["datasetTransfer"] = "direct"
    settings = replace(
        worker_settings, api=ApiSettings(f"http://127.0.0.1:{http_server.server_port}/api", "test-api-secret")
    )
    server = DatasetServer(payload, content)
    try:
        asyncio.run(run_jobs(settings, [server]))
    finally:
        http_server.shutdown()
        http_server.server_close()

    assert server.completions[-1]["status"] == "finished", server.completions[-1]
    assert "file=audio/nested/0002.wav:RIFF-second" in server.messages()
    assert JobTokenArtifactHandler.authorizations == ["Bearer mmtj_test-job-token"] * len(AUDIO_FILES)
    # The worker token is never sent there, and the worker did not download anything itself.
    assert "test-api-secret" not in "".join(JobTokenArtifactHandler.authorizations)


def test_a_relayed_https_reference_is_checked_against_a_sha256_digest(
    job_payload, worker_settings, monkeypatch
):
    body = b"RIFF-remote"

    async def fake_download(uri: str, destination: Any, *, maximum_bytes: int) -> dict[str, Any]:
        assert uri == "https://data.example.invalid/sets/clip.wav" and maximum_bytes == 10 * 1024**2
        destination.write(body)
        return {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}

    monkeypatch.setattr(dataset_staging, "download_https_reference", fake_download)
    dataset = {
        "id": str(uuid4()),
        "datasetId": str(uuid4()),
        "projectId": job_payload["job"]["projectId"],
        "uri": "https://data.example.invalid/sets/clip.wav",
        "digest": "sha256:" + hashlib.sha256(body).hexdigest(),
        "contentKind": "reference",
        "fileCount": None,
    }
    payload = reader_job(job_payload, [dataset])
    payload["target"]["datasetCacheMaxBytes"] = 10 * 1024**2
    server = DatasetServer(payload, DatasetContent())
    asyncio.run(run_jobs(worker_settings, [server]))
    assert server.completions[-1]["status"] == "finished"
    assert "file=clip.wav:RIFF-remote" in server.messages()

    mismatched = another_job(server.payload)
    mismatched["inputDatasets"][0]["uri"] = "https://data.example.invalid/sets/clip.wav"
    mismatched["inputDatasets"][0]["digest"] = "sha256:" + "1" * 64
    failed = DatasetServer(mismatched, DatasetContent())
    asyncio.run(run_jobs(worker_settings, [failed]))
    assert failed.completions[-1]["status"] == "failed"
    assert "differs from its digest" in failed.completions[-1]["error"]


def test_a_dataset_larger_than_the_cache_limit_fails_before_download(job_payload, worker_settings):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], AUDIO_FILES)
    payload = reader_job(job_payload, [dataset])
    payload["target"]["datasetCacheMaxBytes"] = 8
    server = DatasetServer(payload, content)
    asyncio.run(run_jobs(worker_settings, [server]))
    assert server.completions[-1]["status"] == "failed"
    assert "larger than the target's dataset cache limit" in server.completions[-1]["error"]
    assert not content.downloads


# --- the target-side cache ---------------------------------------------------------------------


def job_workspace(work_directory: Path, status: str | None) -> Path:
    workspace = work_directory / str(uuid4())
    workspace.mkdir(parents=True)
    if status is not None:
        (workspace / "state.json").write_text(json.dumps({"status": status}))
    return workspace


def write_files(files: dict[str, bytes]):
    def fill(data: Path) -> list[dict[str, Any]]:
        for path, body in files.items():
            (data / path).parent.mkdir(parents=True, exist_ok=True)
            (data / path).write_bytes(body)
        return [{"path": path, "sha256": None, "size": len(body)} for path, body in files.items()]

    return fill


def test_an_interrupted_entry_without_a_completion_marker_is_rebuilt(tmp_path):
    cache = DatasetCache(tmp_path / "cache")
    stale = cache.data_path("abc")
    stale.mkdir(parents=True)
    (stale / "half.wav").write_bytes(b"RI")
    calls = []

    def fill(data: Path) -> list[dict[str, Any]]:
        calls.append(data)
        return write_files({"clip.wav": b"RIFF"})(data)

    workspace = job_workspace(tmp_path / "work", None)
    response = cache.materialize(
        "abc", files=None, total_size=4, max_bytes=100, workspace=workspace, fill=fill
    )
    assert response["status"] == "fetched" and len(calls) == 1
    assert sorted(path.name for path in stale.iterdir()) == ["clip.wav"]
    assert (cache.entry("abc") / COMPLETE_MARKER).is_file()
    again = cache.materialize("abc", files=None, total_size=4, max_bytes=100, workspace=workspace, fill=fill)
    assert again["status"] == "cached" and len(calls) == 1


def test_a_verification_failure_leaves_no_entry(tmp_path):
    cache = DatasetCache(tmp_path / "cache")
    with pytest.raises(DatasetCacheError, match="sha256 or size mismatch"):
        cache.materialize(
            "abc",
            files=[{"path": "clip.wav", "sha256": "0" * 64, "size": 4}],
            total_size=4,
            max_bytes=100,
            workspace=job_workspace(tmp_path / "work", None),
            fill=write_files({"clip.wav": b"RIFF"}),
        )
    assert not cache.entry("abc").exists()


def test_two_processes_filling_the_same_key_fetch_once(tmp_path):
    cache = DatasetCache(tmp_path / "cache")
    fills: list[int] = []

    def slow_fill(data: Path) -> list[dict[str, Any]]:
        fills.append(1)
        time.sleep(0.3)
        return write_files({"clip.wav": b"RIFF"})(data)

    results: list[dict[str, Any]] = []

    def materialize() -> None:
        # Separate DatasetCache objects open their own lock files, as two runner processes do.
        results.append(
            DatasetCache(tmp_path / "cache").materialize(
                "shared",
                files=None,
                total_size=4,
                max_bytes=100,
                workspace=job_workspace(tmp_path / "work", None),
                fill=slow_fill,
            )
        )

    threads = [threading.Thread(target=materialize) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(fills) == 1
    assert sorted(result["status"] for result in results) == ["cached", "fetched"]
    assert cache.is_complete("shared")


def age_entry(cache: DatasetCache, key: str, seconds_ago: float) -> None:
    used_at = time.time() - seconds_ago
    os.utime(cache.entry(key) / LAST_USED_FILE, (used_at, used_at))


def test_over_the_limit_the_least_recently_used_unused_entries_are_deleted_first(tmp_path):
    cache = DatasetCache(tmp_path / "cache")
    work = tmp_path / "work"
    running, finished = job_workspace(work, "running"), job_workspace(work, "finished")
    for key, workspace in (("oldest-in-use", running), ("older-done", finished), ("newer-done", finished)):
        cache.materialize(
            key,
            files=None,
            total_size=4,
            max_bytes=100,
            workspace=workspace,
            fill=write_files({"a": b"1234"}),
        )
    age_entry(cache, "oldest-in-use", 300)
    age_entry(cache, "older-done", 200)
    age_entry(cache, "newer-done", 100)

    response = cache.materialize(
        "incoming",
        files=None,
        total_size=4,
        max_bytes=12,
        workspace=running,
        fill=write_files({"a": b"1234"}),
    )
    assert response["overLimit"] is False
    # Room for 4 more bytes: the in-use oldest entry stays, the older unused one goes.
    assert cache.is_complete("oldest-in-use") and cache.is_complete("newer-done")
    assert not cache.entry("older-done").exists()


def test_entries_in_use_are_kept_even_when_the_cache_stays_over_its_limit(tmp_path):
    cache = DatasetCache(tmp_path / "cache")
    running = job_workspace(tmp_path / "work", "running")
    unstarted = job_workspace(tmp_path / "work", None)
    cache.materialize(
        "in-use",
        files=None,
        total_size=6,
        max_bytes=100,
        workspace=running,
        fill=write_files({"a": b"123456"}),
    )
    cache.materialize(
        "staged",
        files=None,
        total_size=6,
        max_bytes=100,
        workspace=unstarted,
        fill=write_files({"a": b"123456"}),
    )
    response = cache.materialize(
        "incoming",
        files=None,
        total_size=6,
        max_bytes=10,
        workspace=running,
        fill=write_files({"a": b"123456"}),
    )
    assert response["overLimit"] is True
    assert cache.is_complete("in-use") and cache.is_complete("staged")

    # A Job that failed before launch releases its pins; the entry can then be deleted.
    cache.release(unstarted)
    cache.materialize(
        "last", files=None, total_size=6, max_bytes=13, workspace=running, fill=write_files({"a": b"123456"})
    )
    assert not cache.entry("staged").exists() and cache.is_complete("in-use")


def test_a_dataset_larger_than_the_limit_is_refused_by_the_target(tmp_path):
    with pytest.raises(DatasetCacheError, match="larger than the target's dataset cache limit"):
        DatasetCache(tmp_path / "cache").materialize(
            "big", files=None, total_size=11, max_bytes=10, workspace=tmp_path, fill=write_files({})
        )


# --- containers --------------------------------------------------------------------------------


def staged_container_specification(job_payload, worker_settings, tmp_path) -> tuple[dict, Path, str]:
    from mado_tracking.worker.runtime import execution_specification

    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], {"a.wav": b"RIFF"})
    payload = reader_job(job_payload, [dataset])
    payload["target"]["runtimeKinds"] = ["docker"]
    payload["codeVersion"].update(
        source=None,
        runtime={"kind": "docker", "image": "example.invalid/model@sha256:" + "1" * 64},
        entrypoint=["/bin/true"],
    )
    specification = execution_specification(WorkerJob.parse(payload), worker_settings)
    workspace = tmp_path / "work" / payload["job"]["id"]
    workspace.mkdir(parents=True)
    key = dataset["digest"].removeprefix("sha256:")
    DatasetCache.for_workspace(workspace).materialize(
        key,
        files=None,
        total_size=4,
        max_bytes=100,
        workspace=workspace,
        fill=write_files({"a.wav": b"RIFF"}),
    )
    specification["stagedInputs"] = {
        "datasets": {
            dataset["id"]: {"path": str(DatasetCache.for_workspace(workspace).data_path(key)), "key": key}
        }
    }
    return specification, workspace, dataset["id"]


def test_containers_bind_each_dataset_read_only_and_get_container_paths(
    job_payload, worker_settings, tmp_path
):
    specification, workspace, version_id = staged_container_specification(
        job_payload, worker_settings, tmp_path
    )
    mounts = prepare_container_layout(workspace, specification)
    dataset_mounts = [mount for mount in mounts if mount.container_path.startswith("/mmt/datasets/")]
    assert [(mount.container_path, mount.readonly) for mount in dataset_mounts] == [
        (f"/mmt/datasets/{version_id}", True)
    ]
    environment = container_environment(specification)
    assert json.loads(environment["MMT_INPUT_DATASET_DIRS"]) == {version_id: f"/mmt/datasets/{version_id}"}
    # The upstream and descriptor variables are kept for existing code.
    assert json.loads(environment["MMT_INPUT_DATASET_VERSION_IDS"]) == [version_id]


def test_a_container_launch_refuses_an_entry_that_lost_its_completion_marker(
    job_payload, worker_settings, tmp_path
):
    specification, workspace, version_id = staged_container_specification(
        job_payload, worker_settings, tmp_path
    )
    key = specification["stagedInputs"]["datasets"][version_id]["key"]
    (DatasetCache.for_workspace(workspace).entry(key) / COMPLETE_MARKER).unlink()
    with pytest.raises(ValueError, match="incomplete"):
        prepare_container_layout(workspace, specification)


def test_docker_container_reads_audio_from_mmt_input_dataset_dirs_read_only(
    job_payload,
    worker_settings,
    docker_image,  # noqa: F811
):
    content = DatasetContent()
    dataset = content.add_version(job_payload["job"]["projectId"], {"clips/0001.wav": b"RIFF-in-container"})
    payload = docker_job(job_payload, docker_image)
    payload["run"]["inputDatasetVersionIds"] = [dataset["id"]]
    payload["inputDatasets"] = [dataset]
    payload["codeVersion"]["entrypoint"] = [
        "/bin/sh",
        "-c",
        # MMT_INPUT_DATASET_DIRS is {"<id>": "/mmt/datasets/<id>"}; the image has no JSON parser.
        'dir=$(echo "$MMT_INPUT_DATASET_DIRS" | sed \'s/.*": "\\([^"]*\\)".*/\\1/\'); '
        'echo "dir=$dir"; cat "$dir/clips/0001.wav"; echo; '
        'if touch "$dir/new" 2>/dev/null; then echo writable; else echo read-only; fi',
    ]
    server = DatasetServer(payload, content)
    asyncio.run(run_jobs(worker_settings, [server]))

    assert server.completions[-1]["status"] == "finished", server.completions[-1]
    messages = server.messages()
    assert f"dir=/mmt/datasets/{dataset['id']}" in messages
    assert "RIFF-in-container" in messages and "read-only" in messages and "writable" not in messages


# --- reference downloads on the target ---------------------------------------------------------


def test_s3_requests_are_signed_like_the_aws_sdk():
    # Expected values from @smithy/signature-v4 (the AWS SDK for JavaScript) for the same request.
    environment = {
        "AWS_ACCESS_KEY_ID": "AKIDEXAMPLE",
        "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "AWS_SESSION_TOKEN": "session-token-example",
        "AWS_REGION": "ap-northeast-1",
        "AWS_ENDPOINT_URL": "http://127.0.0.1:9000",
    }
    location = S3Location("s3://corpus/x", environment)
    now = datetime.datetime(2026, 10, 8, 12, 34, 56, tzinfo=datetime.UTC)
    expected = {
        location.request("audio set/clip+1.wav", {}).full_url: (
            "46d8b3ebbf777b5d96e458024dd5bddfef3fb2098c9646725a95be33df0e614c"
        ),
        location.request(
            None, {"list-type": "2", "prefix": "audio set/", "continuation-token": "abc/def="}
        ).full_url: ("24f032456a5967fc19a693ecaaefdfdca33864f62d455cedc1920a58426a0216"),
    }
    for url, signature in expected.items():
        headers = sign_s3_request(
            method="GET",
            url=url,
            region="ap-northeast-1",
            access_key="AKIDEXAMPLE",
            secret_key=environment["AWS_SECRET_ACCESS_KEY"],
            session_token="session-token-example",
            now=now,
        )
        assert headers["Authorization"].endswith(f"Signature={signature}")
        assert (
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
            in headers["Authorization"]
        )


class FakeS3Handler(BaseHTTPRequestHandler):
    objects: dict[str, bytes] = {}
    authorized: list[bool] = []

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's method name
        self.authorized.append(
            self.headers.get("Authorization", "").startswith("AWS4-HMAC-SHA256 Credential=AKID/")
        )
        location = urlsplit(self.path)
        bucket, _, key = location.path.lstrip("/").partition("/")
        assert bucket == "corpus"
        if not key:
            prefix = parse_qs(location.query)["prefix"][0]
            contents = "".join(
                f"<Contents><Key>{name}</Key><Size>{len(body)}</Size></Contents>"
                for name, body in sorted(self.objects.items())
                if name.startswith(prefix)
            )
            body = (
                '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
            ).encode()
        else:
            body = self.objects[key]
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_arguments: object) -> None:
        pass


def test_an_s3_prefix_is_downloaded_with_the_targets_credentials(tmp_path):
    FakeS3Handler.objects = {
        "eval/a.wav": b"RIFF-a",
        "eval/sub/b.wav": b"RIFF-b",
        "eval/": b"",
        "other.wav": b"x",
    }
    FakeS3Handler.authorized = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeS3Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = {
        "AWS_ACCESS_KEY_ID": "AKID",
        "AWS_SECRET_ACCESS_KEY": "secret",
        "AWS_ENDPOINT_URL_S3": f"http://127.0.0.1:{server.server_port}",
    }
    data = tmp_path / "data"
    data.mkdir()
    try:
        files = fetch_s3(data, "s3://corpus/eval", maximum_bytes=1024, environment=environment)
    finally:
        server.shutdown()
        server.server_close()
    assert sorted(file["path"] for file in files) == ["a.wav", "sub/b.wav"]
    assert (data / "sub" / "b.wav").read_bytes() == b"RIFF-b"
    assert FakeS3Handler.authorized and all(FakeS3Handler.authorized)


def test_https_references_refuse_plain_http_and_redirects(tmp_path, monkeypatch):
    with pytest.raises(dataset_downloads.DatasetFetchError, match="https://"):
        dataset_downloads.fetch_https(tmp_path, "http://example.invalid/a.wav", maximum_bytes=10)

    class Response(io.BytesIO):
        headers: dict[str, str] = {"Content-Length": "4"}

    monkeypatch.setattr(dataset_downloads, "_open", lambda request, context=None: Response(b"RIFF"))
    file = dataset_downloads.fetch_https(tmp_path, "https://example.invalid/sets/a%20b.wav", maximum_bytes=10)
    assert file == {"path": "a b.wav", "sha256": hashlib.sha256(b"RIFF").hexdigest(), "size": 4}
    with pytest.raises(dataset_downloads.DatasetFetchError, match="redirect"):
        dataset_downloads._RefuseRedirect().redirect_request()
