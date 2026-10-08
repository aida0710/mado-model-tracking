"""CodeVersion runtime types and validation shared by the SDK and compute runner."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any, Literal, NotRequired, TypedDict

ExecutionRuntimeKind = Literal["python", "docker", "singularity", "apptainer"]
RUNTIME_KINDS = {"python", "docker", "singularity", "apptainer"}
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DOCKER_IMAGE_PATTERN = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")


class PythonRuntime(TypedDict):
    kind: Literal["python"]


class DockerRuntime(TypedDict):
    kind: Literal["docker"]
    image: str
    workingDirectory: NotRequired[str]


class SifRuntime(TypedDict):
    kind: Literal["singularity", "apptainer"]
    artifactId: str
    sha256: str
    workingDirectory: NotRequired[str]


ExecutionRuntime = PythonRuntime | DockerRuntime | SifRuntime


def validate_entrypoint(entrypoint: Sequence[str]) -> None:
    if (
        isinstance(entrypoint, (str, bytes))
        or not entrypoint
        or not all(isinstance(value, str) and value and "\x00" not in value for value in entrypoint)
    ):
        raise ValueError("CodeVersion.entrypoint must be a nonempty argv")


def validate_runtime(
    runtime: Mapping[str, Any] | None,
    *,
    source: Mapping[str, Any] | None,
    requirements: Sequence[str],
) -> dict[str, Any]:
    definition = dict(runtime) if runtime is not None else {"kind": "python"}
    kind = definition.get("kind")
    if kind not in RUNTIME_KINDS:
        raise ValueError("Unknown CodeVersion runtime")
    if kind == "python":
        if source is None:
            raise ValueError("Python runtime requires a CodeVersion source")
        if set(definition) != {"kind"}:
            raise ValueError("Python runtime does not accept container settings")
        return definition
    if requirements:
        raise ValueError("Container requirements must be installed in the image")
    directory = definition.get("workingDirectory")
    if directory is not None and (
        not isinstance(directory, str)
        or not directory.startswith("/")
        or ".." in PurePosixPath(directory).parts
        or any(character in directory for character in "\x00\r\n")
    ):
        raise ValueError("Runtime workingDirectory must be an absolute container path")
    if kind == "docker":
        image = definition.get("image")
        if not isinstance(image, str) or not DOCKER_IMAGE_PATTERN.fullmatch(image) or image.startswith("-"):
            raise ValueError("Docker image must be pinned to a sha256 digest")
        allowed_fields = {"kind", "image", "workingDirectory"}
    else:
        artifact_id, checksum = definition.get("artifactId"), definition.get("sha256")
        if not isinstance(artifact_id, str) or not artifact_id:
            raise ValueError("SIF runtime requires a saved Artifact ID")
        if not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum):
            raise ValueError("SIF runtime requires a sha256 checksum")
        allowed_fields = {"kind", "artifactId", "sha256", "workingDirectory"}
    if set(definition) - allowed_fields:
        raise ValueError("Unknown container runtime settings")
    return definition
