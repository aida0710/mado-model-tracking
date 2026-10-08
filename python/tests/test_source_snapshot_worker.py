from __future__ import annotations

import asyncio
import hashlib
import io
import json
import zipfile
from pathlib import Path

import httpx
import pytest
from test_container_inputs import container_payload
from test_execution_snapshot import pin_execution
from test_source import git_source as git_source
from test_worker import WorkerServer

from mado_tracking.errors import ConfigurationError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.journal import JobJournal
from mado_tracking.worker.runtime import JobExecutor
from mado_tracking.worker.service import Worker

# All code is executed on the CPU/local runner; no production SSH host or GPU is contacted.
JOB_TIMEOUT_SECONDS = 15


async def execute_job(server, settings):
    worker = Worker(settings, api=server.client())
    try:
        await asyncio.wait_for(worker.run_job(WorkerJob.parse(server.payload)), JOB_TIMEOUT_SECONDS)
    finally:
        await worker.api.close()


@pytest.mark.parametrize("mode,exit_code", [("run", 0), ("run", 7), ("test", 0), ("test", 9)])
def test_snapshot_keeps_pre_execution_code_and_failure_after_source_mutation(
    job_payload, worker_settings, mode, exit_code
):
    source = (
        "import pathlib,sys,os\n"
        "with pathlib.Path('../starts.txt').open('a') as output: output.write('started\\n')\n"
        "pathlib.Path('main.py').write_text('mutated during execution')\n"
        "print('executed-mode=' + os.environ['MMT_EXECUTION_MODE'])\n"
        f"sys.exit({exit_code})\n"
    )
    files = {"main.py": source if mode == "run" else "raise RuntimeError('wrong command')\n"}
    if mode == "test":
        files["test.py"] = source
    job_payload["codeVersion"].update(
        source={"kind": "inline", "files": files}, testEntrypoint=["python", "test.py"]
    )
    pin_execution(job_payload, mode)
    server = WorkerServer(job_payload)
    asyncio.run(execute_job(server, worker_settings))
    completion = server.completions[-1]
    assert completion["status"] == ("finished" if exit_code == 0 else "failed")
    assert completion["exitCode"] == exit_code
    uploads = dict(server.snapshot_uploads)
    assert set(uploads) == {".mmt/source.zip", ".mmt/source-manifest.json"}
    with zipfile.ZipFile(io.BytesIO(uploads[".mmt/source.zip"])) as archive:
        assert set(archive.namelist()) == set(files)
        assert {name: archive.read(name).decode() for name in archive.namelist()} == files
    manifest = json.loads(uploads[".mmt/source-manifest.json"])
    assert (manifest["jobId"], manifest["runId"], manifest["codeVersionId"], manifest["mode"]) == (
        job_payload["job"]["id"],
        job_payload["run"]["id"],
        job_payload["codeVersion"]["id"],
        mode,
    )
    assert manifest["runtime"] == {"kind": "python"} and manifest["commit"] is None
    assert manifest["codeVersionVersion"] == "v1"
    assert manifest["entrypoint"] == job_payload["run"]["executionSnapshot"]["entrypoint"]
    assert manifest["files"] == [
        {"path": name, "size": len(content.encode()), "sha256": hashlib.sha256(content.encode()).hexdigest()}
        for name, content in sorted(files.items())
    ]
    assert "configured-secret" not in json.dumps(manifest) and "test-api-secret" not in json.dumps(manifest)
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert (workspace / "source/main.py").read_text() == "mutated during execution"
    assert (workspace / "starts.txt").read_text() == "started\n"
    assert not (workspace / "spec.json").exists()


@pytest.mark.parametrize("exit_code", [0, 7])
def test_snapshot_upload_rejection_fails_success_or_preserves_the_original_code_failure(
    job_payload, worker_settings, exit_code
):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = f"import sys;sys.exit({exit_code})\n"
    pin_execution(job_payload)
    server = WorkerServer(job_payload)

    def serve(request):
        if request.method == "PUT":
            return httpx.Response(403, json={"error": "artifact save denied"})
        return server.serve(request)

    async def scenario():
        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        worker = Worker(worker_settings, api=api)
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), JOB_TIMEOUT_SECONDS)
        finally:
            await api.close()

    asyncio.run(scenario())
    completion = server.completions[-1]
    assert completion["status"] == "failed" and completion["exitCode"] == exit_code
    assert "Source snapshot save failed" in completion["error"]
    if exit_code:
        assert "Entrypoint exited with status 7" in completion["error"]


