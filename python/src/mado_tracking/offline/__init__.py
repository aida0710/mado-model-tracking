"""Offline recording: a Run written to a local spool and sent later with `mado-tracking sync`."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from ..errors import ConfigurationError
from ..security import SecretMasker
from ..timestamps import utc_timestamp
from .spool import RunSpool, SpoolRunRecord, default_offline_directory
from .transport import RunMode, SpoolRunTransport, machine_origin, resolve_mode

if TYPE_CHECKING:
    from ..run import Run

__all__ = ["RunMode", "default_offline_directory", "resolve_mode", "start_offline_run"]

# SyncRunCreate carries only these Run attributes; the rest need an online Run.
OFFLINE_RUN_ATTRIBUTES = frozenset({"parameters", "tags", "parent_run_id"})


def start_offline_run(
    *,
    project_id: str,
    experiment_id: str,
    name: str,
    kind: str,
    attributes: Mapping[str, Any],
    api_url: str | None = None,
    offline_directory: Path | None = None,
    masker: SecretMasker | None = None,
) -> Run:
    """Create a running Run in the spool under a new UUID; the API is not contacted."""
    from ..run import Run

    if unsupported := sorted(set(attributes) - OFFLINE_RUN_ATTRIBUTES):
        raise ConfigurationError(f"An offline Run does not support {', '.join(unsupported)}")
    record = SpoolRunRecord(
        run_id=str(uuid4()),
        project_id=project_id,
        api_url=api_url,
        experiment_id=experiment_id,
        name=name,
        kind=kind,
        parameters=dict(attributes.get("parameters") or {}),
        tags=dict(attributes.get("tags") or {}),
        parent_run_id=attributes.get("parent_run_id"),
        started_at=utc_timestamp(),
        origin=machine_origin(),
    )
    spool = RunSpool.create(offline_directory or default_offline_directory(), record)
    entity = {
        "id": record.run_id,
        "projectId": project_id,
        "experimentId": experiment_id,
        "name": name,
        "kind": kind,
        "status": "running",
        "parameters": record.parameters,
        "tags": record.tags,
        "parentRunId": record.parent_run_id,
        "startedAt": record.started_at,
    }
    return Run(None, project_id, entity, transport=SpoolRunTransport(spool), masker=masker)
