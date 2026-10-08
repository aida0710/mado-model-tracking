from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

# docker_image is the shared fixture that skips unless MMT_TEST_DOCKER_IMAGE names a cached image.
from test_docker_worker import ContainerServer, docker_job, execute_job, workspace_for
from test_docker_worker import docker_image as docker_image  # noqa: F401
from test_worker import WorkerServer

import mado_tracking
from mado_tracking.client import Client
from mado_tracking.errors import ConfigurationError
from mado_tracking.settings import ApiSettings
from mado_tracking.upstream import download_upstream_artifacts, list_upstream_artifacts, upstream_run_id
from mado_tracking.worker import host_runner
from mado_tracking.worker.container_layout import (
    CONTEXT_PATH,
    container_environment,
    prepare_container_layout,
)
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.runtime import execution_specification
from mado_tracking.worker.service import Worker

PROJECT_ID = str(uuid4())
UPSTREAM_RUN_ID = str(uuid4())
JOB_TOKEN = "mmtj_upstream-reader"


def chained_payload(job_payload: dict) -> dict:
    """An evaluation Run chained after an inference Run that produced one input DatasetVersion."""
    dataset_id = str(uuid4())
    job_payload["run"].update(
        parentRunId=UPSTREAM_RUN_ID,
        inputDatasetVersionIds=[dataset_id],
        upstreamDatasetVersionIds=[dataset_id],
    )
    job_payload["inputDatasets"] = [{"id": dataset_id, "projectId": job_payload["job"]["projectId"]}]
    return job_payload


def docker_payload(job_payload: dict) -> dict:
    job_payload["target"]["runtimeKinds"] = ["docker"]
    job_payload["codeVersion"].update(
        source=None,
        runtime={"kind": "docker", "image": "example.invalid/model@sha256:" + "1" * 64},
        entrypoint=["/bin/true"],
    )
    return job_payload


def test_host_python_job_receives_the_upstream_run_id_and_upstream_run_json(
    job_payload, worker_settings, tmp_path
):
    payload = chained_payload(job_payload)
    specification = execution_specification(WorkerJob.parse(payload), worker_settings)
    specification["executionSnapshot"] = {"mode": "run"}
    environment = host_runner._execution_environment(specification, tmp_path)

    assert environment["MMT_UPSTREAM_RUN_ID"] == UPSTREAM_RUN_ID
    upstream_run_file = Path(environment["MMT_UPSTREAM_RUN_FILE"])
    assert upstream_run_file == tmp_path / "upstream-run.json"
    assert json.loads(upstream_run_file.read_text()) == {
        "runId": UPSTREAM_RUN_ID,
        "outputDatasetVersionIds": payload["run"]["upstreamDatasetVersionIds"],
    }
    # The descriptor still reaches the code through dataset-versions.json as before.
    datasets = json.loads((tmp_path / "dataset-versions.json").read_text())["inputDatasets"]
    assert [dataset["id"] for dataset in datasets] == payload["run"]["upstreamDatasetVersionIds"]


def test_docker_job_receives_the_same_upstream_run_id_and_upstream_run_json(
    job_payload, worker_settings, tmp_path
):
    payload = docker_payload(chained_payload(job_payload))
    specification = execution_specification(WorkerJob.parse(payload), worker_settings)
    prepare_container_layout(tmp_path, specification)
    environment = container_environment(specification)

    assert environment["MMT_UPSTREAM_RUN_ID"] == UPSTREAM_RUN_ID
    assert environment["MMT_UPSTREAM_RUN_FILE"] == f"{CONTEXT_PATH}/upstream-run.json"
    document = json.loads((tmp_path / "context/upstream-run.json").read_text())
    assert document["runId"] == UPSTREAM_RUN_ID


def test_training_run_model_version_is_listed_as_an_upstream_output(job_payload, worker_settings, tmp_path):
    model_version_id = str(uuid4())
    job_payload["run"].update(kind="inference", parentRunId=UPSTREAM_RUN_ID, modelVersionId=model_version_id)
    job_payload["modelVersion"] = {
        "id": model_version_id,
        "projectId": job_payload["job"]["projectId"],
        "family": "linear",
        "sourceRunId": UPSTREAM_RUN_ID,
        "artifactId": None,
        "weightsUri": "",
    }
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    assert specification["context"]["upstreamRun"] == {
        "runId": UPSTREAM_RUN_ID,
        "outputModelVersionIds": [model_version_id],
    }


@pytest.mark.parametrize("runtime", ["python", "docker"])
def test_job_without_upstream_gets_neither_the_variable_nor_the_file(
    job_payload, worker_settings, tmp_path, runtime
):
    if runtime == "docker":
        specification = execution_specification(WorkerJob.parse(docker_payload(job_payload)), worker_settings)
        prepare_container_layout(tmp_path, specification)
        environment = container_environment(specification)
        upstream_run_file = tmp_path / "context/upstream-run.json"
    else:
        specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
        specification["executionSnapshot"] = {"mode": "run"}
        environment = host_runner._execution_environment(specification, tmp_path)
        upstream_run_file = tmp_path / "upstream-run.json"
    assert "MMT_UPSTREAM_RUN_ID" not in environment and "MMT_UPSTREAM_RUN_FILE" not in environment
    assert not upstream_run_file.exists()


