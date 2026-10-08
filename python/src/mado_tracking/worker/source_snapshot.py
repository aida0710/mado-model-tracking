"""Publish pre-execution source ZIP/manifest files and read only their declared bytes."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .artifact_files import open_regular_file
from .container_outputs import HASH_CHUNK_BYTES, OUTPUT_CHUNK_BYTES, file_checksum
from .source_tree import (
    MAX_SOURCE_ARCHIVE_BYTES,
    MAX_SOURCE_BYTES,
    MAX_SOURCE_FILE_BYTES,
    walk_source_entries,
)

# Reserved Run Artifact paths never overlap the container's user-declared outputs.
SOURCE_ZIP_PATH = ".mmt/source.zip"
SOURCE_MANIFEST_PATH = ".mmt/source-manifest.json"
SNAPSHOT_DIRECTORY = "source-snapshot"
SNAPSHOT_FILENAMES = {SOURCE_ZIP_PATH: "source.zip", SOURCE_MANIFEST_PATH: "source-manifest.json"}
# File descriptors stay small in runner state; the detailed manifest is streamed as an artifact.
MAX_MANIFEST_BYTES = 16 * 1024**2
# A published ZIP must be accepted by the same bounded source archive extractor.
MAX_SNAPSHOT_BYTES = MAX_SOURCE_ARCHIVE_BYTES
# ZIP readers use the DOS directory flag together with the POSIX type/mode.
ZIP_DIRECTORY_ATTRIBUTE = 0x10


def create_source_snapshot(
    workspace: Path,
    specification: dict[str, Any],
    *,
    actual_commit: str | None,
    check_cancellation: Callable[[], None],
) -> dict[str, Any]:
    destination = workspace / SNAPSHOT_DIRECTORY
    if destination.exists() or destination.is_symlink():
        raise ValueError("Source snapshot already exists; refusing to replace execution evidence")
    snapshot = specification["executionSnapshot"]
    manifest = {
        "version": 1,
        "jobId": specification["jobId"],
        "runId": specification["context"]["runId"],
        "codeVersionId": snapshot["codeVersionId"],
        "codeVersionVersion": snapshot["version"],
        "mode": snapshot["mode"],
        "commit": actual_commit,
        "runtime": snapshot["runtime"],
        "entrypoint": snapshot["entrypoint"],
        "files": [],
        "directories": [],
    }
    source = snapshot["source"]
    if source is not None and source["kind"] == "git" and actual_commit != source["commit"].lower():
        raise ValueError("Source snapshot commit does not match the pinned CodeVersion")
    with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=workspace) as temporary:
        staging = Path(temporary) / SNAPSHOT_DIRECTORY
        staging.mkdir(mode=0o700)
        artifacts = []
        if source is not None:
            manifest["files"], manifest["directories"] = _write_source_zip(
                workspace / "source",
                staging / "source.zip",
                has_git_metadata=actual_commit is not None,
                check_cancellation=check_cancellation,
            )
            artifacts.append(_artifact_descriptor(staging, SOURCE_ZIP_PATH, "application/zip"))
        _write_manifest(staging / "source-manifest.json", manifest)
        artifacts.append(_artifact_descriptor(staging, SOURCE_MANIFEST_PATH, "application/json"))
        check_cancellation()
        os.replace(staging, destination)
    return {"artifacts": artifacts}


def _write_source_zip(
    root: Path,
    destination: Path,
    *,
    has_git_metadata: bool,
    check_cancellation: Callable[[], None],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    files = []
    directories = []
    total_bytes = 0
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in sorted(
            walk_source_entries(root, has_git_metadata=has_git_metadata), key=lambda item: item.relative_path
        ):
            check_cancellation()
            name = entry.relative_path
            if entry.is_directory:
                member = zipfile.ZipInfo(name + "/")
                member.external_attr = (stat.S_IFDIR | (entry.mode & 0o777)) << 16 | ZIP_DIRECTORY_ATTRIBUTE
                archive.writestr(member, b"")
                directories.append({"path": name, "mode": entry.mode & 0o777})
                continue
            checksum, size = hashlib.sha256(), 0
            with open_regular_file(root, name.split("/")) as content:
                properties = os.fstat(content.fileno())
                member = zipfile.ZipInfo(name)
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = (stat.S_IFREG | (properties.st_mode & 0o777)) << 16
                with archive.open(member, "w", force_zip64=True) as output:
                    while chunk := content.read(HASH_CHUNK_BYTES):
                        check_cancellation()
                        size += len(chunk)
                        total_bytes += len(chunk)
                        if size > MAX_SOURCE_FILE_BYTES or total_bytes > MAX_SOURCE_BYTES:
                            raise ValueError("Source changed or exceeded snapshot size limits")
                        checksum.update(chunk)
                        output.write(chunk)
                if size != properties.st_size:
                    raise ValueError("Source changed while its snapshot was being created")
            files.append({"path": name, "size": size, "sha256": checksum.hexdigest()})
        if destination.stat().st_size > MAX_SNAPSHOT_BYTES:
            raise ValueError("Source ZIP exceeds its size limit")
    # Finish the ZIP central directory before hashing or publishing it.
    if destination.stat().st_size > MAX_SNAPSHOT_BYTES:
        raise ValueError("Source ZIP exceeds its size limit")
    with destination.open("rb") as content:
        os.fsync(content.fileno())
    return files, directories


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    size = 0
    with path.open("xb") as output:
        for fragment in json.JSONEncoder(ensure_ascii=False, allow_nan=False, sort_keys=True).iterencode(
            manifest
        ):
            chunk = fragment.encode("utf-8")
            size += len(chunk)
            if size > MAX_MANIFEST_BYTES:
                raise ValueError("Source snapshot manifest exceeds its size limit")
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())


def _artifact_descriptor(root: Path, artifact_path: str, mime_type: str) -> dict[str, Any]:
    filename = SNAPSHOT_FILENAMES[artifact_path]
    with open_regular_file(root, [filename]) as content:
        checksum, size = file_checksum(content)
    return {"path": artifact_path, "sha256": checksum, "size": size, "mimeType": mime_type}


def read_source_snapshot_chunk(
    workspace: Path, request: dict[str, Any], state: dict[str, Any]
) -> dict[str, Any]:
    artifact_path = request.get("path")
    if artifact_path not in SNAPSHOT_FILENAMES:
        raise ValueError("Source snapshot path is not reserved")
    artifact = next(
        (
            item
            for item in (state.get("sourceSnapshot") or {}).get("artifacts", [])
            if item["path"] == artifact_path
        ),
        None,
    )
    if artifact is None:
        raise ValueError("Source snapshot was not published before execution")
    offset = request.get("offset", 0)
    if type(offset) is not int or not 0 <= offset <= artifact["size"]:
        raise ValueError("Invalid source snapshot offset")
    with open_regular_file(workspace / SNAPSHOT_DIRECTORY, [SNAPSHOT_FILENAMES[artifact_path]]) as content:
        if os.fstat(content.fileno()).st_size != artifact["size"]:
            raise ValueError("Source snapshot changed after publication")
        content.seek(offset)
        raw = content.read(min(OUTPUT_CHUNK_BYTES, artifact["size"] - offset))
    return {"content": base64.b64encode(raw).decode(), "nextOffset": offset + len(raw)}
