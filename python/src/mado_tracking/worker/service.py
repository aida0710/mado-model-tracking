"""Worker identity, claim/recovery queue, and process-lifetime coordination."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from ..errors import ApiError, ConfigurationError, LeaseRejected
from .api import WorkerApi
from .config import WorkerSettings
from .contracts import WorkerJob
from .event_wait import wait_interval
from .job_responses import InvalidWorkerJob
from .journal import JobJournal, with_saved_job_token
from .runtime import JobExecutor
from .session import JobSession
from .target_probe import check_target

LOGGER = logging.getLogger(__name__)
# Connection checks are rare administrator requests; a few seconds of delay is fine and keeps
# the extra API traffic far below the one-second Job claim loop.
TARGET_CHECK_POLL_SECONDS = 5.0


class Worker:
    def __init__(
        self,
        settings: WorkerSettings,
        *,
        api: WorkerApi | None = None,
        executor_factory: Callable[[WorkerJob, WorkerSettings], JobExecutor] = JobExecutor,
    ):
        self.settings = settings
        self.api = api or WorkerApi(url=settings.api.url, token=settings.api.token)
        self.journal = JobJournal(settings.state_directory)
        self.executor_factory = executor_factory
        self.stopping = asyncio.Event()
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.retained_job_ids: set[str] = set()
        # Tokens the API re-issued for Jobs whose task already runs (resume after a failed claim).
        self.reissued_job_tokens: dict[str, str] = {}
        self.resume_available = True
        # Only a worker with explicit MMT_WORKER_TARGET_IDS is in charge of diagnosing targets.
        self.target_checks_enabled = bool(settings.target_ids)
        self.target_check_task: asyncio.Task[None] | None = None
        self.next_target_check_poll = 0.0

    async def run_job(self, job: WorkerJob) -> None:
        if job.job.get("workerId") != self.settings.worker_id:
            raise ConfigurationError("Job belongs to a different worker")
        if self.settings.target_ids and job.target["id"] not in self.settings.target_ids:
            raise ConfigurationError("Job target is outside this worker's configured targets")
        record = self.journal.load(job.id)
        job = with_saved_job_token(job, record)
        if "snapshot" in record and record["snapshot"]["job"]["leaseId"] != job.lease_id:
            raise ConfigurationError("Saved job lease differs; refusing a replacement execution")
        if "snapshot" in record:
            previous = WorkerJob.parse(record["snapshot"])
            if previous.run["id"] != job.run["id"] or previous.execution_snapshot != job.execution_snapshot:
                raise ConfigurationError(
                    "Saved executionSnapshot differs; refusing changed execution instructions"
                )
        self.journal.save(
            job,
            offsets=record["offsets"],
            step=record.get("step", 0),
            completion=record.get("completion"),
            results=record.get("results"),
        )
        try:
            executor = self.executor_factory(job, self.settings)
            session = JobSession(
                job,
                api=self.api,
                settings=self.settings,
                journal=self.journal,
                executor=executor,
                reissued_job_token=lambda: self.reissued_job_tokens.get(job.id),
            )
            await session.execute()
        except LeaseRejected:
            self.journal.record_rejection(job)
            LOGGER.error("Job %s lease rejected; no new execution was started", job.id)
        finally:
            self.reissued_job_tokens.pop(job.id, None)

    async def recover(self) -> list[WorkerJob]:
        pending = {job.id: job for job in self.journal.pending()}
        try:
            resumed = await self.api.resume(self.settings.worker_id, self.settings.target_ids)
            self.resume_available = True
            for job in resumed:
                if isinstance(job, InvalidWorkerJob):
                    await self.reject_invalid_job(job, resumed=True)
                else:
                    pending[job.id] = job
        except ApiError as error:
            if error.status_code != 404:
                raise
            self.resume_available = False
            LOGGER.warning("Worker resume endpoint is unavailable; recovering only saved local leases")
        return list(pending.values())

    async def reject_invalid_job(self, job: InvalidWorkerJob, *, resumed: bool = False) -> None:
        if (
            resumed
            or job.status != "claimed"
            or job.id in self.tasks
            or job.id in self.retained_job_ids
            or self.journal.has_job(job.id)
        ):
            # A response cannot prove a previously started execution stopped. Keep saved monitoring.
            LOGGER.error(
                "Job %s instructions failed validation; lease retained for monitoring/recovery: %s",
                job.id,
                self.api.masker.mask(job.error),
            )
            # Exclude retained leases from claim replay without declaring their executions stopped.
            self.retained_job_ids.add(job.id)
            return
        try:
            await self.api.complete(job, status="failed", error=f"WorkerJob validation failed: {job.error}")
            LOGGER.error("Unstarted claimed Job %s failed validation and was completed as failed", job.id)
        except LeaseRejected:
            LOGGER.error("Invalid claimed Job %s lease rejected; no execution started", job.id)

    async def poll_target_check(self) -> None:
        """Claim one connection check while idle; the probe runs beside Job monitoring."""
        if not self.target_checks_enabled or (self.target_check_task and not self.target_check_task.done()):
            return
        now = asyncio.get_running_loop().time()
        if now < self.next_target_check_poll:
            return
        self.next_target_check_poll = now + TARGET_CHECK_POLL_SECONDS
        try:
            claimed = await self.api.claim_target_check(self.settings.worker_id, self.settings.target_ids)
        except ApiError as error:
            if error.status_code == 404:
                self.target_checks_enabled = False
                LOGGER.warning("The API has no target check endpoint; connection checks are disabled")
            else:
                LOGGER.warning("Target check claim failed: %s", str(error))
            return
        except ConfigurationError as error:
            LOGGER.error("Target check claim was rejected: %s", self.api.masker.mask(str(error)))
            return
        if claimed is not None:
            self.target_check_task = asyncio.create_task(self.run_target_check(claimed))

    async def run_target_check(self, claimed: dict[str, Any]) -> None:
        status, result = await check_target(
            claimed["target"],
            allow_local_executor=self.settings.allow_local_executor,
            health_url=f"{self.settings.api.url}/health",
            masker=self.api.masker,
        )
        try:
            await self.api.complete_target_check(claimed, status=status, result=result)
        except ApiError as error:
            # The API expires an unreported check, so the administrator can request it again.
            LOGGER.error("Target check %s report failed: %s", claimed["check"]["id"], str(error))

    def launch(self, job: WorkerJob) -> None:
        if job.id not in self.tasks:
            self.tasks[job.id] = asyncio.create_task(self.run_job(job))
        elif job.job_token is not None:
            # Re-issuing revoked the token the task holds; it adopts this one before launching code.
            self.reissued_job_tokens[job.id] = job.job_token

    def collect_finished(self) -> None:
        for job_id, task in list(self.tasks.items()):
            if not task.done():
                continue
            del self.tasks[job_id]
            if not task.cancelled() and task.exception() is not None:
                if isinstance(task.exception(), ConfigurationError):
                    self.retained_job_ids.add(job_id)
                LOGGER.error(
                    "Job %s monitoring stopped; durable state remains for recovery: %s",
                    job_id,
                    self.api.masker.mask(str(task.exception())),
                )

    async def run_forever(self) -> None:
        self.journal.acquire_worker_lock()
        try:
            for job in await self.recover():
                self.launch(job)
            while not self.stopping.is_set():
                self.collect_finished()
                if len(self.tasks) < self.settings.parallel_jobs:
                    try:
                        claimed_job = await self.api.claim(
                            self.settings.worker_id,
                            self.settings.target_ids,
                            active_job_ids=(*self.tasks, *sorted(self.retained_job_ids - self.tasks.keys())),
                        )
                        if isinstance(claimed_job, InvalidWorkerJob):
                            await self.reject_invalid_job(claimed_job)
                        elif claimed_job is not None and claimed_job.id not in self.tasks:
                            self.launch(claimed_job)
                            continue
                    except ApiError as error:
                        LOGGER.warning("Claim failed; recovering possible existing claim: %s", str(error))
                        if not self.resume_available:
                            raise ConfigurationError(
                                "Lost claim response requires /worker/resume before claiming again"
                            ) from None
                        for job in await self.recover():
                            self.launch(job)
                await self.poll_target_check()
                await wait_interval(self.stopping, self.settings.poll_seconds)
        finally:
            if self.target_check_task is not None:
                self.target_check_task.cancel()
                await asyncio.gather(self.target_check_task, return_exceptions=True)
            # Worker shutdown leaves detached executions running and preserves their journals.
            for task in self.tasks.values():
                task.cancel()
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
            self.journal.close()
            await self.api.close()