def test_restart_during_snapshot_collection_keeps_acknowledged_zip_without_reexecuting_source(
    job_payload, worker_settings
):
    code = "import pathlib\nwith pathlib.Path('../starts.txt').open('a') as output: output.write('once\\n')\n"
    job_payload["codeVersion"]["source"]["files"]["main.py"] = code
    pin_execution(job_payload)
    server = WorkerServer(job_payload)
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]

    async def scenario():
        manifest_started, blocked = asyncio.Event(), asyncio.Event()

        async def serve(request):
            if request.method == "PUT" and request.url.params["path"] == ".mmt/source-manifest.json":
                manifest_started.set()
                await blocked.wait()
            return server.serve(request)

        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        first = Worker(worker_settings, api=api)
        task = asyncio.create_task(first.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(JOB_TIMEOUT_SECONDS):
                await manifest_started.wait()
                record = JobJournal(worker_settings.state_directory).load(job_payload["job"]["id"])
                assert record["results"]["sourceSnapshot"]["artifacts"]
                assert [path for path, _content in server.snapshot_uploads] == [".mmt/source.zip"]
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await api.close()
                (workspace / "source/main.py").write_text("raise RuntimeError('must not rerun')")
                job_payload["job"]["status"] = "running"
                await execute_job(server, worker_settings)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await api.close()

    asyncio.run(scenario())
    assert (workspace / "starts.txt").read_text() == "once\n"
    assert [path for path, _content in server.snapshot_uploads] == [
        ".mmt/source.zip",
        ".mmt/source-manifest.json",
    ]
    with zipfile.ZipFile(io.BytesIO(dict(server.snapshot_uploads)[".mmt/source.zip"])) as archive:
        assert archive.read("main.py").decode() == code
    assert server.completions[-1]["status"] == "finished"


def test_source_free_container_saves_pinned_runtime_manifest_even_when_runtime_is_unavailable(
    job_payload, worker_settings, tmp_path, monkeypatch
):
    container_payload(job_payload)
    pin_execution(job_payload)
    monkeypatch.setenv("PATH", str(tmp_path / "missing-runtime"))
    server = WorkerServer(job_payload)
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "failed"
    assert [path for path, _content in server.snapshot_uploads] == [".mmt/source-manifest.json"]
    manifest = json.loads(server.snapshot_uploads[0][1])
    assert manifest["runtime"] == job_payload["codeVersion"]["runtime"]
    assert manifest["files"] == [] and manifest["commit"] is None


def test_bad_archive_fails_source_preparation_without_running_code_or_saving_false_evidence(
    job_payload, worker_settings
):
    job_payload["codeVersion"]["source"] = {"kind": "artifact", "artifactId": "source-artifact"}
    pin_execution(job_payload)
    server = WorkerServer(job_payload)
    server.artifact = b"not a code archive"
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "failed"
    assert "Code source preparation failed" in server.completions[-1]["error"]
    assert not server.snapshot_uploads
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "venv").exists() and not any((workspace / "source").iterdir())


def test_resume_refuses_changed_pinned_instructions_even_with_the_same_lease(job_payload, worker_settings):
    pin_execution(job_payload)
    journal = JobJournal(worker_settings.state_directory)
    journal.save(WorkerJob.parse(job_payload))
    job_payload["codeVersion"]["entrypoint"] = ["python", "other.py"]
    pin_execution(job_payload)
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            with pytest.raises(ConfigurationError, match="Saved executionSnapshot differs"):
                await worker.run_job(WorkerJob.parse(job_payload))
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert not Path(job_payload["target"]["workDirectory"]).exists()


def test_source_archive_download_limit_fails_before_the_runner_starts(
    job_payload, worker_settings, monkeypatch
):
    job_payload["codeVersion"]["source"] = {"kind": "artifact", "artifactId": "source-artifact"}
    monkeypatch.setattr("mado_tracking.worker.session.MAX_SOURCE_ARCHIVE_BYTES", 4)
    server = WorkerServer(job_payload)
    server.artifact = b"too large"
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "failed"
    assert "download size limit" in server.completions[-1]["error"]
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "state.json").exists() and not server.snapshot_uploads


def test_git_source_snapshot_preserves_the_exact_commit_and_applied_edits(
    job_payload, worker_settings, git_source
):
    source = {
        **git_source,
        "files": {"main.py": "print('edited git code')\n", "new.py": "new source\n"},
        "deletedFiles": ["delete.py"],
    }
    job_payload["codeVersion"]["source"] = source
    pin_execution(job_payload)
    server = WorkerServer(job_payload)
    asyncio.run(execute_job(server, worker_settings))
    uploads = dict(server.snapshot_uploads)
    manifest = json.loads(uploads[".mmt/source-manifest.json"])
    assert manifest["commit"] == git_source["commit"]
    with zipfile.ZipFile(io.BytesIO(uploads[".mmt/source.zip"])) as archive:
        assert archive.read("main.py").decode() == source["files"]["main.py"]
        assert archive.read("new.py").decode() == source["files"]["new.py"]
        assert archive.read("unchanged.bin") == b"base binary\x00"
        assert "delete.py" not in archive.namelist()
        assert not any(".git" in name.split("/") for name in archive.namelist())
    assert server.completions[-1]["status"] == "finished"


def test_snapshot_creation_failure_reports_failure_without_starting_the_entrypoint(
    job_payload, worker_settings
):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import pathlib\npathlib.Path('../entrypoint-started').touch()\n"
    )
    pin_execution(job_payload)
    server = WorkerServer(job_payload)

    class BlockedSnapshotExecutor(JobExecutor):
        async def install_runtime(self):
            await super().install_runtime()
            (Path(self.workspace) / "source-snapshot").mkdir()

    async def scenario():
        worker = Worker(worker_settings, api=server.client(), executor_factory=BlockedSnapshotExecutor)
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), JOB_TIMEOUT_SECONDS)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    completion = server.completions[-1]
    assert completion["status"] == "failed" and "exitCode" not in completion
    assert "Source snapshot creation failed" in completion["error"]
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "entrypoint-started").exists() and not (workspace / "venv").exists()
    assert not server.snapshot_uploads
