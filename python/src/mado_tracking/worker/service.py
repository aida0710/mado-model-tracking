"""Worker identity, claim/recovery queue, and process-lifetime coordination."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from ..errors import ApiError, ConfigurationError, LeaseRejected
from .api import WorkerApi
from .config import WorkerSettings
from .contracts import WorkerJob
from .event_wait import wait_interval
from .journal import JobJournal
from .runtime import JobExecutor
from .session import JobSession

LOGGER = logging.getLogger(__name__)


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
        self.resume_available = True

    async def run_job(self, job: WorkerJob) -> None:
        if job.job.get("workerId") != self.settings.worker_id:
            raise ConfigurationError("Job belongs to a different worker")
        if self.settings.target_ids and job.target["id"] not in self.settings.target_ids:
            raise ConfigurationError("Job target is outside this worker's configured targets")
        record = self.journal.load(job.id)
        if "snapshot" in record and record["snapshot"]["job"]["leaseId"] != job.lease_id:
            raise ConfigurationError("Saved job lease differs; refusing a replacement execution")
        self.journal.save(
            job, offsets=record["offsets"], step=record.get("step", 0), completion=record.get("completion")
        )
        try:
            executor = self.executor_factory(job, self.settings)
            session = JobSession(
                job, api=self.api, settings=self.settings, journal=self.journal, executor=executor
            )
            await session.execute()
        except LeaseRejected:
            self.journal.record_rejection(job)
            LOGGER.error("Job %s lease rejected; no new execution was started", job.id)

    async def recover(self) -> list[WorkerJob]:
        pending = {job.id: job for job in self.journal.pending()}
        try:
            resumed = await self.api.resume(self.settings.worker_id, self.settings.target_ids)
            self.resume_available = True
            pending.update({job.id: job for job in resumed})
        except ApiError as error:
            if error.status_code != 404:
                raise
            self.resume_available = False
            LOGGER.warning("Worker resume endpoint is unavailable; recovering only saved local leases")
        return list(pending.values())

    def launch(self, job: WorkerJob) -> None:
        if job.id not in self.tasks:
            self.tasks[job.id] = asyncio.create_task(self.run_job(job))

    def collect_finished(self) -> None:
        for job_id, task in list(self.tasks.items()):
            if not task.done():
                continue
            del self.tasks[job_id]
            if not task.cancelled() and task.exception() is not None:
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
                            active_job_ids=tuple(self.tasks),
                        )
                        if claimed_job is not None and claimed_job.id not in self.tasks:
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
                await wait_interval(self.stopping, self.settings.poll_seconds)
        finally:
            # Worker shutdown leaves detached executions running and preserves their journals.
            for task in self.tasks.values():
                task.cancel()
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
            self.journal.close()
            await self.api.close()
