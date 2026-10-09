"""Download Job inputs before launch and relay verified, complete bytes to the target."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..checkpoint_archive import (
    CheckpointArchiveError,
    file_sha256,
    verify_checkpoint_archive,
    write_checkpoint_archive,
)
from ..errors import ApiError, ConfigurationError
from ..http import REQUEST_TIMEOUT_SECONDS
from .artifact_transfer import ArtifactTransferApi
from .contracts import WorkerJob
from .download_content import DOWNLOAD_ACCEPT_ENCODING, write_downloaded_content
from .runner_commands import RunnerCommands


@dataclass(frozen=True)
class ContainerInput:
    """One file a container needs before it starts: its SIF or the input model's weights."""

    kind: str
    artifact_id: str | None
    weights_uri: str | None
    expected_sha256: str | None


@dataclass(frozen=True)
class CheckpointInput:
    """A checkpoint staged as one verified tar: the resume checkpoint or a hook's input checkpoint."""

    checkpoint: dict[str, Any]
    # The runner command suffix (upload-<kind>) and the stagedInputs key that records its tar.
    kind: str
    staged_key: str


async def download_external_weights(uri: str, destination: Any) -> dict[str, Any]:
    try:
        location = urlsplit(uri)
        if (
            location.scheme not in {"http", "https"}
            or not location.hostname
            or location.username
            or location.password
        ):
            raise ConfigurationError("External weights require an HTTP(S) URI without embedded credentials")
    except ValueError:
        raise ConfigurationError("Invalid input weights URI") from None
    # Never reuse the authenticated API client or forward its token/headers to a weights URI.
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT_SECONDS,
        follow_redirects=False,
        headers={"Accept-Encoding": DOWNLOAD_ACCEPT_ENCODING},
    ) as download:
        try:
            async with download.stream("GET", uri) as response:
                if not response.is_success:
                    raise ApiError("External weights download failed", status_code=response.status_code)
                return await write_downloaded_content(response, destination, label="External weights")
        except (httpx.TransportError, httpx.DecodingError, httpx.StreamError):
            raise ApiError("External weights download interrupted or invalid") from None


def container_inputs(job: WorkerJob) -> list[ContainerInput]:
    """The SIF of a SIF runtime and the weights of the input ModelVersion, unless already local."""
    runtime = job.runtime
    inputs: list[ContainerInput] = []
    if runtime["kind"] in {"singularity", "apptainer"}:
        inputs.append(ContainerInput("sif", runtime["artifactId"], None, runtime["sha256"]))
    model = job.model_version
    if model is not None:
        artifact_id, weights_uri = model.get("artifactId"), model.get("weightsUri")
        if not artifact_id and not weights_uri:
            raise ConfigurationError("Container input ModelVersion has no saved weights")
        if not artifact_id and not isinstance(weights_uri, str):
            raise ConfigurationError("Container input ModelVersion has an invalid weights URI")
        # A file:// URI names a file on the target, which copies it itself before launch.
        if artifact_id or urlsplit(str(weights_uri)).scheme != "file":
            inputs.append(ContainerInput("weights", artifact_id, weights_uri, None))
    return inputs


async def download_container_input(
    container_input: ContainerInput, *, api: ArtifactTransferApi, project_id: str, destination: Path
) -> dict[str, Any]:
    """Write one input to destination and return its {sha256, size}; a SIF must match its sha256."""
    with destination.open("wb") as output:
        if container_input.artifact_id:
            descriptor = await api.download_artifact(project_id, container_input.artifact_id, output)
        else:
            assert container_input.weights_uri is not None
            descriptor = await download_external_weights(container_input.weights_uri, output)
        output.flush()
        os.fsync(output.fileno())
    expected = container_input.expected_sha256
    if expected is not None and descriptor["sha256"] != expected:
        raise ConfigurationError("SIF Artifact sha256 mismatch")
    return descriptor


