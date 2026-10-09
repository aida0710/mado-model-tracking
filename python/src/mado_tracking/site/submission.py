"""Submit one SiteSubmission through a site's job shell and describe the outcome for the API.

Shared by the launcher (over SSH) and `mado-tracking submit` (on the login node). Setting up the
work directory is retried; the job shell itself runs once, because a lost answer may mean the
scheduler already holds the job, and a second submission would run it twice.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, TypeVar

from ..errors import ConfigurationError, TransportError
from ..security import SecretMasker
from .bundle import runner_installation
from .job_shell import JobShellOutputError, job_shell_environment, job_shell_error, scheduler_job_id
from .site_operations import SiteOperations
from .spec_directory import RunnerSettings, ordered_jobs, spec_files

LOGGER = logging.getLogger(__name__)
SETUP_ATTEMPTS = 3
SETUP_RETRY_SECONDS = 2.0
Result = TypeVar("Result")


@dataclass(frozen=True)
class SubmissionPlan:
    """How one site submits: its job shell, runner and the values the job shell receives."""

    job_shell: bytes
    runner_python: str
    # The API as the compute nodes reach it (often another host name than the launcher uses).
    api_url: str
    runner_settings: RunnerSettings
    variables: Mapping[str, str] = field(default_factory=dict)
    secrets: Mapping[str, Any] | None = None


def submission_job_ids(submission: Mapping[str, Any]) -> list[str]:
    return [str(job["job"]["id"]) for job in ordered_jobs(submission)]


def failed_result(job_ids: list[str], error: str) -> dict[str, Any]:
    return {"jobIds": job_ids, "outcome": "failed", "schedulerJobId": None, "error": error}


def _with_retries(operation: Callable[[], Result], *, sleep: Callable[[float], None]) -> Result:
    for attempt in range(SETUP_ATTEMPTS):
        try:
            return operation()
        except TransportError:
            if attempt == SETUP_ATTEMPTS - 1:
                raise
            sleep(SETUP_RETRY_SECONDS * (attempt + 1))
    raise AssertionError("setup attempts exhausted")


def submit_to_site(
    submission: Mapping[str, Any],
    *,
    operations: SiteOperations,
    plan: SubmissionPlan,
    masker: SecretMasker,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Prepare the work directory, run the job shell once, and return a SiteSubmissionResult."""
    job_ids = submission_job_ids(submission)
    jobs = ordered_jobs(submission)
    target_id = str(submission["target"]["id"])

    def prepare() -> tuple[str, str, str]:
        runner = operations.ensure_runner(runner_installation(plan.runner_python))
        job_shell = operations.ensure_job_shell(plan.job_shell)
        files = spec_files(
            submission, api_url=plan.api_url, settings=plan.runner_settings, secrets=plan.secrets
        )
        return runner, job_shell, operations.write_spec_directory(job_ids[0], files)

    try:
        runner, job_shell, spec_directory = _with_retries(prepare, sleep=sleep)
        environment = job_shell_environment(
            jobs, spec_directory=spec_directory, runner=runner, target_id=target_id, variables=plan.variables
        )
    except (TransportError, ConfigurationError, OSError) as error:
        return failed_result(job_ids, f"The site could not be prepared: {masker.mask(str(error))}")
    try:
        result = operations.run_job_shell(job_shell, spec_directory=spec_directory, environment=environment)
    except TransportError as error:
        LOGGER.error("Job shell for %s lost its connection: %s", ", ".join(job_ids), masker.mask(str(error)))
        return failed_result(
            job_ids,
            "The connection was lost while the job shell ran; the scheduler may still hold the job "
            f"({masker.mask(str(error))})",
        )
    if result.exit_code:
        return failed_result(job_ids, job_shell_error(result.exit_code, result.stderr, masker))
    try:
        scheduler_id = scheduler_job_id(result.stdout)
    except JobShellOutputError as error:
        return failed_result(job_ids, str(error))
    return {"jobIds": job_ids, "outcome": "submitted", "schedulerJobId": scheduler_id, "error": None}
