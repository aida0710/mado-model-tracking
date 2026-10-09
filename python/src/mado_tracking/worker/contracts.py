"""Validate WorkerJob snapshots before using them as execution instructions."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from ..checkpoint_archive import is_safe_relative_path
from ..errors import ConfigurationError
from ..execution_runtime import RUNTIME_KINDS
from ..execution_snapshot import resolve_execution_snapshot

RUN_KINDS = {"inference", "evaluation", "training", "finetuning", "processing"}
TERMINAL_STATUSES = {"finished", "failed", "canceled"}
# The worker drives ssh/local targets; a site's runner (mado_tracking.site) parses site Jobs.
WORKER_EXECUTORS = frozenset({"local", "ssh"})
SITE_EXECUTORS = frozenset({"site"})
SIF_RUNTIME_KINDS = frozenset({"singularity", "apptainer"})
# The Run tag the API sets on a Job started for a saved checkpoint (checkpoint_saved hooks).
INPUT_CHECKPOINT_TAG = "mmt.inputCheckpointId"
ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Job tokens are what the Job's own code authenticates with; the worker token never reaches it.
JOB_TOKEN = re.compile(r"^mmtj_[A-Za-z0-9_-]+$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
# An 'artifacts' DatasetVersion's digest is the server-computed manifest digest.
MANIFEST_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
DATASET_TRANSFERS = {"relay", "direct"}


def require_uuid(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ConfigurationError(f"{field} must be a UUID")
    try:
        UUID(value)
    except ValueError:
        raise ConfigurationError(f"{field} must be a UUID") from None
    return value


@dataclass(frozen=True)
class WorkerJob:
    job: dict[str, Any]
    run: dict[str, Any]
    target: dict[str, Any]
    code_version: dict[str, Any]
    model_version: dict[str, Any] | None
    input_datasets: list[dict[str, Any]]
    # Only claim/resume of a not-yet-started Job carries one; the journal keeps it afterwards.
    job_token: str | None = field(default=None, repr=False)
    # The checkpoint the Run continues from; staged and verified before the entrypoint starts.
    resume_checkpoint: dict[str, Any] | None = None
    # A checkpoint handed to the code as an input (checkpoint_saved hooks); not a resume.
    input_checkpoint: dict[str, Any] | None = None
    # The manual trigger payload or webhook body of the hook start (trigger-payload.json).
    trigger_payload: dict[str, Any] | None = None

    @classmethod
    def parse(cls, payload: dict[str, Any], *, executors: frozenset[str] = WORKER_EXECUTORS) -> WorkerJob:
        try:
            snapshot = cls(
                payload["job"],
                payload["run"],
                payload["target"],
                payload["codeVersion"],
                payload["modelVersion"],
                payload["inputDatasets"],
                payload.get("jobToken"),
                payload.get("resumeCheckpoint"),
                payload.get("inputCheckpoint"),
                payload.get("triggerPayload"),
            )
            snapshot.validate(executors=executors)
        except (KeyError, TypeError, AttributeError):
            raise ConfigurationError("API returned an incomplete WorkerJob") from None
        return snapshot

    @property
    def id(self) -> str:
        return str(self.job["id"])

    @property
    def lease_id(self) -> str:
        return str(self.job["leaseId"])

    @property
    def runtime(self) -> dict[str, Any]:
        return dict(self.execution_snapshot["runtime"])

    @property
    def execution_snapshot(self) -> dict[str, Any]:
        try:
            return resolve_execution_snapshot(self.code_version, self.run)
        except ValueError as error:
            raise ConfigurationError(str(error)) from None

    def validate(self, *, executors: frozenset[str] = WORKER_EXECUTORS) -> None:
        for entity_name, entity in (
            ("job", self.job),
            ("run", self.run),
            ("target", self.target),
            ("codeVersion", self.code_version),
        ):
            require_uuid(entity["id"], f"{entity_name}.id")
        if self.job_token is not None and (
            not isinstance(self.job_token, str) or not JOB_TOKEN.fullmatch(self.job_token)
        ):
            raise ConfigurationError("WorkerJob has an invalid job token")
        if not isinstance(self.job.get("leaseId"), str) or not self.job["leaseId"]:
            raise ConfigurationError("WorkerJob has no lease")
        if self.job["status"] not in {"claimed", "running"}:
            raise ConfigurationError("WorkerJob is not executable")
        if (
            self.job["runId"] != self.run["id"]
            or self.job["targetId"] != self.target["id"]
            or self.run["codeVersionId"] != self.code_version["id"]
        ):
            raise ConfigurationError("WorkerJob references do not match the pinned versions")
        project_id = require_uuid(self.job["projectId"], "job.projectId")
        if self.run["projectId"] != project_id or self.code_version["projectId"] != project_id:
            raise ConfigurationError("WorkerJob references cross project boundaries")
        kind = self.run["kind"]
        if kind not in RUN_KINDS or kind not in self.code_version["taskTypes"]:
            raise ConfigurationError("CodeVersion does not support the Run kind")
        if self.model_version is not None:
            if (
                self.model_version["projectId"] != project_id
                or self.model_version["id"] != self.run["modelVersionId"]
                or self.model_version["family"] not in self.code_version["supportedModelFamilies"]
            ):
                raise ConfigurationError("CodeVersion does not support the pinned ModelVersion")
        elif self.run["modelVersionId"] is not None:
            raise ConfigurationError("Pinned ModelVersion was not supplied")
        dataset_ids = []
        for dataset in self.input_datasets:
            require_uuid(dataset["id"], "inputDataset.id")
            if dataset["projectId"] != project_id:
                raise ConfigurationError("Input DatasetVersion is outside the project")
            validate_dataset_content(dataset)
            dataset_ids.append(dataset["id"])
        if sorted(dataset_ids) != sorted(self.run["inputDatasetVersionIds"]):
            raise ConfigurationError("Pinned DatasetVersions were not supplied")
        gpu_ids = self.job["gpuIds"]
        if not isinstance(gpu_ids, list) or not all(isinstance(value, str) for value in gpu_ids):
            raise ConfigurationError("gpuIds must be a list of strings")
        if not set(gpu_ids).issubset(self.target["gpuIds"]):
            raise ConfigurationError("Job requests GPUs outside the compute target")
        snapshot = self.execution_snapshot
        if "runtime" in self.run and self.run["runtime"] != snapshot["runtime"]:
            raise ConfigurationError("Run.runtime does not match its immutable executionSnapshot")
        if self.target["executor"] not in executors:
            raise ConfigurationError("Unknown compute executor")
        validate_target_dataset_settings(self.target)
        runtime_kinds = self.target.get("runtimeKinds", ["python"])
        if (
            not isinstance(runtime_kinds, list)
            or not runtime_kinds
            or not all(isinstance(kind, str) and kind in RUNTIME_KINDS for kind in runtime_kinds)
            or not target_runs_runtime(self.target["executor"], runtime_kinds, self.runtime["kind"])
        ):
            raise ConfigurationError("Compute target does not support the CodeVersion runtime")
        for name, value in self.code_version["environment"].items():
            if not ENVIRONMENT_NAME.fullmatch(name) or not isinstance(value, str) or "\x00" in value:
                raise ConfigurationError("Invalid CodeVersion environment")
        if self.resume_checkpoint is not None:
            validate_resume_checkpoint(self.resume_checkpoint, run=self.run)
        if self.input_checkpoint is not None:
            validate_input_checkpoint(self.input_checkpoint, run=self.run)
        if self.trigger_payload is not None and not isinstance(self.trigger_payload, dict):
            raise ConfigurationError("WorkerJob triggerPayload must be a JSON object")


def target_runs_runtime(executor: str, runtime_kinds: list[str], runtime_kind: str) -> bool:
    """A target runs its registered runtimes; a site also runs a Docker image as a converted SIF."""
    if executor != "site":
        return runtime_kind in runtime_kinds
    if runtime_kind == "python":
        return False
    if runtime_kind == "docker":
        return "docker" in runtime_kinds or bool(SIF_RUNTIME_KINDS & set(runtime_kinds))
    return runtime_kind in runtime_kinds


def _is_positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_dataset_content(dataset: dict[str, Any]) -> None:
    """What the worker needs to fetch and verify a version (absent from APIs before W4 content)."""
    content_kind = dataset.get("contentKind")
    if content_kind is None:
        return
    if content_kind == "artifacts":
        file_count = dataset.get("fileCount")
        if (
            not isinstance(dataset.get("digest"), str)
            or not MANIFEST_DIGEST.fullmatch(dataset["digest"])
            or not isinstance(dataset.get("datasetId"), str)
            or not isinstance(file_count, int)
            or isinstance(file_count, bool)
            or file_count < 0
        ):
            raise ConfigurationError("Input DatasetVersion has an invalid artifacts manifest")
        require_uuid(dataset["datasetId"], "inputDataset.datasetId")
    elif content_kind == "reference":
        if not isinstance(dataset.get("uri"), str) or not isinstance(dataset.get("digest"), str):
            raise ConfigurationError("Input DatasetVersion reference needs a uri and digest")
    else:
        raise ConfigurationError("Input DatasetVersion has an unknown contentKind")


def validate_target_dataset_settings(target: dict[str, Any]) -> None:
    # Both are optional so that an API from before the setting existed keeps working.
    if target.get("datasetTransfer", "relay") not in DATASET_TRANSFERS:
        raise ConfigurationError("Compute target has an unknown datasetTransfer")
    if "datasetCacheMaxBytes" in target and not _is_positive_integer(target["datasetCacheMaxBytes"]):
        raise ConfigurationError("Compute target datasetCacheMaxBytes must be a positive integer")


def _is_file_entry(entry: Any) -> bool:
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("path"), str)
        and is_safe_relative_path(entry["path"])
        and isinstance(entry.get("sha256"), str)
        and SHA256.fullmatch(entry["sha256"]) is not None
        and isinstance(entry.get("size"), int)
        and not isinstance(entry["size"], bool)
        and entry["size"] >= 0
    )


def validate_resume_checkpoint(checkpoint: dict[str, Any], *, run: dict[str, Any]) -> None:
    """The checkpoint must be the one pinned to the Run, with Artifacts the worker can verify."""
    _validate_checkpoint_files(checkpoint, label="resumeCheckpoint")
    if checkpoint["id"] != run.get("resumeCheckpointId"):
        raise ConfigurationError("WorkerJob resumeCheckpoint is not the Run's pinned checkpoint")


def validate_input_checkpoint(checkpoint: dict[str, Any], *, run: dict[str, Any]) -> None:
    """An input checkpoint is verifiable like a resume one; the Run's tag, when set, names it."""
    _validate_checkpoint_files(checkpoint, label="inputCheckpoint")
    tagged = (run.get("tags") or {}).get(INPUT_CHECKPOINT_TAG)
    if tagged is not None and tagged != checkpoint["id"]:
        raise ConfigurationError("WorkerJob inputCheckpoint is not the checkpoint the Run was started for")


