"""Python SDK for Mado Model Tracking."""

from .client import Client
from .errors import ApiError, ConfigurationError
from .execution_runtime import (
    DockerRuntime,
    ExecutionRuntime,
    ExecutionRuntimeKind,
    PythonRuntime,
    SifRuntime,
)
from .execution_snapshot import ExecutionMode
from .run import Run
from .upstream import download_upstream_artifacts, list_upstream_artifacts, upstream_run_id

__all__ = [
    "ApiError",
    "Client",
    "ConfigurationError",
    "DockerRuntime",
    "ExecutionMode",
    "ExecutionRuntime",
    "ExecutionRuntimeKind",
    "PythonRuntime",
    "Run",
    "SifRuntime",
    "download_upstream_artifacts",
    "list_upstream_artifacts",
    "start_run",
    "upstream_run_id",
]


def start_run(
    *,
    project_id: str | None = None,
    experiment_id: str | None = None,
    name: str | None = None,
    kind: str = "training",
    **attributes: object,
) -> Run:
    """Use an existing worker Run, or create a Run from explicit IDs / environment."""
    client = Client()
    try:
        run = client.start_run(
            project_id=project_id, experiment_id=experiment_id, name=name, kind=kind, **attributes
        )
    except BaseException:
        client.close()
        raise
    run.close_client_on_exit = True
    return run
