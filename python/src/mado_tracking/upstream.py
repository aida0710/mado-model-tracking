"""Read the upstream Run's Artifacts from a Job's code (for example inference WAVs in evaluation).

The worker sets MMT_UPSTREAM_RUN_ID when the Run has a parent Run. Listing and download use the
Job token in MMT_API_TOKEN, which may read any Run in the same Project.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .atomic_files import atomic_output
from .client import Client, path_id
from .errors import ConfigurationError
from .pagination import iterate_listed_items

UPSTREAM_RUN_ID_VARIABLE = "MMT_UPSTREAM_RUN_ID"
# Matches the API's maximum page size so a large Run is listed in few requests.
ARTIFACT_PAGE_LIMIT = 500


def upstream_run_id() -> str | None:
    """The upstream Run ID from the worker, or None when this Job has no upstream."""
    return os.environ.get(UPSTREAM_RUN_ID_VARIABLE) or None


def list_upstream_artifacts(
    prefix: str | None = None, *, client: Client | None = None
) -> list[dict[str, Any]]:
    """Latest Artifact per path of the upstream Run, optionally under a path prefix."""
    run_id = upstream_run_id()
    if run_id is None:
        return []
    with _client_scope(client) as api:
        return _list_latest_artifacts(api, _project_id(), run_id, prefix)


def download_upstream_artifacts(
    destination: str | os.PathLike[str], prefix: str | None = None, *, client: Client | None = None
) -> list[Path]:
    """Save the upstream Run's Artifacts under destination, keeping their relative paths."""
    run_id = upstream_run_id()
    if run_id is None:
        return []
    root = Path(destination)
    project_id = _project_id()
    with _client_scope(client) as api:
        artifacts = _list_latest_artifacts(api, project_id, run_id, prefix)
        # Every path is checked before the first write so a hostile listing writes nothing.
        targets = [
            (artifact, root.joinpath(*_safe_artifact_parts(artifact["path"]))) for artifact in artifacts
        ]
        saved = []
        for artifact, target in targets:
            # A dropped connection resumes with Range, and the file appears only once it is complete.
            with atomic_output(target) as output:
                api.download_artifact_to(project_id, artifact["id"], output)
            saved.append(target)
    return saved


@contextmanager
def _client_scope(client: Client | None) -> Iterator[Client]:
    if client is not None:
        yield client
        return
    with Client() as created:
        yield created


def _project_id() -> str:
    project_id = os.environ.get("MMT_PROJECT_ID")
    if not project_id:
        raise ConfigurationError("MMT_PROJECT_ID is required to read upstream Artifacts")
    return project_id


def _list_latest_artifacts(
    api: Client, project_id: str, run_id: str, prefix: str | None
) -> list[dict[str, Any]]:
    resource = api.project_path(project_id, f"runs/{path_id(run_id)}/artifacts")
    params = {"versions": "latest", "limit": str(ARTIFACT_PAGE_LIMIT)}
    if prefix:
        params["prefix"] = prefix
    latest_by_path: dict[str, dict[str, Any]] = {}
    for artifact in iterate_listed_items(api, resource, params=params, label="Upstream Artifact list"):
        path = artifact.get("path")
        if not isinstance(path, str) or not isinstance(artifact.get("id"), str):
            raise ConfigurationError("API returned an Artifact without id or path")
        # An API without prefix/versions support returns every row, newest first.
        if prefix and not path.startswith(prefix):
            continue
        latest_by_path.setdefault(path, artifact)
    return list(latest_by_path.values())


def _safe_artifact_parts(path: str) -> list[str]:
    # A relative path of plain segments cannot leave the destination directory.
    parts = path.split("/")
    if any(part in {"", ".", ".."} or "\\" in part or "\x00" in part for part in parts):
        raise ConfigurationError(f"Unsafe upstream Artifact path: {path!r}")
    return parts
