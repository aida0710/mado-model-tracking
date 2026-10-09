"""Bring each input DatasetVersion's files to the target's dataset cache before the Job starts.

'artifacts' versions are verified against their manifest digest and per-file sha256. 'reference'
versions are fetched by URI scheme: file:// (in place on the target), https:// and s3://. The
target's datasetTransfer decides who downloads API files and HTTPS URLs: the worker, relaying
one tar to the target ('relay'), or the target itself with the Job token ('direct').
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tarfile
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote, urlsplit

import httpx

from ..dataset_upload import manifest_entries_digest
from ..errors import ApiError, ConfigurationError
from ..http import REQUEST_TIMEOUT_SECONDS, request_async
from .artifact_transfer import ArtifactTransferApi
from .dataset_downloads import (
    DatasetFetchError,
    expected_reference_sha256,
    reference_file_name,
    validate_https_uri,
)
from .dataset_partition import DatasetPartition, partition_cache_key, partition_files
from .download_content import DOWNLOAD_ACCEPT_ENCODING, write_downloaded_content
from .runner_commands import RunnerCommands

# Same as the API's migration default, for claims from an API without the target setting.
DEFAULT_DATASET_CACHE_MAX_BYTES = 100 * 1024**3
DEFAULT_DATASET_TRANSFER = "relay"
# The files API's largest page.
FILE_PAGE_LIMIT = 1000
# A target-side fetch that failed on the network is tried again before the Job fails.
DATASET_FETCH_ATTEMPTS = 3
DATASET_FETCH_RETRY_SECONDS = 2.0
# Labels Mado itself writes for data that the Job's code reads another way (the upstream Run's
# Artifacts through the SDK, or a verification fixture); there is nothing to download.
DESCRIPTOR_ONLY_SCHEMES = {"urn", "mmt-artifact"}
FETCHED_REFERENCE_SCHEMES = {"file", "https", "s3"}

# Jobs of one worker that need the same cache entry wait for each other, so a relayed entry is
# downloaded once; the target's lock covers Jobs of different workers.
_CACHE_ENTRY_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


class DatasetStagingError(ConfigurationError):
    """An input dataset cannot be brought to the target; the Job fails before it starts."""


@dataclass(frozen=True)
class DatasetSource:
    version_id: str
    kind: str
    key: str | None
    uri: str
    digest: str
    files: list[dict[str, Any]] | None = None
    total_size: int | None = None


@dataclass
class StagedDatasets:
    # versionId -> {"path": target path, "key": cache key or None for a file:// reference}
    paths: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Facts for the Run's log (data left to the Job's code, a cache above its limit).
    notices: list[str] = field(default_factory=list)


def indexed_transfer_path(transfer_path: Callable[[str], Path], index: int) -> Callable[[str], Path]:
    # Each input gets its own temporary files in the worker's journal directory.
    return lambda name: transfer_path(f"{name}-{index}")


def reference_cache_key(uri: str, digest: str) -> str:
    # A reference digest is whatever the client recorded, so the URI is part of the key.
    return "r-" + hashlib.sha256(f"{uri}\n{digest}".encode()).hexdigest()


def artifacts_cache_key(digest: str) -> str:
    return digest.removeprefix("sha256:")


def dataset_transfer(target: dict[str, Any]) -> str:
    return str(target.get("datasetTransfer", DEFAULT_DATASET_TRANSFER))


def dataset_cache_max_bytes(target: dict[str, Any]) -> int:
    return int(target.get("datasetCacheMaxBytes", DEFAULT_DATASET_CACHE_MAX_BYTES))


async def list_dataset_files(api: ArtifactTransferApi, dataset: dict[str, Any]) -> list[dict[str, Any]]:
    path = "projects/{}/datasets/{}/versions/{}/files".format(
        *(quote(dataset[name], safe="") for name in ("projectId", "datasetId", "id"))
    )
    files: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        params = {"limit": str(FILE_PAGE_LIMIT), **({"cursor": cursor} if cursor else {})}
        response = await request_async(
            api.http, "GET", path, params=params, masker=api.masker, retryable=True
        )
        page = response.json()
        files.extend(page["items"])
        cursor = page.get("nextCursor")
        if not cursor:
            return files


async def plan_dataset(api: ArtifactTransferApi, dataset: dict[str, Any]) -> DatasetSource | None:
    """How to obtain one version, or None when it is a descriptor only."""
    version_id, uri, digest = dataset["id"], str(dataset.get("uri") or ""), str(dataset.get("digest") or "")
    content_kind = dataset.get("contentKind")
    if content_kind is None:
        # An API from before 'artifacts' versions sends descriptors only; keep its behavior.
        return None
    if content_kind == "artifacts":
        files = await list_dataset_files(api, dataset)
        if len(files) != dataset["fileCount"] or manifest_entries_digest(files) != digest:
            raise DatasetStagingError(
                f"DatasetVersion {version_id} files do not match its digest; refusing to start"
            )
        return DatasetSource(
            version_id,
            "artifacts",
            artifacts_cache_key(digest),
            uri,
            digest,
            files=files,
            total_size=sum(int(file["size"]) for file in files),
        )
    scheme = urlsplit(uri).scheme.lower()
    if scheme in DESCRIPTOR_ONLY_SCHEMES:
        return None
    if scheme not in FETCHED_REFERENCE_SCHEMES:
        raise DatasetStagingError(
            f"DatasetVersion {version_id} has a URI scheme the worker cannot fetch ({scheme or 'none'}); "
            "supported: file://, https://, s3://"
        )
    key = None if scheme == "file" else reference_cache_key(uri, digest)
    return DatasetSource(version_id, scheme, key, uri, digest)


def partition_source(source: DatasetSource, partition: DatasetPartition) -> DatasetSource:
    """The array member's share of a verified 'artifacts' version, as its own cache entry."""
    if source.kind != "artifacts" or source.files is None:
        raise DatasetStagingError(
            f"DatasetVersion {source.version_id} is split among array members, so it must hold Artifacts"
        )
    files = partition_files(source.files, array_size=partition.array_size, array_index=partition.array_index)
    return replace(
        source,
        key=partition_cache_key(
            source.digest, array_size=partition.array_size, array_index=partition.array_index
        ),
        files=files,
        total_size=sum(int(file["size"]) for file in files),
    )


