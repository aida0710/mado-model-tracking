"""Create an 'artifacts' DatasetVersion from a local directory.

Each file becomes a Project Artifact, then one request lists them as the version's files. A file
whose sha256 and size match an Artifact the Project already stored is not uploaded again; its
Artifact is listed instead, so re-running after an interruption sends only what is missing.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .artifact_uploads import SESSION_UPLOAD_THRESHOLD_BYTES, UploadTarget, upload_file_sync
from .api_paths import path_id
from .errors import ApiError, ConfigurationError

if TYPE_CHECKING:
    from .client import Client

# Same bound as the API's MAX_DATASET_VERSION_FILES; checked before anything is uploaded.
MAX_DATASET_VERSION_FILES = 100_000
# Reads files in pieces so hashing a large audio file does not load it into memory.
HASH_CHUNK_BYTES = 1024 * 1024
# Artifacts of a dataset are stored under this folder of the Project's standalone Artifacts.
DATASET_ARTIFACT_FOLDER = "datasets"
NOT_FOUND = 404


@dataclass(frozen=True)
class LocalDatasetFile:
    """A file below the directory: its path inside the dataset and its content digest."""

    path: str
    source: Path
    size: int
    sha256: str


def file_sha256(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as content:
        while chunk := content.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def scan_dataset_directory(directory: Path) -> list[LocalDatasetFile]:
    """Every file below directory with its relative POSIX path, in path order."""
    if not directory.is_dir():
        raise ConfigurationError(f"{directory} is not a directory")
    # rglob does not descend into symlinked directories, so the walk stays inside the tree.
    sources = sorted(file for file in directory.rglob("*") if file.is_file())
    if not sources:
        raise ConfigurationError(f"{directory} has no files")
    if len(sources) > MAX_DATASET_VERSION_FILES:
        raise ConfigurationError(f"A DatasetVersion holds at most {MAX_DATASET_VERSION_FILES} files")
    return [
        LocalDatasetFile(
            path=source.relative_to(directory).as_posix(),
            source=source,
            size=source.stat().st_size,
            sha256=file_sha256(source),
        )
        for source in sources
    ]


def dataset_manifest_digest(files: list[LocalDatasetFile]) -> str:
    """The digest the API computes for an 'artifacts' version (see datasetManifestDigest.ts)."""
    entries = [
        {"path": file.path, "sha256": file.sha256, "size": file.size}
        for file in sorted(files, key=lambda file: file.path.encode("utf-8"))
    ]
    canonical = json.dumps(entries, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def find_stored_artifact(client: Client, project_id: str, file: LocalDatasetFile) -> str | None:
    """ID of a stored Project Artifact with the same content, or None when there is none."""
    try:
        artifact = client.request(
            "GET",
            client.project_path(project_id, "artifacts/by-digest"),
            params={"sha256": file.sha256, "size": file.size},
            retryable=True,
        )
    except ApiError as error:
        if error.status_code == NOT_FOUND:
            return None
        raise
    return str(artifact["id"])


def upload_dataset_file(client: Client, project_id: str, dataset_id: str, file: LocalDatasetFile) -> str:
    """Stores the file as a standalone Artifact and returns its ID."""
    path = f"{DATASET_ARTIFACT_FOLDER}/{dataset_id}/{file.path}"
    mime_type = mimetypes.guess_type(file.path)[0] or "application/octet-stream"
    if file.size >= SESSION_UPLOAD_THRESHOLD_BYTES:
        target = UploadTarget(
            api_url=client.settings.url, project_id=project_id, run_id=None, path=path, mime_type=mime_type
        )
        artifact = upload_file_sync(client, target=target, source=file.source)
    else:

        def chunks() -> Iterator[bytes]:
            with file.source.open("rb") as content:
                while chunk := content.read(HASH_CHUNK_BYTES):
                    yield chunk

        artifact = client.request(
            "PUT",
            client.project_path(project_id, "artifacts"),
            params={"path": path},
            headers={"Content-Type": mime_type},
            content_factory=chunks,
        )
    if artifact.get("sha256") != file.sha256:
        raise ConfigurationError(f"{file.source} changed while it was uploaded")
    return str(artifact["id"])


def upload_dataset_directory(
    client: Client,
    project_id: str,
    dataset_id: str,
    directory: str | Path,
    *,
    version: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    schema: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Upload a directory and create a DatasetVersion of its files; version None takes the next integer.

    The locally computed digest is sent with the request, so the API rejects the version if the
    stored Artifacts differ from the files on disk.
    """
    files = scan_dataset_directory(Path(directory))
    listed = [
        {
            "path": file.path,
            "artifactId": find_stored_artifact(client, project_id, file)
            or upload_dataset_file(client, project_id, dataset_id, file),
        }
        for file in files
    ]
    body: dict[str, Any] = {
        "digest": dataset_manifest_digest(files),
        "metadata": dict(metadata or {}),
        "schema": dict(schema or {}),
        "content": {"kind": "artifacts", "files": listed},
    }
    if version is not None:
        body["version"] = version
    return client.request(
        "POST", client.project_path(project_id, f"datasets/{path_id(dataset_id)}/versions"), json=body
    )
