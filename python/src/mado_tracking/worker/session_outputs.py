"""Relay runner Artifact files and acknowledge each successful API save in the journal."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..execution_runtime import SHA256_PATTERN
from .api import WorkerApi
from .container_outputs import OUTPUT_CHUNK_BYTES
from .contracts import WorkerJob
from .runtime import JobExecutor
from .source_snapshot import MAX_MANIFEST_BYTES, MAX_SNAPSHOT_BYTES, SNAPSHOT_FILENAMES, SOURCE_MANIFEST_PATH


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
    await forward_artifacts(
        results["artifacts"],
        executor=executor,
        acknowledgments=acknowledgments,
        persist=persist,
        temporary_path=temporary_path,
        read_command="output",
        upload=lambda artifact, source: api.upload_output_artifact(job, artifact, source),
    )
    if not acknowledgments.get("metrics"):
        if results["metrics"]:
            await api.metrics(job, results["metrics"])
        acknowledgments["metrics"] = True
        persist()


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
