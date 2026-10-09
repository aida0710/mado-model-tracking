"""Job arrays on a site: one Run and Job per index, submitted together by the site's job shell."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

# Mirrors MAX_JOB_ARRAY_SIZE.
MAX_JOB_ARRAY_SIZE = 10000


def create_job_array(
    client: Client,
    project_id: str,
    *,
    experiment_id: str,
    name: str,
    kind: str,
    code_version_id: str,
    target_id: str,
    size: int,
    model_version_id: str | None = None,
    input_dataset_version_ids: Sequence[str] = (),
    parameters: Mapping[str, Any] | None = None,
    tags: Mapping[str, str] | None = None,
    gpu_count: int | None = None,
    walltime_seconds: int | None = None,
    max_attempts: int | None = None,
    retry_on_failure: bool | None = None,
    retry_on_timeout: bool | None = None,
    allow_child_jobs: bool | None = None,
    dataset_partition_version_id: str | None = None,
) -> dict[str, Any]:
    """POST /projects/:p/job-arrays; returns JobArrayCreated {arrayGroup, jobs}.

    `dataset_partition_version_id` names an input version whose files are split among the members
    (member i reads the files at positions p with p % size == i, in path order). Not retried: a
    resent create would start a second array.
    """
    if type(size) is not int or not 1 <= size <= MAX_JOB_ARRAY_SIZE:
        raise ConfigurationError(f"size must be an integer from 1 to {MAX_JOB_ARRAY_SIZE}")
    body: dict[str, Any] = {
        "experimentId": experiment_id,
        "name": name,
        "kind": kind,
        "codeVersionId": code_version_id,
        "targetId": target_id,
        "size": size,
        "modelVersionId": model_version_id,
        "inputDatasetVersionIds": list(input_dataset_version_ids),
        "parameters": dict(parameters or {}),
        "tags": dict(tags or {}),
        "datasetPartitionVersionId": dataset_partition_version_id,
    }
    optional = {
        "gpuCount": gpu_count,
        "walltimeSeconds": walltime_seconds,
        "maxAttempts": max_attempts,
        "retryOnFailure": retry_on_failure,
        "retryOnTimeout": retry_on_timeout,
        "allowChildJobs": allow_child_jobs,
    }
    body.update({key: value for key, value in optional.items() if value is not None})
    return client.request("POST", client.project_path(project_id, "job-arrays"), json=body)


def get_job_array(client: Client, project_id: str, array_group_id: str) -> dict[str, Any]:
    """The array and its Jobs as they are now (JobArrayCreated)."""
    return client.request(
        "GET", client.project_path(project_id, f"job-arrays/{path_id(array_group_id)}"), retryable=True
    )
