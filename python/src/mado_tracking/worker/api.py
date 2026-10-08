"""Worker API; lease credentials accompany every job mutation."""

from __future__ import annotations

import logging
import socket
from collections.abc import AsyncIterator, Sequence
from importlib import metadata
from pathlib import Path
from typing import Any, BinaryIO

import httpx

from ..artifact_downloads import download_resumable_async
from ..artifact_uploads import (
    SESSION_UPLOAD_THRESHOLD_BYTES,
    UploadStateStore,
    UploadTarget,
    upload_file_async,
)
from ..errors import ApiError, ConfigurationError, LeaseRejected
from ..http import REQUEST_TIMEOUT_SECONDS, request_async
from ..security import SecretMasker
from .contracts import WorkerJob
from .download_content import write_downloaded_content
from .job_responses import InvalidWorkerJob, parse_worker_job_response

# Artifact uploads share the SDK's bounded one-MiB memory budget.
ARTIFACT_CHUNK_BYTES = 1024 * 1024

LEASE_REJECTED_STATUSES = {401, 403, 404, 409, 410}
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


class WorkerApi:
    def __init__(
        self,
        *,
        url: str,
        token: str,
        transport: httpx.AsyncBaseTransport | None = None,
        upload_state_store: UploadStateStore | None = None,
    ):
        self.masker = SecretMasker([token])
        self.upload_state_store = upload_state_store
        self.worker_info = worker_info()
        self.http = httpx.AsyncClient(
            base_url=url.rstrip("/") + "/",
            transport=transport,
            headers={"Authorization": f"Bearer {token}"},
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
        )

    async def close(self) -> None:
        await self.http.aclose()

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

    async def download_artifact(
        self, project_id: str, artifact_id: str, destination: BinaryIO, *, maximum_bytes: int | None = None
    ) -> dict[str, Any]:
        """Resume an interrupted download with Range; the destination must be seekable."""

        async def write_encoded(response: httpx.Response) -> dict[str, Any]:
            try:
                return await write_downloaded_content(
                    response, destination, label="Artifact", maximum_bytes=maximum_bytes
                )
            except (httpx.TransportError, httpx.DecodingError, httpx.StreamError):
                # An encoded body has no byte offset to resume from.
                raise ApiError("Artifact download interrupted or invalid; retry from the beginning") from None

        return await download_resumable_async(
            self.http,
            f"projects/{project_id}/artifacts/{artifact_id}/content",
            destination,
            masker=self.masker,
            maximum_bytes=maximum_bytes,
            # Bounded code archives stay identity-only; write_downloaded_content rejects encodings.
            encoded_fallback=write_encoded,
        )

    async def upload_output_artifact(self, job: WorkerJob, artifact: dict[str, Any], source: Path) -> None:
        await self.upload_run_artifact(job, artifact, source, path=f"container/{artifact['path']}")

    async def upload_source_snapshot_artifact(
        self, job: WorkerJob, artifact: dict[str, Any], source: Path
    ) -> None:
        from .source_snapshot import SNAPSHOT_FILENAMES

        if artifact.get("path") not in SNAPSHOT_FILENAMES:
            raise ConfigurationError("Source snapshot requires a reserved Artifact path")
        await self.heartbeat(job)
        await self.upload_run_artifact(job, artifact, source, path=artifact["path"])

    async def upload_run_artifact(
        self, job: WorkerJob, artifact: dict[str, Any], source: Path, *, path: str
    ) -> None:
        project_id, run_id = job.job["projectId"], job.run["id"]
        if artifact["size"] >= SESSION_UPLOAD_THRESHOLD_BYTES:
            saved = await upload_file_async(
                self.http,
                masker=self.masker,
                target=UploadTarget(
                    api_url=str(self.http.base_url),
                    project_id=project_id,
                    run_id=run_id,
                    path=path,
                    mime_type=artifact["mimeType"],
                ),
                source=source,
                state_store=self.upload_state_store,
            )
        else:
            saved = await self.put_run_artifact(
                project_id=project_id, run_id=run_id, artifact=artifact, source=source, path=path
            )
        if (saved.get("sha256"), saved.get("size")) != (artifact["sha256"], artifact["size"]):
            raise ConfigurationError("Saved Run Artifact checksum or size does not match")

    async def put_run_artifact(
        self, *, project_id: str, run_id: str, artifact: dict[str, Any], source: Path, path: str
    ) -> dict[str, Any]:
        """One PUT; a failure resends the whole file, so only small Artifacts take this path."""

        async def chunks() -> AsyncIterator[bytes]:
            with source.open("rb") as content:
                while chunk := content.read(ARTIFACT_CHUNK_BYTES):
                    yield chunk

        response = await request_async(
            self.http,
            "PUT",
            f"projects/{project_id}/runs/{run_id}/artifacts",
            params={"path": path},
            headers={"Content-Type": artifact["mimeType"]},
            content=chunks(),
            masker=self.masker,
        )
        saved = response.json()
        if not isinstance(saved, dict):
            raise ConfigurationError("Saved Run Artifact response must be an object")
        return saved
