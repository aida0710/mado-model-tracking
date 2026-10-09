"""WorkerJob rules for sites, hook inputs in the container layout, and dataset partitions."""

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
from site_fixtures import site_job
from test_worker import WorkerServer

from mado_tracking.errors import ConfigurationError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.container_layout import container_environment, prepare_container_layout
from mado_tracking.worker.contracts import SITE_EXECUTORS, WorkerJob
from mado_tracking.worker.dataset_partition import DatasetPartition, partition_cache_key, partition_files
from mado_tracking.worker.runtime import execution_specification
from mado_tracking.worker.service import Worker
from mado_tracking.worker.session_inputs import stage_job_inputs

SIF_RUNTIME = {"kind": "apptainer", "artifactId": "sif", "sha256": "0" * 64}
DOCKER_RUNTIME = {"kind": "docker", "image": "forge.example.org/tts@sha256:" + "a" * 64}


def checkpoint(files: dict[str, bytes]) -> tuple[dict, bytes]:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
    content = archive.getvalue()
    document = {
        "id": str(uuid4()),
        "runId": str(uuid4()),
        "step": 12,
        "source": "native",
        "artifacts": [
            {
                "id": str(uuid4()),
                "path": "checkpoint.tar",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        ],
        "manifest": {
            "files": [
                {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                for name, data in files.items()
            ],
            "includesOptimizer": False,
            "framework": "torch",
        },
        "metadata": {},
    }
    return document, content


def test_site_jobs_are_parsed_by_the_site_runner_only():
    payload = site_job(
        project_id=str(uuid4()),
        source_files={"main.py": ""},
        runtime=SIF_RUNTIME,
        runtime_kinds=["apptainer"],
    )
    with pytest.raises(ConfigurationError, match="Unknown compute executor"):
        WorkerJob.parse(payload)
    assert WorkerJob.parse(payload, executors=SITE_EXECUTORS).target["executor"] == "site"


@pytest.mark.parametrize(
    ("runtime", "runtime_kinds", "accepted"),
    [
        (DOCKER_RUNTIME, ["apptainer"], True),
        (DOCKER_RUNTIME, ["singularity"], True),
        (DOCKER_RUNTIME, ["docker"], True),
        ({"kind": "singularity", "artifactId": "a", "sha256": "0" * 64}, ["apptainer"], False),
        ({"kind": "python"}, ["apptainer"], False),
    ],
)
def test_a_site_runs_containers_and_converts_docker_images_for_its_sif_cli(runtime, runtime_kinds, accepted):
    payload = site_job(
        project_id=str(uuid4()), source_files={"main.py": ""}, runtime=runtime, runtime_kinds=runtime_kinds
    )
    if accepted:
        WorkerJob.parse(payload, executors=SITE_EXECUTORS)
    else:
        with pytest.raises(ConfigurationError):
            WorkerJob.parse(payload, executors=SITE_EXECUTORS)


def test_an_input_checkpoint_must_be_the_one_the_run_was_started_for(job_payload):
    document, _content = checkpoint({"model.bin": b"weights"})
    job_payload["inputCheckpoint"] = document
    assert WorkerJob.parse(job_payload).input_checkpoint == document
    job_payload["run"]["tags"] = {"mmt.inputCheckpointId": str(uuid4())}
    with pytest.raises(ConfigurationError, match="inputCheckpoint"):
        WorkerJob.parse(job_payload)
    job_payload["run"]["tags"] = {"mmt.inputCheckpointId": document["id"]}
    job_payload["triggerPayload"] = ["not", "an", "object"]
    with pytest.raises(ConfigurationError, match="triggerPayload"):
        WorkerJob.parse(job_payload)


def test_hook_inputs_appear_in_the_context_and_the_environment(job_payload, worker_settings, tmp_path):
    document, _content = checkpoint({"model.bin": b"weights"})
    job_payload["inputCheckpoint"] = document
    job_payload["triggerPayload"] = {"after": "abc123"}
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    assert specification["context"]["inputCheckpoint"]["checkpointId"] == document["id"]
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    prepare_container_layout(workspace, specification)
    assert json.loads((workspace / "context/trigger-payload.json").read_text()) == {"after": "abc123"}
    assert json.loads((workspace / "context/input-checkpoint.json").read_text())["step"] == 12
    environment = container_environment(specification)
    assert environment["MMT_INPUT_CHECKPOINT_DIR"] == "/mmt/inputs/checkpoint"
    assert environment["MMT_INPUT_CHECKPOINT_FILE"] == "/mmt/context/input-checkpoint.json"
    assert environment["MMT_TRIGGER_PAYLOAD_FILE"] == "/mmt/context/trigger-payload.json"


def test_a_job_that_also_resumes_reads_its_input_checkpoint_beside_the_resume_one(
    job_payload, worker_settings
):
    resume, _content = checkpoint({"optimizer.bin": b"state"})
    job_payload["run"]["resumeCheckpointId"] = resume["id"]
    job_payload["resumeCheckpoint"] = resume
    job_payload["inputCheckpoint"], _input_content = checkpoint({"model.bin": b"weights"})
    environment = container_environment(
        execution_specification(WorkerJob.parse(job_payload), worker_settings)
    )
    assert environment["MMT_RESUME_CHECKPOINT_DIR"] == "/mmt/inputs/checkpoint"
    assert environment["MMT_INPUT_CHECKPOINT_DIR"] == "/mmt/inputs/input-checkpoint"


def test_jobs_without_hook_inputs_keep_their_context_unchanged(job_payload, worker_settings):
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    assert (
        "inputCheckpoint" not in specification["context"] and "triggerPayload" not in specification["context"]
    )
    environment = container_environment(specification)
    assert not {"MMT_INPUT_CHECKPOINT_DIR", "MMT_TRIGGER_PAYLOAD_FILE"} & set(environment)


class RelayExecutor:
    def __init__(self) -> None:
        self.staged_inputs: dict = {}
        self.uploaded: dict[str, bytes] = {}

    async def command(self, name: str, *, payload=None, stdin_file: Path | None = None) -> dict:
        assert stdin_file is not None
        content = await asyncio.to_thread(stdin_file.read_bytes)
        self.uploaded[name] = content
        return {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}


def test_the_worker_relays_an_input_checkpoint_verified_against_its_manifest(job_payload, tmp_path):
    document, content = checkpoint({"model.bin": b"weights"})
    job_payload["inputCheckpoint"] = document
    job = WorkerJob.parse(job_payload)
    executor = RelayExecutor()

    def serve(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith(f"/artifacts/{document['artifacts'][0]['id']}/content")
        return httpx.Response(200, content=content)

    async def stage() -> None:
        api = WorkerApi(url="http://localhost/api", token="t", transport=httpx.MockTransport(serve))
        try:
            await stage_job_inputs(
                job, api=api, executor=executor, transfer_path=lambda kind: tmp_path / kind
            )
        finally:
            await api.close()

    asyncio.run(stage())
    assert executor.uploaded["upload-input-checkpoint"] == content
    assert executor.staged_inputs["inputCheckpoint"] == {
        "sha256": hashlib.sha256(content).hexdigest(),
        "size": len(content),
    }
    assert not (tmp_path / "input-checkpoint").exists()


def test_array_members_share_a_partitioned_version_without_overlap():
    files = [{"path": f"shard-{index:03d}.tar", "size": 1} for index in reversed(range(10))]
    shares = [partition_files(files, array_size=4, array_index=index) for index in range(4)]
    assert [file["path"] for file in shares[1]] == ["shard-001.tar", "shard-005.tar", "shard-009.tar"]
    assert sorted(file["path"] for share in shares for file in share) == sorted(
        file["path"] for file in files
    )
    keys = {partition_cache_key("sha256:" + "0" * 64, array_size=4, array_index=index) for index in range(4)}
    assert len(keys) == 4


def test_a_job_s_partition_comes_from_its_array_place():
    assert DatasetPartition.for_job({"datasetPartitionVersionId": None}) is None
    assert DatasetPartition.for_job({"datasetPartitionVersionId": "v"}) == DatasetPartition("v", 1, 0)
    assert DatasetPartition.for_job(
        {"datasetPartitionVersionId": "v", "arraySize": 8, "arrayIndex": 3}
    ) == DatasetPartition("v", 8, 3)
    with pytest.raises(ConfigurationError):
        DatasetPartition.for_job({"datasetPartitionVersionId": "v", "arraySize": 8, "arrayIndex": 8})


def test_the_worker_hands_hook_inputs_to_a_python_job(job_payload, worker_settings):
    document, content = checkpoint({"model.bin": b"weights at step 12"})
    job_payload["inputCheckpoint"] = document
    job_payload["triggerPayload"] = {"ref": "refs/tags/v1"}
    job_payload["codeVersion"]["source"]["files"]["main.py"] = (
        "import json, os, pathlib\n"
        "directory = pathlib.Path(os.environ['MMT_INPUT_CHECKPOINT_DIR'])\n"
        "print('checkpoint ' + (directory / 'model.bin').read_text(), flush=True)\n"
        "print('step ' + str(json.load(open(os.environ['MMT_INPUT_CHECKPOINT_FILE']))['step']), flush=True)\n"
        "print('payload ' + json.load(open(os.environ['MMT_TRIGGER_PAYLOAD_FILE']))['ref'], flush=True)\n"
    )
    server = WorkerServer(job_payload)
    server.artifact = content

    async def scenario() -> None:
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(job_payload)), 30)
        finally:
            await worker.api.close()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "finished", server.completions[-1]
    messages = "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )
    assert "checkpoint weights at step 12" in messages and "step 12" in messages
    assert "payload refs/tags/v1" in messages