async def stage_container_inputs(
    job: WorkerJob,
    *,
    api: ArtifactTransferApi,
    executor: RunnerCommands,
    transfer_path: Callable[[str], Path],
) -> None:
    for container_input in container_inputs(job):
        path = transfer_path(container_input.kind)
        try:
            descriptor = await download_container_input(
                container_input, api=api, project_id=job.job["projectId"], destination=path
            )
            uploaded = await executor.command(f"upload-{container_input.kind}", stdin_file=path)
            if uploaded.get("sha256") != descriptor["sha256"] or uploaded.get("size") != descriptor["size"]:
                raise ConfigurationError("Container input changed during transfer")
            executor.staged_inputs[container_input.kind] = descriptor
        finally:
            path.unlink(missing_ok=True)


def checkpoint_inputs(job: WorkerJob) -> list[CheckpointInput]:
    inputs = []
    if job.resume_checkpoint is not None:
        inputs.append(CheckpointInput(job.resume_checkpoint, "checkpoint", "checkpoint"))
    if job.input_checkpoint is not None:
        inputs.append(CheckpointInput(job.input_checkpoint, "input-checkpoint", "inputCheckpoint"))
    return inputs


async def stage_job_inputs(
    job: WorkerJob,
    *,
    api: ArtifactTransferApi,
    executor: RunnerCommands,
    transfer_path: Callable[[str], Path],
) -> None:
    """Container runtimes need their image and weights; any runtime may get checkpoints."""
    if job.runtime["kind"] != "python":
        await stage_container_inputs(job, api=api, executor=executor, transfer_path=transfer_path)
    for checkpoint_input in checkpoint_inputs(job):
        await stage_checkpoint(job, checkpoint_input, api=api, executor=executor, transfer_path=transfer_path)


async def _download_verified_artifact(
    api: ArtifactTransferApi, *, project_id: str, artifact: dict[str, Any], destination: Path
) -> None:
    with destination.open("wb") as output:
        descriptor = await api.download_artifact(project_id, artifact["id"], output)
        output.flush()
        os.fsync(output.fileno())
    if descriptor["sha256"] != artifact["sha256"] or descriptor["size"] != artifact["size"]:
        raise CheckpointArchiveError(f"Checkpoint Artifact sha256 or size mismatch: {artifact['path']}")


async def download_checkpoint_archive(
    checkpoint: dict[str, Any], *, api: ArtifactTransferApi, project_id: str, archive_path: Path
) -> dict[str, Any]:
    """Download the checkpoint as one tar verified against its manifest; returns {sha256, size}.

    A native checkpoint already is that tar. An MLflow checkpoint's files are packed into one
    after each is verified. Any mismatch fails the Job before its entrypoint is started.
    """
    if checkpoint["source"] == "native":
        await _download_verified_artifact(
            api, project_id=project_id, artifact=checkpoint["artifacts"][0], destination=archive_path
        )
    else:
        with tempfile.TemporaryDirectory(dir=archive_path.parent) as staging:
            files = []
            for index, artifact in enumerate(checkpoint["artifacts"]):
                local = Path(staging) / str(index)
                await _download_verified_artifact(
                    api, project_id=project_id, artifact=artifact, destination=local
                )
                files.append((artifact["path"], local))
            with archive_path.open("wb") as archive:
                write_checkpoint_archive(files, archive)
    verify_checkpoint_archive(archive_path, checkpoint["manifest"]["files"])
    checksum, size = file_sha256(archive_path)
    return {"sha256": checksum, "size": size}


async def stage_checkpoint(
    job: WorkerJob,
    checkpoint_input: CheckpointInput,
    *,
    api: ArtifactTransferApi,
    executor: RunnerCommands,
    transfer_path: Callable[[str], Path],
) -> None:
    """Send the verified tar to the target, which checks and extracts it again before launch."""
    archive_path = transfer_path(checkpoint_input.kind)
    try:
        descriptor = await download_checkpoint_archive(
            checkpoint_input.checkpoint, api=api, project_id=job.job["projectId"], archive_path=archive_path
        )
        uploaded = await executor.command(f"upload-{checkpoint_input.kind}", stdin_file=archive_path)
        if uploaded.get("sha256") != descriptor["sha256"] or uploaded.get("size") != descriptor["size"]:
            raise ConfigurationError("Checkpoint changed during transfer")
        executor.staged_inputs[checkpoint_input.staged_key] = descriptor
    finally:
        archive_path.unlink(missing_ok=True)
