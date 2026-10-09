"""The site runner: one Job on a compute node, reporting to the API itself with the Job token.

runner/start → inputs → GPUs → phase running → container → outputs → metrics and declarations →
runner/finish. A heartbeat every five seconds carries the phase and answers cancelRequested; a
rejected heartbeat (401/410: the Job is over) stops the container and ends the runner without a
finish. SIGTERM, the scheduler's time limit, stops the container and finishes as timed_out.
The container runs through the worker's own execution code (execute_registered_code).
"""

from __future__ import annotations

import asyncio
import enum
import logging
import os
import signal
import socket
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import httpx

from ..artifact_uploads import UploadStateStore
from ..errors import ApiError, ConfigurationError, LeaseRejected
from ..http import RETRYABLE_STATUS
from ..security import SecretMasker, secret_values
from ..settings import ApiSettings
from ..worker.config import DEFAULT_TELEMETRY_SECONDS
from ..worker.container_layout import host_environment
from ..worker.container_outputs import validate_results
from ..worker.contracts import SITE_EXECUTORS, WorkerJob
from ..worker.event_wait import wait_interval
from ..worker.execution_specification import build_execution_specification
from ..worker.host_execution import CommandExecution, ExecutionCanceled
from ..worker.host_state import process_identity, write_json
from ..worker.job_execution import execute_registered_code
from ..worker.runtime_capability import ContainerStateUncertain, RuntimeUnavailable
from ..worker.telemetry import collect_system_metrics
from .daemon_thread import run_in_daemon_thread
from .gpu_lease import GpuLeaseError, GpuLeases
from .log_forwarder import LogForwarder
from .runner_api import RunnerApi, upload_state_directory
from .runner_inputs import InputStaging, StagedInputs
from .runner_outputs import OutputSaver
from .spec_directory import RunnerSettings, SpecDirectory

LOGGER = logging.getLogger(__name__)
# Calls that must reach the API (start, finish, saving results) ride out an outage of minutes.
API_ATTEMPTS = 8
API_RETRY_INITIAL_SECONDS = 2.0
API_RETRY_MAX_SECONDS = 30.0
# After a stop, the container gets its grace period plus Docker's stop/remove round trips.
STOP_MARGIN_SECONDS = 30.0
# jobs.runner_host in the API's database.
MAX_HOST_LENGTH = 253
WORKSPACE_MODE = 0o700
FIRST_PHASE = "waiting_resources"

EXIT_FINISHED = 0
EXIT_FAILED = 1
EXIT_CONFIGURATION_ERROR = 2
# The API refused the Job (already ended, another runner, revoked token); nothing was reported.
EXIT_NOT_RUN = 3

Result = TypeVar("Result")


@dataclass(frozen=True)
class RunnerTimings:
    heartbeat_seconds: float = 5.0
    log_forward_seconds: float = 1.0
    gpu_wait_seconds: float = 15.0
    telemetry_seconds: float = DEFAULT_TELEMETRY_SECONDS
    api_retry_seconds: float = API_RETRY_INITIAL_SECONDS


class StopReason(enum.Enum):
    CANCELED = "canceled"
    TIMED_OUT = "timed_out"
    INTERRUPTED = "interrupted"
    # The API ended the Job or revoked its token: nothing more can be reported.
    LOST = "lost"


class Stopped(Exception):
    def __init__(self, reason: StopReason):
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class Outcome:
    status: str
    exit_code: int | None = None
    error: str | None = None
    end_reason: str | None = None


def stopped_outcome(reason: StopReason) -> Outcome:
    if reason is StopReason.CANCELED:
        return Outcome("canceled")
    if reason is StopReason.TIMED_OUT:
        return Outcome(
            "failed",
            error="The scheduler stopped the Job at its time limit (SIGTERM)",
            end_reason="timed_out",
        )
    if reason is StopReason.INTERRUPTED:
        return Outcome("failed", error="The runner was interrupted (SIGINT)")
    return Outcome("failed", error="The API ended the Job")


def is_transient(error: Exception) -> bool:
    if isinstance(error, httpx.TransportError):
        return True
    return isinstance(error, ApiError) and (
        error.status_code is None or error.status_code in RETRYABLE_STATUS
    )


