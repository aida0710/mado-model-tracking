"""Upload large Artifacts through resumable upload sessions (`/projects/:p/artifact-uploads`).

The whole file is hashed first so the session carries `expectedSha256` and every part carries
`X-Part-SHA256`. A local state file remembers the session id; rerunning the same upload asks the
API which parts it already holds and sends only the missing ones. The SDK is synchronous and the
worker is asyncio, so the session protocol below is shared and only the two drivers differ.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from .client import path_id
from .errors import ApiError, ConfigurationError
from .http import request_async
from .security import SecretMasker

if TYPE_CHECKING:
    from .client import Client

# Below this size one PUT is cheap to resend; above it a dropped connection wastes real time.
SESSION_UPLOAD_THRESHOLD_BYTES = 64 * 1024 * 1024
# The API's default part size; larger files grow it so the part count stays within the limit.
DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024
# Mirrors MULTIPART_MAX_PART_COUNT in @mmt/platform (S3 allows at most 10000 parts).
MAX_PART_COUNT = 10_000
PART_SIZE_ALIGNMENT_BYTES = 1024 * 1024
# Four parts in flight keep a link busy while bounding memory and server-side staging.
UPLOAD_PART_CONCURRENCY = 4
# Each read holds at most one MiB, the same memory budget as single-PUT uploads.
UPLOAD_CHUNK_BYTES = 1024 * 1024
# The finalizer concatenates and rehashes the object; a 200 GiB Artifact needs tens of minutes.
VERIFY_TIMEOUT_SECONDS = 2 * 60 * 60
VERIFY_POLL_INITIAL_SECONDS = 0.5
VERIFY_POLL_MAX_SECONDS = 5.0
PART_SHA256_HEADER = "X-Part-SHA256"
UPLOAD_STATE_VERSION = 1
# A session that is still usable; aborted, expired and failed sessions start over.
REUSABLE_STATUSES = {"open", "verifying", "completed"}
# The API answers these when the session belongs to another credential or no longer exists.
LOST_SESSION_STATUSES = {403, 404}
# The part does not match what was hashed: the file changed after the upload started.
CHANGED_PART_CODES = {"part_size_mismatch", "part_checksum_mismatch"}


# One JSON request to the API with the worker's retries; the async driver's only HTTP primitive.
SessionRequest = Callable[..., Awaitable[dict[str, Any]]]


class UploadSessionFailed(ApiError):
    """The API finished verification without registering the Artifact."""


@dataclass(frozen=True)
class UploadTarget:
    api_url: str
    project_id: str
    run_id: str | None
    path: str
    mime_type: str


@dataclass(frozen=True)
class LocalFile:
    source: Path
    size: int
    sha256: str
    part_size: int
    part_sha256s: tuple[str, ...]

    @property
    def part_count(self) -> int:
        return len(self.part_sha256s)

    def part_length(self, part_number: int) -> int:
        offset = (part_number - 1) * self.part_size
        return min(self.part_size, self.size - offset)

    def read_part(self, part_number: int) -> Iterator[bytes]:
        remaining = self.part_length(part_number)
        with self.source.open("rb") as content:
            content.seek((part_number - 1) * self.part_size)
            while remaining > 0 and (chunk := content.read(min(UPLOAD_CHUNK_BYTES, remaining))):
                remaining -= len(chunk)
                yield chunk

    async def read_part_async(self, part_number: int) -> AsyncIterator[bytes]:
        for chunk in self.read_part(part_number):
            yield chunk

    def part_headers(self, part_number: int) -> dict[str, str]:
        return {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(self.part_length(part_number)),
            PART_SHA256_HEADER: self.part_sha256s[part_number - 1],
        }


def choose_part_size(size: int) -> int:
    smallest = -(-size // MAX_PART_COUNT)
    aligned = -(-smallest // PART_SIZE_ALIGNMENT_BYTES) * PART_SIZE_ALIGNMENT_BYTES
    return max(DEFAULT_PART_SIZE_BYTES, aligned)


def describe_local_file(source: Path, *, part_size: int | None = None) -> LocalFile:
    """Hash the whole file and each part in one read."""
    size = source.stat().st_size
    if size <= 0:
        raise ConfigurationError("An upload session requires a non-empty file")
    part_size = part_size or choose_part_size(size)
    whole, part_digests = hashlib.sha256(), []
    with source.open("rb") as content:
        while part := content.read(part_size):
            whole.update(part)
            part_digests.append(hashlib.sha256(part).hexdigest())
    return LocalFile(source, size, whole.hexdigest(), part_size, tuple(part_digests))


def default_state_directory() -> Path:
    cache = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(cache) / "mado-tracking" / "uploads"


class UploadStateStore:
    """`<sha256>.json` per file. The token is never written; only the session id and its target."""

    def __init__(self, directory: Path | None = None):
        self.directory = directory or default_state_directory()

    def state_path(self, local: LocalFile) -> Path:
        return self.directory / f"{local.sha256}.json"

    def load(self, local: LocalFile, target: UploadTarget) -> str | None:
        try:
            state = json.loads(self.state_path(local).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        upload_id = state.get("uploadId") if isinstance(state, dict) else None
        if not isinstance(upload_id, str) or state != self._state(local, target, upload_id=upload_id):
            return None
        return upload_id

    def save(self, local: LocalFile, target: UploadTarget, upload_id: str) -> None:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self.state_path(local)
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(self._state(local, target, upload_id=upload_id), output)
        os.replace(temporary, path)

    def remove(self, local: LocalFile) -> None:
        self.state_path(local).unlink(missing_ok=True)

    @staticmethod
    def _state(local: LocalFile, target: UploadTarget, *, upload_id: Any) -> dict[str, Any]:
        return {
            "version": UPLOAD_STATE_VERSION,
            "uploadId": upload_id,
            "apiUrl": target.api_url,
            "projectId": target.project_id,
            "runId": target.run_id,
            "path": target.path,
            "size": local.size,
            "partSize": local.part_size,
        }


def session_create_body(target: UploadTarget, local: LocalFile) -> dict[str, Any]:
    body: dict[str, Any] = {
        "path": target.path,
        "mimeType": target.mime_type,
        "expectedSize": local.size,
        "expectedSha256": local.sha256,
        "partSize": local.part_size,
    }
    if target.run_id:
        body["runId"] = target.run_id
    return body


def is_reusable(upload: dict[str, Any], target: UploadTarget, local: LocalFile) -> bool:
    return (
        upload.get("status") in REUSABLE_STATUSES
        and upload.get("path") == target.path
        and upload.get("runId") == target.run_id
        and upload.get("expectedSize") == local.size
        and upload.get("expectedSha256") == local.sha256
        and upload.get("partSize") == local.part_size
    )


def missing_parts(upload: dict[str, Any], local: LocalFile) -> list[int]:
    """Parts the API does not hold with exactly this file's bytes."""
    received = {
        part.get("partNumber")
        for part in upload.get("receivedParts", [])
        if isinstance(part, dict)
        and isinstance(part.get("partNumber"), int)
        and 1 <= part["partNumber"] <= local.part_count
        and part.get("size") == local.part_length(part["partNumber"])
        and part.get("sha256") == local.part_sha256s[part["partNumber"] - 1]
    }
    return [number for number in range(1, local.part_count + 1) if number not in received]


