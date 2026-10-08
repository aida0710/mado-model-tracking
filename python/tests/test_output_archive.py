from __future__ import annotations

import asyncio
import hashlib
import io
import json
import tarfile
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_worker import WorkerServer

from mado_tracking.errors import ConfigurationError, TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.container_outputs import validate_results
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.output_archive import INDEX_MEMBER_NAME, write_output_archive
from mado_tracking.worker.runtime import JobExecutor, StreamRejected
from mado_tracking.worker.service import Worker
from mado_tracking.worker.session_outputs import receive_output_archive
from mado_tracking.worker.transport import LocalTransport

# Many small files exercise the per-file overhead that the old 64 KiB command protocol paid.
BULK_OUTPUT_FILES = 5000
BULK_JOB_TIMEOUT_SECONDS = 120

BULK_OUTPUT_SCRIPT = f"""
import hashlib, json, os, pathlib
outputs = pathlib.Path(os.environ["MMT_OUTPUTS_DIR"])
(outputs / "audio").mkdir()
lines = []
for number in range({BULK_OUTPUT_FILES}):
    content = f"utterance-{{number}}".encode()
    path = f"audio/{{number:05d}}.wav"
    (outputs / path).write_bytes(content)
    lines.append(json.dumps({{"path": path, "sha256": hashlib.sha256(content).hexdigest(),
                             "size": len(content), "mimeType": "audio/wav"}}))
(outputs / "artifacts.jsonl").write_text("\\n".join(lines) + "\\n")
weights = b"trained-weights"
(outputs / "model.bin").write_bytes(weights)
model = {{"path": "model.bin", "sha256": hashlib.sha256(weights).hexdigest(), "size": len(weights)}}
result = {{
    "version": 2,
    "complete": True,
    "artifactsManifest": "artifacts.jsonl",
    "artifacts": [model],
    "models": [{{"path": "model.bin", "metadata": {{"utterances": {BULK_OUTPUT_FILES}}}}}],
    "metrics": [{{"name": "utterances", "value": {BULK_OUTPUT_FILES}}}],
}}
(outputs / "result.partial").write_text(json.dumps(result))
os.replace(outputs / "result.partial", os.environ["MMT_RESULT_FILE"])
"""


class OutputServer(WorkerServer):
    """The worker API with Run Artifact saves and idempotent output declarations."""

    def __init__(self, payload: dict):
        super().__init__(payload)
        self.uploads: list[tuple[str, bytes]] = []
        self.declarations: dict[int, dict] = {}
        self.declaration_requests: list[list[dict]] = []
        self.lose_first_declaration_response = False

    def serve(self, request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and request.url.params["path"].startswith("container/"):
            self.uploads.append((request.url.params["path"], request.content))
            return httpx.Response(
                200,
                json={"sha256": hashlib.sha256(request.content).hexdigest(), "size": len(request.content)},
            )
        if request.url.path.endswith("/outputs"):
            body = json.loads(request.content)
            self.calls.append((request.url.path, body))
            self.declaration_requests.append(body["declarations"])
            for declaration in body["declarations"]:
                self.declarations.setdefault(
                    declaration["index"], {**declaration, "modelVersionId": str(uuid4())}
                )
            if self.lose_first_declaration_response and len(self.declaration_requests) == 1:
                raise httpx.ReadError("lost declaration response", request=request)
            items = [
                {
                    "index": declaration["index"],
                    "kind": declaration["kind"],
                    "modelVersionId": self.declarations[declaration["index"]]["modelVersionId"],
                    "datasetVersionId": None,
                    "createdAt": "2026-10-08T00:00:00Z",
                }
                for declaration in body["declarations"]
            ]
            return httpx.Response(200, json={"items": items})
        return super().serve(request)


class CountingTransport(LocalTransport):
    """Records the runner command of every process the worker starts on the target."""

    def __init__(self) -> None:
        super().__init__(allow_local_executor=True, masker=SecretMasker([]))
        self.commands: list[str] = []

    def command_argv(self, command):
        self.commands.append("bootstrap" if command[1] == "-c" else command[2])
        return super().command_argv(command)


def test_thousands_of_outputs_take_one_archive_command_and_register_the_declared_model_last(
    job_payload, worker_settings
):
    job_payload["codeVersion"]["source"] = {"kind": "inline", "files": {"main.py": BULK_OUTPUT_SCRIPT}}
    server = OutputServer(job_payload)
    transport = CountingTransport()

    async def scenario():
        worker = Worker(
            worker_settings,
            api=server.client(),
            executor_factory=lambda job, settings: JobExecutor(job, settings, transport=transport),
        )
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), BULK_JOB_TIMEOUT_SECONDS)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished", server.completions
    assert len(server.uploads) == BULK_OUTPUT_FILES + 1
    assert len({path for path, _content in server.uploads}) == BULK_OUTPUT_FILES + 1
    assert dict(server.uploads)["container/audio/04999.wav"] == b"utterance-4999"
    # The manifest and result.json describe outputs; they are not outputs themselves.
    assert "container/artifacts.jsonl" not in dict(server.uploads)
    assert transport.commands.count("output-archive") == 1
    assert "output" not in transport.commands
    assert len([name for name in transport.commands if name != "poll"]) <= 5
    assert server.declaration_requests == [
        [{"index": 0, "kind": "model", "path": "model.bin", "metadata": {"utterances": BULK_OUTPUT_FILES}}]
    ]
    paths = [path for path, _body in server.calls]
    assert paths.index(next(path for path in paths if path.endswith("/outputs"))) < paths.index(
        next(path for path in paths if path.endswith("/complete"))
    )


