from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from mado_tracking import Client, artifact_uploads, http
from mado_tracking.artifact_uploads import (
    UploadSessionFailed,
    UploadStateStore,
    UploadTarget,
    upload_file_async,
    upload_file_sync,
)
from mado_tracking.run import Run
from mado_tracking.worker import api as worker_api
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import WorkerJob

# Worker jobs validate their ids as UUIDs.
PROJECT_ID = str(uuid4())
RUN_ID = str(uuid4())
TOKEN = "upload-test-secret"
# Small parts keep the tests fast; the fake API does not enforce the real 5 MiB minimum.
PART_SIZE = 1024
PART_COUNT = 5


class FakeUploadApi:
    """In-memory /artifact-uploads with the contract's part, complete and verification rules."""

    def __init__(self):
        self.sessions: dict[str, dict] = {}
        self.parts: dict[str, dict[int, bytes]] = {}
        self.artifacts: dict[str, dict] = {}
        self.part_requests: list[int] = []
        self.sessions_created = 0
        self.interrupted_parts: set[int] = set()
        self.corrupt_on_finalize = False
        self.single_puts: list[str] = []

    def handle(self, request: httpx.Request, body: bytes) -> httpx.Response:
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}/")
        segments = path.split("/")
        if request.method == "POST" and path == "artifact-uploads":
            return self.create(json.loads(body))
        if segments[0] == "artifact-uploads" and len(segments) == 2 and request.method == "GET":
            return self.detail(segments[1])
        if segments[0] == "artifact-uploads" and len(segments) == 4 and request.method == "PUT":
            return self.put_part(segments[1], int(segments[3]), request, body)
        if segments[0] == "artifact-uploads" and segments[-1] == "complete":
            return self.complete(segments[1])
        if segments[0] == "artifacts" and request.method == "GET":
            return httpx.Response(200, json=self.artifacts[segments[1]])
        if path == f"runs/{RUN_ID}/artifacts" and request.method == "PUT":
            self.single_puts.append(request.url.params["path"])
            return httpx.Response(
                201, json={"id": str(uuid4()), "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
            )
        raise AssertionError(f"Unexpected request {request.method} {request.url.path}")

    def create(self, payload: dict) -> httpx.Response:
        self.sessions_created += 1
        upload_id = str(uuid4())
        part_count = -(-payload["expectedSize"] // payload["partSize"])
        self.sessions[upload_id] = {
            "id": upload_id,
            "projectId": PROJECT_ID,
            "runId": payload.get("runId"),
            "path": payload["path"],
            "mimeType": payload["mimeType"],
            "expectedSize": payload["expectedSize"],
            "expectedSha256": payload["expectedSha256"],
            "partSize": payload["partSize"],
            "partCount": part_count,
            "status": "open",
            "artifactId": None,
            "error": None,
        }
        self.parts[upload_id] = {}
        return httpx.Response(201, json=self.sessions[upload_id])

    def detail(self, upload_id: str) -> httpx.Response:
        session = self.sessions.get(upload_id)
        if session is None:
            return httpx.Response(404, json={"error": "not found"})
        if session["status"] == "verifying":
            self.finalize(upload_id)
        received = [
            {"partNumber": number, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            for number, content in sorted(self.parts[upload_id].items())
        ]
        return httpx.Response(200, json={**session, "receivedParts": received})

    def put_part(self, upload_id: str, number: int, request: httpx.Request, body: bytes) -> httpx.Response:
        self.part_requests.append(number)
        if number in self.interrupted_parts:
            raise httpx.WriteError("connection dropped while sending the part")
        if request.headers["X-Part-SHA256"] != hashlib.sha256(body).hexdigest():
            return httpx.Response(422, json={"error": "checksum", "code": "part_checksum_mismatch"})
        assert int(request.headers["Content-Length"]) == len(body)
        self.parts[upload_id][number] = body
        return httpx.Response(200, json={"partNumber": number, "size": len(body)})

    def complete(self, upload_id: str) -> httpx.Response:
        session = self.sessions[upload_id]
        if len(self.parts[upload_id]) != session["partCount"]:
            return httpx.Response(409, json={"error": "incomplete", "code": "upload_incomplete"})
        session["status"] = "verifying"
        return httpx.Response(202, json=session)

    def finalize(self, upload_id: str) -> None:
        session = self.sessions[upload_id]
        content = b"".join(content for _number, content in sorted(self.parts[upload_id].items()))
        if self.corrupt_on_finalize:
            content += b"!"
        digest = hashlib.sha256(content).hexdigest()
        if digest != session["expectedSha256"]:
            session.update(status="failed", error="sha256_mismatch")
            return
        session.update(status="completed", artifactId=upload_id)
        self.artifacts[upload_id] = {"id": upload_id, "sha256": digest, "size": len(content)}

    def sync_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(lambda request: self.handle(request, request.read()))

    def async_transport(self) -> httpx.MockTransport:
        async def handle(request: httpx.Request) -> httpx.Response:
            return self.handle(request, await request.aread())

        return httpx.MockTransport(handle)


@pytest.fixture(autouse=True)
def immediate_retries(monkeypatch, tmp_path):
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)
    monkeypatch.setattr(artifact_uploads, "VERIFY_POLL_INITIAL_SECONDS", 0)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))


