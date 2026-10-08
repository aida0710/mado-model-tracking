"""Validate complete container results and record the index of declared, regular output files."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import tempfile
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
# Audio inference writes one file per utterance; 10000 covers a test set while keeping the index
# (at most MAX_ARTIFACT_LINE_BYTES per file) small enough to hold in memory. MMT_WORKER_MAX_OUTPUT_FILES
# changes it per worker.
DEFAULT_MAX_OUTPUT_FILES = 10_000
# A descriptor line is a 1024-byte path, a sha256, a size and a 255-byte mimeType with JSON quoting.
MAX_ARTIFACT_LINE_BYTES = 4096
MAX_MIME_TYPE_LENGTH = 255
MAX_OUTPUT_PATH_LENGTH = 1024
MAX_METRIC_POINTS = 1000
# The API's per-Run declaration limits (apps/api/src/domain/workerOutputValidation.ts).
MAX_MODEL_DECLARATIONS = 16
MAX_DATASET_DECLARATIONS = 64
MAX_DATASET_URI_LENGTH = 4000
MAX_DATASET_DIGEST_LENGTH = 1000
OUTPUT_CHUNK_BYTES = 64 * 1024
HASH_CHUNK_BYTES = 1024 * 1024
RESULT_FILENAME = "result.json"
# Written beside outputs/ (never inside it) so the job state stays small for any number of files.
OUTPUT_INDEX_FILENAME = "output-index.jsonl"
SPEC_FILENAME = "spec.json"
# Match the API's ISO timestamp and JavaScript integer contract before uploading any artifacts.
ISO_TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$")
MAX_METRIC_STEP = 2**53 - 1
RESULT_VERSION_FIELDS = {
    1: {"version", "complete", "artifacts", "metrics"},
    2: {"version", "complete", "artifacts", "metrics", "artifactsManifest", "models", "datasets"},
}


def output_path_parts(path: str) -> list[str]:
    if (
        not isinstance(path, str)
        or not path
        or len(path) > MAX_OUTPUT_PATH_LENGTH
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


def artifact_key(artifact: dict[str, Any]) -> str:
    """The journal acknowledges each saved output by path and content."""
    return f"{artifact['path']}:{artifact['sha256']}"


def _output_files(root: Path, *, max_files: int) -> set[str]:
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
            # result.json and an artifactsManifest are the only files beyond the declared outputs.
            if len(paths) > max_files + 2:
                raise ValueError(f"Too many container output files (limit {max_files})")
    return paths


def configured_max_output_files(workspace: Path) -> int:
    """The worker's MMT_WORKER_MAX_OUTPUT_FILES, which reaches the runner in spec.json."""
    spec_path = workspace / SPEC_FILENAME
    if not spec_path.exists():
        return DEFAULT_MAX_OUTPUT_FILES
    limit = json.loads(spec_path.read_text(encoding="utf-8")).get("maxOutputFiles", DEFAULT_MAX_OUTPUT_FILES)
    if type(limit) is not int or limit < 1:
        raise ValueError("maxOutputFiles must be a positive integer")
    return limit


