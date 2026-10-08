from __future__ import annotations

import asyncio
import hashlib
import io
import os
from uuid import uuid4

import httpx
import pytest

from mado_tracking import Client, artifact_downloads
from mado_tracking.errors import ApiError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.session_inputs import stage_container_inputs

CONTENT = os.urandom(64 * 1024)
CUT_AFTER_BYTES = 20_000


def entity_tag(content: bytes) -> str:
    return f'"sha256-{hashlib.sha256(content).hexdigest()}"'


class CutStream(httpx.SyncByteStream, httpx.AsyncByteStream):
    """Delivers a prefix of the body, then drops the connection like a lost link."""

    def __init__(self, body: bytes, cut_after: int | None):
        self.body, self.cut_after = body, cut_after

    def chunks(self):
        delivered = self.body if self.cut_after is None else self.body[: self.cut_after]
        for offset in range(0, len(delivered), 4096):
            yield delivered[offset : offset + 4096]
        if self.cut_after is not None:
            raise httpx.ReadError("connection lost mid-download")

    def __iter__(self):
        yield from self.chunks()

    async def __aiter__(self):
        for chunk in self.chunks():
            yield chunk


class ContentServer:
    """The content endpoint's Range / If-Range rules with injectable interruptions."""

    def __init__(self, content: bytes = CONTENT, *, with_entity_tag: bool = True):
        self.content = content
        self.with_entity_tag = with_entity_tag
        self.cuts = [CUT_AFTER_BYTES]
        self.requests: list[httpx.Headers] = []
        self.on_request = lambda _number: None

    def serve(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request.headers)
        self.on_request(len(self.requests))
        tag = entity_tag(self.content)
        headers = {"Accept-Ranges": "bytes"}
        if self.with_entity_tag:
            headers["ETag"] = tag
        cut_after = self.cuts.pop(0) if self.cuts else None
        range_header = request.headers.get("Range")
        if range_header and request.headers.get("If-Range") in {None, tag}:
            start = int(range_header.removeprefix("bytes=").removesuffix("-"))
            body = self.content[start:]
            headers["Content-Range"] = f"bytes {start}-{len(self.content) - 1}/{len(self.content)}"
            headers["Content-Length"] = str(len(body))
            return httpx.Response(206, headers=headers, stream=CutStream(body, cut_after))
        headers["Content-Length"] = str(len(self.content))
        return httpx.Response(200, headers=headers, stream=CutStream(self.content, cut_after))


@pytest.fixture(autouse=True)
def immediate_retries(monkeypatch):
    monkeypatch.setattr(artifact_downloads, "retry_delay", lambda *_arguments: 0)


def download_sync(server: ContentServer) -> tuple[dict, bytes]:
    destination = io.BytesIO()
    with Client(
        api_url="http://localhost",
        api_token="download-test-secret",
        transport=httpx.MockTransport(server.serve),
    ) as client:
        received = client.download_artifact_to("project", "artifact", destination)
    return received, destination.getvalue()


def test_interrupted_download_resumes_from_the_received_offset_and_matches_sha256():
    server = ContentServer()
    received, saved = download_sync(server)
    assert saved == CONTENT
    assert received == {"sha256": hashlib.sha256(CONTENT).hexdigest(), "size": len(CONTENT)}
    first, resumed = server.requests
    assert "Range" not in first and first["Accept-Encoding"] == "identity"
    assert resumed["Range"] == f"bytes={CUT_AFTER_BYTES}-"
    assert resumed["If-Range"] == entity_tag(CONTENT)


def test_a_version_change_between_attempts_restarts_from_the_beginning():
    server = ContentServer()
    replacement = os.urandom(len(CONTENT) // 2)

    def replace_before_resume(request_number: int) -> None:
        if request_number == 2:
            server.content = replacement

    server.on_request = replace_before_resume
    received, saved = download_sync(server)
    assert saved == replacement, "no byte of the old version may remain"
    assert received["sha256"] == hashlib.sha256(replacement).hexdigest()


def test_bytes_that_do_not_match_the_versions_sha256_are_rejected():
    server = ContentServer()
    server.cuts = []
    original_serve = server.serve

    def serve_corrupted(request: httpx.Request) -> httpx.Response:
        response = original_serve(request)
        server.content = CONTENT
        response.stream = CutStream(bytes(len(CONTENT)), None)
        return response

    with (
        Client(
            api_url="http://localhost",
            api_token="download-test-secret",
            transport=httpx.MockTransport(serve_corrupted),
        ) as client,
        pytest.raises(ApiError, match="sha256"),
    ):
        client.download_artifact_to("project", "artifact", io.BytesIO())


def test_without_an_entity_tag_an_interruption_restarts_instead_of_resuming():
    server = ContentServer(with_entity_tag=False)
    _received, saved = download_sync(server)
    assert saved == CONTENT
    assert all("Range" not in headers for headers in server.requests)


def test_repeated_interruptions_give_up_with_an_error():
    server = ContentServer()
    server.cuts = [100] * artifact_downloads.DOWNLOAD_RESUME_ATTEMPTS
    with pytest.raises(ApiError, match="kept failing"):
        download_sync(server)


def test_worker_download_resumes_with_range():
    server = ContentServer()

    async def download():
        api = WorkerApi(url="http://localhost/api", token="t", transport=httpx.MockTransport(server.serve))
        destination = io.BytesIO()
        try:
            return await api.download_artifact("project", "artifact", destination), destination.getvalue()
        finally:
            await api.close()

    received, saved = asyncio.run(download())
    assert saved == CONTENT and received["size"] == len(CONTENT)
    assert server.requests[1]["Range"] == f"bytes={CUT_AFTER_BYTES}-"


class StagingExecutor:
    """Stands in for the target: records the bytes it received for each staged input."""

    def __init__(self):
        self.staged_inputs: dict = {}
        self.uploaded: dict[str, bytes] = {}

    async def command(self, name: str, *, stdin_file):
        content = stdin_file.read_bytes()
        self.uploaded[name] = content
        return {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}


def test_sif_staging_resumes_after_a_cut_and_passes_the_sha256_check(job_payload, tmp_path):
    job_payload["target"]["runtimeKinds"] = ["apptainer"]
    job_payload["codeVersion"].update(
        source=None,
        runtime={
            "kind": "apptainer",
            "artifactId": str(uuid4()),
            "sha256": hashlib.sha256(CONTENT).hexdigest(),
        },
        entrypoint=["/bin/true"],
    )
    job = WorkerJob.parse(job_payload)
    server = ContentServer()
    executor = StagingExecutor()

    async def stage():
        api = WorkerApi(url="http://localhost/api", token="t", transport=httpx.MockTransport(server.serve))
        try:
            await stage_container_inputs(
                job, api=api, executor=executor, transfer_path=lambda kind: tmp_path / f"{kind}.transfer"
            )
        finally:
            await api.close()

    asyncio.run(stage())
    assert executor.uploaded["upload-sif"] == CONTENT
    assert executor.staged_inputs["sif"]["sha256"] == hashlib.sha256(CONTENT).hexdigest()
    assert len(server.requests) == 2 and server.requests[1]["Range"] == f"bytes={CUT_AFTER_BYTES}-"
    assert not list(tmp_path.glob("*.transfer"))