class ArchiveExecutor:
    """Serves output-archive streams built by a test instead of a remote runner."""

    def __init__(self, build_stream):
        self.build_stream = build_stream
        self.requests: list[dict] = []

    async def stream_command(self, name, *, payload, consume):
        assert name == "output-archive"
        self.requests.append(payload)
        stream = asyncio.StreamReader()
        stream.feed_data(self.build_stream(payload))
        stream.feed_eof()
        return await consume(stream)


def write_outputs(workspace: Path, count: int = 4) -> dict:
    outputs = workspace / "outputs"
    outputs.mkdir(parents=True)
    artifacts = []
    for number in range(count):
        content = f"generated audio {number}".encode() * 100
        (outputs / f"{number}.wav").write_bytes(content)
        artifacts.append(
            {"path": f"{number}.wav", "sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
        )
    (outputs / "result.json").write_text(json.dumps({"version": 1, "complete": True, "artifacts": artifacts}))
    results = validate_results(outputs)
    assert results is not None
    return results


def runner_archive(workspace: Path, payload: dict) -> bytes:
    destination = io.BytesIO()
    index = (workspace / "output-index.jsonl").read_bytes()
    write_output_archive(destination, workspace / "outputs", index, acknowledged=set(payload["acknowledged"]))
    return destination.getvalue()


def collect(worker_job, results, executor, acknowledgments, tmp_path, *, uploads):
    async def save(request: httpx.Request) -> httpx.Response:
        content = await request.aread()
        uploads.append((request.url.params["path"], content))
        return httpx.Response(200, json={"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)})

    async def scenario():
        api = WorkerApi(url="http://localhost/api", token="secret", transport=httpx.MockTransport(save))
        try:
            await receive_output_archive(
                worker_job,
                results,
                api=api,
                executor=executor,
                acknowledgments=acknowledgments,
                persist=lambda: None,
                temporary_path=tmp_path / "transfer.output",
            )
        finally:
            await api.close()

    asyncio.run(scenario())


def test_interrupted_archive_is_resumed_with_only_the_unacknowledged_outputs(worker_job, tmp_path):
    workspace = tmp_path / "workspace"
    results = write_outputs(workspace)
    first_full_archive = runner_archive(workspace, {"acknowledged": []})
    # Cut the stream in the third file: two outputs are saved before the connection drops.
    third_offset = first_full_archive.index(b"generated audio 2")
    attempts = iter([first_full_archive[: third_offset + 10], None])

    def build(payload):
        truncated = next(attempts)
        return truncated if truncated is not None else runner_archive(workspace, payload)

    executor = ArchiveExecutor(build)
    acknowledgments: dict = {}
    uploads: list = []
    with pytest.raises(TransportError):
        collect(worker_job, results, executor, acknowledgments, tmp_path, uploads=uploads)
    assert [path for path, _ in uploads] == ["container/0.wav", "container/1.wav"]
    collect(worker_job, results, executor, acknowledgments, tmp_path, uploads=uploads)
    assert sorted(executor.requests[1]["acknowledged"]) == sorted(acknowledgments["artifacts"][:2])
    assert [path for path, _ in uploads] == [f"container/{number}.wav" for number in range(4)]
    assert len(acknowledgments["artifacts"]) == 4
    # Everything acknowledged: no further connection is opened.
    collect(worker_job, results, executor, acknowledgments, tmp_path, uploads=uploads)
    assert len(executor.requests) == 2


def tar_with(members: list[tuple[tarfile.TarInfo, bytes]], index: bytes) -> bytes:
    destination = io.BytesIO()
    with tarfile.open(fileobj=destination, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        index_member = tarfile.TarInfo(INDEX_MEMBER_NAME)
        index_member.size = len(index)
        archive.addfile(index_member, io.BytesIO(index))
        for member, content in members:
            archive.addfile(member, io.BytesIO(content) if member.isfile() else None)
    return destination.getvalue()


def regular(path: str, content: bytes) -> tuple[tarfile.TarInfo, bytes]:
    member = tarfile.TarInfo(path)
    member.size = len(content)
    return member, content


def link(path: str, kind: bytes) -> tuple[tarfile.TarInfo, bytes]:
    member = tarfile.TarInfo(path)
    member.type = kind
    member.linkname = "../../etc/passwd"
    return member, b""


@pytest.mark.parametrize(
    "extra_member",
    [
        regular("undeclared.wav", b"not in the manifest"),
        regular("../escape.wav", b"outside outputs"),
        link("0.wav", tarfile.SYMTYPE),
        link("0.wav", tarfile.LNKTYPE),
    ],
    ids=["undeclared", "parent-path", "symlink", "hardlink"],
)
def test_archive_with_undeclared_escaping_or_linked_members_is_rejected_before_saving_them(
    worker_job, tmp_path, extra_member
):
    workspace = tmp_path / "workspace"
    results = write_outputs(workspace, count=1)
    index = (workspace / "output-index.jsonl").read_bytes()
    content = (workspace / "outputs/0.wav").read_bytes()
    members = [extra_member] if extra_member[0].name == "0.wav" else [regular("0.wav", content), extra_member]
    executor = ArchiveExecutor(lambda _payload: tar_with(members, index))
    uploads: list = []
    with pytest.raises(ConfigurationError):
        collect(worker_job, results, executor, {}, tmp_path, uploads=uploads)
    assert all(path == "container/0.wav" for path, _ in uploads)


def test_one_changed_output_fails_collection_and_is_never_saved(worker_job, tmp_path):
    workspace = tmp_path / "workspace"
    results = write_outputs(workspace)
    changed = workspace / "outputs/2.wav"
    changed.write_bytes(bytes(len(changed.read_bytes())))
    executor = ArchiveExecutor(lambda payload: runner_archive(workspace, payload))
    acknowledgments: dict = {}
    uploads: list = []
    with pytest.raises(ConfigurationError, match="sha256 mismatch"):
        collect(worker_job, results, executor, acknowledgments, tmp_path, uploads=uploads)
    assert [path for path, _ in uploads] == ["container/0.wav", "container/1.wav"]
    assert not any(key.startswith("2.wav:") for key in acknowledgments["artifacts"])


def test_index_that_differs_from_the_validated_summary_is_rejected(worker_job, tmp_path):
    workspace = tmp_path / "workspace"
    results = write_outputs(workspace)
    results["artifactIndexSha256"] = "0" * 64
    executor = ArchiveExecutor(lambda payload: runner_archive(workspace, payload))
    with pytest.raises(ConfigurationError, match="index"):
        collect(worker_job, results, executor, {}, tmp_path, uploads=[])


def test_runner_refuses_outputs_changed_after_validation_without_a_retry(worker_job, worker_settings):
    async def scenario():
        executor = JobExecutor(worker_job, worker_settings)
        await executor.install_runtime()
        assert executor.workspace is not None
        workspace = Path(executor.workspace)
        results = write_outputs(workspace)
        (workspace / "state.json").write_text(json.dumps({"status": "finished", "results": results}))
        (workspace / "outputs/1.wav").write_bytes(b"shorter")
        received: list[str] = []

        async def consume(stream: asyncio.StreamReader) -> None:
            from mado_tracking.worker.output_archive import OutputArchiveReader

            archive = OutputArchiveReader(stream, idle_timeout_seconds=10)
            await archive.read_index(maximum_bytes=1 << 20)
            while member := await archive.next_member():
                received.append(member.path)
                async for _chunk in archive.content(member):
                    pass

        with pytest.raises(StreamRejected, match="changed after completion"):
            await executor.stream_command("output-archive", payload={"acknowledged": []}, consume=consume)
        assert received == ["0.wav"]

    asyncio.run(scenario())
