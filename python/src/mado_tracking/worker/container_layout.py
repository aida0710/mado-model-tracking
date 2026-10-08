"""Prepare only the container's input, context, optional source, and output mounts."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from .container_outputs import HASH_CHUNK_BYTES, file_checksum
from .host_state import write_json

INPUTS_PATH = "/mmt/inputs"
CONTEXT_PATH = "/mmt/context"
OUTPUTS_PATH = "/mmt/outputs"
SOURCE_PATH = "/mmt/source"
WEIGHTS_FILENAME = "weights"


@dataclass(frozen=True)
class ContainerMount:
    host_path: Path
    container_path: str
    readonly: bool


def host_environment() -> dict[str, str]:
    # Container variables must not select the CLI binary, daemon, or the host's credentials.
    allowed_names = {"PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "TMPDIR"}
    return {name: value for name, value in os.environ.items() if name in allowed_names}


def prepare_container_layout(workspace: Path, specification: dict[str, Any]) -> list[ContainerMount]:
    mounts = []
    for name, container_path, readonly in (
        ("inputs", INPUTS_PATH, True),
        ("context", CONTEXT_PATH, True),
        ("outputs", OUTPUTS_PATH, False),
    ):
        directory = workspace / name
        if directory.is_symlink():
            raise ValueError("Container mount directory must not be a symlink")
        directory.mkdir(mode=0o700, exist_ok=True)
        mounts.append(ContainerMount(directory, container_path, readonly))
    context = specification["context"]
    context_files = {
        "context.json": context,
        "parameters.json": context["parameters"],
        "model-version.json": {"modelVersion": context["modelVersion"]},
        "dataset-versions.json": {"inputDatasets": context["inputDatasets"]},
    }
    for name, document in context_files.items():
        write_json(workspace / "context" / name, document)
    if specification["codeVersion"]["source"] is not None:
        mounts.append(ContainerMount(workspace / "source", SOURCE_PATH, True))
    return mounts


def stage_local_weights(workspace: Path, model_version: dict[str, Any]) -> None:
    uri = urlsplit(model_version.get("weightsUri") or "")
    if uri.scheme != "file" or uri.netloc not in {"", "localhost"} or uri.query or uri.fragment:
        raise ValueError("Input weights require a staged Artifact, HTTP(S) download, or local file:// URI")
    source_path = Path(unquote(uri.path))
    if not source_path.is_absolute() or source_path.is_symlink():
        raise ValueError("Local input weights must be an absolute regular file")
    descriptor = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    destination = workspace / "inputs" / WEIGHTS_FILENAME
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Local input weights must be a regular file")
        temporary_descriptor, temporary = tempfile.mkstemp(dir=destination.parent)
        try:
            with os.fdopen(temporary_descriptor, "wb") as output:
                shutil.copyfileobj(source, output, length=HASH_CHUNK_BYTES)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)


def verify_container_inputs(workspace: Path, specification: dict[str, Any]) -> None:
    model_version = specification["context"]["modelVersion"]
    if model_version is not None:
        weights = workspace / "inputs" / WEIGHTS_FILENAME
        expected = specification.get("stagedInputs", {}).get("weights")
        if not weights.exists() and not model_version.get("artifactId") and expected is None:
            stage_local_weights(workspace, model_version)
        verify_staged_file(weights, expected)
        weights.chmod(0o400)
    runtime = specification["codeVersion"].get("runtime", {"kind": "python"})
    if runtime["kind"] in {"singularity", "apptainer"}:
        verify_staged_file(workspace / "runtime.sif", {"sha256": runtime["sha256"]})
        (workspace / "runtime.sif").chmod(0o400)


def verify_staged_file(path: Path, expected: dict[str, Any] | None) -> None:
    if path.is_symlink():
        raise ValueError("Staged inputs must not be symlinks")
    with path.open("rb") as content:
        if not stat.S_ISREG(os.fstat(content.fileno()).st_mode):
            raise ValueError("Staged inputs must be regular files")
        checksum, size = file_checksum(content)
    if expected is not None and (
        checksum != expected["sha256"] or "size" in expected and size != expected["size"]
    ):
        raise ValueError("Staged input sha256 or size mismatch")


def container_environment(specification: dict[str, Any]) -> dict[str, str]:
    context = specification["context"]
    environment = dict(specification["codeVersion"]["environment"])
    environment.update(specification["sdkEnvironment"])
    environment.update(
        MMT_JOB_KIND=context["kind"],
        MMT_JOB_CONTEXT_FILE=f"{CONTEXT_PATH}/context.json",
        MMT_PARAMETERS_FILE=f"{CONTEXT_PATH}/parameters.json",
        MMT_MODEL_VERSION_FILE=f"{CONTEXT_PATH}/model-version.json",
        MMT_DATASET_VERSIONS_FILE=f"{CONTEXT_PATH}/dataset-versions.json",
        MMT_PARAMETERS_JSON=json.dumps(context["parameters"]),
        MMT_MODEL_VERSION_ID=str((context["modelVersion"] or {}).get("id", "")),
        MMT_INPUT_DATASET_VERSION_IDS=json.dumps([dataset["id"] for dataset in context["inputDatasets"]]),
        MMT_INPUTS_DIR=INPUTS_PATH,
        MMT_OUTPUTS_DIR=OUTPUTS_PATH,
        MMT_RESULT_FILE=f"{OUTPUTS_PATH}/result.json",
        MMT_SOURCE_DIR=SOURCE_PATH if specification["codeVersion"]["source"] is not None else "",
        MMT_MODEL_FILE=f"{INPUTS_PATH}/{WEIGHTS_FILENAME}" if context["modelVersion"] is not None else "",
        PYTHONUNBUFFERED="1",
    )
    # A Docker-selected GPU UUID/index is remapped to a container-local CUDA ordinal.
    gpu_ids = specification["gpuIds"]
    runtime_kind = specification["codeVersion"].get("runtime", {}).get("kind")
    environment["CUDA_VISIBLE_DEVICES"] = (
        ",".join(str(index) for index in range(len(gpu_ids)))
        if runtime_kind == "docker"
        else ",".join(gpu_ids)
    )
    environment["NVIDIA_VISIBLE_DEVICES"] = ",".join(gpu_ids) if gpu_ids else "void"
    environment["NVIDIA_DRIVER_CAPABILITIES"] = "compute,utility"
    return environment
