"""Validate complete container results and read only declared, regular output files."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from ..execution_runtime import SHA256_PATTERN
from ..timestamps import utc_timestamp
from .artifact_files import open_regular_file

# Bound protocol metadata and each SSH response; artifact contents remain streamed.
MAX_RESULT_BYTES = 1024 * 1024
MAX_OUTPUT_FILES = 128
MAX_METRIC_POINTS = 1000
OUTPUT_CHUNK_BYTES = 64 * 1024
HASH_CHUNK_BYTES = 1024 * 1024
RESULT_FILENAME = "result.json"
# Match the API's ISO timestamp and JavaScript integer contract before uploading any artifacts.
ISO_TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$")
MAX_METRIC_STEP = 2**53 - 1


def output_path_parts(path: str) -> list[str]:
    if (
        not isinstance(path, str)
        or not path
        or len(path) > 1024
        or PurePosixPath(path).is_absolute()
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or any(character in path for character in "\\\x00\r\n")
        or path.endswith((".partial", ".tmp"))
    ):
        raise ValueError("Output path must be a completed file inside /mmt/outputs")
    return path.split("/")


@contextmanager
def open_output(root: Path, path: str) -> Iterator[BinaryIO]:
    parts = output_path_parts(path)
    with open_regular_file(root, parts) as content:
        yield content


def file_checksum(content: BinaryIO) -> tuple[str, int]:
    checksum, size = hashlib.sha256(), 0
    while chunk := content.read(HASH_CHUNK_BYTES):
        checksum.update(chunk)
        size += len(chunk)
    return checksum.hexdigest(), size


def _output_files(root: Path) -> set[str]:
    paths: set[str] = set()
    for directory, subdirectories, filenames in os.walk(root, followlinks=False):
        for name in subdirectories + filenames:
            entry = Path(directory) / name
            if entry.is_symlink():
                raise ValueError("Output symlinks are not accepted")
        for name in filenames:
            path = (Path(directory) / name).relative_to(root).as_posix()
            output_path_parts(path)
            paths.add(path)
            if len(paths) > MAX_OUTPUT_FILES + 1:
                raise ValueError("Too many container output files")
    return paths


def validate_results(root: Path) -> dict[str, Any] | None:
    if root.is_symlink():
        raise ValueError("Output directory must not be a symlink")
    files = _output_files(root)
    if not files:
        return None
    if RESULT_FILENAME not in files:
        raise ValueError("Container outputs require a complete result.json manifest")
    with open_output(root, RESULT_FILENAME) as manifest:
        raw = manifest.read(MAX_RESULT_BYTES + 1)
    if len(raw) > MAX_RESULT_BYTES:
        raise ValueError("Container result.json exceeds the metadata limit")
    result = json.loads(raw)
    if (
        not isinstance(result, dict)
        or type(result.get("version")) is not int
        or result.get("version") != 1
        or result.get("complete") is not True
        or set(result) - {"version", "complete", "artifacts", "metrics"}
    ):
        raise ValueError("Container result.json requires version=1 and complete=true")
    artifacts = result.get("artifacts", [])
    if not isinstance(artifacts, list) or len(artifacts) > MAX_OUTPUT_FILES:
        raise ValueError("Invalid container artifact list")
    declared: set[str] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict) or set(artifact) - {"path", "sha256", "size", "mimeType"}:
            raise ValueError("Invalid container artifact descriptor")
        path = artifact.get("path")
        if not isinstance(path, str):
            raise ValueError("Container artifact requires an output path")
        output_path_parts(path)
        if path == RESULT_FILENAME or path in declared:
            raise ValueError("Container artifacts must have distinct output paths")
        declared.add(path)
        checksum, size = artifact.get("sha256"), artifact.get("size")
        if not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum):
            raise ValueError("Container artifact requires a sha256 checksum")
        if type(size) is not int or size < 0:
            raise ValueError("Container artifact requires a nonnegative size")
        mime_type = artifact.get("mimeType", "application/octet-stream")
        if not isinstance(mime_type, str) or not mime_type or any(char in mime_type for char in "\r\n\x00"):
            raise ValueError("Invalid container artifact mimeType")
        with open_output(root, path) as content:
            actual_checksum, actual_size = file_checksum(content)
        if (actual_checksum, actual_size) != (checksum, size):
            raise ValueError("Container output checksum or size mismatch; output may be incomplete")
        artifact["mimeType"] = mime_type
    if files != declared | {RESULT_FILENAME}:
        raise ValueError("Container outputs contain undeclared or incomplete files")
    metrics = result.get("metrics", [])
    if not isinstance(metrics, list) or len(metrics) > MAX_METRIC_POINTS:
        raise ValueError("Invalid container metrics list")
    timestamp = utc_timestamp()
    for metric in metrics:
        if not isinstance(metric, dict) or set(metric) - {"name", "value", "step", "timestamp"}:
            raise ValueError("Invalid container metric")
        name, value, step = metric.get("name"), metric.get("value"), metric.get("step", 0)
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200 or "\x00" in name:
            raise ValueError("Invalid container metric name")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("Container metrics must be finite numbers")
        if type(step) is not int or not 0 <= step <= MAX_METRIC_STEP:
            raise ValueError("Container metric step must be a nonnegative integer")
        metric_timestamp = metric.get("timestamp", timestamp)
        if not isinstance(metric_timestamp, str) or not ISO_TIMESTAMP_PATTERN.fullmatch(metric_timestamp):
            raise ValueError("Container metric timestamp must be an ISO timestamp")
        try:
            parsed_timestamp = datetime.fromisoformat(metric_timestamp.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("Container metric timestamp must be an ISO timestamp") from None
        if parsed_timestamp.tzinfo is None:
            raise ValueError("Container metric timestamp requires a timezone")
        metric.update(step=step, timestamp=metric_timestamp)
    return {"artifacts": artifacts, "metrics": metrics}


def read_output_chunk(workspace: Path, request: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    if state.get("status") != "finished":
        raise ValueError("Outputs can only be read after successful execution and cleanup")
    artifact = next(
        (
            item
            for item in (state.get("results") or {}).get("artifacts", [])
            if item["path"] == request["path"]
        ),
        None,
    )
    if artifact is None:
        raise ValueError("Output was not declared in the validated result manifest")
    offset = request.get("offset", 0)
    if type(offset) is not int or not 0 <= offset <= artifact["size"]:
        raise ValueError("Invalid container output offset")
    with open_output(workspace / "outputs", artifact["path"]) as content:
        if os.fstat(content.fileno()).st_size != artifact["size"]:
            raise ValueError("Container output changed after completion")
        content.seek(offset)
        raw = content.read(min(OUTPUT_CHUNK_BYTES, artifact["size"] - offset))
    return {"content": base64.b64encode(raw).decode(), "nextOffset": offset + len(raw)}
