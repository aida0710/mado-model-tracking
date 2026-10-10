"""A site's settings as the API hands them out, and the SubmissionPlan of one claimed submission.

Every SiteSubmission carries the site's settings at claim time (`settings`), the job shell
version its Jobs recorded (`jobShell`) and whose account it runs as (`account`: the SSH user, the
work directory and the variables, the person's own on top of the site's), so one submission never
mixes the settings of two moments. `mado-tracking submit` reads the same shapes from
GET /manual-submissions/sites/:id before it claims.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .api_documents import DocumentReader
from .spec_directory import RunnerSettings
from .submission import SubmissionPlan


@dataclass(frozen=True)
class SiteConnection:
    """Where a launcher logs in (automatic sites only)."""

    host: str
    port: int
    # [user@]host[:port] of each host to pass through, in order.
    jump_hosts: tuple[str, ...]
    # known_hosts lines of the host and every jump host; no other host key is accepted.
    known_hosts: str

    @classmethod
    def parse(cls, reader: DocumentReader) -> SiteConnection:
        return cls(
            host=reader.text("host"),
            port=reader.integer("port"),
            jump_hosts=reader.text_list("jumpHosts"),
            known_hosts=reader.text("knownHosts"),
        )


@dataclass(frozen=True)
class SiteSettings:
    """The parts of a site's global settings that a launcher or `mado-tracking submit` uses."""

    connection: SiteConnection | None
    runner_python: str
    # The API as compute nodes reach it; None for the URL the launcher or submit uses.
    runner_api_url: str | None
    # Shell text that removes one queued scheduler job (MMT_SCHEDULER_JOB_ID); None without a queue.
    cancel_command: str | None
    gpu_assignment: str
    lease_gpu_ids: tuple[str, ...]
    cancel_grace_seconds: float
    max_output_files: int
    max_active_submissions: int

    @classmethod
    def parse(cls, reader: DocumentReader) -> SiteSettings:
        connection = reader.optional_child("connection")
        return cls(
            connection=SiteConnection.parse(connection) if connection is not None else None,
            runner_python=reader.text("runnerPython"),
            runner_api_url=reader.optional_text("runnerApiUrl"),
            cancel_command=reader.optional_text("cancelCommand"),
            gpu_assignment=reader.text("gpuAssignment"),
            lease_gpu_ids=reader.text_list("leaseGpuIds"),
            cancel_grace_seconds=reader.number("cancelGraceSeconds"),
            max_output_files=reader.integer("maxOutputFiles"),
            max_active_submissions=reader.integer("maxActiveSubmissions"),
        )


@dataclass(frozen=True)
class SubmissionAccount:
    """Whose account one job shell call runs as, with the work directory and variables for it."""

    # The SSH user a launcher logs in as; '' for manual submissions, which run as whoever submits.
    account_name: str
    work_directory: str
    # The site's variables with the person's own on top.
    variables: Mapping[str, str]
    # The launcher key to log in with; None for manual submissions.
    key_id: str | None

    @classmethod
    def parse(cls, reader: DocumentReader) -> SubmissionAccount:
        return cls(
            account_name=reader.text("accountName"),
            work_directory=reader.text("workDirectory"),
            variables=reader.text_map("variables"),
            key_id=reader.optional_uuid("keyId"),
        )


@dataclass(frozen=True)
class JobShell:
    """One version of a site's job shell; versions never change once saved on the Web."""

    version: int
    content: bytes = field(repr=False)

    @classmethod
    def parse(cls, reader: DocumentReader) -> JobShell:
        return cls(version=reader.integer("version"), content=reader.text("content").encode())


@dataclass(frozen=True)
class SubmissionSetup:
    """How one claimed SiteSubmission is submitted: the site's settings, job shell and account."""

    settings: SiteSettings
    job_shell: JobShell
    account: SubmissionAccount

    @classmethod
    def of(cls, submission: Mapping[str, Any]) -> SubmissionSetup:
        reader = DocumentReader(submission, label="submission")
        return cls(
            settings=SiteSettings.parse(reader.child("settings")),
            job_shell=JobShell.parse(reader.child("jobShell")),
            account=SubmissionAccount.parse(reader.child("account")),
        )

    def plan(self, *, api_url: str, secrets: Mapping[str, Any] | None = None) -> SubmissionPlan:
        """`api_url` is the API as the caller reaches it; runnerApiUrl replaces it for the runner."""
        return SubmissionPlan(
            job_shell=self.job_shell.content,
            runner_python=self.settings.runner_python,
            api_url=self.settings.runner_api_url or api_url,
            runner_settings=RunnerSettings(
                work_directory=self.account.work_directory,
                gpu_assignment=self.settings.gpu_assignment,
                gpu_ids=self.settings.lease_gpu_ids,
                cancel_grace_seconds=self.settings.cancel_grace_seconds,
                max_output_files=self.settings.max_output_files,
            ),
            variables=self.account.variables,
            secrets=secrets,
        )


@dataclass(frozen=True)
class ManualSiteConfiguration:
    """GET /manual-submissions/sites/:id: what `mado-tracking submit` checks before it claims."""

    target_name: str
    # None until the site's owner saves one; a claim would then only fail the waiting Jobs.
    job_shell: JobShell | None
    # The caller's own work directory and variables on this site.
    account: SubmissionAccount

    @classmethod
    def parse(cls, document: Any) -> ManualSiteConfiguration:
        reader = DocumentReader(document, label="site configuration")
        job_shell = reader.optional_child("jobShell")
        return cls(
            target_name=reader.child("target").text("name"),
            job_shell=JobShell.parse(job_shell) if job_shell is not None else None,
            account=SubmissionAccount.parse(reader.child("account")),
        )
