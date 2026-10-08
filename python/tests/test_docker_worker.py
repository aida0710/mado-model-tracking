"""Real local Docker daemon tests; opt in with an already-cached immutable image reference."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import os
import runpy
import signal
import subprocess
import threading
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_container_inputs import container_payload
from test_worker import WorkerServer

from mado_tracking.errors import TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.host_state import is_same_process
from mado_tracking.worker.runtime import JobExecutor
from mado_tracking.worker.service import Worker
from mado_tracking.worker.transport import LocalTransport

EXAMPLE_PATH = Path(__file__).resolve().parent.parent / "examples/container_fixture.py"
FIXTURE_SCRIPT = runpy.run_path(str(EXAMPLE_PATH))["FIXTURE_SCRIPT"]
# A leaked client/container fails promptly; cleanup runs against this test's job only.
DOCKER_TEST_TIMEOUT_SECONDS = 20


@pytest.fixture
def docker_image():
    image = os.environ.get("MMT_TEST_DOCKER_IMAGE")
    if not image:
        pytest.skip("Set MMT_TEST_DOCKER_IMAGE to a cached image@sha256 reference for local Docker tests")
    subprocess.run(["docker", "image", "inspect", image], check=True, capture_output=True)
    return image


def docker_job(payload, image, *, script=FIXTURE_SCRIPT, delay="0"):
    container_payload(payload)
    payload["codeVersion"].update(
        runtime={"kind": "docker", "image": image, "workingDirectory": "/tmp"},
        entrypoint=["/bin/sh", "-c", script, "mmt-fixture", delay],
    )
    return payload


def workspace_for(payload):
    return Path(payload["target"]["workDirectory"]) / payload["job"]["id"]


def container_exists(payload):
    response = subprocess.run(
        [
            "docker",
            "container",
            "ls",
            "--all",
            "--filter",
            f"name=^/mmt-job-{payload['job']['id']}$",
            "--format",
            "{{.ID}}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return bool(response.stdout.strip())


class ContainerServer(WorkerServer):
    def __init__(self, payload, *, verify_daemon_cleanup=True):
        super().__init__(payload)
        self.uploads = []
        self.upload_status = 200
        self.result_metrics_status = 200
        self.lose_first_upload_response = False
        self.result_metrics = []
        self.verify_daemon_cleanup = verify_daemon_cleanup
        self.artifact_encoding = None
        self.truncate_artifact = False

    async def serve_container(self, request):
        if request.method == "GET" and self.artifact_encoding == "gzip":
            encoded = gzip.compress(self.artifact)
            if self.truncate_artifact:
                encoded = encoded[:-8]

            class EncodedArtifact(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield encoded

            return httpx.Response(
                200,
                headers={"Content-Encoding": "gzip", "Content-Length": str(len(encoded))},
                stream=EncodedArtifact(),
            )
        if request.method == "PUT":
            content = await request.aread()
            self.uploads.append((request.url.params["path"], content))
            if self.lose_first_upload_response and len(self.uploads) == 1:
                raise httpx.ReadError("lost output save response", request=request)
            if self.upload_status != 200:
                return httpx.Response(self.upload_status, json={"error": "output API save rejected"})
            return httpx.Response(
                200,
                json={
                    "id": str(uuid4()),
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                },
            )
        if request.url.path.endswith("/metrics"):
            metrics = json.loads(request.content)["metrics"]
            result_metrics = [point for point in metrics if point["name"] == "fixture.score"]
            self.result_metrics.extend(result_metrics)
            if result_metrics and self.result_metrics_status != 200:
                return httpx.Response(self.result_metrics_status, json={"error": "metrics save rejected"})
        if request.url.path.endswith("/complete") and self.verify_daemon_cleanup:
            assert not container_exists(self.payload), (
                "Job must not release resources before daemon container cleanup"
            )
        return super().serve(request)

    def client(self):
        from mado_tracking.worker.api import WorkerApi

        return WorkerApi(
            url="http://localhost/api",
            token="test-api-secret",
            transport=httpx.MockTransport(self.serve_container),
        )


async def execute_job(server, settings, *, executor_factory=JobExecutor):
    worker = Worker(settings, api=server.client(), executor_factory=executor_factory)
    try:
        await asyncio.wait_for(worker.run_job(WorkerJob.parse(server.payload)), DOCKER_TEST_TIMEOUT_SECONDS)
    finally:
        await worker.api.close()
        if not server.completions and workspace_for(server.payload).exists():
            (workspace_for(server.payload) / "cancel.request").touch()


def test_docker_stages_weights_mounts_readonly_collects_files_and_metrics_without_sdk_or_pip(
    job_payload, worker_settings, docker_image
):
    docker_job(job_payload, docker_image)
    model_id, artifact_id, dataset_id = [str(uuid4()) for _ in range(3)]
    job_payload["run"].update(modelVersionId=model_id, inputDatasetVersionIds=[dataset_id])
    job_payload["modelVersion"] = {
        "id": model_id,
        "projectId": job_payload["job"]["projectId"],
        "family": "linear",
        "artifactId": artifact_id,
    }
    job_payload["inputDatasets"] = [
        {
            "id": dataset_id,
            "projectId": job_payload["job"]["projectId"],
            "uri": "https://example.invalid/no-token",
            "metadata": {"format": "json"},
        }
    ]
    server = ContainerServer(job_payload)
    server.artifact = b'{"weight":2,"bias":1}'
    asyncio.run(execute_job(server, replace(worker_settings, install_dependencies=True)))
    assert server.completions[-1]["status"] == "finished"
    assert server.uploads == [("container/input-copy.json", server.artifact)]
    assert len(server.result_metrics) == 1 and server.result_metrics[0]["value"] == 0.9
    workspace = workspace_for(job_payload)
    state = json.loads((workspace / "state.json").read_text())
    assert state["container"]["released"] and state["container"]["exitCode"] == 0
    assert not (workspace / "venv").exists() and not (workspace / "container.env").exists()
    assert not (workspace / "spec.json").exists()
    assert (workspace / "inputs/weights").stat().st_mode & 0o777 == 0o400
    context = json.loads((workspace / "context/dataset-versions.json").read_text())
    assert context["inputDatasets"][0]["uri"] == "https://example.invalid/no-token"
    logs = "".join((workspace / f"{name}.log").read_text() for name in ("stdout", "stderr"))
    assert "container-ready" in logs and "[REDACTED]" in logs and "test-api-secret" not in logs


@pytest.mark.parametrize("truncate", [False, True], ids=["normal-gzip", "missing-gzip-trailer"])
def test_gzip_artifact_weights_reach_container_only_when_the_download_is_complete(
    job_payload, worker_settings, docker_image, truncate
):
    docker_job(job_payload, docker_image)
    model_id = str(uuid4())
    job_payload["run"]["modelVersionId"] = model_id
    job_payload["modelVersion"] = {
        "id": model_id,
        "projectId": job_payload["job"]["projectId"],
        "family": "linear",
        "artifactId": str(uuid4()),
    }
    server = ContainerServer(job_payload)
    server.artifact = b'{"weight":2,"bias":1}'
    server.artifact_encoding = "gzip"
    server.truncate_artifact = truncate
    asyncio.run(execute_job(server, worker_settings))
    if truncate:
        assert server.completions[-1]["status"] == "failed"
        assert not (workspace_for(job_payload) / "state.json").exists()
        assert not server.uploads and not server.result_metrics
    else:
        assert server.completions[-1]["status"] == "finished"
        assert server.uploads == [("container/input-copy.json", server.artifact)]
    assert not container_exists(job_payload)
    assert not list(worker_settings.state_directory.glob("*.weights"))


@pytest.mark.parametrize("failure", ["entrypoint", "incomplete", "sha", "metrics", "upload", "metric-save"])
def test_docker_execution_or_output_failures_cannot_complete_successfully(
    job_payload, worker_settings, docker_image, failure
):
    script = FIXTURE_SCRIPT
    if failure == "entrypoint":
        script = "echo entrypoint-failed >&2; exit 7"
    elif failure == "incomplete":
        script = "printf partial > /mmt/outputs/predictions.partial"
    elif failure == "sha":
        script = FIXTURE_SCRIPT.replace('"$checksum" "$size"', '"' + "0" * 64 + '" "$size"')
    elif failure == "metrics":
        script = FIXTURE_SCRIPT.replace('"value":0.9', '"value":null')
    docker_job(job_payload, docker_image, script=script)
    server = ContainerServer(job_payload)
    server.upload_status = 403 if failure == "upload" else 200
    server.result_metrics_status = 400 if failure == "metric-save" else 200
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "failed"
    assert not container_exists(job_payload)
    if failure in {"entrypoint", "incomplete", "sha", "metrics"}:
        assert not server.uploads and not server.result_metrics
    if failure == "entrypoint":
        assert server.completions[-1]["exitCode"] == 7


def test_docker_cancel_stops_daemon_and_children_before_job_completion(
    job_payload, worker_settings, docker_image
):
    script = "trap '' TERM; sleep 60 & echo container-ready; wait"
    docker_job(job_payload, docker_image, script=script)
    server = ContainerServer(job_payload)

    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        ready = asyncio.Event()
        server.log_notifications["container-ready"] = ready
        task = asyncio.create_task(worker.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(DOCKER_TEST_TIMEOUT_SECONDS):
                await ready.wait()
                server.cancel = True
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await worker.api.close()
            (workspace_for(job_payload) / "cancel.request").touch()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "canceled" and not container_exists(job_payload)


@pytest.mark.parametrize("kill_supervisor", [False, True], ids=["worker-restart", "supervisor-recovery"])
def test_docker_recovery_adopts_one_existing_container_without_restart(
    job_payload, worker_settings, docker_image, kill_supervisor
):
    docker_job(job_payload, docker_image, delay="2")
    server = ContainerServer(job_payload)
    workspace = workspace_for(job_payload)

    async def scenario():
        ready = asyncio.Event()
        server.log_notifications["container-ready"] = ready
        first = Worker(worker_settings, api=server.client())
        task = asyncio.create_task(first.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(DOCKER_TEST_TIMEOUT_SECONDS):
                await ready.wait()
                before = json.loads((workspace / "state.json").read_text())
                identifier = before["container"]["id"]
                if kill_supervisor:
                    assert is_same_process(before["supervisorPid"], before["supervisorIdentity"])
                    os.kill(before["supervisorPid"], signal.SIGKILL)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await first.api.close()
                job_payload["job"]["status"] = "running"
                await execute_job(server, worker_settings)
                after = json.loads((workspace / "state.json").read_text())
                assert after["container"]["id"] == identifier
                assert after["container"]["exitCode"] == 0 and after["container"]["released"]
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await first.api.close()
            (workspace / "cancel.request").touch()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished" and len(server.uploads) == 1


def test_lost_docker_start_control_response_reattaches_without_creating_a_second_container(
    job_payload, worker_settings, docker_image
):
    docker_job(job_payload, docker_image, delay="1")
    server = ContainerServer(job_payload)
    identifiers = []

    class InterruptedTransport(LocalTransport):
        failed_once = False

        async def run(self, command, **options):
            response = await super().run(command, **options)
            if "start" in command and not self.failed_once:
                self.failed_once = True
                identifiers.append(json.loads(response)["supervisorPid"])
                raise TransportError("lost start response")
            if "start" in command:
                assert json.loads(response)["supervisorPid"] == identifiers[0]
            return response

    def executor(job, settings):
        return JobExecutor(
            job,
            settings,
            transport=InterruptedTransport(
                allow_local_executor=True, masker=SecretMasker([settings.api.token])
            ),
        )

    asyncio.run(execute_job(server, worker_settings, executor_factory=executor))
    assert len(identifiers) == 1 and server.completions[-1]["status"] == "finished"


def test_temporary_output_api_failure_is_retried_with_the_same_verified_bytes(
    job_payload, worker_settings, docker_image
):
    docker_job(job_payload, docker_image)
    server = ContainerServer(job_payload)
    server.lose_first_upload_response = True
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "finished"
    assert len(server.uploads) == 2 and server.uploads[0] == server.uploads[1]
    assert len(server.result_metrics) == 1


def test_optional_source_runs_readonly_with_its_default_container_working_directory(
    job_payload, worker_settings, docker_image
):
    docker_job(job_payload, docker_image)
    job_payload["codeVersion"]["runtime"].pop("workingDirectory")
    script = FIXTURE_SCRIPT.replace('test "$PWD" = /tmp', 'test "$PWD" = /mmt/source')
    script = "if printf changed > /mmt/source/new-file 2>/dev/null; then exit 22; fi\n" + script
    job_payload["codeVersion"].update(
        source={"kind": "inline", "files": {"fixture.sh": script}},
        entrypoint=["/bin/sh", "/mmt/source/fixture.sh"],
    )
    server = ContainerServer(job_payload)
    asyncio.run(execute_job(server, worker_settings))
    assert server.completions[-1]["status"] == "finished"
    assert not (workspace_for(job_payload) / "source/new-file").exists()


def test_output_metrics_lease_rejection_stops_reporting_without_completing_the_job(
    job_payload, worker_settings, docker_image
):
    docker_job(job_payload, docker_image)
    server = ContainerServer(job_payload)
    server.result_metrics_status = 403
    asyncio.run(execute_job(server, worker_settings))
    assert not server.completions
    assert not any(path.endswith("/complete") for path, _body in server.calls)
    assert list(worker_settings.state_directory.glob("*.rejected"))
    assert not container_exists(job_payload)


def test_worker_restart_during_result_collection_keeps_the_artifact_acknowledgment(
    job_payload, worker_settings, docker_image
):
    from mado_tracking.worker.api import WorkerApi

    docker_job(job_payload, docker_image)
    server = ContainerServer(job_payload)

    async def scenario():
        metrics_started, metrics_blocked = asyncio.Event(), asyncio.Event()

        async def interrupted_metrics(request):
            if request.url.path.endswith("/metrics") and any(
                point["name"] == "fixture.score" for point in json.loads(request.content)["metrics"]
            ):
                metrics_started.set()
                await metrics_blocked.wait()
            return await server.serve_container(request)

        api = WorkerApi(
            url="http://localhost/api",
            token="test-api-secret",
            transport=httpx.MockTransport(interrupted_metrics),
        )
        first = Worker(worker_settings, api=api)
        task = asyncio.create_task(first.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(DOCKER_TEST_TIMEOUT_SECONDS):
                await metrics_started.wait()
                assert len(server.uploads) == 1
                journal = json.loads(
                    (worker_settings.state_directory / f"{job_payload['job']['id']}.json").read_text()
                )
                assert journal["results"]["artifacts"] and not journal["results"].get("metrics")
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await api.close()
                job_payload["job"]["status"] = "running"
                await execute_job(server, worker_settings)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished"
    assert len(server.uploads) == 1 and len(server.result_metrics) == 1


@pytest.mark.parametrize("failure", ["construct", "start", "join"])
def test_log_thread_failure_after_real_container_start_always_stops_and_removes_owned_container(
    job_payload, worker_settings, docker_image, tmp_path, monkeypatch, failure
):
    from mado_tracking.worker.container_layout import host_environment
    from mado_tracking.worker.docker_container import DockerContainer
    from mado_tracking.worker.host_execution import CommandExecution
    from mado_tracking.worker.host_state import process_identity
    from mado_tracking.worker.runtime import execution_specification

    script = "exit 0" if failure == "join" else "trap '' TERM; sleep 60 & wait"
    docker_job(job_payload, docker_image, script=script)
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    execution = CommandExecution(
        tmp_path,
        {
            "status": "running",
            "supervisorPid": os.getpid(),
            "supervisorIdentity": process_identity(os.getpid()),
            "processPid": 0,
        },
        environment=host_environment(),
        masker=SecretMasker([worker_settings.api.token]),
        cancel_grace_seconds=0.15,
    )
    owner = DockerContainer(tmp_path, specification, execution)
    original_thread, original_start, original_join = (
        threading.Thread,
        threading.Thread.start,
        threading.Thread.join,
    )
    observed_start = []

    def fail_construction(*arguments, **options):
        if options.get("name") == "mmt-docker-logs":
            observed_start.append(owner.inspect_owned()["state"]["Running"])
            raise RuntimeError("fixture log thread construct failure")
        return original_thread(*arguments, **options)

    def fail_start(thread):
        if thread.name == "mmt-docker-logs":
            observed_start.append(owner.inspect_owned()["state"]["Running"])
            raise RuntimeError("fixture log thread start failure")
        return original_start(thread)

    def fail_join(thread, *arguments, **options):
        original_join(thread, *arguments, **options)
        if thread.name == "mmt-docker-logs":
            raise RuntimeError("fixture log thread join failure")

    if failure == "construct":
        monkeypatch.setattr("mado_tracking.worker.docker_container.threading.Thread", fail_construction)
    elif failure == "start":
        monkeypatch.setattr(threading.Thread, "start", fail_start)
    else:
        monkeypatch.setattr(threading.Thread, "join", fail_join)
    try:
        with pytest.raises(RuntimeError, match=f"fixture log thread {failure} failure"):
            owner.run([])
        if failure != "join":
            assert observed_start == [True], (
                "Failure must occur after the actual daemon container has started"
            )
        assert not container_exists(job_payload)
        assert owner.state["container"]["released"] is True
    finally:
        # A regression leaves this job's daemon container running; never leave it behind after the assertion.
        owner.stop_and_remove()
