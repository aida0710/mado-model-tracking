from __future__ import annotations

import asyncio
import hashlib
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_worker import WorkerServer

from mado_tracking.errors import ApiError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.container_layout import verify_staged_file
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.service import Worker
from mado_tracking.worker.session_inputs import download_external_weights


def container_payload(payload, kind="docker"):
    payload["target"]["runtimeKinds"] = [kind]
    payload["codeVersion"].update(
        source=None,
        runtime={"kind": kind, "image": "example.invalid/model@sha256:" + "1" * 64},
        entrypoint=["/bin/true"],
    )
    return payload


def test_sif_checksum_mismatch_fails_before_transfer_or_entrypoint(job_payload, worker_settings):
    container_payload(job_payload, "apptainer")
    job_payload["codeVersion"]["runtime"] = {
        "kind": "apptainer",
        "artifactId": str(uuid4()),
        "sha256": "0" * 64,
    }
    server = WorkerServer(job_payload)
    server.artifact = b"corrupted SIF content"

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 10)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "failed"
    assert "sha256 mismatch" in server.completions[-1]["error"]
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "state.json").exists() and not (workspace / "runtime.sif").exists()
    assert not list(worker_settings.state_directory.glob("*.sif"))


@pytest.mark.parametrize("status", [403, 404, 503])
def test_api_weight_download_failure_never_starts_the_container(job_payload, worker_settings, status):
    container_payload(job_payload)
    model_id = str(uuid4())
    job_payload["run"]["modelVersionId"] = model_id
    job_payload["modelVersion"] = {
        "id": model_id,
        "projectId": job_payload["job"]["projectId"],
        "family": "linear",
        "artifactId": str(uuid4()),
    }
    server = WorkerServer(job_payload)
    downloads = []

    def serve(request):
        if request.method == "GET":
            downloads.append(request.url.path)
            return httpx.Response(status, json={"error": "weight download rejected"})
        return server.serve(request)

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        worker = Worker(worker_settings, api=api)
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 10)
        finally:
            await api.close()

    asyncio.run(scenario())
    assert len(downloads) == 1 and server.completions[-1]["status"] == "failed"
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "state.json").exists() and not (workspace / "inputs/weights").exists()
    assert not list(worker_settings.state_directory.glob("*.weights"))


@pytest.mark.parametrize("kind", ["singularity", "apptainer"])
def test_missing_sif_runtime_reports_capability_failure_without_pip_or_a_fake_success(
    job_payload, worker_settings, monkeypatch, tmp_path, kind
):
    container_payload(job_payload, kind)
    content = b"test SIF bytes"
    job_payload["codeVersion"]["runtime"] = {
        "kind": kind,
        "artifactId": str(uuid4()),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    monkeypatch.setenv("PATH", str(tmp_path / "missing-runtime"))
    server = WorkerServer(job_payload)
    server.artifact = content

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 10)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    state = json.loads((workspace / "state.json").read_text())
    assert state["runtimeCapability"] == {"kind": kind, "available": False}
    assert server.completions[-1]["status"] == "failed" and "unavailable" in server.completions[-1]["error"]
    assert not (workspace / "venv").exists() and not (workspace / "spec.json").exists()


def test_target_rejects_tampered_sif_bytes_after_transfer(tmp_path):
    sif = tmp_path / "runtime.sif"
    sif.write_bytes(b"altered in transit")
    with pytest.raises(ValueError, match="sha256"):
        verify_staged_file(sif, {"sha256": hashlib.sha256(b"registered bytes").hexdigest()})


def test_lease_rejection_during_weight_transfer_never_launches_or_reports_a_completion(
    job_payload, worker_settings
):
    container_payload(job_payload)
    model_id = str(uuid4())
    job_payload["run"]["modelVersionId"] = model_id
    job_payload["modelVersion"] = {
        "id": model_id,
        "projectId": job_payload["job"]["projectId"],
        "family": "linear",
        "artifactId": str(uuid4()),
    }
    server = WorkerServer(job_payload)

    async def scenario():
        started, blocked = asyncio.Event(), asyncio.Event()

        class SlowWeights(httpx.AsyncByteStream):
            async def __aiter__(self):
                started.set()
                yield b"partial weights"
                await blocked.wait()

        async def serve(request):
            if request.method == "GET":
                return httpx.Response(200, stream=SlowWeights())
            return server.serve(request)

        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        worker = Worker(worker_settings, api=api)
        task = asyncio.create_task(worker.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(10):
                await started.wait()
                server.reject_lease = True
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await api.close()

    asyncio.run(scenario())
    assert not any(path.endswith("/complete") for path, _body in server.calls)
    assert list(worker_settings.state_directory.glob("*.rejected"))
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "state.json").exists()
    assert not list(worker_settings.state_directory.glob("*.weights"))


@pytest.mark.parametrize("redirect", [False, True])
def test_external_weights_download_never_receives_api_authorization_or_follows_redirects(redirect):
    authorization = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_arguments):
            pass

        def do_GET(self):
            authorization.append(self.headers.get("Authorization"))
            if redirect:
                self.send_response(302)
                self.send_header("Location", "/redirect-target-must-not-be-fetched")
                self.end_headers()
                return
            content = b"external model weights"
            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    destination = io.BytesIO()
    try:
        operation = download_external_weights(f"http://127.0.0.1:{server.server_port}/weights", destination)
        if redirect:
            with pytest.raises(ApiError) as error:
                asyncio.run(operation)
            assert error.value.status_code == 302
            metadata = {"sha256": hashlib.sha256(b"").hexdigest(), "size": 0}
        else:
            metadata = asyncio.run(operation)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert authorization == [None]
    assert metadata == {
        "sha256": hashlib.sha256(destination.getvalue()).hexdigest(),
        "size": len(destination.getvalue()),
    }
