"""Identify rejected execution instructions without trusting their source or compute target."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..errors import ConfigurationError
from .contracts import WorkerJob, require_uuid


@dataclass(frozen=True)
class InvalidWorkerJob:
    id: str
    lease_id: str
    status: str
    error: str


def parse_worker_job_response(payload: dict[str, Any], *, worker_id: str) -> WorkerJob | InvalidWorkerJob:
    try:
        job = WorkerJob.parse(payload)
    except ConfigurationError as error:
        identity = payload.get("job")
        if not isinstance(identity, dict) or identity.get("workerId") != worker_id:
            raise ConfigurationError("Invalid WorkerJob has no verified worker ownership") from None
        job_id = require_uuid(identity.get("id"), "job.id")
        lease_id = require_uuid(identity.get("leaseId"), "job.leaseId")
        if not isinstance(identity.get("status"), str) or identity["status"] not in {"claimed", "running"}:
            raise ConfigurationError("Invalid WorkerJob has no active lease status") from None
        return InvalidWorkerJob(job_id, lease_id, identity["status"], str(error))
    if job.job.get("workerId") != worker_id:
        raise ConfigurationError("WorkerJob belongs to a different worker")
    return job
