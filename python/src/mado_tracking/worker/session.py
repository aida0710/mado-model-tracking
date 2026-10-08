"""One job's lease, source transfer, cancellation, and durable output forwarding."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from collections.abc import Callable
from typing import Any

from ..errors import ApiError, ConfigurationError, LeaseRejected, TransportError
from ..http import BACKOFF_MAX_SECONDS, retry_delay
from ..timestamps import utc_timestamp
from .api import WorkerApi
from .config import WorkerSettings
from .contracts import TERMINAL_STATUSES, WorkerJob
from .event_wait import wait_interval
from .journal import JobJournal
from .runtime import JobExecutor
from .session_inputs import stage_container_inputs
from .session_outputs import forward_container_outputs

LOGGER = logging.getLogger(__name__)


class PreparationCanceled(Exception):
    """A source transfer was canceled before the entrypoint could be launched."""


class JobSession:
    def __init__(
        self,
        job: WorkerJob,
        *,
        api: WorkerApi,
        settings: WorkerSettings,
        journal: JobJournal,
        executor: JobExecutor,
    ):
        self.job = job
        self.api = api
        self.settings = settings
        self.journal = journal
        self.executor = executor
        self.cancel_requested = asyncio.Event()
        self.finished = asyncio.Event()
        self.lease_rejected = asyncio.Event()
        self.running = False
        self.completing = False
        record = journal.load(job.id)
        self.offsets: dict[str, int] = record["offsets"]
        self.step: int = record.get("step", 0)
        self.saved_completion: dict[str, Any] | None = record.get("completion")
        self.result_acknowledgments: dict[str, Any] = record.get("results", {})
        self.last_telemetry = 0.0

    def persist(self, *, completion: dict[str, Any] | None = None) -> None:
        self.journal.save(
            self.job,
            offsets=self.offsets,
            step=self.step,
            completion=completion,
            results=self.result_acknowledgments,
        )

    async def heartbeat(self) -> None:
        while not self.finished.is_set():
            await wait_interval(self.finished, self.settings.heartbeat_seconds)
            if self.finished.is_set():
                return
            try:
                if await self.api.heartbeat(self.job, running=self.running):
                    self.cancel_requested.set()
            except LeaseRejected:
                if not self.completing:
                    self.lease_rejected.set()
                return
            except (ApiError, ConfigurationError) as error:
                LOGGER.warning(
                    "Job %s heartbeat failed: %s", self.job.id, self.executor.masker.mask(str(error))
                )

    async def execute(self) -> None:
        if self.saved_completion is not None:
            await self.complete(self.saved_completion)
            return
        # Lease validation is mandatory even when this workspace already contains an execution.
        if await self.api.heartbeat(self.job):
            self.cancel_requested.set()
        heartbeat_task = asyncio.create_task(self.heartbeat())
        try:
            await self.prepare()
            await self.monitor()
        finally:
            self.finished.set()
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)

    async def prepare(self) -> None:
        await self.retry_transport(self.executor.install_runtime)
        response = await self.retry_transport(lambda: self.executor.poll(self.offsets))
        state = response["state"]
        if state["status"] == "missing" and self.job.job["status"] == "claimed":
            if self.cancel_requested.is_set():
                await self.complete({"status": "canceled", "exit_code": None, "error": None})
                return
            source = self.job.code_version["source"]
            if source is not None and source["kind"] == "artifact":
                archive_path = self.journal.archive_path(self.job.id)
                try:
                    await self.transfer_before_start(lambda: self.download_source(archive_path))
                    await self.transfer_before_start(
                        lambda: self.retry_transport(
                            lambda: self.executor.command("upload", stdin_file=archive_path)
                        )
                    )
                except PreparationCanceled:
                    await self.complete({"status": "canceled", "exit_code": None, "error": None})
                    return
                finally:
                    archive_path.unlink(missing_ok=True)
            if self.job.runtime["kind"] != "python":
                if not await self.prepare_container_inputs():
                    return
            # Bootstrap/download may be slow. Validate ownership immediately before launching.
            if self.lease_rejected.is_set():
                raise LeaseRejected("Lease rejected before execution")
            if await self.api.heartbeat(self.job) or self.cancel_requested.is_set():
                await self.complete({"status": "canceled", "exit_code": None, "error": None})
                return
            await self.retry_transport(self.executor.start)
        self.running = state["status"] in {"starting", "running"} or state["status"] == "missing"

    async def prepare_container_inputs(self) -> bool:
        try:
            await self.transfer_before_start(
                lambda: self.retry_transport(
                    lambda: stage_container_inputs(
                        self.job,
                        api=self.api,
                        executor=self.executor,
                        transfer_path=lambda kind: self.journal.transfer_path(self.job.id, kind),
                    )
                )
            )
        except LeaseRejected:
            raise
        except PreparationCanceled:
            await self.complete({"status": "canceled", "exit_code": None, "error": None})
            return False
        except (ApiError, ValueError) as error:
            await self.complete({"status": "failed", "exit_code": None, "error": str(error)})
            return False
        return True

    async def transfer_before_start(self, operation: Callable[[], Any]) -> Any:
        transfer = asyncio.create_task(operation())
        cancel_wait = asyncio.create_task(self.cancel_requested.wait())
        lease_wait = asyncio.create_task(self.lease_rejected.wait())
        try:
            completed, _pending = await asyncio.wait(
                {transfer, cancel_wait, lease_wait}, return_when=asyncio.FIRST_COMPLETED
            )
            if self.lease_rejected.is_set():
                raise LeaseRejected("Lease rejected during source transfer")
            if self.cancel_requested.is_set():
                raise PreparationCanceled()
            if transfer in completed:
                return transfer.result()
            raise AssertionError("Transfer wait ended without a completion")
        finally:
            for task in (transfer, cancel_wait, lease_wait):
                task.cancel()
            await asyncio.gather(transfer, cancel_wait, lease_wait, return_exceptions=True)

    async def download_source(self, archive_path: Any) -> None:
        attempt = 0
        while True:
            try:
                with archive_path.open("wb") as destination:
                    await self.api.download_artifact(
                        self.job.job["projectId"], self.job.code_version["source"]["artifactId"], destination
                    )
                return
            except ApiError as error:
                if error.status_code is not None and error.status_code < 500 and error.status_code != 429:
                    raise
                LOGGER.warning("Job %s source download failed; retrying", self.job.id)
                await self.delay(attempt)
                attempt += 1

    async def monitor(self) -> None:
        warned_unknown = False
        failures = 0
        while not self.finished.is_set():
            if self.lease_rejected.is_set():
                raise LeaseRejected("Lease rejected; execution will not be restarted")
            try:
                if self.cancel_requested.is_set():
                    await self.executor.cancel()
                now = time.monotonic()
                telemetry_due = now - self.last_telemetry >= self.settings.telemetry_seconds
                response = await self.executor.poll(self.offsets, telemetry=telemetry_due, step=self.step)
                await self.forward_logs(response["logs"])
                if response.get("metrics"):
                    await self.api.metrics(self.job, response["metrics"])
                    self.step += 1
                    self.persist()
                if telemetry_due:
                    self.last_telemetry = now
                state = response["state"]
                status = state["status"]
                if status in TERMINAL_STATUSES and self.logs_are_drained(response["logs"]):
                    status = await self.collect_results(state)
                    await self.complete(
                        {"status": status, "exit_code": state.get("exitCode"), "error": state.get("error")}
                    )
                    return
                container_unreleased = bool(
                    state.get("container") and state["container"].get("released") is not True
                )
                if (
                    status == "unknown"
                    and state.get("processAlive") is False
                    and not state.get("processPending")
                    and not container_unreleased
                ):
                    await self.complete(
                        {
                            "status": "failed",
                            "exit_code": None,
                            "error": state.get("error", "Remote execution state is unknown"),
                        }
                    )
                    return
                if status in {"unknown", "missing"} and not warned_unknown:
                    await self.api.logs(
                        self.job,
                        [
                            {
                                "timestamp": utc_timestamp(),
                                "level": "error",
                                "message": (
                                    "Remote state is unknown; retaining lease and refusing a new execution"
                                ),
                            }
                        ],
                    )
                    warned_unknown = True
                failures = 0
            except LeaseRejected:
                raise
            except ApiError as error:
                if (
                    error.status_code is not None
                    and error.status_code < 500
                    and error.status_code not in {408, 429}
                ):
                    raise
                LOGGER.warning(
                    "Job %s API interrupted: %s", self.job.id, self.executor.masker.mask(str(error))
                )
                await self.delay(failures)
                failures += 1
                continue
            except (TransportError, OSError, TimeoutError) as error:
                LOGGER.warning(
                    "Job %s connection/reporting failed: %s",
                    self.job.id,
                    self.executor.masker.mask(str(error)),
                )
                await self.delay(failures)
                failures += 1
                continue
            await wait_interval(self.finished, self.settings.poll_seconds)

    async def collect_results(self, state: dict[str, Any]) -> str:
        status = str(state["status"])
        if status != "finished" or state.get("results") is None:
            return status
        try:
            await forward_container_outputs(
                self.job,
                state["results"],
                api=self.api,
                executor=self.executor,
                acknowledgments=self.result_acknowledgments,
                persist=self.persist,
                temporary_path=self.journal.transfer_path(self.job.id, "output"),
            )
        except LeaseRejected:
            raise
        except ConfigurationError as error:
            state["error"] = str(error)
            return "failed"
        except ApiError as error:
            if error.status_code is None or error.status_code >= 500 or error.status_code in {408, 429}:
                raise
            state["error"] = f"Container output API save failed: {error}"
            return "failed"
        return status

    async def forward_logs(self, streams: dict[str, Any]) -> None:
        for stream_name, level in (("stdout", "info"), ("stderr", "error")):
            stream = streams[stream_name]
            content = base64.b64decode(stream["content"], validate=True).decode("utf-8")
            if content:
                await self.api.logs(
                    self.job,
                    [
                        {
                            "timestamp": utc_timestamp(),
                            "level": level,
                            "message": self.executor.masker.mask(content),
                        }
                    ],
                )
            self.offsets[stream_name] = int(stream["nextOffset"])
            self.persist()

    def logs_are_drained(self, streams: dict[str, Any]) -> bool:
        return all(self.offsets[name] >= stream["size"] for name, stream in streams.items())

    async def complete(self, completion: dict[str, Any]) -> None:
        if completion.get("error"):
            completion = {**completion, "error": self.executor.masker.mask(completion["error"])}
        self.completing = True
        self.persist(completion=completion)
        attempts = 0
        while True:
            try:
                await self.api.complete(self.job, **completion)
                self.journal.forget(self.job.id)
                self.finished.set()
                return
            except LeaseRejected:
                raise
            except ApiError as error:
                if (
                    error.status_code is not None
                    and error.status_code < 500
                    and error.status_code not in {408, 429}
                ):
                    raise
                LOGGER.warning(
                    "Job %s completion failed: %s", self.job.id, self.executor.masker.mask(str(error))
                )
                await asyncio.sleep(min(BACKOFF_MAX_SECONDS, retry_delay(attempts)))
                attempts += 1

    async def retry_transport(self, operation: Callable[[], Any]) -> Any:
        attempts = 0
        while True:
            if self.lease_rejected.is_set():
                raise LeaseRejected("Lease rejected during reconnect")
            try:
                return await operation()
            except (TransportError, OSError, TimeoutError) as error:
                LOGGER.warning(
                    "Job %s transport interrupted: %s", self.job.id, self.executor.masker.mask(str(error))
                )
                await self.delay(attempts)
                attempts += 1

    async def delay(self, attempt: int) -> None:
        await asyncio.sleep(min(BACKOFF_MAX_SECONDS, retry_delay(min(attempt, 10))))
