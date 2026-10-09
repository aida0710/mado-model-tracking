"""Worker API; lease credentials accompany every job mutation."""

from __future__ import annotations

import logging
import socket
from collections.abc import Sequence
from importlib import metadata
from pathlib import Path
from typing import Any

import httpx

from ..artifact_uploads import UploadStateStore
from ..errors import ApiError, ConfigurationError, LeaseRejected
from ..http import request_async
from .artifact_transfer import ArtifactTransferApi
from .contracts import WorkerJob
from .job_responses import InvalidWorkerJob, parse_worker_job_response

LEASE_REJECTED_STATUSES = {401, 403, 404, 409, 410}
# Output declarations answer 403/404/409 for the declared Model, Dataset or scope; only these mean
# the lease itself is gone (the other job routes treat every such status as a lost lease).
OUTPUT_LEASE_REJECTED_STATUSES = {401, 410}
INVALID_LEASE_CODE = "invalid_lease"
LOGGER = logging.getLogger(__name__)
# The distribution name in pyproject.toml; its version is what operators compare across hosts.
DISTRIBUTION_NAME = "mado-tracking"


def worker_info() -> dict[str, str]:
    """Describe this worker host for the API's worker list; display only, never authorization."""
    info = {"hostname": socket.gethostname()}
    try:
        info["version"] = metadata.version(DISTRIBUTION_NAME)
    except metadata.PackageNotFoundError:
        # A source checkout without installation has no version to report.
        pass
    return info