def validate_results(root: Path, *, max_files: int | None = None) -> dict[str, Any] | None:
    """Verify every declared output, then save its index beside ``root`` and return a summary.

    The summary (counts, the index sha256, metrics and output declarations) is what the job state
    keeps; the per-file list lives in the index so that poll responses stay bounded.
    """
    if root.is_symlink():
        raise ValueError("Output directory must not be a symlink")
    workspace = root.parent
    limit = max_files if max_files is not None else configured_max_output_files(workspace)
    files = _output_files(root, max_files=limit)
    if not files:
        return None
    if RESULT_FILENAME not in files:
        raise ValueError("Container outputs require a complete result.json manifest")
    with open_output(root, RESULT_FILENAME) as manifest:
        raw = manifest.read(MAX_RESULT_BYTES + 1)
    if len(raw) > MAX_RESULT_BYTES:
        raise ValueError("Container result.json exceeds the metadata limit")
    result = json.loads(raw)
    version = result.get("version") if isinstance(result, dict) else None
    if (
        not isinstance(result, dict)
        or type(version) is not int
        or version not in RESULT_VERSION_FIELDS
        or result.get("complete") is not True
        or set(result) - RESULT_VERSION_FIELDS[version]
    ):
        raise ValueError("Container result.json requires version 1 or 2 and complete=true")
    listed = result.get("artifacts", [])
    if not isinstance(listed, list):
        raise ValueError("Invalid container artifact list")
    metadata_files = {RESULT_FILENAME}
    manifest_path = result.get("artifactsManifest")
    if manifest_path is not None:
        output_path_parts(manifest_path)
        if manifest_path == RESULT_FILENAME:
            raise ValueError("artifactsManifest must be a separate output file")
        listed = listed + _read_artifacts_manifest(root, manifest_path, max_files=limit)
        metadata_files.add(manifest_path)
    if len(listed) > limit:
        raise ValueError(f"Too many container output files (limit {limit})")
    artifacts = _verified_artifacts(root, listed, reserved=metadata_files)
    declared = {artifact["path"] for artifact in artifacts}
    if files != declared | metadata_files:
        raise ValueError("Container outputs contain undeclared or incomplete files")
    metrics = _validated_metrics(result.get("metrics", []))
    declarations = _output_declarations(result, declared)
    # The index is the last step, so a rejected result never leaves one for the archive command.
    index = encode_output_index(artifacts)
    _write_private_file(workspace / OUTPUT_INDEX_FILENAME, index)
    return {
        "version": version,
        "artifactCount": len(artifacts),
        "artifactBytes": sum(artifact["size"] for artifact in artifacts),
        "artifactIndexSha256": hashlib.sha256(index).hexdigest(),
        "metrics": metrics,
        "declarations": declarations,
    }


def _read_artifacts_manifest(root: Path, path: str, *, max_files: int) -> list[Any]:
    maximum_bytes = max_files * MAX_ARTIFACT_LINE_BYTES
    with open_output(root, path) as content:
        raw = content.read(maximum_bytes + 1)
    if len(raw) > maximum_bytes:
        raise ValueError("artifactsManifest exceeds its size limit")
    entries: list[Any] = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        if len(line) > MAX_ARTIFACT_LINE_BYTES:
            raise ValueError("artifactsManifest line exceeds its size limit")
        try:
            entries.append(json.loads(line))
        except ValueError:
            raise ValueError("artifactsManifest must be JSON Lines") from None
    return entries


def _verified_artifacts(root: Path, listed: list[Any], *, reserved: set[str]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    declared: set[str] = set()
    for artifact in listed:
        if not isinstance(artifact, dict) or set(artifact) - {"path", "sha256", "size", "mimeType"}:
            raise ValueError("Invalid container artifact descriptor")
        path = artifact.get("path")
        if not isinstance(path, str):
            raise ValueError("Container artifact requires an output path")
        output_path_parts(path)
        if path in reserved or path in declared:
            raise ValueError("Container artifacts must have distinct output paths")
        declared.add(path)
        checksum, size = artifact.get("sha256"), artifact.get("size")
        if not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum):
            raise ValueError("Container artifact requires a sha256 checksum")
        if type(size) is not int or size < 0:
            raise ValueError("Container artifact requires a nonnegative size")
        mime_type = artifact.get("mimeType", "application/octet-stream")
        if (
            not isinstance(mime_type, str)
            or not mime_type
            or len(mime_type) > MAX_MIME_TYPE_LENGTH
            or any(char in mime_type for char in "\r\n\x00")
        ):
            raise ValueError("Invalid container artifact mimeType")
        with open_output(root, path) as content:
            actual_checksum, actual_size = file_checksum(content)
        if (actual_checksum, actual_size) != (checksum, size):
            raise ValueError("Container output checksum or size mismatch; output may be incomplete")
        artifacts.append({"path": path, "sha256": checksum, "size": size, "mimeType": mime_type})
    return artifacts


def _validated_metrics(metrics: Any) -> list[dict[str, Any]]:
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
    return metrics


def _output_declarations(result: dict[str, Any], declared_paths: set[str]) -> list[dict[str, Any]]:
    """WorkerOutputDeclaration list: `models` are indexed from 0, `datasets` continue after them."""
    models, datasets = result.get("models", []), result.get("datasets", [])
    if not isinstance(models, list) or len(models) > MAX_MODEL_DECLARATIONS:
        raise ValueError(f"result.json models must be a list of at most {MAX_MODEL_DECLARATIONS}")
    if not isinstance(datasets, list) or len(datasets) > MAX_DATASET_DECLARATIONS:
        raise ValueError(f"result.json datasets must be a list of at most {MAX_DATASET_DECLARATIONS}")
    declarations = [
        {"index": index, "kind": "model", **_model_declaration(model, declared_paths)}
        for index, model in enumerate(models)
    ]
    declarations.extend(
        {"index": len(models) + position, "kind": "dataset", **_dataset_declaration(dataset, declared_paths)}
        for position, dataset in enumerate(datasets)
    )
    return declarations


