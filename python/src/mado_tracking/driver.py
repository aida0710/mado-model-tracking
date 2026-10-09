"""Driver Jobs: a Job's code starts child Jobs with its own Job token.

The parent Job must have been created with allowChildJobs. Its code finds its Project and Job in
MMT_PROJECT_ID and MMT_JOB_ID, and its Job token in MMT_API_TOKEN, so `Client()` is enough. Each
child is created with an idempotency key: a driver that restarts gets back the children it
already made instead of starting them twice.

    spec = ChildJobSpec(name="shard", kind="processing", code_version_id=..., target_id=...)
    jobs = map_shards(client, spec, [{"shard": i} for i in range(64)], key="generate-v1")
"""

from __future__ import annotations

import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

# Mirrors CHILD_JOB_WAIT_MAX_SECONDS: one wait request lasts at most this long.
CHILD_JOB_WAIT_MAX_SECONDS = 60
MAX_IDEMPOTENCY_KEY_LENGTH = 200


@dataclass(frozen=True)
class ChildJobSpec:
    """What one child is (ChildJobCreate without its key); unset options take the API's defaults."""

    name: str
    kind: str
    code_version_id: str
    target_id: str
    experiment_id: str | None = None
    model_version_id: str | None = None
    input_dataset_version_ids: Sequence[str] = ()
    parameters: Mapping[str, Any] = field(default_factory=dict)
    tags: Mapping[str, str] = field(default_factory=dict)
    gpu_ids: Sequence[str] = ()
    gpu_count: int | None = None
    walltime_seconds: int | None = None
    array_size: int | None = None
    dataset_partition_version_id: str | None = None
    max_attempts: int | None = None
    retry_on_failure: bool | None = None
    retry_on_timeout: bool | None = None
    allow_child_jobs: bool | None = None

    def body(self, idempotency_key: str) -> dict[str, Any]:
        if not idempotency_key or len(idempotency_key) > MAX_IDEMPOTENCY_KEY_LENGTH:
            raise ConfigurationError(f"A child Job key is 1 to {MAX_IDEMPOTENCY_KEY_LENGTH} characters")
        body: dict[str, Any] = {
            "idempotencyKey": idempotency_key,
            "name": self.name,
            "kind": self.kind,
            "codeVersionId": self.code_version_id,
            "targetId": self.target_id,
            "parameters": dict(self.parameters),
            "tags": dict(self.tags),
        }
        optional = {
            "experimentId": self.experiment_id,
            "modelVersionId": self.model_version_id,
            "inputDatasetVersionIds": list(self.input_dataset_version_ids) or None,
            "gpuIds": list(self.gpu_ids) or None,
            "gpuCount": self.gpu_count,
            "walltimeSeconds": self.walltime_seconds,
            "arraySize": self.array_size,
            "datasetPartitionVersionId": self.dataset_partition_version_id,
            "maxAttempts": self.max_attempts,
            "retryOnFailure": self.retry_on_failure,
            "retryOnTimeout": self.retry_on_timeout,
            "allowChildJobs": self.allow_child_jobs,
        }
        # Left out when unset, so the API applies its own defaults (and the parent's experiment).
        body.update({name: value for name, value in optional.items() if value is not None})
        return body


def driver_job(project_id: str | None = None, parent_job_id: str | None = None) -> tuple[str, str]:
    """The Project and the driver's own Job: the arguments, else MMT_PROJECT_ID and MMT_JOB_ID."""
    project = project_id or os.environ.get("MMT_PROJECT_ID")
    job = parent_job_id or os.environ.get("MMT_JOB_ID")
    if not project or not job:
        raise ConfigurationError("Driver calls need MMT_PROJECT_ID and MMT_JOB_ID (run them inside a Job)")
    return project, job


def _children_path(client: Client, project_id: str, job_id: str, resource: str = "") -> str:
    return client.project_path(
        project_id, f"jobs/{path_id(job_id)}/children" + (f"/{resource}" if resource else "")
    )


def submit_child_job(
    client: Client,
    spec: ChildJobSpec,
    *,
    key: str,
    project_id: str | None = None,
    parent_job_id: str | None = None,
) -> dict[str, Any]:
    """Create a child Job (or an array when spec.array_size is set); returns ChildJobCreated.

    `created` is false when the key was used before: the response then names what the first
    request created, so resending after a lost answer or a restart is safe.
    """
    project, job = driver_job(project_id, parent_job_id)
    return client.request("POST", _children_path(client, project, job), json=spec.body(key), retryable=True)


def list_child_jobs(
    client: Client, *, project_id: str | None = None, parent_job_id: str | None = None
) -> list[dict[str, Any]]:
    project, job = driver_job(project_id, parent_job_id)
    items = client.request("GET", _children_path(client, project, job), retryable=True).get("items")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ConfigurationError("Child Job list response must contain items")
    return items


def wait_for_child_jobs(
    client: Client,
    *,
    timeout_seconds: float | None = None,
    project_id: str | None = None,
    parent_job_id: str | None = None,
) -> dict[str, Any]:
    """Wait until every child has ended (or timeout_seconds passed); returns ChildJobWait.

    Each request is one long poll of at most CHILD_JOB_WAIT_MAX_SECONDS, so a driver waiting for
    hours keeps no request open longer than that.
    """
    project, job = driver_job(project_id, parent_job_id)
    deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
    while True:
        remaining = CHILD_JOB_WAIT_MAX_SECONDS if deadline is None else deadline - time.monotonic()
        seconds = max(1, min(CHILD_JOB_WAIT_MAX_SECONDS, int(remaining)))
        waited = client.request(
            "GET",
            _children_path(client, project, job, "wait"),
            params={"timeoutSeconds": str(seconds)},
            retryable=True,
            # The server holds the request up to `seconds`; the client allows a little more.
            timeout=seconds + CHILD_JOB_WAIT_MAX_SECONDS / 2,
        )
        if waited.get("done") is True or (deadline is not None and time.monotonic() >= deadline):
            return waited


def map_shards(
    client: Client,
    spec: ChildJobSpec,
    shards: Sequence[Mapping[str, Any]],
    *,
    key: str,
    wait: bool = True,
    timeout_seconds: float | None = None,
    project_id: str | None = None,
    parent_job_id: str | None = None,
) -> list[dict[str, Any]]:
    """One child per shard, its parameters updated with the shard's; keys are `<key>:<index>`.

    With wait=True the call returns once every child has ended. The returned Jobs are the
    children's current state, in shard order (an array child contributes all its members).
    """
    project, job = driver_job(project_id, parent_job_id)
    created_ids: list[str] = []
    for index, shard in enumerate(shards):
        child = replace(spec, name=f"{spec.name}-{index}", parameters={**spec.parameters, **dict(shard)})
        created = submit_child_job(client, child, key=f"{key}:{index}", project_id=project, parent_job_id=job)
        created_ids.extend(str(item["id"]) for item in created.get("jobs", []))
    if wait:
        wait_for_child_jobs(client, timeout_seconds=timeout_seconds, project_id=project, parent_job_id=job)
    current = {
        str(item["id"]): item for item in list_child_jobs(client, project_id=project, parent_job_id=job)
    }
    return [current[job_id] for job_id in created_ids if job_id in current]