def test_spec_saved_before_upstream_inputs_still_prepares_a_container(job_payload, worker_settings, tmp_path):
    specification = execution_specification(WorkerJob.parse(docker_payload(job_payload)), worker_settings)
    del specification["context"]["upstreamRun"]
    prepare_container_layout(tmp_path, specification)
    assert "MMT_UPSTREAM_RUN_ID" not in container_environment(specification)


class ArtifactApi:
    """Run Artifact listing with cursor pages (new API) or one unfiltered page (old API)."""

    def __init__(self, artifacts: list[dict], contents: dict[str, bytes], *, paged: bool):
        self.artifacts = artifacts
        self.contents = contents
        self.paged = paged
        self.list_requests: list[dict[str, list[str]]] = []
        self.downloads: list[str] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {JOB_TOKEN}"
        path = request.url.path
        if path == f"/api/projects/{PROJECT_ID}/runs/{UPSTREAM_RUN_ID}/artifacts":
            query = parse_qs(request.url.query.decode())
            self.list_requests.append(query)
            if not self.paged:
                return httpx.Response(200, json={"items": self.artifacts})
            prefix = query.get("prefix", [""])[0]
            matching = [artifact for artifact in self.artifacts if artifact["path"].startswith(prefix)]
            start = int(query.get("cursor", ["0"])[0])
            page_size = 2
            page = matching[start : start + page_size]
            next_cursor = str(start + page_size) if start + page_size < len(matching) else None
            return httpx.Response(200, json={"items": page, "nextCursor": next_cursor})
        artifact_id = path.removeprefix(f"/api/projects/{PROJECT_ID}/artifacts/").removesuffix("/content")
        self.downloads.append(artifact_id)
        return httpx.Response(200, content=self.contents[artifact_id])


def artifact(path: str) -> dict:
    return {"id": str(uuid4()), "path": path, "runId": UPSTREAM_RUN_ID}


@pytest.fixture
def upstream_environment(monkeypatch):
    monkeypatch.setenv("MMT_UPSTREAM_RUN_ID", UPSTREAM_RUN_ID)
    monkeypatch.setenv("MMT_PROJECT_ID", PROJECT_ID)


def client_for(serve) -> Client:
    return Client(api_url="http://api.invalid", api_token=JOB_TOKEN, transport=httpx.MockTransport(serve))


def test_download_walks_every_page_and_keeps_artifact_paths(upstream_environment, tmp_path):
    artifacts = [artifact(path) for path in ("wav/a.wav", "wav/sub/b.wav", "predictions.jsonl")]
    contents = {item["id"]: f"content of {item['path']}".encode() for item in artifacts}
    api = ArtifactApi(artifacts, contents, paged=True)

    with client_for(api.serve) as client:
        saved = download_upstream_artifacts(tmp_path / "upstream", client=client)

    assert len(api.list_requests) == 2
    assert api.list_requests[0]["versions"] == ["latest"] and "cursor" not in api.list_requests[0]
    assert api.list_requests[1]["cursor"] == ["2"]
    assert sorted(path.relative_to(tmp_path / "upstream").as_posix() for path in saved) == [
        "predictions.jsonl",
        "wav/a.wav",
        "wav/sub/b.wav",
    ]
    assert (tmp_path / "upstream/wav/sub/b.wav").read_bytes() == b"content of wav/sub/b.wav"
    assert not list((tmp_path / "upstream").rglob("*.partial"))


def test_old_api_without_prefix_or_versions_yields_the_newest_artifact_per_path(
    upstream_environment, tmp_path
):
    newest, older = artifact("wav/a.wav"), artifact("wav/a.wav")
    other = artifact("logs/train.log")
    # The old API returns every saved row, newest first, and ignores the query parameters.
    api = ArtifactApi([newest, other, older], {newest["id"]: b"new", older["id"]: b"old"}, paged=False)

    with client_for(api.serve) as client:
        listed = list_upstream_artifacts("wav/", client=client)
        download_upstream_artifacts(tmp_path, "wav/", client=client)

    assert [item["id"] for item in listed] == [newest["id"]]
    assert (tmp_path / "wav/a.wav").read_bytes() == b"new"
    assert api.downloads == [newest["id"]]


