"""Connect recording clients to the worker's project and existing Run."""

from __future__ import annotations

from ..settings import ApiSettings
from .contracts import WorkerJob


def build_tracking_environment(job: WorkerJob, api: ApiSettings) -> dict[str, str]:
    project_id = job.job["projectId"]
    tracking_uri = f"{api.url.rstrip('/')}/mlflow/projects/{project_id}"
    return {
        "MMT_API_URL": api.url,
        "MMT_API_TOKEN": api.token,
        "MMT_PROJECT_ID": project_id,
        "MMT_RUN_ID": job.run["id"],
        "MMT_EXPERIMENT_ID": job.run["experimentId"],
        "MMT_JOB_ID": job.id,
        "MLFLOW_TRACKING_URI": tracking_uri,
        "MLFLOW_REGISTRY_URI": tracking_uri,
        "MLFLOW_TRACKING_TOKEN": api.token,
        "MLFLOW_RUN_ID": job.run["id"],
        "MLFLOW_EXPERIMENT_ID": job.run["experimentId"],
    }
