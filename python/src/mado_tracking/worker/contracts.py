"""Validate WorkerJob snapshots before using them as execution instructions."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from ..errors import ConfigurationError
from ..execution_runtime import RUNTIME_KINDS
from ..execution_snapshot import resolve_execution_snapshot

RUN_KINDS = {"inference", "evaluation", "training", "finetuning", "processing"}
TERMINAL_STATUSES = {"finished", "failed", "canceled"}
ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Job tokens are what the Job's own code authenticates with; the worker token never reaches it.
JOB_TOKEN = re.compile(r"^mmtj_[A-Za-z0-9_-]+$")


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

    @classmethod
    def parse(cls, payload: dict[str, Any]) -> WorkerJob:
        try:
            snapshot = cls(
                payload["job"],
                payload["run"],
                payload["target"],
                payload["codeVersion"],
                payload["modelVersion"],
                payload["inputDatasets"],
                payload.get("jobToken"),
            )
            snapshot.validate()
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

    def validate(self) -> None:
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
        if self.target["executor"] not in {"local", "ssh"}:
            raise ConfigurationError("Unknown compute executor")
        runtime_kinds = self.target.get("runtimeKinds", ["python"])
        if (
            not isinstance(runtime_kinds, list)
            or not runtime_kinds
            or not all(isinstance(kind, str) and kind in RUNTIME_KINDS for kind in runtime_kinds)
            or self.runtime["kind"] not in runtime_kinds
        ):
            raise ConfigurationError("Compute target does not support the CodeVersion runtime")
        for name, value in self.code_version["environment"].items():
            if not ENVIRONMENT_NAME.fullmatch(name) or not isinstance(value, str) or "\x00" in value:
                raise ConfigurationError("Invalid CodeVersion environment")