async def stage_input_datasets(
    job: Any,
    *,
    api: ArtifactTransferApi,
    executor: RunnerCommands,
    transfer_path: Callable[[str], Path],
    api_url: str,
    partition: DatasetPartition | None = None,
) -> StagedDatasets:
    """Stage every input; the version named by `partition` brings only the member's share."""
    staged = StagedDatasets()
    for index, dataset in enumerate(job.input_datasets):
        source = await plan_dataset(api, dataset)
        if source is None:
            staged.notices.append(
                f"DatasetVersion {dataset['id']} is a descriptor only ({dataset.get('uri') or 'no URI'}); "
                "the Job's code reads its data"
            )
            continue
        if partition is not None and source.version_id == partition.version_id:
            whole_count = len(source.files or [])
            source = partition_source(source, partition)
            staged.notices.append(
                f"DatasetVersion {source.version_id} is split among {partition.array_size} array members; "
                f"member {partition.array_index} reads {len(source.files or [])} of {whole_count} files"
            )
        staging = _DatasetStaging(
            job,
            api=api,
            executor=executor,
            transfer_path=indexed_transfer_path(transfer_path, index),
            api_url=api_url,
        )
        lock = _CACHE_ENTRY_LOCKS.setdefault((job.target["id"], source.key or source.uri), asyncio.Lock())
        async with lock:
            response = await staging.materialize(source)
        staged.paths[source.version_id] = {"path": response["path"], "key": source.key}
        if response.get("overLimit"):
            staged.notices.append(
                "The dataset cache stays above its limit because unfinished Jobs use the other entries"
            )
    return staged


