"""Relay runner Artifact files to the API and acknowledge each successful save in the journal."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError, TransportError
from ..execution_runtime import SHA256_PATTERN
from .api import WorkerApi
from .container_outputs import (
    MAX_ARTIFACT_LINE_BYTES,
    OUTPUT_CHUNK_BYTES,
    artifact_key,
    parse_output_index,
)
from .contracts import WorkerJob
from .output_archive import (
    OUTPUT_ARCHIVE_COMMAND,
    ArchiveFormatError,
    ArchiveMember,
    ArchiveTruncated,
    OutputArchiveReader,
)
from .runtime import JobExecutor
from .source_snapshot import MAX_MANIFEST_BYTES, MAX_SNAPSHOT_BYTES, SNAPSHOT_FILENAMES, SOURCE_MANIFEST_PATH

# Journal rewrites while saving many outputs are batched to at most one per interval.
ACKNOWLEDGMENT_PERSIST_SECONDS = 1.0
# A target that sends nothing for this long is treated as disconnected; uploads in between do not
# count because the worker is not reading then.
OUTPUT_STREAM_IDLE_SECONDS = 300.0


async def forward_container_outputs(
    job: WorkerJob,
    results: dict[str, Any],
    *,
    api: WorkerApi,
    executor: JobExecutor,
    acknowledgments: dict[str, Any],
    persist: Callable[[], None],
    temporary_path: Path,
) -> None:
    """Save outputs, then metrics, then result.json declarations; each step is acknowledged once."""
    await receive_output_archive(
        job,
        results,
        api=api,
        executor=executor,
        acknowledgments=acknowledgments,
        persist=persist,
        temporary_path=temporary_path,
    )
    if not acknowledgments.get("metrics"):
        if results["metrics"]:
            await api.metrics(job, results["metrics"])
        acknowledgments["metrics"] = True
        persist()
    # Declarations name saved Artifacts, so they are sent only after every output is saved.
    registered = acknowledgments.setdefault("declarations", [])
    remaining = [item for item in results.get("declarations", []) if item["index"] not in registered]
    if remaining:
        items = await api.declare_outputs(job, remaining)
        registered.extend(item["index"] for item in items if item["index"] not in registered)
        persist()
        if any(item["index"] not in registered for item in remaining):
            raise ConfigurationError("Output declaration response omitted a declared output")


async def receive_output_archive(
    job: WorkerJob,
    results: dict[str, Any],
    *,
    api: WorkerApi,
    executor: JobExecutor,
    acknowledgments: dict[str, Any],
    persist: Callable[[], None],
    temporary_path: Path,
) -> None:
    """Fetch every unacknowledged output in one tar stream, verifying and saving file by file.

    An interrupted stream raises TransportError; the session retries and this call requests only
    the outputs whose save was not yet acknowledged.
    """
    uploaded: list[str] = acknowledgments.setdefault("artifacts", [])
    acknowledged = set(uploaded)
    expected_count = results.get("artifactCount", len(results.get("artifacts", [])))
    if len(acknowledged) >= expected_count:
        return
    persisted_at = time.monotonic()

    async def save_member(artifact: dict[str, Any]) -> None:
        nonlocal persisted_at
        await api.upload_output_artifact(job, artifact, temporary_path)
        key = artifact_key(artifact)
        uploaded.append(key)
        acknowledged.add(key)
        # Rewriting the journal per file is quadratic for 10000 outputs; a crash re-saves at most
        # one interval of files, which only adds an identical Artifact version.
        if time.monotonic() - persisted_at >= ACKNOWLEDGMENT_PERSIST_SECONDS:
            persist()
            persisted_at = time.monotonic()

    async def consume(stream: asyncio.StreamReader) -> None:
        archive = OutputArchiveReader(stream, idle_timeout_seconds=OUTPUT_STREAM_IDLE_SECONDS)
        try:
            index = await archive.read_index(maximum_bytes=(expected_count + 1) * MAX_ARTIFACT_LINE_BYTES)
            pending = _pending_outputs(index, results, acknowledged)
            for artifact in pending:
                member = await archive.next_member()
                if member is None or (member.path, member.size) != (artifact["path"], artifact["size"]):
                    raise ConfigurationError("Output archive does not match the declared outputs")
                await _write_verified_member(archive, member, artifact, temporary_path)
                await save_member(artifact)
            if await archive.next_member() is not None:
                raise ConfigurationError("Output archive contains undeclared files")
        except ArchiveFormatError as error:
            raise ConfigurationError(f"Output archive rejected: {error}") from None

    try:
        await executor.stream_command(
            OUTPUT_ARCHIVE_COMMAND, payload={"acknowledged": sorted(acknowledged)}, consume=consume
        )
    except ArchiveTruncated as error:
        raise TransportError(str(error)) from None
    finally:
        persist()
        await asyncio.to_thread(temporary_path.unlink, missing_ok=True)


def _pending_outputs(index: bytes, results: dict[str, Any], acknowledged: set[str]) -> list[dict[str, Any]]:
    expected_sha256 = results.get("artifactIndexSha256")
    if expected_sha256 is not None and hashlib.sha256(index).hexdigest() != expected_sha256:
        raise ConfigurationError("Output index does not match the validated result")
    try:
        artifacts = parse_output_index(index)
    except ValueError:
        raise ConfigurationError("Output index is invalid") from None
    if len(artifacts) != results.get("artifactCount", len(artifacts)):
        raise ConfigurationError("Output index does not match the validated result")
    return [artifact for artifact in artifacts if artifact_key(artifact) not in acknowledged]


async def _write_verified_member(
    archive: OutputArchiveReader, member: ArchiveMember, artifact: dict[str, Any], temporary_path: Path
) -> None:
    checksum = hashlib.sha256()
    descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as destination:
        async for chunk in archive.content(member):
            checksum.update(chunk)
            destination.write(chunk)
        destination.flush()
        os.fsync(destination.fileno())
    if checksum.hexdigest() != artifact["sha256"]:
        raise ConfigurationError(f"Run Artifact sha256 mismatch during collection: {artifact['path']}")


async def forward_source_snapshot(
    job: WorkerJob,
    snapshot: dict[str, Any],
    *,
    api: WorkerApi,
    executor: JobExecutor,
    acknowledgments: dict[str, Any],
    persist: Callable[[], None],
    temporary_path: Path,
) -> None:
    artifacts = snapshot.get("artifacts")
    expected_paths = (
        set(SNAPSHOT_FILENAMES) if job.execution_snapshot["source"] is not None else {SOURCE_MANIFEST_PATH}
    )
    if (
        not isinstance(artifacts, list)
        or len(artifacts) != len(expected_paths)
        or not all(isinstance(artifact, dict) for artifact in artifacts)
        or not all(isinstance(artifact.get("path"), str) for artifact in artifacts)
        or {artifact.get("path") for artifact in artifacts} != expected_paths
    ):
        raise ConfigurationError("Source snapshot does not declare the required ZIP/manifest files")
    for artifact in artifacts:
        limit = MAX_MANIFEST_BYTES if artifact["path"] == SOURCE_MANIFEST_PATH else MAX_SNAPSHOT_BYTES
        if (
            type(artifact.get("size")) is not int
            or not 0 < artifact["size"] <= limit
            or not isinstance(artifact.get("sha256"), str)
            or not SHA256_PATTERN.fullmatch(artifact["sha256"])
            or artifact.get("mimeType") not in {"application/zip", "application/json"}
        ):
            raise ConfigurationError("Source snapshot Artifact descriptor is invalid")
    await forward_artifacts(
        artifacts,
        executor=executor,
        acknowledgments=acknowledgments.setdefault("sourceSnapshot", {}),
        persist=persist,
        temporary_path=temporary_path,
        read_command="snapshot",
        upload=lambda artifact, source: api.upload_source_snapshot_artifact(job, artifact, source),
    )


async def forward_artifacts(
    artifacts: list[dict[str, Any]],
    *,
    executor: JobExecutor,
    acknowledgments: dict[str, Any],
    persist: Callable[[], None],
    temporary_path: Path,
    read_command: str,
    upload: Callable[[dict[str, Any], Path], Awaitable[None]],
) -> None:
    uploaded = acknowledgments.setdefault("artifacts", [])
    for artifact in artifacts:
        key = f"{artifact['path']}:{artifact['sha256']}"
        if key in uploaded:
            continue
        checksum, offset = hashlib.sha256(), 0
        try:
            descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as destination:
                while offset < artifact["size"]:
                    response = await executor.command(
                        read_command, payload={"path": artifact["path"], "offset": offset}
                    )
                    if response.get("error"):
                        raise ConfigurationError("Run Artifact could not be read safely after execution")
                    try:
                        chunk = base64.b64decode(response["content"], validate=True)
                        next_offset = response["nextOffset"]
                    except (KeyError, TypeError, ValueError):
                        raise ConfigurationError("Run Artifact transfer returned invalid bytes") from None
                    if (
                        not chunk
                        or len(chunk) > OUTPUT_CHUNK_BYTES
                        or type(next_offset) is not int
                        or next_offset != offset + len(chunk)
                        or next_offset > artifact["size"]
                    ):
                        raise ConfigurationError("Run Artifact transfer has an invalid offset or size")
                    checksum.update(chunk)
                    destination.write(chunk)
                    offset = next_offset
                destination.flush()
                os.fsync(destination.fileno())
            if checksum.hexdigest() != artifact["sha256"]:
                raise ConfigurationError("Run Artifact sha256 mismatch during collection")
            await upload(artifact, temporary_path)
            uploaded.append(key)
            persist()
        finally:
            await asyncio.to_thread(temporary_path.unlink, missing_ok=True)
