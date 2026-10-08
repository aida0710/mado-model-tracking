"""Download container inputs before launch and relay verified, complete bytes to the target."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..errors import ApiError, ConfigurationError
from ..http import REQUEST_TIMEOUT_SECONDS
from .api import WorkerApi
from .contracts import WorkerJob
from .download_content import DOWNLOAD_ACCEPT_ENCODING, write_downloaded_content
from .runtime import JobExecutor


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


async def stage_container_inputs(
    job: WorkerJob,
    *,
    api: WorkerApi,
    executor: JobExecutor,
    transfer_path: Callable[[str], Path],
) -> None:
    runtime = job.runtime
    transfers: list[tuple[str, str | None, str | None, str | None]] = []
    if runtime["kind"] in {"singularity", "apptainer"}:
        transfers.append(("sif", runtime["artifactId"], None, runtime["sha256"]))
    model = job.model_version
    if model is not None:
        artifact_id, weights_uri = model.get("artifactId"), model.get("weightsUri")
        if not artifact_id and not weights_uri:
            raise ConfigurationError("Container input ModelVersion has no saved weights")
        if not artifact_id and not isinstance(weights_uri, str):
            raise ConfigurationError("Container input ModelVersion has an invalid weights URI")
        if artifact_id or urlsplit(str(weights_uri)).scheme != "file":
            transfers.append(("weights", artifact_id, weights_uri, None))
    for kind, artifact_id, weights_uri, expected_checksum in transfers:
        path = transfer_path(kind)
        try:
            with path.open("wb") as destination:
                if artifact_id:
                    descriptor = await api.download_artifact(job.job["projectId"], artifact_id, destination)
                else:
                    assert weights_uri is not None
                    descriptor = await download_external_weights(weights_uri, destination)
                destination.flush()
                os.fsync(destination.fileno())
            if expected_checksum is not None and descriptor["sha256"] != expected_checksum:
                raise ConfigurationError("SIF Artifact sha256 mismatch")
            uploaded = await executor.command(f"upload-{kind}", stdin_file=path)
            if uploaded.get("sha256") != descriptor["sha256"] or uploaded.get("size") != descriptor["size"]:
                raise ConfigurationError("Container input changed during transfer")
            executor.staged_inputs[kind] = descriptor
        finally:
            path.unlink(missing_ok=True)
