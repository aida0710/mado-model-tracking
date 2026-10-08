"""Checkpoint save (SDK), staging and verification (worker), and a resumed training run."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_artifact_uploads import PROJECT_ID, RUN_ID, TOKEN, FakeUploadApi
from test_worker import WorkerServer

from mado_tracking import Client, artifact_uploads, http
from mado_tracking.checkpoint_archive import (
    CheckpointArchiveError,
    extract_checkpoint_archive,
    verify_checkpoint_archive,
    write_checkpoint_archive,
)
from mado_tracking.checkpoints import resume_checkpoint_from_environment
from mado_tracking.errors import ConfigurationError
from mado_tracking.run import Run
from mado_tracking.worker.container_layout import (
    container_environment,
    install_resume_checkpoint,
    prepare_container_layout,
)
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.runtime import execution_specification
from mado_tracking.worker.service import Worker

TRAINING_SCRIPT = Path(__file__).resolve().parent.parent / "examples" / "training.py"
EXAMPLE_TIMEOUT_SECONDS = 15
JOB_TIMEOUT_SECONDS = 15


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def tar_of(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, content in files.items():
            information = tarfile.TarInfo(name)
            information.size = len(content)
            archive.addfile(information, io.BytesIO(content))
    return buffer.getvalue()


def manifest_of(files: dict[str, bytes]) -> list[dict]:
    return [
        {"path": name, "sha256": sha256(content), "size": len(content)} for name, content in files.items()
    ]


CHECKPOINT_FILES = {"model.json": b'{"weight": 1.5}', "optim/state.json": b'{"velocity": 0.25}'}


@pytest.fixture(autouse=True)
def immediate_retries(monkeypatch, tmp_path):
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)
    monkeypatch.setattr(artifact_uploads, "VERIFY_POLL_INITIAL_SECONDS", 0)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))


class CheckpointRegistrationApi(FakeUploadApi):
    """Upload sessions plus POST /runs/:r/checkpoints, which records the registered body."""

    def __init__(self):
        super().__init__()
        self.registrations: list[dict] = []

    def handle(self, request: httpx.Request, body: bytes) -> httpx.Response:
        if (
            request.method == "POST"
            and request.url.path == f"/api/projects/{PROJECT_ID}/runs/{RUN_ID}/checkpoints"
        ):
            registration = json.loads(body)
            self.registrations.append(registration)
            return httpx.Response(201, json={"id": str(uuid4()), **registration})
        return super().handle(request, body)


def test_log_checkpoint_uploads_one_tar_through_a_session_and_registers_its_manifest(tmp_path):
    directory = tmp_path / "checkpoint"
    for name, content in CHECKPOINT_FILES.items():
        (directory / name).parent.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(content)
    api = CheckpointRegistrationApi()
    with Client(api_url="http://localhost", api_token=TOKEN, transport=api.sync_transport()) as client:
        run = Run(client, PROJECT_ID, {"id": RUN_ID, "kind": "training"})
        run.log_checkpoint(
            directory, step=12, includes_optimizer=True, framework="torch", metadata={"epoch": 3}
        )
    [session] = api.sessions.values()
    assert session["path"] == "checkpoints/step-12.tar"
    assert session["mimeType"] == "application/x-tar"
    assert api.single_puts == [], "a checkpoint is always a resumable session upload"
    [registration] = api.registrations
    assert registration == {
        "step": 12,
        "artifactId": session["artifactId"],
        "manifest": {
            "files": sorted(manifest_of(CHECKPOINT_FILES), key=lambda file: file["path"]),
            "includesOptimizer": True,
            "framework": "torch",
        },
        "metadata": {"epoch": 3},
    }
    archive = b"".join(content for _number, content in sorted(api.parts[session["id"]].items()))
    with tarfile.open(fileobj=io.BytesIO(archive)) as opened:
        assert {member.name: opened.extractfile(member).read() for member in opened} == CHECKPOINT_FILES


def test_log_checkpoint_rejects_symlinks_and_an_empty_directory(tmp_path):
    api = CheckpointRegistrationApi()
    (tmp_path / "empty").mkdir()
    (tmp_path / "linked").mkdir()
    (tmp_path / "linked" / "escape").symlink_to("/etc/passwd")
    with Client(api_url="http://localhost", api_token=TOKEN, transport=api.sync_transport()) as client:
        run = Run(client, PROJECT_ID, {"id": RUN_ID, "kind": "training"})
        for directory in ("empty", "linked"):
            with pytest.raises(CheckpointArchiveError):
                run.log_checkpoint(tmp_path / directory, step=1)
    assert not api.sessions and not api.registrations


@pytest.mark.parametrize(
    ("archive", "message"),
    [
        (tar_of({**CHECKPOINT_FILES, "extra.bin": b"x"}), "outside the manifest"),
        (tar_of({"model.json": CHECKPOINT_FILES["model.json"]}), "missing files"),
        (
            tar_of({"model.json": b"tampered", "optim/state.json": CHECKPOINT_FILES["optim/state.json"]}),
            "mismatch",
        ),
        (tar_of({"../model.json": b"x"}), "unsafe path"),
    ],
    ids=["extra", "missing", "tampered", "traversal"],
)
def test_archive_verification_rejects_anything_but_the_manifest(tmp_path, archive, message):
    path = tmp_path / "checkpoint.tar"
    path.write_bytes(archive)
    with pytest.raises(CheckpointArchiveError, match=message):
        extract_checkpoint_archive(path, tmp_path / "out", manifest_of(CHECKPOINT_FILES))
    assert not (tmp_path / "out").exists()


def test_archive_with_a_symlink_member_is_rejected(tmp_path):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        link = tarfile.TarInfo("model.json")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        archive.addfile(link)
    path = tmp_path / "checkpoint.tar"
    path.write_bytes(buffer.getvalue())
    with pytest.raises(CheckpointArchiveError, match="regular files"):
        verify_checkpoint_archive(path, manifest_of({"model.json": b""}))


def checkpoint_payload(
    job_payload: dict, *, source: str, artifacts: list[dict], files: dict[str, bytes]
) -> dict:
    checkpoint_id = str(uuid4())
    job_payload["run"]["resumeCheckpointId"] = checkpoint_id
    job_payload["resumeCheckpoint"] = {
        "id": checkpoint_id,
        "runId": str(uuid4()),
        "step": 20,
        "source": source,
        "artifacts": artifacts,
        "manifest": {"files": manifest_of(files), "includesOptimizer": True, "framework": "torch"},
        "metadata": {"epoch": 2},
    }
    return job_payload


def native_checkpoint_payload(job_payload: dict, archive: bytes) -> tuple[dict, dict]:
    """A Job resuming from one tar Artifact whose manifest lists CHECKPOINT_FILES."""
    artifact = {
        "id": str(uuid4()),
        "path": "checkpoints/step-20.tar",
        "sha256": sha256(archive),
        "size": len(archive),
    }
    payload = checkpoint_payload(job_payload, source="native", artifacts=[artifact], files=CHECKPOINT_FILES)
    return payload, artifact


class CheckpointWorkerServer(WorkerServer):
    """The worker API whose content endpoint serves several Artifacts by id."""

    def __init__(self, payload: dict, contents: dict[str, bytes]):
        super().__init__(payload)
        self.contents = contents
        self.downloads: list[str] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            artifact_id = request.url.path.split("/")[-2]
            self.downloads.append(artifact_id)
            return httpx.Response(200, content=self.contents[artifact_id])
        return super().serve(request)


RESUME_PROBE = (
    "import json, os, pathlib\n"
    "directory = pathlib.Path(os.environ['MMT_RESUME_CHECKPOINT_DIR'])\n"
    "document = json.loads(pathlib.Path(os.environ['MMT_RESUME_CHECKPOINT_FILE']).read_text())\n"
    "print('step=' + os.environ['MMT_RESUME_STEP'] + ' document=' + str(document['step']), flush=True)\n"
    "print('model=' + (directory / 'model.json').read_text(), flush=True)\n"
    "print('optim=' + (directory / 'optim/state.json').read_text(), flush=True)\n"
    "try:\n"
    "    (directory / 'model.json').write_text('overwritten')\n"
    "    print('writable', flush=True)\n"
    "except PermissionError:\n"
    "    print('read-only', flush=True)\n"
)


def run_worker_job(server: WorkerServer, payload: dict, worker_settings) -> None:
    async def scenario():
        worker = Worker(worker_settings, api=server.client())
        try:
            await asyncio.wait_for(worker.run_job(WorkerJob.parse(payload)), JOB_TIMEOUT_SECONDS)
        finally:
            await worker.api.close()

    asyncio.run(scenario())


def job_messages(server: WorkerServer) -> str:
    return "".join(
        entry["message"] for path, body in server.calls if path.endswith("/logs") for entry in body["entries"]
    )


def test_worker_extracts_a_native_checkpoint_read_only_and_passes_the_resume_variables(
    job_payload, worker_settings
):
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    archive = tar_of(CHECKPOINT_FILES)
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    payload["codeVersion"]["source"]["files"]["main.py"] = RESUME_PROBE
    server = CheckpointWorkerServer(payload, {artifact["id"]: archive})
    run_worker_job(server, payload, worker_settings)
    assert server.completions[-1]["status"] == "finished", server.completions
    messages = job_messages(server)
    assert "step=20 document=20" in messages
    assert 'model={"weight": 1.5}' in messages and 'optim={"velocity": 0.25}' in messages
    assert "read-only" in messages and "writable" not in messages


def test_worker_assembles_an_mlflow_checkpoint_from_its_verified_files(job_payload, worker_settings):
    contents, artifacts = {}, []
    for name, content in CHECKPOINT_FILES.items():
        artifact_id = str(uuid4())
        contents[artifact_id] = content
        artifacts.append({"id": artifact_id, "path": name, "sha256": sha256(content), "size": len(content)})
    payload = checkpoint_payload(job_payload, source="mlflow", artifacts=artifacts, files=CHECKPOINT_FILES)
    payload["codeVersion"]["source"]["files"]["main.py"] = RESUME_PROBE
    server = CheckpointWorkerServer(payload, contents)
    run_worker_job(server, payload, worker_settings)
    assert server.completions[-1]["status"] == "finished", server.completions
    assert sorted(server.downloads) == sorted(contents)
    assert 'optim={"velocity": 0.25}' in job_messages(server)


def test_a_broken_checkpoint_checksum_fails_the_job_without_starting_the_entrypoint(
    job_payload, worker_settings, tmp_path
):
    archive = tar_of(CHECKPOINT_FILES)
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    marker = tmp_path / "entrypoint-started"
    payload["codeVersion"]["source"]["files"]["main.py"] = f"open({str(marker)!r}, 'w').close()\n"
    corrupted = archive[:-1] + bytes([archive[-1] ^ 1])
    server = CheckpointWorkerServer(payload, {artifact["id"]: corrupted})
    run_worker_job(server, payload, worker_settings)
    assert server.completions[-1]["status"] == "failed"
    assert "sha256" in server.completions[-1]["error"]
    assert not marker.exists()
    assert not (Path(payload["target"]["workDirectory"]) / payload["job"]["id"] / "state.json").exists()


def test_a_manifest_that_disagrees_with_the_archive_fails_before_the_entrypoint(
    job_payload, worker_settings, tmp_path
):
    archive = tar_of({"model.json": b"other weights"})
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    marker = tmp_path / "entrypoint-started"
    payload["codeVersion"]["source"]["files"]["main.py"] = f"open({str(marker)!r}, 'w').close()\n"
    server = CheckpointWorkerServer(payload, {artifact["id"]: archive})
    run_worker_job(server, payload, worker_settings)
    assert server.completions[-1]["status"] == "failed"
    assert not marker.exists()


def test_a_checkpoint_other_than_the_runs_pinned_one_is_rejected(job_payload):
    archive = tar_of(CHECKPOINT_FILES)
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    payload["run"]["resumeCheckpointId"] = str(uuid4())
    with pytest.raises(ConfigurationError, match="pinned checkpoint"):
        WorkerJob.parse(payload)


def test_a_container_sees_the_checkpoint_under_a_read_only_inputs_mount(
    job_payload, worker_settings, tmp_path
):
    archive = tar_of(CHECKPOINT_FILES)
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    payload["target"]["runtimeKinds"] = ["docker"]
    payload["codeVersion"].update(
        source=None,
        runtime={"kind": "docker", "image": "example.invalid/model@sha256:" + "1" * 64},
        entrypoint=["/bin/true"],
    )
    specification = execution_specification(WorkerJob.parse(payload), worker_settings)
    specification["stagedInputs"] = {"checkpoint": {"sha256": sha256(archive), "size": len(archive)}}
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "checkpoint.tar").write_bytes(archive)
    install_resume_checkpoint(workspace, specification)
    mounts = prepare_container_layout(workspace, specification)
    [inputs] = [mount for mount in mounts if mount.container_path == "/mmt/inputs"]
    assert inputs.readonly and inputs.host_path == workspace / "inputs"
    checkpoint = workspace / "inputs" / "checkpoint"
    assert (checkpoint / "optim/state.json").read_bytes() == CHECKPOINT_FILES["optim/state.json"]
    assert stat.S_IMODE((checkpoint / "model.json").stat().st_mode) == 0o400
    assert stat.S_IMODE(checkpoint.stat().st_mode) == 0o500
    assert not (workspace / "checkpoint.tar").exists()
    environment = container_environment(specification)
    assert environment["MMT_RESUME_CHECKPOINT_DIR"] == "/mmt/inputs/checkpoint"
    assert environment["MMT_RESUME_STEP"] == "20"
    assert environment["MMT_RESUME_CHECKPOINT_FILE"] == "/mmt/context/resume-checkpoint.json"
    document = json.loads((workspace / "context" / "resume-checkpoint.json").read_text())
    assert document["checkpointId"] == payload["resumeCheckpoint"]["id"] and document["step"] == 20
    for path in [checkpoint, *checkpoint.rglob("*")]:
        path.chmod(0o700)


def test_a_job_without_a_checkpoint_gets_no_resume_variables(job_payload, worker_settings):
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    assert specification["context"]["resumeCheckpoint"] is None
    assert resume_checkpoint_from_environment({}) is None


def test_a_staged_archive_that_changed_on_the_target_is_not_extracted(job_payload, worker_settings, tmp_path):
    archive = tar_of(CHECKPOINT_FILES)
    payload, artifact = native_checkpoint_payload(job_payload, archive)
    specification = execution_specification(WorkerJob.parse(payload), worker_settings)
    specification["stagedInputs"] = {"checkpoint": {"sha256": sha256(archive), "size": len(archive)}}
    (tmp_path / "checkpoint.tar").write_bytes(tar_of({"model.json": b"swapped"}))
    with pytest.raises(ValueError, match="sha256"):
        install_resume_checkpoint(tmp_path, specification)
    assert not (tmp_path / "inputs" / "checkpoint").exists()


def run_training_example(output: Path, environment: dict[str, str], *arguments: str):
    return subprocess.run(
        [
            sys.executable,
            str(TRAINING_SCRIPT),
            "--offline",
            "--steps",
            "40",
            "--momentum",
            "0.5",
            "--checkpoint-every",
            "10",
            "--output",
            str(output),
            *arguments,
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=EXAMPLE_TIMEOUT_SECONDS,
    )


def test_training_interrupted_and_resumed_from_its_checkpoint_matches_an_uninterrupted_run(tmp_path):
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    environment["MMT_JOB_KIND"] = "training"
    uninterrupted = tmp_path / "uninterrupted" / "weights.json"
    assert run_training_example(uninterrupted, environment).returncode == 0

    interrupted = tmp_path / "interrupted" / "weights.json"
    failed = run_training_example(interrupted, environment, "--fail-at-step", "27")
    assert failed.returncode != 0 and "Simulated interruption at step 27" in failed.stderr
    assert not interrupted.exists()
    checkpoint = interrupted.parent / "checkpoints" / "step-20"
    assert sorted(path.name for path in checkpoint.iterdir()) == ["model.json", "optimizer.json"]

    # What the worker hands a resumed Job: the checkpoint directory, its step and the document.
    document = tmp_path / "resume-checkpoint.json"
    document.write_text(json.dumps({"checkpointId": str(uuid4()), "sourceRunId": str(uuid4()), "step": 20}))
    resumed = tmp_path / "resumed" / "weights.json"
    execution = run_training_example(
        resumed,
        {
            **environment,
            "MMT_RESUME_CHECKPOINT_DIR": str(checkpoint),
            "MMT_RESUME_STEP": "20",
            "MMT_RESUME_CHECKPOINT_FILE": str(document),
        },
    )
    assert execution.returncode == 0, execution.stderr
    assert "start_step=20" in execution.stdout and "step=19 " not in execution.stdout
    assert json.loads(resumed.read_text()) == json.loads(uninterrupted.read_text())
    assert json.loads((resumed.parent / "optimizer.json").read_text()) == json.loads(
        (uninterrupted.parent / "optimizer.json").read_text()
    )


def test_write_checkpoint_archive_is_byte_identical_for_the_same_files(tmp_path):
    for name, content in CHECKPOINT_FILES.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(content)
    archives = []
    for _attempt in range(2):
        buffer = io.BytesIO()
        write_checkpoint_archive(((name, tmp_path / name) for name in CHECKPOINT_FILES), buffer)
        archives.append(buffer.getvalue())
        os.utime(tmp_path / "model.json", (0, 12345))
    assert archives[0] == archives[1]