def _validate_checkpoint_files(checkpoint: dict[str, Any], *, label: str) -> None:
    if not isinstance(checkpoint, dict):
        raise ConfigurationError(f"WorkerJob {label} must be an object")
    require_uuid(checkpoint.get("id"), f"{label}.id")
    require_uuid(checkpoint.get("runId"), f"{label}.runId")
    step = checkpoint.get("step")
    if isinstance(step, bool) or not isinstance(step, int) or step < 0:
        raise ConfigurationError(f"{label}.step must be a non-negative integer")
    source, artifacts = checkpoint.get("source"), checkpoint.get("artifacts")
    if source not in {"native", "mlflow"} or not isinstance(artifacts, list) or not artifacts:
        raise ConfigurationError(f"{label} has an unknown source or no Artifacts")
    if source == "native" and len(artifacts) != 1:
        raise ConfigurationError("A native checkpoint is exactly one archive Artifact")
    for artifact in artifacts:
        if not _is_file_entry(artifact):
            raise ConfigurationError(f"{label} has an invalid Artifact")
        require_uuid(artifact.get("id"), f"{label}.artifacts.id")
    manifest = checkpoint.get("manifest")
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list) or not files or not all(_is_file_entry(file) for file in files):
        raise ConfigurationError(f"{label} has an invalid manifest")
    if source == "mlflow" and sorted((a["path"], a["sha256"], a["size"]) for a in artifacts) != sorted(
        (file["path"], file["sha256"], file["size"]) for file in files
    ):
        raise ConfigurationError("MLflow checkpoint Artifacts do not match its manifest")
    if not isinstance(checkpoint.get("metadata", {}), dict):
        raise ConfigurationError(f"{label}.metadata must be an object")
