"""Validate WorkerJob snapshots before using them as execution instructions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from ..errors import ConfigurationError

RUN_KINDS = {"inference", "evaluation", "training", "finetuning", "processing"}
TERMINAL_STATUSES = {"finished", "failed", "canceled"}
ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


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

    def validate(self) -> None:
        for entity_name, entity in (
            ("job", self.job),
            ("run", self.run),
            ("target", self.target),
            ("codeVersion", self.code_version),
        ):
            require_uuid(entity["id"], f"{entity_name}.id")
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
        entrypoint = self.code_version["entrypoint"]
        if (
            not entrypoint
            or not isinstance(entrypoint, list)
            or not all(isinstance(value, str) and "\x00" not in value for value in entrypoint)
        ):
            raise ConfigurationError("CodeVersion.entrypoint must be a nonempty argv")
        if self.target["executor"] not in {"local", "ssh"}:
            raise ConfigurationError("Unknown compute executor")
        for name, value in self.code_version["environment"].items():
            if not ENVIRONMENT_NAME.fullmatch(name) or not isinstance(value, str) or "\x00" in value:
                raise ConfigurationError("Invalid CodeVersion environment")
