from __future__ import annotations

import asyncio
import io
import json
import shlex
import tarfile
import zipfile
from pathlib import Path

import httpx
import pytest
from background_process import entrypoint_with_background_child

from mado_tracking.errors import TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.host_state import process_identity
from mado_tracking.worker.runtime import JobExecutor
from mado_tracking.worker.service import Worker
from mado_tracking.worker.transport import LocalTransport, SSHTransport


class WorkerServer:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls: list[tuple[str, dict]] = []
        self.cancel = False
        self.reject_lease = False
        self.completions: list[dict] = []
        self.log_notifications: dict[str, asyncio.Event] = {}
        self.artifact: bytes | None = None

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-api-secret"
        if request.method == "GET":
            assert request.url.path.endswith("/content") and self.artifact is not None
            return httpx.Response(200, content=self.artifact)
        body = json.loads(request.content)
        self.calls.append((request.url.path, body))
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json={"item": self.payload})
        if request.url.path.endswith("/resume"):
            return httpx.Response(200, json={"items": [self.payload]})
        assert body["leaseId"] == self.payload["job"]["leaseId"]
        if self.reject_lease:
            return httpx.Response(409, json={"error": "stale lease", "code": "LEASE_REJECTED"})
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"cancelRequested": self.cancel})
        if request.url.path.endswith("/complete"):
            assert all(value is not None for value in body.values())
            self.completions.append(body)
        if request.url.path.endswith("/logs"):
            for message, event in self.log_notifications.items():
                if any(message in entry["message"] for entry in body["entries"]):
                    event.set()
        return httpx.Response(200, json={})

    def client(self) -> WorkerApi:
        return WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(self.serve)
        )


def test_local_job_runs_for_real_and_forwards_masked_output_with_metrics(job_payload, worker_settings):
    job_payload["codeVersion"]["environment"]["MLFLOW_TRACKING_URI"] = "http://wrong-project.invalid"
    job_payload["codeVersion"]["environment"]["MLFLOW_RUN_ID"] = "wrong-run"
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import os,sys,time,json\n"
        "print('running cpu job', flush=True)\n"
        "print(os.environ['MMT_API_TOKEN'], flush=True)\n"
        "print(os.environ['MLFLOW_TRACKING_TOKEN'], flush=True)\n"
        "print('tracking=' + os.environ['MLFLOW_TRACKING_URI'], flush=True)\n"
        "print('run=' + os.environ['MLFLOW_RUN_ID'], flush=True)\n"
        "sys.stderr.write(os.environ['MY_PASSWORD'] + '\\n'); sys.stderr.flush()\n"
        "print(json.load(open(os.environ['MMT_PARAMETERS_FILE']))['steps'])\n"
        "print('gpus=' + os.environ['CUDA_VISIBLE_DEVICES'])\n"
        "time.sleep(0.2)\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    assert server.completions[-1]["exitCode"] == 0
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert "running cpu job" in messages and "[REDACTED]" in messages and "gpus=" in messages
    assert "test-api-secret" not in messages and "configured-secret" not in messages
    assert f"tracking=http://localhost/api/mlflow/projects/{job_payload['job']['projectId']}" in messages
    assert f"run={job_payload['run']['id']}" in messages
    assert "wrong-project.invalid" not in messages and "wrong-run" not in messages
    assert any(path.endswith("/metrics") and body["metrics"] for path, body in server.calls)
    assert any(path.endswith("/heartbeat") and body.get("status") == "running" for path, body in server.calls)
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "spec.json").exists()
    assert (workspace / "state.json").stat().st_mode & 0o077 == 0


def test_nonzero_exit_completes_failed_and_stderr_is_visible(job_payload, worker_settings):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import sys\nprint('bad input',file=sys.stderr)\nsys.exit(7)\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "failed" and server.completions[-1]["exitCode"] == 7
    assert any(
        "bad input" in entry["message"]
        for path, body in server.calls
        if path.endswith("/logs")
        for entry in body["entries"]
    )