@pytest.mark.parametrize("unsafe_path", ["../escape.wav", "/etc/passwd", "wav/../../x", "wav//a", "a\\b"])
def test_unsafe_artifact_paths_are_rejected_before_anything_is_written(
    upstream_environment, tmp_path, unsafe_path
):
    safe = artifact("wav/a.wav")
    api = ArtifactApi([safe, artifact(unsafe_path)], {safe["id"]: b"x"}, paged=False)
    destination = tmp_path / "destination"

    with (
        client_for(api.serve) as client,
        pytest.raises(ConfigurationError, match="Unsafe upstream Artifact path"),
    ):
        download_upstream_artifacts(destination, client=client)

    assert api.downloads == []
    assert not destination.exists()
    assert not (tmp_path / "escape.wav").exists()


def test_repeating_cursor_stops_instead_of_looping(upstream_environment):
    def serve(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [], "nextCursor": "same"})

    with (
        client_for(serve) as client,
        pytest.raises(ConfigurationError, match="repeating"),
    ):
        list_upstream_artifacts(client=client)


def test_without_upstream_the_functions_return_none_and_empty_without_calling_the_api(monkeypatch, tmp_path):
    monkeypatch.delenv("MMT_UPSTREAM_RUN_ID", raising=False)

    def serve(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected request {request.url}")

    with client_for(serve) as client:
        assert upstream_run_id() is None
        assert list_upstream_artifacts(client=client) == []
        assert download_upstream_artifacts(tmp_path / "none", client=client) == []
    assert not (tmp_path / "none").exists()


def test_sdk_exports_the_upstream_functions():
    assert mado_tracking.download_upstream_artifacts is download_upstream_artifacts
    assert mado_tracking.list_upstream_artifacts is list_upstream_artifacts
    assert mado_tracking.upstream_run_id is upstream_run_id


class UpstreamArtifactHandler(BaseHTTPRequestHandler):
    artifacts: list[dict] = []
    contents: dict[str, bytes] = {}

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's method name
        path = urlsplit(self.path).path
        if path.endswith(f"/runs/{UPSTREAM_RUN_ID}/artifacts"):
            body = json.dumps({"items": self.artifacts, "nextCursor": None}).encode()
        else:
            body = self.contents[path.split("/")[-2]]
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_arguments: object) -> None:
        pass


def test_chained_host_job_downloads_the_upstream_wavs_with_the_same_paths(job_payload, worker_settings):
    payload = chained_payload(job_payload)
    payload["run"]["kind"] = "evaluation"
    payload["codeVersion"]["taskTypes"] = ["evaluation"]
    wavs = {"wav/0001.wav": b"RIFF-first", "wav/nested/0002.wav": b"RIFF-second"}
    UpstreamArtifactHandler.artifacts = [artifact(path) for path in wavs]
    UpstreamArtifactHandler.contents = {
        item["id"]: wavs[item["path"]] for item in UpstreamArtifactHandler.artifacts
    }
    # The test worker skips pip, so the Job reuses this interpreter's httpx instead of installing it.
    site_packages = str(Path(httpx.__file__).resolve().parent.parent)
    payload["codeVersion"]["source"]["files"]["main.py"] = (
        f"import sys; sys.path.append({site_packages!r})\n"
        "import hashlib, pathlib\n"
        "from mado_tracking import download_upstream_artifacts, upstream_run_id\n"
        "print('upstream=' + str(upstream_run_id()), flush=True)\n"
        "root = pathlib.Path('upstream')\n"
        "for path in sorted(download_upstream_artifacts(root)):\n"
        "    digest = hashlib.sha256(path.read_bytes()).hexdigest()\n"
        "    print('saved=' + path.relative_to(root).as_posix() + ':' + digest, flush=True)\n"
    )
    http_server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamArtifactHandler)
    thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    thread.start()
    settings = dataclasses.replace(
        worker_settings, api=ApiSettings(f"http://127.0.0.1:{http_server.server_port}/api", "test-api-secret")
    )
    server = WorkerServer(payload)

    async def scenario():
        worker = Worker(settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(payload)), 20)
        finally:
            await worker.api.close()

    try:
        asyncio.run(scenario())
    finally:
        http_server.shutdown()
        http_server.server_close()
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert server.completions[-1]["status"] == "finished", messages
    assert f"upstream={UPSTREAM_RUN_ID}" in messages
    for path, content in wavs.items():
        assert f"saved={path}:{hashlib.sha256(content).hexdigest()}" in messages


def test_chained_docker_job_sees_the_upstream_run_id_and_file_inside_the_container(
    job_payload,
    worker_settings,
    docker_image,  # noqa: F811
):
    payload = chained_payload(job_payload)
    docker_job(
        payload, docker_image, script='echo "upstream=$MMT_UPSTREAM_RUN_ID"; cat "$MMT_UPSTREAM_RUN_FILE"'
    )
    server = ContainerServer(payload)
    asyncio.run(execute_job(server, worker_settings))

    assert server.completions[-1]["status"] == "finished"
    stdout = (workspace_for(payload) / "stdout.log").read_text()
    assert f"upstream={UPSTREAM_RUN_ID}" in stdout
    assert f'"runId":"{UPSTREAM_RUN_ID}"' in stdout.replace(" ", "")