def _model_declaration(model: Any, declared_paths: set[str]) -> dict[str, Any]:
    if not isinstance(model, dict) or set(model) - {"path", "modelId", "metadata"}:
        raise ValueError("Invalid result.json model declaration")
    _require_declared_path(model.get("path"), declared_paths)
    if "modelId" in model:
        _require_text(model["modelId"], "modelId", maximum_length=100)
    _require_json_object(model, "metadata")
    return dict(model)


def _dataset_declaration(dataset: Any, declared_paths: set[str]) -> dict[str, Any]:
    if not isinstance(dataset, dict) or set(dataset) - {
        "datasetId",
        "uri",
        "path",
        "digest",
        "schema",
        "metadata",
    }:
        raise ValueError("Invalid result.json dataset declaration")
    _require_text(dataset.get("datasetId"), "datasetId", maximum_length=100)
    _require_text(dataset.get("digest"), "digest", maximum_length=MAX_DATASET_DIGEST_LENGTH)
    if ("uri" in dataset) == ("path" in dataset):
        raise ValueError("A result.json dataset needs exactly one of uri or path")
    if "path" in dataset:
        _require_declared_path(dataset["path"], declared_paths)
    else:
        _require_text(dataset["uri"], "uri", maximum_length=MAX_DATASET_URI_LENGTH)
    _require_json_object(dataset, "schema")
    _require_json_object(dataset, "metadata")
    return dict(dataset)


def _require_declared_path(path: Any, declared_paths: set[str]) -> None:
    if not isinstance(path, str) or path not in declared_paths:
        raise ValueError("Declared model and dataset paths must be listed output artifacts")


def _require_text(value: Any, name: str, *, maximum_length: int) -> None:
    if not isinstance(value, str) or not value or len(value) > maximum_length or "\x00" in value:
        raise ValueError(f"result.json {name} must be a nonempty string")


def _require_json_object(declaration: dict[str, Any], name: str) -> None:
    if name in declaration and not isinstance(declaration[name], dict):
        raise ValueError(f"result.json {name} must be a JSON object")


def encode_output_index(artifacts: list[dict[str, Any]]) -> bytes:
    """JSON Lines of verified descriptors; its sha256 binds the index to the job state."""
    return b"".join(
        json.dumps(artifact, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        for artifact in artifacts
    )


def parse_output_index(raw: bytes) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for line in raw.splitlines():
        artifact = json.loads(line)
        if (
            not isinstance(artifact, dict)
            or set(artifact) != {"path", "sha256", "size", "mimeType"}
            or not isinstance(artifact["sha256"], str)
            or not SHA256_PATTERN.fullmatch(artifact["sha256"])
            or type(artifact["size"]) is not int
            or artifact["size"] < 0
            or not isinstance(artifact["mimeType"], str)
        ):
            raise ValueError("Output index entry is invalid")
        output_path_parts(artifact["path"])
        artifacts.append(artifact)
    return artifacts


def read_output_index(workspace: Path, results: dict[str, Any]) -> bytes:
    """The index saved by validate_results, checked against the summary in the job state."""
    if "artifacts" in results:
        # A job validated by an earlier runner kept its descriptors inline in the state.
        return encode_output_index(results["artifacts"])
    maximum_bytes = (int(results["artifactCount"]) + 1) * MAX_ARTIFACT_LINE_BYTES
    with open_regular_file(workspace, [OUTPUT_INDEX_FILENAME]) as content:
        raw = content.read(maximum_bytes + 1)
    if len(raw) > maximum_bytes or hashlib.sha256(raw).hexdigest() != results["artifactIndexSha256"]:
        raise ValueError("Output index changed after validation")
    return raw


def finished_results(state: dict[str, Any]) -> dict[str, Any]:
    results = state.get("results")
    if state.get("status") != "finished" or not isinstance(results, dict):
        raise ValueError("Outputs can only be read after successful execution and cleanup")
    return results


def read_output_chunk(workspace: Path, request: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """One bounded chunk of a declared output (the runner's `output` command)."""
    results = finished_results(state)
    artifact = next(
        (
            item
            for item in parse_output_index(read_output_index(workspace, results))
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


def _write_private_file(path: Path, content: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise
