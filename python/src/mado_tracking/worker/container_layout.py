"""Prepare only the container's input, context, optional source, and output mounts.

Also places the resume and input checkpoints, which sit under inputs for every runtime, and
exposes the staged input datasets (MMT_INPUT_DATASET_DIRS) to every runtime.
"""

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

from ..checkpoint_archive import extract_checkpoint_archive
from .container_outputs import HASH_CHUNK_BYTES, file_checksum
from .dataset_cache import DatasetCache
from .host_state import write_json

INPUTS_PATH = "/mmt/inputs"
CONTEXT_PATH = "/mmt/context"
OUTPUTS_PATH = "/mmt/outputs"
SOURCE_PATH = "/mmt/source"
WEIGHTS_FILENAME = "weights"
UPSTREAM_RUN_FILENAME = "upstream-run.json"
# The checkpoint is extracted to inputs/checkpoint (read-only /mmt/inputs/checkpoint in a container).
RESUME_CHECKPOINT_DIRECTORY = "checkpoint"
RESUME_CHECKPOINT_FILENAME = "resume-checkpoint.json"
RESUME_CHECKPOINT_ARCHIVE = "checkpoint.tar"
# A checkpoint handed to the code as an input (checkpoint_saved hooks) takes the same place,
# /mmt/inputs/checkpoint. A Job that also resumes keeps that place for its resume checkpoint and
# reads the input checkpoint from inputs/input-checkpoint; MMT_INPUT_CHECKPOINT_DIR names either.
INPUT_CHECKPOINT_FALLBACK_DIRECTORY = "input-checkpoint"
INPUT_CHECKPOINT_FILENAME = "input-checkpoint.json"
INPUT_CHECKPOINT_ARCHIVE = "input-checkpoint.tar"
# The manual trigger payload or webhook body that started the Job (hooks).
TRIGGER_PAYLOAD_FILENAME = "trigger-payload.json"
# Where each staged input file sits in the Job workspace; `upload-<kind>` writes it there.
STAGED_INPUT_PATHS = {
    "source": "source.archive",
    "sif": "runtime.sif",
    "weights": "inputs/weights",
    "checkpoint": RESUME_CHECKPOINT_ARCHIVE,
    "input-checkpoint": INPUT_CHECKPOINT_ARCHIVE,
}
# Containers get each dataset as its own read-only bind. It is not nested below the read-only
# /mmt/inputs bind, whose host directory could not hold the mount points.
INPUT_DATASETS_PATH = "/mmt/datasets"
# Host python reads <workspace>/inputs/datasets/<versionId>, a symlink into the dataset cache.
INPUT_DATASETS_DIRECTORY = "datasets"


@dataclass(frozen=True)
class ContainerMount:
    host_path: Path
    container_path: str
    readonly: bool


def host_runtime(specification: dict[str, Any]) -> dict[str, Any]:
    """The runtime this host executes: the registered one, or the SIF a site converted it to.

    The executionSnapshot keeps the registered runtime either way, so the Run records what was
    registered while the host runs its local equivalent (a Docker image pulled into a SIF).
    """
    converted = specification.get("hostRuntime")
    if converted is not None:
        return dict(converted)
    return dict(specification["codeVersion"].get("runtime") or {"kind": "python"})


def host_environment() -> dict[str, str]:
    # Container variables must not select the CLI binary, daemon, or the host's credentials.
    allowed_names = {"PATH", "HOME", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "TMPDIR"}
    return {name: value for name, value in os.environ.items() if name in allowed_names}


def upstream_run_document(run: dict[str, Any], model_version: dict[str, Any] | None) -> dict[str, Any] | None:
    """Describe the Run whose outputs this Job consumes, or None when it has no upstream.

    The parent Run is the upstream: deferred automation links the training Run and stage
    chaining links the upstream inference Run. WorkerJob carries no snapshot of that Run, so
    only the facts visible from this Run are included and the rest (for example its kind)
    are omitted instead of guessed.
    """
    parent_run_id = run.get("parentRunId")
    if not parent_run_id:
        return None
    if not isinstance(parent_run_id, str):
        raise ValueError("WorkerJob run.parentRunId must be a string")
    document: dict[str, Any] = {"runId": parent_run_id}
    # Only the upstream outputs that this Run takes as inputs; the parent may have produced more.
    upstream_dataset_ids = run.get("upstreamDatasetVersionIds") or []
    if upstream_dataset_ids:
        document["outputDatasetVersionIds"] = list(upstream_dataset_ids)
    if model_version is not None and model_version.get("sourceRunId") == parent_run_id:
        document["outputModelVersionIds"] = [model_version["id"]]
    return document


def upstream_environment(context: dict[str, Any], upstream_run_file: str) -> dict[str, str]:
    # A Job without an upstream gets no variables, so code can test for their presence.
    upstream_run = context.get("upstreamRun")
    if upstream_run is None:
        return {}
    return {"MMT_UPSTREAM_RUN_ID": upstream_run["runId"], "MMT_UPSTREAM_RUN_FILE": upstream_run_file}


def resume_checkpoint_document(checkpoint: dict[str, Any] | None) -> dict[str, Any] | None:
    """What the Job's code reads about its checkpoint (MMT_RESUME_CHECKPOINT_FILE)."""
    if checkpoint is None:
        return None
    manifest = checkpoint["manifest"]
    return {
        "checkpointId": checkpoint["id"],
        "sourceRunId": checkpoint["runId"],
        "step": checkpoint["step"],
        "source": checkpoint["source"],
        "files": manifest["files"],
        "includesOptimizer": bool(manifest.get("includesOptimizer", False)),
        "framework": manifest.get("framework"),
        "metadata": checkpoint.get("metadata", {}),
    }


def resume_checkpoint_environment(
    context: dict[str, Any], *, checkpoint_directory: str, document_file: str
) -> dict[str, str]:
    # A Job that starts from scratch gets no variables, so code can test for their presence.
    document = context.get("resumeCheckpoint")
    if document is None:
        return {}
    return {
        "MMT_RESUME_CHECKPOINT_DIR": checkpoint_directory,
        "MMT_RESUME_STEP": str(document["step"]),
        "MMT_RESUME_CHECKPOINT_FILE": document_file,
    }


def input_checkpoint_directory(context: dict[str, Any]) -> str:
    """Directory under inputs that holds the input checkpoint (see INPUT_CHECKPOINT_FALLBACK_DIRECTORY)."""
    if context.get("resumeCheckpoint") is not None:
        return INPUT_CHECKPOINT_FALLBACK_DIRECTORY
    return RESUME_CHECKPOINT_DIRECTORY


def input_checkpoint_environment(
    context: dict[str, Any], *, inputs_directory: str, document_file: str
) -> dict[str, str]:
    # A Job without an input checkpoint gets no variables, so code can test for their presence.
    if context.get("inputCheckpoint") is None:
        return {}
    return {
        "MMT_INPUT_CHECKPOINT_DIR": f"{inputs_directory}/{input_checkpoint_directory(context)}",
        "MMT_INPUT_CHECKPOINT_FILE": document_file,
    }


def trigger_payload_environment(context: dict[str, Any], *, document_file: str) -> dict[str, str]:
    if context.get("triggerPayload") is None:
        return {}
    return {"MMT_TRIGGER_PAYLOAD_FILE": document_file}


def staged_dataset_paths(workspace: Path, specification: dict[str, Any]) -> dict[str, Path] | None:
    """Target paths of the staged input datasets, checked again right before launch.

    None for a specification saved before datasets were staged; such a Job gets no
    MMT_INPUT_DATASET_DIRS rather than an empty mapping that would claim nothing is staged.
    """
    staged = specification.get("stagedInputs", {}).get("datasets")
    if staged is None:
        return None
    # Descriptor-only versions (urn:, mmt-artifact:) have nothing staged and are left out.
    if not set(staged) <= {dataset["id"] for dataset in specification["context"]["inputDatasets"]}:
        raise ValueError("Staged datasets are not the Job's inputs")
    cache = DatasetCache.for_workspace(workspace)
    paths = {}
    for version_id, entry in staged.items():
        path = Path(entry["path"])
        key = entry.get("key")
        if key is not None and (path != cache.data_path(key) or not cache.is_complete(key)):
            raise ValueError(f"Input dataset cache entry is incomplete: {version_id}")
        if not path.exists():
            raise ValueError(f"Input dataset path is missing on the target: {version_id}")
        paths[version_id] = path
    return paths