class _DatasetStaging:
    def __init__(
        self,
        job: Any,
        *,
        api: ArtifactTransferApi,
        executor: RunnerCommands,
        transfer_path: Callable[[str], Path],
        api_url: str,
    ):
        self.job = job
        self.api = api
        self.executor = executor
        self.transfer_path = transfer_path
        self.api_url = api_url
        self.max_bytes = dataset_cache_max_bytes(job.target)
        self.relayed = dataset_transfer(job.target) == "relay"

    async def materialize(self, source: DatasetSource) -> dict[str, Any]:
        if source.total_size is not None and source.total_size > self.max_bytes:
            raise DatasetStagingError(
                f"DatasetVersion {source.version_id} is larger than the target's dataset cache limit"
            )
        if source.kind == "https":
            validate_https_uri_or_fail(source)
        request = {
            "key": source.key,
            "files": source.files,
            "totalSize": source.total_size,
            "maxCacheBytes": self.max_bytes,
        }
        if self.relayed and source.kind in {"artifacts", "https"}:
            # The file list is only needed to fill the entry; a lookup sends no list.
            cached = await self.command({**request, "files": None, "source": {"kind": "lookup"}})
            if cached.get("status") == "cached":
                return cached
            return await self.relay(source, request)
        return await self.command({**request, "source": self.target_source(source)})

    def target_source(self, source: DatasetSource) -> dict[str, Any]:
        if source.kind == "artifacts":
            if self.job.job_token is None:
                raise DatasetStagingError("Direct dataset transfer needs the Job token; refusing to start")
            return {
                "kind": "api",
                "apiUrl": self.api_url,
                "projectId": self.job.job["projectId"],
                "token": self.job.job_token,
            }
        return {"kind": source.kind, "uri": source.uri, "digest": source.digest}

    async def command(self, request: dict[str, Any]) -> dict[str, Any]:
        path = self.transfer_path("dataset-request")
        try:
            write_request_header(path, request)
            return await self.send(path)
        finally:
            path.unlink(missing_ok=True)

    async def relay(self, source: DatasetSource, request: dict[str, Any]) -> dict[str, Any]:
        archive = self.transfer_path("dataset-archive")
        try:
            # HTTPS sizes and sha256 are only known after the download; the target computes them.
            files = source.files or [{"path": reference_file_name(source.uri), "sha256": None, "size": None}]
            write_request_header(archive, {**request, "files": files, "source": {"kind": "relay"}})
            await self.append_archive(source, files, archive)
            return await self.send(archive)
        finally:
            archive.unlink(missing_ok=True)

    async def send(self, request_path: Path) -> dict[str, Any]:
        """One dataset-materialize call per attempt, retrying network failures the target reports.

        The request is a file on stdin: a file has no control timeout (a direct fetch can take
        hours), and the Job token never appears in argv.
        """
        for attempt in range(DATASET_FETCH_ATTEMPTS):
            response = await self.executor.command("dataset-materialize", stdin_file=request_path)
            if "error" not in response:
                return response
            if not response.get("retryable") or attempt == DATASET_FETCH_ATTEMPTS - 1:
                break
            await asyncio.sleep(DATASET_FETCH_RETRY_SECONDS * (attempt + 1))
        raise DatasetStagingError(f"Input dataset could not be prepared on the target: {response['error']}")

    async def append_archive(self, source: DatasetSource, files: list[dict[str, Any]], path: Path) -> None:
        """Download each file once, verify it, and append it to the tar sent to the target."""
        download = self.transfer_path("dataset-file")
        try:
            with path.open("ab") as output:
                with tarfile.open(fileobj=output, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                    for file in files:
                        with download.open("w+b") as content:
                            descriptor = await self.download(source, file, content)
                            content.seek(0)
                            member = tarfile.TarInfo(file["path"])
                            member.size = descriptor["size"]
                            member.mode = 0o600
                            archive.addfile(member, content)
                output.flush()
                os.fsync(output.fileno())
        finally:
            download.unlink(missing_ok=True)

    async def download(
        self, source: DatasetSource, file: dict[str, Any], content: BinaryIO
    ) -> dict[str, Any]:
        if source.kind == "artifacts":
            descriptor = await self.api.download_artifact(
                self.job.job["projectId"], file["artifactId"], content
            )
            if descriptor["sha256"] != file["sha256"] or descriptor["size"] != file["size"]:
                raise DatasetStagingError(
                    f"DatasetVersion {source.version_id} file sha256 or size mismatch: {file['path']}"
                )
            return descriptor
        descriptor = await download_https_reference(source.uri, content, maximum_bytes=self.max_bytes)
        expected = expected_reference_sha256(source.digest)
        if expected is not None and descriptor["sha256"] != expected:
            raise DatasetStagingError(f"DatasetVersion {source.version_id} sha256 differs from its digest")
        return descriptor


def write_request_header(path: Path, request: dict[str, Any]) -> None:
    with path.open("wb") as output:
        output.write(json.dumps(request, allow_nan=False).encode() + b"\n")


def validate_https_uri_or_fail(source: DatasetSource) -> None:
    try:
        validate_https_uri(source.uri)
    except DatasetFetchError as error:
        raise DatasetStagingError(f"DatasetVersion {source.version_id}: {error}") from None


async def download_https_reference(uri: str, destination: BinaryIO, *, maximum_bytes: int) -> dict[str, Any]:
    # A separate client: the API token and cookies are never sent to a dataset URL.
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT_SECONDS,
        follow_redirects=False,
        headers={"Accept-Encoding": DOWNLOAD_ACCEPT_ENCODING},
    ) as client:
        try:
            async with client.stream("GET", uri) as response:
                if not response.is_success:
                    raise ApiError("HTTPS dataset download failed", status_code=response.status_code)
                return await write_downloaded_content(
                    response, destination, label="HTTPS dataset", maximum_bytes=maximum_bytes
                )
        except (httpx.TransportError, httpx.DecodingError, httpx.StreamError):
            raise ApiError("HTTPS dataset download interrupted or invalid") from None