@pytest.fixture
def weights(tmp_path) -> Path:
    path = tmp_path / "weights.bin"
    path.write_bytes(os.urandom(PART_SIZE * (PART_COUNT - 1) + 300))
    return path


def target(api_url: str = "http://localhost/api", path: str = "model/weights.bin") -> UploadTarget:
    return UploadTarget(
        api_url=api_url, project_id=PROJECT_ID, run_id=RUN_ID, path=path, mime_type="application/octet-stream"
    )


def client_for(api: FakeUploadApi) -> Client:
    return Client(api_url="http://localhost", api_token=TOKEN, transport=api.sync_transport())


def state_files(tmp_path: Path) -> list[Path]:
    return list((tmp_path / "cache" / "mado-tracking" / "uploads").glob("*.json"))


def test_rerun_after_part_3_is_cut_sends_only_part_3_and_later(weights, tmp_path):
    api = FakeUploadApi()
    api.interrupted_parts = {3}
    with client_for(api) as client:
        with pytest.raises(Exception, match="connection"):
            upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
        assert {1, 2} <= set(api.parts[next(iter(api.sessions))])
        assert len(state_files(tmp_path)) == 1

        api.interrupted_parts.clear()
        api.part_requests.clear()
        artifact = upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)

    assert 3 in api.part_requests and not {1, 2} & set(api.part_requests)
    assert api.sessions_created == 1
    assert artifact["sha256"] == hashlib.sha256(weights.read_bytes()).hexdigest()
    assert not state_files(tmp_path), "a completed upload leaves no resume state"


def test_state_file_is_private_and_never_contains_the_token(weights, tmp_path):
    api = FakeUploadApi()
    api.interrupted_parts = {PART_COUNT}
    with client_for(api) as client, pytest.raises(Exception, match="connection"):
        upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
    [state_path] = state_files(tmp_path)
    assert state_path.name == hashlib.sha256(weights.read_bytes()).hexdigest() + ".json"
    assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    assert TOKEN not in state_path.read_text()


def test_whole_file_sha256_mismatch_raises_and_removes_the_state_file(weights, tmp_path):
    api = FakeUploadApi()
    api.corrupt_on_finalize = True
    with client_for(api) as client, pytest.raises(UploadSessionFailed, match="sha256_mismatch"):
        upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
    assert not state_files(tmp_path)
    assert not api.artifacts


def test_a_session_for_another_path_or_server_is_not_reused(weights, tmp_path):
    api = FakeUploadApi()
    api.interrupted_parts = {PART_COUNT}
    with client_for(api) as client:
        with pytest.raises(Exception, match="connection"):
            upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
        api.interrupted_parts.clear()
        upload_file_sync(client, target=target(path="model/other.bin"), source=weights, part_size=PART_SIZE)
    assert api.sessions_created == 2


def test_a_lost_session_starts_a_new_one(weights, tmp_path):
    api = FakeUploadApi()
    api.interrupted_parts = {PART_COUNT}
    with client_for(api) as client:
        with pytest.raises(Exception, match="connection"):
            upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
        api.sessions.clear()
        api.interrupted_parts.clear()
        artifact = upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
    assert api.sessions_created == 2 and artifact["size"] == weights.stat().st_size


