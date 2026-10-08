"""SDK operations for editable Task defaults and revision-pinned launches."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import quote

from .errors import ApiError, ConfigurationError
from .execution_snapshot import ExecutionMode, validate_execution_mode

# Match the server's integer revision so a mistaken launch fails before any side effect.
MAX_TASK_REVISION = 2_147_483_647


class _Unset:
    """Distinguish inheriting the Task model from explicitly clearing it with null."""


UNSET = _Unset()


def _validate_revision(revision: int) -> None:
    if type(revision) is not int or not 1 <= revision <= MAX_TASK_REVISION:
        raise ConfigurationError("expected_revision must be a positive Task revision")


def task_output_model(
    *,
    artifact_path: str,
    model_id: str | None = None,
    create_model: Mapping[str, str] | None = None,
    version_template: str | None = None,
    default_code_version_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a Task ``outputModel``: register ``artifact_path`` when a Run of the Task finishes.

    Give either an existing ``model_id`` or ``create_model={"name": ..., "family": ...}``; a Model
    with that name is reused, otherwise created. ``artifact_path`` is a file path in the Run's
    Artifacts (worker outputs are uploaded under ``container/``).
    """
    if (model_id is None) == (create_model is None):
        raise ConfigurationError("Specify exactly one of model_id and create_model")
    if create_model is not None and set(create_model) != {"name", "family"}:
        raise ConfigurationError("create_model requires exactly name and family")
    output_model: dict[str, Any] = {
        "modelId": model_id,
        "createModel": dict(create_model) if create_model is not None else None,
        "artifactPath": artifact_path,
        "defaultCodeVersionId": default_code_version_id,
        "metadata": dict(metadata or {}),
    }
    if version_template is not None:
        output_model["versionTemplate"] = version_template
    return output_model


def _list_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = payload.get("items")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ConfigurationError("Task API list response must contain items")
    return items


class ExperimentTasksClient(ABC):
    @abstractmethod
    def request(self, method: str, path: str, *, retryable: bool = False, **options: Any) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def project_path(self, project_id: str, resource: str = "") -> str:
        raise NotImplementedError

    def _task_path(self, project_id: str, task_id: str, resource: str = "") -> str:
        if not task_id:
            raise ConfigurationError("A Task ID is required")
        path = f"tasks/{quote(task_id, safe='')}"
        return self.project_path(project_id, path + (f"/{resource}" if resource else ""))

    def list_tasks(self, project_id: str, *, experiment_id: str | None = None) -> list[dict[str, Any]]:
        params = {"experimentId": experiment_id} if experiment_id is not None else {}
        return _list_items(
            self.request("GET", self.project_path(project_id, "tasks"), params=params, retryable=True)
        )

    def get_task(self, project_id: str, task_id: str) -> dict[str, Any]:
        return self.request("GET", self._task_path(project_id, task_id), retryable=True)

    def create_task(
        self,
        project_id: str,
        *,
        experiment_id: str,
        name: str,
        kind: str,
        code_version_id: str,
        description: str = "",
        model_version_id: str | None = None,
        input_dataset_version_ids: Sequence[str] = (),
        parameters: Mapping[str, Any] | None = None,
        tags: Mapping[str, str] | None = None,
        target_id: str | None = None,
        gpu_ids: Sequence[str] = (),
        output_model: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a Task. ``output_model`` comes from :func:`task_output_model`."""
        payload: dict[str, Any] = {
            "experimentId": experiment_id,
            "name": name,
            "description": description,
            "kind": kind,
            "codeVersionId": code_version_id,
            "modelVersionId": model_version_id,
            "inputDatasetVersionIds": list(input_dataset_version_ids),
            "parameters": dict(parameters or {}),
            "tags": dict(tags or {}),
            "targetId": target_id,
            "gpuIds": list(gpu_ids),
        }
        if output_model is not None:
            payload["outputModel"] = dict(output_model)
        return self.request("POST", self.project_path(project_id, "tasks"), json=payload)

    def update_task(
        self,
        project_id: str,
        task_id: str,
        *,
        expected_revision: int,
        changes: Mapping[str, Any],
    ) -> dict[str, Any]:
        _validate_revision(expected_revision)
        allowed_fields = {
            "name",
            "description",
            "kind",
            "codeVersionId",
            "modelVersionId",
            "inputDatasetVersionIds",
            "parameters",
            "tags",
            "targetId",
            "gpuIds",
            "outputModel",
        }
        if set(changes) - allowed_fields:
            raise ConfigurationError("Task changes contain unknown or immutable fields")
        return self.request(
            "PATCH",
            self._task_path(project_id, task_id),
            json={**changes, "expectedRevision": expected_revision},
        )

    def launch_task(
        self,
        project_id: str,
        task_id: str,
        *,
        expected_revision: int,
        execution_mode: ExecutionMode = "run",
        target_id: str | None = None,
        gpu_ids: Sequence[str] | None = None,
        name: str | None = None,
        parameters: Mapping[str, Any] | None = None,
        model_version_id: str | None | _Unset = UNSET,
        input_dataset_version_ids: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        _validate_revision(expected_revision)
        try:
            validate_execution_mode(execution_mode)
        except ValueError as error:
            raise ConfigurationError(str(error)) from None
        payload: dict[str, Any] = {"expectedRevision": expected_revision, "executionMode": execution_mode}
        for key, value in (
            ("targetId", target_id),
            ("name", name),
            ("parameters", dict(parameters) if parameters is not None else None),
            ("gpuIds", list(gpu_ids) if gpu_ids is not None else None),
            (
                "inputDatasetVersionIds",
                list(input_dataset_version_ids) if input_dataset_version_ids is not None else None,
            ),
        ):
            if value is not None:
                payload[key] = value
        if not isinstance(model_version_id, _Unset):
            payload["modelVersionId"] = model_version_id
        # A lost launch response must be reconciled through Task runs; replay could start a second Job.
        return self.request("POST", self._task_path(project_id, task_id, "launch"), json=payload)

    def list_task_runs(self, project_id: str, task_id: str) -> list[dict[str, Any]]:
        runs: list[dict[str, Any]] = []
        visited_cursors: set[str] = set()
        params: dict[str, str] = {}
        while True:
            page = self.request(
                "GET", self._task_path(project_id, task_id, "runs"), params=params, retryable=True
            )
            runs.extend(_list_items(page))
            cursor = page.get("nextCursor")
            if cursor is None:
                return runs
            if not isinstance(cursor, str) or not cursor or cursor in visited_cursors:
                raise ConfigurationError("Task runs returned an invalid or repeated pagination cursor")
            visited_cursors.add(cursor)
            params = {"cursor": cursor}

    def get_output_registration(self, project_id: str, run_id: str) -> dict[str, Any] | None:
        """Return the Task-side output model registration of a Run, or None before it is recorded."""
        if not run_id:
            raise ConfigurationError("A Run ID is required")
        path = self.project_path(project_id, f"runs/{quote(run_id, safe='')}/output-registration")
        try:
            return self.request("GET", path, retryable=True)
        except ApiError as error:
            if error.code == "output_registration_not_found":
                return None
            raise
