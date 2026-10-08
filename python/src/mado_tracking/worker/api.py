"""Worker API; lease credentials accompany every job mutation."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

import httpx

from ..errors import ApiError, ConfigurationError, LeaseRejected
from ..http import REQUEST_TIMEOUT_SECONDS, request_async
from ..security import SecretMasker
from .contracts import WorkerJob
from .download_content import DOWNLOAD_ACCEPT_ENCODING, write_downloaded_content

# Artifact uploads share the SDK's bounded one-MiB memory budget.
ARTIFACT_CHUNK_BYTES = 1024 * 1024

LEASE_REJECTED_STATUSES = {401, 403, 404, 409, 410}


class WorkerApi:
    def __init__(self, *, url: str, token: str, transport: httpx.AsyncBaseTransport | None = None):
        self.masker = SecretMasker([token])
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
    ) -> WorkerJob | None:
        # A lost claim response is recovered through resume; replay could claim another job.
        payload: dict[str, Any] = {"workerId": worker_id, "activeJobIds": list(active_job_ids)}
        if target_ids:
            payload["targetIds"] = list(target_ids)
        response = await self.request("worker/claim", payload, retryable=False)
        if "item" not in response or response["item"] is not None and not isinstance(response["item"], dict):
            raise ConfigurationError("Worker claim response must contain item or null")
        return WorkerJob.parse(response["item"]) if response["item"] is not None else None

    async def resume(self, worker_id: str, target_ids: Sequence[str]) -> list[WorkerJob]:
        payload: dict[str, Any] = {"workerId": worker_id}
        if target_ids:
            payload["targetIds"] = list(target_ids)
        response = await self.request("worker/resume", payload)
        items = response.get("items")
        if not isinstance(items, list):
            raise ConfigurationError("Worker resume response must contain items")
        return [WorkerJob.parse(item) for item in items]

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
        self, job: WorkerJob, *, status: str, exit_code: int | None = None, error: str | None = None
    ) -> None:
        payload: dict[str, Any] = {"leaseId": job.lease_id, "status": status}
        if exit_code is not None:
            payload["exitCode"] = exit_code
        if error:
            payload["error"] = self.masker.mask(error)
        await self.request(f"worker/jobs/{job.id}/complete", payload, leased=True)

    async def download_artifact(self, project_id: str, artifact_id: str, destination: Any) -> dict[str, Any]:
        try:
            async with self.http.stream(
                "GET",
                f"projects/{project_id}/artifacts/{artifact_id}/content",
                headers={"Accept-Encoding": DOWNLOAD_ACCEPT_ENCODING},
            ) as response:
                if not response.is_success:
                    from ..http import check_response

                    await response.aread()
                    check_response(response, self.masker)
                return await write_downloaded_content(response, destination, label="Artifact")
        except (httpx.TransportError, httpx.DecodingError, httpx.StreamError):
            raise ApiError("Artifact download interrupted or invalid; retry from the beginning") from None

    async def upload_output_artifact(self, job: WorkerJob, artifact: dict[str, Any], source: Path) -> None:
        async def chunks() -> AsyncIterator[bytes]:
            with source.open("rb") as content:
                while chunk := content.read(ARTIFACT_CHUNK_BYTES):
                    yield chunk

        response = await request_async(
            self.http,
            "PUT",
            f"projects/{job.job['projectId']}/runs/{job.run['id']}/artifacts",
            params={"path": f"container/{artifact['path']}"},
            headers={"Content-Type": artifact["mimeType"]},
            content=chunks(),
            masker=self.masker,
        )
        saved = response.json()
        if not isinstance(saved, dict) or (saved.get("sha256"), saved.get("size")) != (
            artifact["sha256"],
            artifact["size"],
        ):
            raise ConfigurationError("Saved container Artifact checksum or size does not match")