def scheduler_gpu_ids(environment: Mapping[str, str], count: int) -> list[str]:
    """The GPUs a scheduler gave this node: CUDA_VISIBLE_DEVICES, else the first `count` ordinals."""
    if count <= 0:
        return []
    visible = [value.strip() for value in environment.get("CUDA_VISIBLE_DEVICES", "").split(",")]
    return [value for value in visible if value] or [str(index) for index in range(count)]


def array_index_from_environment(environment: Mapping[str, str]) -> int:
    raw = environment.get("MMT_ARRAY_INDEX", "0").strip() or "0"
    if not raw.isdigit():
        raise ConfigurationError("MMT_ARRAY_INDEX must be a non-negative integer (the array number from 0)")
    return int(raw)


def registry_secrets(secrets: Mapping[str, Any]) -> list[str]:
    registry = secrets.get("registry")
    if isinstance(registry, dict) and isinstance(registry.get("password"), str):
        return [registry["password"]]
    return []


class SiteRunner:
    """Read the spec directory and run its Job; a Job that fails validation is failed at the API."""

    def __init__(
        self,
        spec_directory: SpecDirectory,
        *,
        array_index: int,
        environment: Mapping[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        hostname: str | None = None,
        gpu_leases: Callable[[Path, str], GpuLeases] | None = None,
        timings: RunnerTimings | None = None,
        handle_signals: bool = True,
    ):
        self.spec = spec_directory
        self.array_index = array_index
        self.environment = dict(os.environ if environment is None else environment)
        self.transport = transport
        self.hostname = (hostname or socket.gethostname())[:MAX_HOST_LENGTH]
        self.gpu_leases = gpu_leases
        self.timings = timings or RunnerTimings()
        self.handle_signals = handle_signals
        self.instance_id = str(uuid.uuid4())

    async def run(self) -> int:
        payload = self.spec.job_payload(self.array_index)
        settings = self.spec.runner_settings()
        secrets = self.spec.secrets()
        token = payload.get("jobToken")
        if not isinstance(token, str) or not token:
            raise ConfigurationError("The spec directory's Job has no Job token")
        api_settings = ApiSettings.from_environment(url=self.spec.api_url(), token=token)
        try:
            job = WorkerJob.parse(payload, executors=SITE_EXECUTORS)
        except ConfigurationError as error:
            return await self.report_invalid_job(payload, api_settings, error)
        masker = SecretMasker([*registry_secrets(secrets), *secret_values(job.code_version["environment"])])
        workspace = Path(settings.work_directory) / job.id
        api = RunnerApi(
            url=api_settings.url,
            token=token,
            job=job,
            instance_id=self.instance_id,
            masker=masker,
            transport=self.transport,
            upload_state_store=UploadStateStore(upload_state_directory(workspace)),
        )
        hostname = self.hostname
        leases = self.gpu_leases or (
            lambda work_directory, job_id: GpuLeases(
                work_directory, hostname=hostname, job_id=job_id, pid=os.getpid()
            )
        )
        session = RunnerSession(
            job,
            api=api,
            api_settings=api_settings,
            settings=settings,
            secrets=secrets,
            workspace=workspace,
            environment=self.environment,
            hostname=self.hostname,
            gpu_leases=leases,
            timings=self.timings,
        )
        try:
            return await session.run(handle_signals=self.handle_signals)
        finally:
            await api.close()

    async def report_invalid_job(
        self, payload: dict[str, Any], api_settings: ApiSettings, error: ConfigurationError
    ) -> int:
        """Fail a Job whose instructions do not validate instead of leaving it to wait in vain."""
        LOGGER.error("The Job in the spec directory failed validation: %s", error)
        identity = payload.get("job")
        if not isinstance(identity, dict) or not identity.get("id") or not identity.get("projectId"):
            return EXIT_CONFIGURATION_ERROR
        unverified = WorkerJob(
            job=identity, run={}, target={}, code_version={}, model_version=None, input_datasets=[]
        )
        api = RunnerApi(
            url=api_settings.url,
            token=api_settings.token,
            job=unverified,
            instance_id=self.instance_id,
            transport=self.transport,
        )
        try:
            await api.start(host=self.hostname, gpu_ids=[], phase=FIRST_PHASE)
            await api.finish(
                status="failed",
                exit_code=None,
                error=f"WorkerJob validation failed: {error}",
                end_reason=None,
            )
        except (ApiError, ConfigurationError) as report_error:
            LOGGER.error("The invalid Job could not be reported: %s", report_error)
        finally:
            await api.close()
        return EXIT_CONFIGURATION_ERROR


class RunnerSession:
    """One validated Job from runner/start to runner/finish."""

    def __init__(
        self,
        job: WorkerJob,
        *,
        api: RunnerApi,
        api_settings: ApiSettings,
        settings: RunnerSettings,
        secrets: dict[str, Any],
        workspace: Path,
        environment: Mapping[str, str],
        hostname: str,
        gpu_leases: Callable[[Path, str], GpuLeases],
        timings: RunnerTimings,
    ):
        self.job = job
        self.api = api
        self.api_settings = api_settings
        self.settings = settings
        self.secrets = secrets
        self.workspace = workspace
        self.environment = environment
        self.hostname = hostname
        self.make_gpu_leases = gpu_leases
        self.timings = timings
        self.masker = api.masker
        self.gpu_count = int(job.job.get("gpuCount") or 0)
        self.phase = FIRST_PHASE
        self.gpu_ids: list[str] = (
            scheduler_gpu_ids(environment, self.gpu_count) if settings.gpu_assignment == "scheduler" else []
        )
        self.stop_reason: StopReason | None = None
        self.stopping = asyncio.Event()
        self.finished = asyncio.Event()
        self.workspace_ready = False
        self.state: dict[str, Any] = {
            "jobId": job.id,
            "status": "starting",
            "runnerPid": os.getpid(),
            "runnerIdentity": process_identity(os.getpid()),
            "sourceSnapshotRequired": True,
        }
        self.forwarder = LogForwarder(workspace, send=api.logs, masker=self.masker)
        self.telemetry_step = 0

    async def run(self, *, handle_signals: bool) -> int:
        if handle_signals:
            # Installed first: a time limit that strikes while the API is slow still ends as timed_out.
            self.install_signal_handlers()
        try:
            started = await self.with_api_retries(
                lambda: self.api.start(host=self.hostname, gpu_ids=self.gpu_ids, phase=self.phase)
            )
        except LeaseRejected as error:
            LOGGER.error("The API refused to start Job %s: %s", self.job.id, self.masker.mask(str(error)))
            return EXIT_NOT_RUN
        except (ApiError, ConfigurationError) as error:
            LOGGER.error(
                "Job %s could not be started at the API: %s", self.job.id, self.masker.mask(str(error))
            )
            return EXIT_NOT_RUN
        if started["cancelRequested"]:
            return await self.finish(stopped_outcome(StopReason.CANCELED))
        if self.stop_reason is not None:
            return await self.finish(stopped_outcome(self.stop_reason))
        try:
            self.workspace.parent.mkdir(mode=WORKSPACE_MODE, parents=True, exist_ok=True)
            self.workspace.mkdir(mode=WORKSPACE_MODE)
        except FileExistsError:
            return await self.finish(
                Outcome("failed", error="The Job's workspace already exists on the site")
            )
        except OSError as error:
            return await self.finish(
                Outcome("failed", error=f"The site work directory cannot be used: {error.strerror}")
            )
        self.workspace_ready = True
        write_json(self.workspace / "state.json", self.state)
        background = [asyncio.create_task(self.heartbeat_loop()), asyncio.create_task(self.log_loop())]
        try:
            outcome = await self.execute()
        finally:
            self.finished.set()
            for task in background:
                task.cancel()
            await asyncio.gather(*background, return_exceptions=True)
        if self.stop_reason is StopReason.LOST:
            self.record_terminal_state("failed")
            LOGGER.error("Job %s ended at the API; the runner stopped without a finish", self.job.id)
            return EXIT_NOT_RUN
        await self.flush_logs()
        return await self.finish(outcome)

    # Stop requests -----------------------------------------------------------------------------

    def install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        # The login session that started a direct-host runner may end; the Job does not.
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        loop.add_signal_handler(signal.SIGTERM, self.request_stop, StopReason.TIMED_OUT)
        loop.add_signal_handler(signal.SIGINT, self.request_stop, StopReason.INTERRUPTED)

    def request_stop(self, reason: StopReason) -> None:
        # The first reason decides the finish, except that a lost Job cannot be finished at all.
        if self.stop_reason is None or reason is StopReason.LOST:
            self.stop_reason = reason
        if self.workspace_ready:
            # CommandExecution and DockerContainer stop the running command when this file appears.
            (self.workspace / "cancel.request").touch(mode=0o600)
        self.stopping.set()

    async def until_stopped(self, awaitable: Awaitable[Result]) -> Result:
        """Await the operation, or raise Stopped as soon as a stop is requested."""
        task = asyncio.ensure_future(awaitable)
        stop = asyncio.ensure_future(self.stopping.wait())
        try:
            done, _pending = await asyncio.wait({task, stop}, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return task.result()
            assert self.stop_reason is not None
            raise Stopped(self.stop_reason)
        finally:
            for pending in (task, stop):
                pending.cancel()
            await asyncio.gather(task, stop, return_exceptions=True)

    # Background loops --------------------------------------------------------------------------

    async def heartbeat_loop(self) -> None:
        loop = asyncio.get_running_loop()
        telemetry_due = loop.time() + self.timings.telemetry_seconds
        while not self.finished.is_set():
            await wait_interval(self.finished, self.timings.heartbeat_seconds)
            if self.finished.is_set():
                return
            await self.send_heartbeat()
            if self.phase == "running" and loop.time() >= telemetry_due:
                telemetry_due = loop.time() + self.timings.telemetry_seconds
                await self.send_telemetry()

    async def send_heartbeat(self) -> None:
        try:
            state = await self.api.heartbeat(phase=self.phase, gpu_ids=self.gpu_ids)
        except LeaseRejected as error:
            LOGGER.error("Heartbeat rejected; stopping: %s", self.masker.mask(str(error)))
            self.request_stop(StopReason.LOST)
            return
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning("Heartbeat failed: %s", self.masker.mask(str(error)))
            return
        if state["cancelRequested"]:
            self.request_stop(StopReason.CANCELED)

    async def send_telemetry(self) -> None:
        container = self.state.get("container") or {}
        pid = int(container.get("pid") or self.state.get("processPid") or 0)
        state_path = self.workspace / "telemetry-state.json"
        step = self.telemetry_step
        gpu_ids = list(self.gpu_ids)
        try:
            metrics = await run_in_daemon_thread(
                lambda: collect_system_metrics(pid=pid, gpu_ids=gpu_ids, step=step, state_path=state_path),
                name="mmt-telemetry",
            )
            if metrics:
                await self.api.metrics(metrics)
                self.telemetry_step += 1
        except LeaseRejected:
            self.request_stop(StopReason.LOST)
        except (ApiError, OSError, ValueError) as error:
            LOGGER.warning("Telemetry failed: %s", self.masker.mask(str(error)))

    async def log_loop(self) -> None:
        while not self.finished.is_set():
            await wait_interval(self.finished, self.timings.log_forward_seconds)
            try:
                await self.forwarder.forward()
            except LeaseRejected:
                self.request_stop(StopReason.LOST)
                return

    async def flush_logs(self) -> None:
        try:
            await self.forwarder.forward(final=True)
        except LeaseRejected:
            pass

    # The Job -----------------------------------------------------------------------------------

    async def execute(self) -> Outcome:
        staging = InputStaging(
            self.job,
            api=self.api,
            api_url=self.api_settings.url,
            workspace=self.workspace,
            work_directory=Path(self.settings.work_directory),
            state=self.state,
            secrets=self.secrets,
            masker=self.masker,
            cancel_grace_seconds=self.settings.cancel_grace_seconds,
            notify=self.forwarder.add,
        )
        try:
            staged = await self.until_stopped(staging.stage())
        except (Stopped, ExecutionCanceled):
            await staging.release_datasets()
            return stopped_outcome(self.stop_reason or StopReason.CANCELED)
        except (ApiError, ConfigurationError, RuntimeUnavailable, OSError, ValueError, RuntimeError) as error:
            await staging.release_datasets()
            return self.failed_before_start(f"Job inputs could not be prepared: {error}")
        leases = (
            self.make_gpu_leases(Path(self.settings.work_directory), self.job.id)
            if self.settings.gpu_assignment == "lease" and self.gpu_count > 0
            else None
        )
        try:
            if leases is not None:
                try:
                    self.gpu_ids = await self.until_stopped(self.lease_gpus(leases))
                except (GpuLeaseError, ConfigurationError) as error:
                    await staging.release_datasets()
                    return self.failed_before_start(f"GPUs could not be assigned: {error}")
            self.phase = "running"
            await self.send_heartbeat()
            if self.stop_reason is not None:
                raise Stopped(self.stop_reason)
            outcome, results = await self.run_container(staged)
            return await self.save_results(outcome, results)
        except Stopped as stopped:
            await staging.release_datasets()
            return stopped_outcome(stopped.reason)
        finally:
            if leases is not None:
                await run_in_daemon_thread(leases.release, name="mmt-gpu-release")

    def failed_before_start(self, message: str) -> Outcome:
        masked = self.masker.mask(message)
        self.forwarder.add("error", masked)
        return Outcome("failed", error=masked)

    async def lease_gpus(self, leases: GpuLeases) -> list[str]:
        announced = False
        candidates = self.settings.gpu_ids
        while True:
            chosen = await run_in_daemon_thread(
                lambda: leases.try_acquire(self.gpu_count, candidates), name="mmt-gpu-lease"
            )
            if chosen is not None:
                self.forwarder.add("info", f"Assigned GPUs {','.join(chosen)} on {self.hostname}")
                return chosen
            if not announced:
                self.forwarder.add("info", f"Waiting for {self.gpu_count} free GPUs on {self.hostname}")
                announced = True
            await asyncio.sleep(self.timings.gpu_wait_seconds)

    async def run_container(self, staged: StagedInputs) -> tuple[Outcome, dict[str, Any] | None]:
        specification = build_execution_specification(
            self.job,
            api=self.api_settings,
            gpu_ids=self.gpu_ids,
            install_dependencies=False,
            cancel_grace_seconds=self.settings.cancel_grace_seconds,
            max_output_files=self.settings.max_output_files,
        )
        specification["stagedInputs"] = staged.files
        if staged.host_runtime is not None:
            specification["hostRuntime"] = staged.host_runtime
        self.state["status"] = "running"
        write_json(self.workspace / "state.json", self.state)
        execution = CommandExecution(
            self.workspace,
            self.state,
            environment=host_environment(),
            masker=self.masker,
            cancel_grace_seconds=self.settings.cancel_grace_seconds,
        )
        running = asyncio.ensure_future(
            run_in_daemon_thread(
                lambda: execute_registered_code(self.workspace, specification, execution),
                name="mmt-container",
            )
        )
        stop = asyncio.ensure_future(self.stopping.wait())
        await asyncio.wait({running, stop}, return_when=asyncio.FIRST_COMPLETED)
        stop.cancel()
        await asyncio.gather(stop, return_exceptions=True)
        if not running.done():
            # cancel.request is in place; the container has its grace period to stop.
            await asyncio.wait({running}, timeout=self.settings.cancel_grace_seconds + STOP_MARGIN_SECONDS)
        if not running.done():
            LOGGER.error("The container did not stop in time; finishing without waiting for it")
            assert self.stop_reason is not None
            return stopped_outcome(self.stop_reason), None
        try:
            exit_code = running.result()
        except ExecutionCanceled:
            return stopped_outcome(self.stop_reason or StopReason.CANCELED), None
        except ContainerStateUncertain as error:
            return Outcome(
                "failed", error=f"Container state is uncertain: {self.masker.mask(str(error))}"
            ), None
        except (RuntimeUnavailable, OSError, ValueError, RuntimeError) as error:
            return Outcome("failed", error=self.masker.mask(str(error))), None
        if self.stop_reason is not None:
            return stopped_outcome(self.stop_reason), None
        if exit_code:
            return Outcome(
                "failed", exit_code=exit_code, error=f"Entrypoint exited with status {exit_code}"
            ), None
        try:
            results = validate_results(self.workspace / "outputs", max_files=self.settings.max_output_files)
        except (OSError, ValueError) as error:
            return Outcome("failed", exit_code=0, error=f"Container outputs were rejected: {error}"), None
        return Outcome("finished", exit_code=0), results

    async def save_results(self, outcome: Outcome, results: dict[str, Any] | None) -> Outcome:
        """The snapshot records what ran, so it is saved for every end but a time limit."""
        if self.stop_reason in {StopReason.TIMED_OUT, StopReason.LOST}:
            return outcome
        # After a cancel there is no deadline; before any stop, a later stop aborts the saving.
        guard = self.until_stopped if self.stop_reason is None else _unguarded
        saver = OutputSaver(self.job, api=self.api, workspace=self.workspace)
        snapshot = self.state.get("sourceSnapshot")
        try:
            if snapshot is not None:
                await guard(self.with_api_retries(lambda: saver.save_snapshot(snapshot)))
            elif outcome.status == "finished":
                return Outcome("failed", exit_code=outcome.exit_code, error="Source snapshot is missing")
        except (ApiError, ConfigurationError, OSError, ValueError) as error:
            saved = f"Source snapshot save failed: {self.masker.mask(str(error))}"
            message = "; ".join(part for part in (outcome.error, saved) if part)
            return Outcome("failed", exit_code=outcome.exit_code, error=message)
        if outcome.status != "finished" or results is None:
            return outcome
        try:
            await guard(self.with_api_retries(lambda: saver.save_outputs(results)))
        except ConfigurationError as error:
            return Outcome("failed", exit_code=outcome.exit_code, error=self.masker.mask(str(error)))
        except (ApiError, OSError, ValueError) as error:
            message = f"Container output API save failed: {self.masker.mask(str(error))}"
            return Outcome("failed", exit_code=outcome.exit_code, error=message)
        return outcome

    async def with_api_retries(self, operation: Callable[[], Awaitable[Result]]) -> Result:
        for attempt in range(API_ATTEMPTS):
            try:
                return await operation()
            except LeaseRejected:
                raise
            except (ApiError, httpx.TransportError) as error:
                if not is_transient(error) or attempt == API_ATTEMPTS - 1:
                    raise
                LOGGER.warning("API call interrupted; retrying: %s", self.masker.mask(str(error)))
                await asyncio.sleep(min(API_RETRY_MAX_SECONDS, self.timings.api_retry_seconds * 2**attempt))
        raise AssertionError("API attempts exhausted")

    def record_terminal_state(self, status: str) -> None:
        """A terminal state.json releases the Job's dataset cache pins."""
        if not self.workspace_ready:
            return
        self.state["status"] = status
        try:
            write_json(self.workspace / "state.json", self.state)
        except OSError as error:
            LOGGER.warning("The workspace state could not be saved: %s", error)

    async def finish(self, outcome: Outcome) -> int:
        self.record_terminal_state(outcome.status)
        try:
            await self.with_api_retries(
                lambda: self.api.finish(
                    status=outcome.status,
                    exit_code=outcome.exit_code,
                    error=outcome.error,
                    end_reason=outcome.end_reason,
                )
            )
        except LeaseRejected as error:
            LOGGER.error("The API refused the finish: %s", self.masker.mask(str(error)))
            return EXIT_NOT_RUN
        except (ApiError, ConfigurationError) as error:
            LOGGER.error("The finish did not reach the API: %s", self.masker.mask(str(error)))
            return EXIT_FAILED
        return EXIT_FINISHED if outcome.status == "finished" else EXIT_FAILED


async def _unguarded(awaitable: Awaitable[Result]) -> Result:
    return await awaitable


def run_site_runner(spec_directory: Path, *, environment: Mapping[str, str] | None = None) -> int:
    """`mado-tracking site-run <spec dir>`: run jobs/<MMT_ARRAY_INDEX>.json to its end."""
    os.umask(0o077)
    values = os.environ if environment is None else environment
    try:
        runner = SiteRunner(
            SpecDirectory(spec_directory),
            array_index=array_index_from_environment(values),
            environment=values,
        )
        return asyncio.run(runner.run())
    except ConfigurationError as error:
        LOGGER.error("%s", error)
        return EXIT_CONFIGURATION_ERROR
