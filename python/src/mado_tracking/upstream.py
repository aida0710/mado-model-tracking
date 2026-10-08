"""Read the upstream Run's Artifacts from a Job's code (for example inference WAVs in evaluation).

The worker sets MMT_UPSTREAM_RUN_ID when the Run has a parent Run. Listing and download use the
Job token in MMT_API_TOKEN, which may read any Run in the same Project.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .client import Client, path_id
from .errors import ConfigurationError

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
            # Range resumption arrives with the SDK's resumable transfer; until then this uses the
            # existing whole-file download so client.py stays with its owner.
            _write_atomically(target, api.download_artifact(project_id, artifact["id"]))
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
    seen_cursors: set[str] = set()
    while True:
        page = api.request("GET", resource, retryable=True, params=params)
        items = page.get("items")
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise ConfigurationError("API list response must contain items")
        for artifact in items:
            path = artifact.get("path")
            if not isinstance(path, str) or not isinstance(artifact.get("id"), str):
                raise ConfigurationError("API returned an Artifact without id or path")
            # An API without prefix/versions support returns every row, newest first.
            if prefix and not path.startswith(prefix):
                continue
            latest_by_path.setdefault(path, artifact)
        next_cursor = page.get("nextCursor")
        if not next_cursor:
            break
        if not isinstance(next_cursor, str) or next_cursor in seen_cursors:
            raise ConfigurationError("API returned a repeating or invalid Artifact cursor")
        seen_cursors.add(next_cursor)
        params["cursor"] = next_cursor
    return list(latest_by_path.values())


def _safe_artifact_parts(path: str) -> list[str]:
    # A relative path of plain segments cannot leave the destination directory.
    parts = path.split("/")
    if any(part in {"", ".", ".."} or "\\" in part or "\x00" in part for part in parts):
        raise ConfigurationError(f"Unsafe upstream Artifact path: {path!r}")
    return parts


def _write_atomically(target: Path, chunks: Iterator[bytes]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".partial")
    try:
        with os.fdopen(descriptor, "wb") as output:
            for chunk in chunks:
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