class WorkerApi(ArtifactTransferApi):
    def __init__(
        self,
        *,
        url: str,
        token: str,
        transport: httpx.AsyncBaseTransport | None = None,
        upload_state_store: UploadStateStore | None = None,
    ):
        super().__init__(url=url, token=token, transport=transport, upload_state_store=upload_state_store)
        self.worker_info = worker_info()

    async def request(
        self, path: str, payload: dict[str, Any], *, retryable: bool = True, leased: bool = False
    ) -> dict[str, Any]:
        try:
            response = await request_async(
                self.http, "POST", path, json=payload, masker=self.masker, retryable=retryable
            )
        except ApiError as error:
            if leased and error.status_code in LEASE_REJECTED_STATUSES:
                raise LeaseRejected(str(error), status_code=error.status_code, code=error.code) from None
            raise
        if response.status_code == 204:
            return {}
        response_body = response.json()
        if not isinstance(response_body, dict):
            raise ConfigurationError("Worker API returned a non-object response")
        return response_body

    async def claim(
        self, worker_id: str, target_ids: Sequence[str], *, active_job_ids: Sequence[str] = ()
    ) -> WorkerJob | InvalidWorkerJob | None:
        # A lost claim response is recovered through resume; replay could claim another job.
        payload: dict[str, Any] = {
            "workerId": worker_id,
            "activeJobIds": list(active_job_ids),
            "workerInfo": self.worker_info,
        }
        if target_ids:
            payload["targetIds"] = list(target_ids)
        response = await self.request("worker/claim", payload, retryable=False)
        if "item" not in response or response["item"] is not None and not isinstance(response["item"], dict):
            raise ConfigurationError("Worker claim response must contain item or null")
        return (
            parse_worker_job_response(response["item"], worker_id=worker_id)
            if response["item"] is not None
            else None
        )

    async def resume(self, worker_id: str, target_ids: Sequence[str]) -> list[WorkerJob | InvalidWorkerJob]:
        payload: dict[str, Any] = {"workerId": worker_id, "workerInfo": self.worker_info}
        if target_ids:
            payload["targetIds"] = list(target_ids)
        response = await self.request("worker/resume", payload)
        items = response.get("items")
        if not isinstance(items, list):
            raise ConfigurationError("Worker resume response must contain items")
        jobs: list[WorkerJob | InvalidWorkerJob] = []
        for item in items:
            try:
                if not isinstance(item, dict):
                    raise ConfigurationError("Resumed WorkerJob must be an object")
                jobs.append(parse_worker_job_response(item, worker_id=worker_id))
            except ConfigurationError as error:
                # Unverified identities cannot authorize a mutation of any lease in the batch.
                LOGGER.error(
                    "Resumed Job has no verified lease; no completion sent: %s", self.masker.mask(str(error))
                )
        return jobs

    async def claim_target_check(self, worker_id: str, target_ids: Sequence[str]) -> dict[str, Any] | None:
        """Claim a queued connection check for one of this worker's targets (resent claims are safe)."""
        response = await self.request(
            "worker/target-checks/claim", {"workerId": worker_id, "targetIds": list(target_ids)}
        )
        claimed = response.get("item")
        if claimed is None:
            return None
        if (
            not isinstance(claimed, dict)
            or not isinstance(claimed.get("leaseId"), str)
            or not isinstance(claimed.get("check"), dict)
            or not isinstance(claimed.get("target"), dict)
            or claimed["target"].get("id") not in target_ids
        ):
            raise ConfigurationError("Target check claim response is invalid")
        return claimed

    async def complete_target_check(
        self, claimed: dict[str, Any], *, status: str, result: dict[str, Any]
    ) -> None:
        await self.request(
            f"worker/target-checks/{claimed['check']['id']}/complete",
            {"leaseId": claimed["leaseId"], "status": status, "result": result},
            leased=True,
        )

    async def heartbeat(self, job: WorkerJob, *, running: bool = False) -> bool:
        payload: dict[str, Any] = {"leaseId": job.lease_id}
        if running:
            payload["status"] = "running"
        response = await self.request(f"worker/jobs/{job.id}/heartbeat", payload, leased=True)
        if not isinstance(response.get("cancelRequested"), bool):
            raise ConfigurationError("Heartbeat response must contain cancelRequested")
        return bool(response["cancelRequested"])

    async def logs(self, job: WorkerJob, entries: list[dict[str, Any]]) -> None:
        await self.request(
            f"worker/jobs/{job.id}/logs", {"leaseId": job.lease_id, "entries": entries}, leased=True
        )

    async def metrics(self, job: WorkerJob, metrics: list[dict[str, Any]]) -> None:
        await self.request(
            f"worker/jobs/{job.id}/metrics", {"leaseId": job.lease_id, "metrics": metrics}, leased=True
        )

    async def declare_outputs(
        self, job: WorkerJob, declarations: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Register result.json models/datasets; a resent index returns the stored registration."""
        try:
            response = await self.request(
                f"worker/jobs/{job.id}/outputs", {"leaseId": job.lease_id, "declarations": declarations}
            )
        except ApiError as error:
            if error.status_code in OUTPUT_LEASE_REJECTED_STATUSES or error.code == INVALID_LEASE_CODE:
                raise LeaseRejected(str(error), status_code=error.status_code, code=error.code) from None
            raise
        items = response.get("items")
        if not isinstance(items, list) or not all(
            isinstance(item, dict) and type(item.get("index")) is int for item in items
        ):
            raise ConfigurationError("Output declaration response must contain indexed items")
        return items

    async def complete(
        self,
        job: WorkerJob | InvalidWorkerJob,
        *,
        status: str,
        exit_code: int | None = None,
        error: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {"leaseId": job.lease_id, "status": status}
        if exit_code is not None:
            payload["exitCode"] = exit_code
        if error:
            payload["error"] = self.masker.mask(error)
        await self.request(f"worker/jobs/{job.id}/complete", payload, leased=True)

    async def upload_source_snapshot_artifact(
        self, job: WorkerJob, artifact: dict[str, Any], source: Path
    ) -> None:
        # The lease is checked first so a lost Job never adds Artifacts to its Run.
        await self.heartbeat(job)
        await self.upload_snapshot_artifact(job, artifact, source)
