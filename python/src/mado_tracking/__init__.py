"""Python SDK for Mado Model Tracking."""

import os
from typing import Any

from .client import Client, ResumeMode, start_run_offline
from .errors import ApiError, ConfigurationError
from .execution_runtime import (
    DockerRuntime,
    ExecutionRuntime,
    ExecutionRuntimeKind,
    PythonRuntime,
    SifRuntime,
)
from .execution_snapshot import ExecutionMode
from .media import Audio, Image, Table, Video, artifact_reference
from .offline.transport import RunMode, resolve_mode
from .run import Run
from .sweeps import SweepsClient, trial_parameters
from .upstream import download_upstream_artifacts, list_upstream_artifacts, upstream_run_id

__all__ = [
    "ApiError",
    "Audio",
    "Client",
    "ConfigurationError",
    "DockerRuntime",
    "ExecutionMode",
    "ExecutionRuntime",
    "ExecutionRuntimeKind",
    "Image",
    "PythonRuntime",
    "ResumeMode",
    "Run",
    "RunMode",
    "SifRuntime",
    "SweepsClient",
    "Table",
    "Video",
    "artifact_reference",
    "download_upstream_artifacts",
    "list_upstream_artifacts",
    "start_run",
    "trial_parameters",
    "upstream_run_id",
]


def start_run(
    *,
    project_id: str | None = None,
    experiment_id: str | None = None,
    name: str | None = None,
    kind: str = "training",
    mode: RunMode | None = None,
    **options: Any,
) -> Run:
    """Use an existing worker Run, or create or resume a Run (see Client.start_run for options).

    An offline Run needs neither MMT_API_URL nor MMT_API_TOKEN.
    """
    if resolve_mode(mode, os.environ) == "offline":
        return start_run_offline(
            project_id=project_id, experiment_id=experiment_id, name=name, kind=kind, **options
        )
    client = Client()
    try:
        run = client.start_run(
            project_id=project_id, experiment_id=experiment_id, name=name, kind=kind, mode=mode, **options
        )
    except BaseException:
        client.close()
        raise
    run.close_client_on_exit = True
    return run