@pytest.mark.parametrize("ignore_sigterm", [False, True], ids=["graceful-child", "child-ignores-term"])
def test_successful_job_completes_after_stopping_children_that_inherit_its_output(
    job_payload, worker_settings, ignore_sigterm
):
    job_payload["codeVersion"]["environment"]["TEST_SECRET"] = "configured-secret"
    job_payload["codeVersion"]["source"]["files"]["main.py"] = entrypoint_with_background_child(
        ignore_sigterm=ignore_sigterm
    )
    server = WorkerServer(job_payload)
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            if (workspace / "state.json").exists() and not server.completions:
                (workspace / "cancel.request").touch()
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions == [
        {"leaseId": job_payload["job"]["leaseId"], "status": "finished", "exitCode": 0}
    ]
    state = json.loads((workspace / "state.json").read_text())
    assert state["status"] == "finished" and state["exitCode"] == 0
    assert process_identity(int((workspace / "source/child.pid").read_text())) is None
    assert not (workspace / "spec.json").exists()
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert "entrypoint exit=0" in messages and "child stdout [REDACTED]" in messages
    assert "entrypoint stderr" in messages and "child stderr [REDACTED]" in messages
    assert "configured-secret" not in messages
    if not ignore_sigterm:
        assert "child cleanup stdout" in messages and "child cleanup stderr [REDACTED]" in messages


def test_cancel_kills_process_group_after_sigterm_grace(job_payload, worker_settings):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import signal,time,subprocess,sys\n"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
        "child='import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'\n"
        "subprocess.Popen([sys.executable,'-c',child])\n"
        "print('ready-for-cancel',flush=True)\n"
        "time.sleep(60)\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(worker.run_job(WorkerJob.parse(job_payload)))
        ready = asyncio.Event()
        server.log_notifications["ready-for-cancel"] = ready
        try:
            async with asyncio.timeout(15):
                await ready.wait()
                server.cancel = True
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "canceled"


def test_rejected_lease_never_installs_or_starts_execution(job_payload, worker_settings):
    server = WorkerServer(job_payload)
    server.reject_lease = True

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await worker.run_job(WorkerJob.parse(job_payload))
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert not Path(job_payload["target"]["workDirectory"]).exists()
    assert not server.completions
    assert list(worker_settings.state_directory.glob("*.rejected"))


def test_lost_start_response_reattaches_without_starting_twice(job_payload, worker_settings):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import pathlib,time\n"
        "path=pathlib.Path('../starts.txt')\n"
        "with path.open('a') as output: output.write('started\\n')\n"
        "time.sleep(0.2)\nprint('after-disconnect')\n"
    )
    server = WorkerServer(job_payload)

    class InterruptedTransport(LocalTransport):
        failed_once = False

        async def run(self, command, **options):
            response = await super().run(command, **options)
            if "start" in command and not self.failed_once:
                self.failed_once = True
                raise TransportError("SSH connection lost after start")
            return response

    def executor(job, settings):
        transport = InterruptedTransport(allow_local_executor=True, masker=SecretMasker(["test-api-secret"]))
        return JobExecutor(job, settings, transport=transport)

    async def scenario():
        worker = Worker(worker_settings, api=server.client(), executor_factory=executor)
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert (workspace / "starts.txt").read_text() == "started\n"
    assert server.completions[-1]["status"] == "finished"


@pytest.mark.parametrize("archive_format", ["zip", "tar"])
def test_artifact_source_downloads_and_runs_real_code(job_payload, worker_settings, archive_format):
    content = b"print('archive execution succeeded')\n"
    buffer = io.BytesIO()
    if archive_format == "zip":
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("main.py", content)
    else:
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            member = tarfile.TarInfo("main.py")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    job_payload["codeVersion"]["source"] = {"kind": "artifact", "artifactId": "code-artifact"}
    server = WorkerServer(job_payload)
    server.artifact = buffer.getvalue()

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    assert any(
        "archive execution succeeded" in entry["message"]
        for path, body in server.calls
        if path.endswith("/logs")
        for entry in body["entries"]
    )


