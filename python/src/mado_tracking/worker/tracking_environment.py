"""Connect recording clients to the worker's project and existing Run."""

from __future__ import annotations

from ..errors import ConfigurationError
from ..settings import ApiSettings
from .contracts import WorkerJob


def build_tracking_environment(job: WorkerJob, api: ApiSettings) -> dict[str, str]:
    """Environment for the Job's code. It authenticates with the Job token, never the worker's.

    The worker token can claim other Jobs and write every Run in the Project, so a Job
    without its own token is not started rather than falling back to the worker token.
    """
    if job.job_token is None:
        raise ConfigurationError("WorkerJob has no job token; refusing to start its code")
    project_id = job.job["projectId"]
    tracking_uri = f"{api.url.rstrip('/')}/mlflow/projects/{project_id}"
    return {
        "MMT_API_URL": api.url,
        "MMT_API_TOKEN": job.job_token,
        "MMT_PROJECT_ID": project_id,
        "MMT_RUN_ID": job.run["id"],
        "MMT_EXPERIMENT_ID": job.run["experimentId"],
        "MMT_JOB_ID": job.id,
        "MLFLOW_TRACKING_URI": tracking_uri,
        "MLFLOW_REGISTRY_URI": tracking_uri,
        "MLFLOW_TRACKING_TOKEN": job.job_token,
        "MLFLOW_RUN_ID": job.run["id"],
        "MLFLOW_EXPERIMENT_ID": job.run["experimentId"],
    }