def test_a_file_changed_after_hashing_is_reported_and_its_state_dropped(weights, tmp_path, monkeypatch):
    api = FakeUploadApi()
    original = artifact_uploads.LocalFile.read_part

    def read_changed(local, part_number):
        for chunk in original(local, part_number):
            yield bytes(len(chunk))

    monkeypatch.setattr(artifact_uploads.LocalFile, "read_part", read_changed)
    with client_for(api) as client, pytest.raises(ValueError, match="changed during upload"):
        upload_file_sync(client, target=target(), source=weights, part_size=PART_SIZE)
    assert not state_files(tmp_path)


def test_log_artifact_switches_to_a_session_at_the_threshold(weights, monkeypatch):
    api = FakeUploadApi()
    size = weights.stat().st_size
    monkeypatch.setattr("mado_tracking.run.SESSION_UPLOAD_THRESHOLD_BYTES", size)
    small = weights.with_name("small.txt")
    small.write_bytes(b"x" * (size - 1))
    with client_for(api) as client:
        run = Run(client, PROJECT_ID, {"id": RUN_ID, "status": "running"})
        large_artifact = run.log_artifact(weights, path="model/weights.bin")
        run.log_artifact(small)
    assert api.sessions_created == 1 and large_artifact["size"] == size
    assert api.single_puts == ["small.txt"]


def test_log_artifacts_keeps_relative_paths_under_the_prefix(tmp_path):
    api = FakeUploadApi()
    root = tmp_path / "outputs"
    (root / "eval" / "audio").mkdir(parents=True)
    (root / "metrics.json").write_text("{}")
    (root / "eval" / "audio" / "0001.wav").write_bytes(b"RIFF")
    with client_for(api) as client:
        run = Run(client, PROJECT_ID, {"id": RUN_ID, "status": "running"})
        saved = run.log_artifacts(root, path="/results/")
    assert api.single_puts == ["results/eval/audio/0001.wav", "results/metrics.json"]
    assert len(saved) == 2


def test_async_resume_sends_only_missing_parts(weights, tmp_path):
    api = FakeUploadApi()
    api.interrupted_parts = {4}

    async def upload():
        async with httpx.AsyncClient(
            base_url="http://localhost/api/", transport=api.async_transport()
        ) as client:
            return await upload_file_async(
                client,
                masker=WorkerApi(url="http://localhost/api", token=TOKEN).masker,
                target=target(),
                source=weights,
                part_size=PART_SIZE,
            )

    with pytest.raises(Exception, match="connection"):
        asyncio.run(upload())
    sent_before = set(api.parts[next(iter(api.sessions))])
    api.interrupted_parts.clear()
    api.part_requests.clear()
    artifact = asyncio.run(upload())
    assert 4 in api.part_requests and not sent_before & set(api.part_requests)
    assert artifact["sha256"] == hashlib.sha256(weights.read_bytes()).hexdigest()
    assert not state_files(tmp_path)


def test_worker_uploads_large_run_artifacts_through_a_session(weights, job_payload, monkeypatch, tmp_path):
    for entity in ("job", "run", "codeVersion"):
        job_payload[entity]["projectId"] = PROJECT_ID
    job_payload["job"]["runId"] = job_payload["run"]["id"] = RUN_ID
    job = WorkerJob.parse(job_payload)
    api = FakeUploadApi()
    monkeypatch.setattr(worker_api, "SESSION_UPLOAD_THRESHOLD_BYTES", weights.stat().st_size)
    monkeypatch.setattr(artifact_uploads, "choose_part_size", lambda _size: PART_SIZE)
    content = weights.read_bytes()
    descriptor = {
        "path": "weights.bin",
        "mimeType": "application/octet-stream",
        "sha256": hashlib.sha256(content).hexdigest(),
        "size": len(content),
    }

    async def upload():
        worker = WorkerApi(
            url="http://localhost/api",
            token=TOKEN,
            transport=api.async_transport(),
            upload_state_store=UploadStateStore(tmp_path / "worker-uploads"),
        )
        try:
            await worker.upload_output_artifact(job, descriptor, weights)
        finally:
            await worker.close()

    asyncio.run(upload())
    [session] = api.sessions.values()
    assert session["path"] == "container/weights.bin" and session["status"] == "completed"
    assert not api.single_puts