def completed_artifact_id(upload: dict[str, Any]) -> str | None:
    """The registered Artifact id, None while verifying, or an error for a terminal failure."""
    status = upload.get("status")
    if status == "completed" and isinstance(upload.get("artifactId"), str):
        return str(upload["artifactId"])
    if status == "verifying":
        return None
    raise UploadSessionFailed(
        f"Artifact upload session ended as {status}: {upload.get('error') or 'no error reported'}",
        code=upload.get("error") or None,
    )


def verify_saved_artifact(artifact: dict[str, Any], local: LocalFile) -> dict[str, Any]:
    if (artifact.get("sha256"), artifact.get("size")) != (local.sha256, local.size):
        raise ConfigurationError("Saved Artifact checksum or size does not match the uploaded file")
    return artifact


def verify_poll_delays() -> Iterator[float]:
    delay, deadline = VERIFY_POLL_INITIAL_SECONDS, time.monotonic() + VERIFY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        yield delay
        delay = min(VERIFY_POLL_MAX_SECONDS, delay * 2)
    raise ApiError("Artifact upload verification did not finish in time; rerun to resume waiting")


def changed_file_error(error: ApiError) -> ConfigurationError | None:
    if error.code in CHANGED_PART_CODES:
        return ConfigurationError("The file changed during upload; rerun to upload its new content")
    return None


class UploadPaths:
    def __init__(self, project_id: str):
        self.project = f"projects/{path_id(project_id)}"

    @property
    def sessions(self) -> str:
        return f"{self.project}/artifact-uploads"

    def session(self, upload_id: str) -> str:
        return f"{self.sessions}/{path_id(upload_id)}"

    def part(self, upload_id: str, part_number: int) -> str:
        return f"{self.session(upload_id)}/parts/{part_number}"

    def artifact(self, artifact_id: str) -> str:
        return f"{self.project}/artifacts/{path_id(artifact_id)}"


def upload_file_sync(
    client: Client,
    *,
    target: UploadTarget,
    source: Path,
    part_size: int | None = None,
    state_store: UploadStateStore | None = None,
) -> dict[str, Any]:
    local = describe_local_file(source, part_size=part_size)
    store = state_store or UploadStateStore()
    paths = UploadPaths(target.project_id)
    upload = _resume_or_create_sync(client, paths=paths, target=target, local=local, store=store)
    try:
        if upload["status"] == "open":
            _send_parts_sync(
                client,
                paths=paths,
                upload_id=upload["id"],
                local=local,
                part_numbers=missing_parts(upload, local),
            )
            upload = client.request("POST", f"{paths.session(upload['id'])}/complete", retryable=True)
        artifact_id = completed_artifact_id(upload)
        delays = verify_poll_delays()
        while artifact_id is None:
            time.sleep(next(delays))
            artifact_id = completed_artifact_id(
                client.request("GET", paths.session(upload["id"]), retryable=True)
            )
    except UploadSessionFailed:
        store.remove(local)
        raise
    except ApiError as error:
        if changed := changed_file_error(error):
            store.remove(local)
            raise changed from None
        raise
    store.remove(local)
    return verify_saved_artifact(client.request("GET", paths.artifact(artifact_id), retryable=True), local)