def link_input_datasets(workspace: Path, paths: dict[str, Path]) -> dict[str, str]:
    """Symlink each dataset under inputs/datasets for host python; returns MMT_INPUT_DATASET_DIRS."""
    directory = workspace / "inputs" / INPUT_DATASETS_DIRECTORY
    if directory.parent.is_symlink() or directory.is_symlink():
        raise ValueError("Input dataset directory must not be a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    links = {}
    for version_id, path in paths.items():
        link = directory / version_id
        link.unlink(missing_ok=True)
        link.symlink_to(path, target_is_directory=path.is_dir())
        links[version_id] = str(link)
    return links


def install_resume_checkpoint(workspace: Path, specification: dict[str, Any]) -> None:
    """Extract the staged checkpoint tar, verifying it again on the target, as read-only files."""
    _install_checkpoint(
        workspace,
        specification,
        document_key="resumeCheckpoint",
        staged_key="checkpoint",
        archive_name=RESUME_CHECKPOINT_ARCHIVE,
        directory_name=RESUME_CHECKPOINT_DIRECTORY,
        label="Resume checkpoint",
    )


def install_input_checkpoint(workspace: Path, specification: dict[str, Any]) -> None:
    """Extract the staged input checkpoint the same way, beside a resume checkpoint if any."""
    _install_checkpoint(
        workspace,
        specification,
        document_key="inputCheckpoint",
        staged_key="inputCheckpoint",
        archive_name=INPUT_CHECKPOINT_ARCHIVE,
        directory_name=input_checkpoint_directory(specification["context"]),
        label="Input checkpoint",
    )


def _install_checkpoint(
    workspace: Path,
    specification: dict[str, Any],
    *,
    document_key: str,
    staged_key: str,
    archive_name: str,
    directory_name: str,
    label: str,
) -> None:
    document = specification["context"].get(document_key)
    if document is None:
        return
    archive = workspace / archive_name
    expected = specification.get("stagedInputs", {}).get(staged_key)
    if expected is None or not archive.exists():
        raise ValueError(f"{label} was not staged")
    verify_staged_file(archive, expected)
    inputs = workspace / "inputs"
    if inputs.is_symlink():
        raise ValueError("Container mount directory must not be a symlink")
    inputs.mkdir(mode=0o700, exist_ok=True)
    extract_checkpoint_archive(archive, inputs / directory_name, document["files"])
    archive.unlink()


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
    # A spec saved before upstream inputs existed has no upstreamRun key.
    if context.get("upstreamRun") is not None:
        context_files[UPSTREAM_RUN_FILENAME] = context["upstreamRun"]
    if context.get("resumeCheckpoint") is not None:
        context_files[RESUME_CHECKPOINT_FILENAME] = context["resumeCheckpoint"]
    if context.get("inputCheckpoint") is not None:
        context_files[INPUT_CHECKPOINT_FILENAME] = context["inputCheckpoint"]
    if context.get("triggerPayload") is not None:
        context_files[TRIGGER_PAYLOAD_FILENAME] = context["triggerPayload"]
    for name, document in context_files.items():
        write_json(workspace / "context" / name, document)
    if specification["codeVersion"]["source"] is not None:
        mounts.append(ContainerMount(workspace / "source", SOURCE_PATH, True))
    for version_id, path in (staged_dataset_paths(workspace, specification) or {}).items():
        mounts.append(ContainerMount(path, f"{INPUT_DATASETS_PATH}/{version_id}", True))
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
    runtime = host_runtime(specification)
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
        MMT_EXECUTION_MODE=specification["executionSnapshot"]["mode"],
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
    environment.update(upstream_environment(context, f"{CONTEXT_PATH}/{UPSTREAM_RUN_FILENAME}"))
    staged_datasets = specification.get("stagedInputs", {}).get("datasets")
    if staged_datasets is not None:
        environment["MMT_INPUT_DATASET_DIRS"] = json.dumps(
            {version_id: f"{INPUT_DATASETS_PATH}/{version_id}" for version_id in staged_datasets}
        )
    environment.update(
        resume_checkpoint_environment(
            context,
            checkpoint_directory=f"{INPUTS_PATH}/{RESUME_CHECKPOINT_DIRECTORY}",
            document_file=f"{CONTEXT_PATH}/{RESUME_CHECKPOINT_FILENAME}",
        )
    )
    environment.update(
        input_checkpoint_environment(
            context, inputs_directory=INPUTS_PATH, document_file=f"{CONTEXT_PATH}/{INPUT_CHECKPOINT_FILENAME}"
        )
    )
    environment.update(
        trigger_payload_environment(context, document_file=f"{CONTEXT_PATH}/{TRIGGER_PAYLOAD_FILENAME}")
    )
    # A Docker-selected GPU UUID/index is remapped to a container-local CUDA ordinal.
    gpu_ids = specification["gpuIds"]
    runtime_kind = host_runtime(specification).get("kind")
    environment["CUDA_VISIBLE_DEVICES"] = (
        ",".join(str(index) for index in range(len(gpu_ids)))
        if runtime_kind == "docker"
        else ",".join(gpu_ids)
    )
    environment["NVIDIA_VISIBLE_DEVICES"] = ",".join(gpu_ids) if gpu_ids else "void"
    environment["NVIDIA_DRIVER_CAPABILITIES"] = "compute,utility"
    return environment