def test_cancel_during_source_download_does_not_wait_for_the_entire_artifact(job_payload, worker_settings):
    job_payload["codeVersion"]["source"] = {"kind": "artifact", "artifactId": "code-artifact"}
    server = WorkerServer(job_payload)

    async def scenario():
        download_started = asyncio.Event()
        never_finishes = asyncio.Event()

        class SlowArchive(httpx.AsyncByteStream):
            async def __aiter__(self):
                download_started.set()
                yield b"partial-archive"
                await never_finishes.wait()

        async def serve(request):
            if request.method == "GET":
                return httpx.Response(200, stream=SlowArchive())
            return server.serve(request)

        api = WorkerApi(
            url="http://localhost/api", token="test-api-secret", transport=httpx.MockTransport(serve)
        )
        worker = Worker(worker_settings, api=api)
        task = asyncio.create_task(worker.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(15):
                await download_started.wait()
                server.cancel = True
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "canceled"
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert not (workspace / "state.json").exists()
    assert not list(worker_settings.state_directory.glob("*.source"))


def test_fake_ssh_transport_preserves_argv_and_detached_runner_state(job_payload, worker_settings, tmp_path):
    key, known_hosts = tmp_path / "key", tmp_path / "known_hosts"
    key.write_text("not-a-real-private-key")
    key.chmod(0o600)
    known_hosts.write_text("test fixture only")
    job_payload["target"].update(
        executor="ssh",
        sshKeyPath=str(key),
        knownHostsPath=str(known_hosts),
        workDirectory=str(tmp_path / "space ' and ; characters"),
    )
    arguments = ["two words", "$(touch never-created)", "a;exit 19", "quote's"]
    job_payload["codeVersion"]["entrypoint"] = ["python", "main.py", *arguments]
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import json,sys\nprint(json.dumps(sys.argv[1:]))\n"
    )
    server = WorkerServer(job_payload)

    class FakeSSHTransport(SSHTransport):
        def command_argv(self, command):
            ssh_argv = super().command_argv(command)
            assert "StrictHostKeyChecking=yes" in ssh_argv
            assert shlex.split(ssh_argv[-1]) == command
            # Simulate the remote login shell locally; never contact an SSH host.
            return ["sh", "-c", ssh_argv[-1]]

    def executor(job, settings):
        transport = FakeSSHTransport(
            host="example.invalid",
            port=22,
            username="worker",
            ssh_key_path=str(key),
            known_hosts_path=str(known_hosts),
            masker=SecretMasker([settings.api.token]),
        )
        return JobExecutor(job, settings, transport=transport)

    async def scenario():
        worker = Worker(worker_settings, api=server.client(), executor_factory=executor)
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 15)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert json.dumps(arguments) in messages
    assert not (
        Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"] / "source/never-created"
    ).exists()


def test_worker_restart_reattaches_existing_process_and_preserves_log_cursor(job_payload, worker_settings):
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import pathlib,time\n"
        "with pathlib.Path('../starts.txt').open('a') as output: output.write('started\\n')\n"
        "print('before-worker-restart',flush=True)\ntime.sleep(0.7)\nprint('after-worker-restart')\n"
    )
    server = WorkerServer(job_payload)

    async def scenario():
        first_worker = Worker(worker_settings, api=server.client())
        first_task = asyncio.create_task(first_worker.run_job(WorkerJob.parse(job_payload)))
        ready = asyncio.Event()
        server.log_notifications["before-worker-restart"] = ready
        async with asyncio.timeout(15):
            await ready.wait()
            first_task.cancel()
            await asyncio.gather(first_task, return_exceptions=True)
            await first_worker.api.close()
            job_payload["job"]["status"] = "running"
            second_worker = Worker(worker_settings, api=server.client())
            try:
                recovered = await second_worker.recover()
                await second_worker.run_job(recovered[0])
            finally:
                await second_worker.api.close()

    asyncio.run(scenario())
    workspace = Path(job_payload["target"]["workDirectory"]) / job_payload["job"]["id"]
    assert (workspace / "starts.txt").read_text() == "started\n"
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert messages.count("before-worker-restart") == 1 and "after-worker-restart" in messages
    assert server.completions[-1]["status"] == "finished"