def _resume_or_create_sync(
    client: Client, *, paths: UploadPaths, target: UploadTarget, local: LocalFile, store: UploadStateStore
) -> dict[str, Any]:
    if upload_id := store.load(local, target):
        try:
            upload = client.request("GET", paths.session(upload_id), retryable=True)
            if is_reusable(upload, target, local):
                return upload
        except ApiError as error:
            if error.status_code not in LOST_SESSION_STATUSES:
                raise
    # A lost create response leaves an orphan session; the API expires it with its staged parts.
    upload = client.request("POST", paths.sessions, json=session_create_body(target, local), retryable=True)
    store.save(local, target, upload["id"])
    return upload


def _send_parts_sync(
    client: Client, *, paths: UploadPaths, upload_id: str, local: LocalFile, part_numbers: list[int]
) -> None:
    def send(part_number: int) -> None:
        client.request(
            "PUT",
            paths.part(upload_id, part_number),
            headers=local.part_headers(part_number),
            content_factory=lambda: local.read_part(part_number),
            retryable=True,
        )

    with ThreadPoolExecutor(max_workers=UPLOAD_PART_CONCURRENCY) as executor:
        futures = [executor.submit(send, number) for number in part_numbers]
        done, pending = wait(futures, return_when=FIRST_EXCEPTION)
        for future in pending:
            future.cancel()
        for future in done:
            future.result()


async def upload_file_async(
    http: httpx.AsyncClient,
    *,
    masker: SecretMasker,
    target: UploadTarget,
    source: Path,
    part_size: int | None = None,
    state_store: UploadStateStore | None = None,
) -> dict[str, Any]:
    async def request(method: str, path: str, **options: Any) -> dict[str, Any]:
        response = await request_async(http, method, path, masker=masker, retryable=True, **options)
        payload = response.json()
        if not isinstance(payload, dict):
            raise ConfigurationError("API returned a non-object response")
        return payload

    # Hashing a multi-gigabyte file must not stall heartbeats on the event loop.
    local = await asyncio.to_thread(describe_local_file, source, part_size=part_size)
    store = state_store or UploadStateStore()
    paths = UploadPaths(target.project_id)
    upload = await _resume_or_create_async(request, paths=paths, target=target, local=local, store=store)
    try:
        if upload["status"] == "open":
            await _send_parts_async(
                request,
                paths=paths,
                upload_id=upload["id"],
                local=local,
                part_numbers=missing_parts(upload, local),
            )
            upload = await request("POST", f"{paths.session(upload['id'])}/complete")
        artifact_id = completed_artifact_id(upload)
        delays = verify_poll_delays()
        while artifact_id is None:
            await asyncio.sleep(next(delays))
            artifact_id = completed_artifact_id(await request("GET", paths.session(upload["id"])))
    except UploadSessionFailed:
        store.remove(local)
        raise
    except ApiError as error:
        if changed := changed_file_error(error):
            store.remove(local)
            raise changed from None
        raise
    store.remove(local)
    return verify_saved_artifact(await request("GET", paths.artifact(artifact_id)), local)


async def _resume_or_create_async(
    request: SessionRequest,
    *,
    paths: UploadPaths,
    target: UploadTarget,
    local: LocalFile,
    store: UploadStateStore,
) -> dict[str, Any]:
    if upload_id := store.load(local, target):
        try:
            upload: dict[str, Any] = await request("GET", paths.session(upload_id))
            if is_reusable(upload, target, local):
                return upload
        except ApiError as error:
            if error.status_code not in LOST_SESSION_STATUSES:
                raise
    upload = await request("POST", paths.sessions, json=session_create_body(target, local))
    store.save(local, target, upload["id"])
    return upload


async def _send_parts_async(
    request: SessionRequest, *, paths: UploadPaths, upload_id: str, local: LocalFile, part_numbers: list[int]
) -> None:
    slots = asyncio.Semaphore(UPLOAD_PART_CONCURRENCY)

    async def send(part_number: int) -> None:
        async with slots:
            await request(
                "PUT",
                paths.part(upload_id, part_number),
                headers=local.part_headers(part_number),
                content_factory=lambda: local.read_part_async(part_number),
            )

    # A failed part cancels the others; the state file lets the next run resume.
    try:
        async with asyncio.TaskGroup() as group:
            for number in part_numbers:
                group.create_task(send(number))
    except ExceptionGroup as failures:
        raise failures.exceptions[0] from None
