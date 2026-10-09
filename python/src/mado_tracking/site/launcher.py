"""The launcher: claim site submissions, run each through its site's job shell, report the result.

It never watches a Job afterwards; the runner on the compute node reports for itself. Results are
kept on disk until the API has them, and the account that queued each Job is remembered so that
a Job canceled in the queue is removed from it with the site's cancel command.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..client import Client
from ..errors import ApiError, ConfigurationError, TransportError
from ..security import SecretMasker
from .job_shell import JobShellOutputError, scheduler_job_id
from .launcher_config import LauncherConfig, ProjectConnection, SiteAccount, SiteConfig
from .pending_reports import PendingReports
from .site_operations import SiteOperations
from .submission import failed_result, submission_job_ids, submit_to_site
from .submission_api import LauncherApi
from .submission_ledger import SubmissionLedger
from .transport import LocalSiteTransport, SiteTransport, SshSiteTransport

LOGGER = logging.getLogger(__name__)
# The API answers this when the Jobs are no longer this launcher's `submitting` ones.
INVALID_SUBMISSION_STATUS = 409
TransportFactory = Callable[[SiteConfig, SiteAccount], SiteTransport]
ClientFactory = Callable[..., Client]


@dataclass
class ProjectLink:
    project: ProjectConnection
    api: LauncherApi


class Launcher:
    def __init__(
        self,
        config: LauncherConfig,
        *,
        client_factory: ClientFactory = Client,
        transport_factory: TransportFactory | None = None,
    ):
        self.config = config
        self.masker = SecretMasker([project.token for project in config.projects])
        self.links = {
            project.name: ProjectLink(
                project,
                LauncherApi(
                    client_factory(api_url=project.api_url, api_token=project.token),
                    launcher_id=config.launcher_id,
                ),
            )
            for project in config.projects
        }
        self.sites = {site.target_id: site for site in config.sites}
        self.pending = PendingReports(config.state_directory / "pending-reports")
        self.ledger = SubmissionLedger(config.state_directory / "submissions")
        self.transport_factory = transport_factory or self.default_transport
        self.transports: dict[tuple[str, str], SiteTransport] = {}

    def default_transport(self, site: SiteConfig, account: SiteAccount) -> SiteTransport:
        if site.connection.local:
            return LocalSiteTransport(masker=self.masker)
        return SshSiteTransport(
            site.connection.endpoint(account), state_directory=self.config.state_directory, masker=self.masker
        )

    def transport_for(self, site: SiteConfig, account: SiteAccount) -> SiteTransport:
        key = (site.target_id, account.key)
        if key not in self.transports:
            self.transports[key] = self.transport_factory(site, account)
        return self.transports[key]

    def close(self) -> None:
        for transport in self.transports.values():
            transport.close()
        self.transports.clear()
        for link in self.links.values():
            link.api.client.close()

    def run_forever(self, stop: threading.Event) -> None:
        try:
            while not stop.is_set():
                try:
                    self.run_once()
                except (ApiError, ConfigurationError, OSError) as error:
                    LOGGER.error("Launcher cycle failed: %s", self.masker.mask(str(error)))
                stop.wait(self.config.poll_seconds)
        finally:
            self.close()

    def run_once(self) -> None:
        self.resend_pending_reports()
        for link in self.links.values():
            for site in self.config.sites:
                self.submit_claimed(link, site)
            self.cancel_in_queue(link)
        self.ledger.prune()

    # Submissions ----------------------------------------------------------------------------

    def submit_claimed(self, link: ProjectLink, site: SiteConfig) -> None:
        try:
            submissions = link.api.claim([site.target_id], limit=site.max_active_submissions)
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning(
                "Claim for site %s (%s) failed: %s",
                site.target_id,
                link.project.name,
                self.masker.mask(str(error)),
            )
            return
        for submission in submissions:
            try:
                result = self.submit(site, submission, link.project)
            except (KeyError, TypeError, ValueError) as error:
                # Without readable Job IDs nothing can be reported; the API fails them in time.
                LOGGER.error("A submission for site %s is malformed: %s", site.target_id, error)
                continue
            self.report(link, result)

    def submit(
        self, site: SiteConfig, submission: dict[str, Any], project: ProjectConnection
    ) -> dict[str, Any]:
        job_ids = submission_job_ids(submission)
        if str(submission.get("target", {}).get("id")) != site.target_id:
            return failed_result(job_ids, "The launcher received a submission for another site")
        email = str((submission.get("requester") or {}).get("email") or "")
        account = site.account_for(email)
        if account is None:
            return failed_result(
                job_ids, f"No account on this site is configured for {email or 'the requester'}"
            )
        try:
            plan = site.submission.plan(api_url=project.api_url, variables=account.variables)
            transport = self.transport_for(site, account)
            operations = SiteOperations(transport, work_directory=site.work_dir(account))
        except ConfigurationError as error:
            return failed_result(job_ids, f"The site settings are incomplete: {self.masker.mask(str(error))}")
        result = submit_to_site(submission, operations=operations, plan=plan, masker=self.masker)
        LOGGER.info(
            "Submission %s on site %s: %s %s",
            ",".join(job_ids),
            site.target_id,
            result["outcome"],
            result.get("schedulerJobId") or "",
        )
        if result["outcome"] == "submitted" and result.get("schedulerJobId"):
            self.ledger.record(
                job_ids,
                target_id=site.target_id,
                account=account.key,
                scheduler_job_id=result["schedulerJobId"],
            )
        return result

    def report(self, link: ProjectLink, result: dict[str, Any]) -> None:
        # Saved first: the job shell has submitted, so the report must survive a crash from here.
        path = self.pending.save({"project": link.project.name, "result": result})
        if self.deliver(link, result):
            self.pending.discard(path)

    def deliver(self, link: ProjectLink, result: dict[str, Any]) -> bool:
        """True when the report needs no resend (delivered, or refused for good)."""
        try:
            link.api.report([result])
            return True
        except ApiError as error:
            if error.status_code == INVALID_SUBMISSION_STATUS:
                # Reported before (a lost answer), or the Jobs left `submitting` meanwhile.
                LOGGER.warning(
                    "Report for %s refused: %s", ",".join(result["jobIds"]), self.masker.mask(str(error))
                )
                return True
            if (
                error.status_code is not None
                and 400 <= error.status_code < 500
                and error.status_code not in {408, 429}
            ):
                LOGGER.error(
                    "Report for %s refused: %s", ",".join(result["jobIds"]), self.masker.mask(str(error))
                )
                return True
            LOGGER.warning(
                "Report for %s deferred: %s", ",".join(result["jobIds"]), self.masker.mask(str(error))
            )
            return False

    def resend_pending_reports(self) -> None:
        for path, saved in self.pending.items():
            link = self.links.get(str(saved.get("project")))
            result = saved.get("result")
            if link is None or not isinstance(result, dict):
                self.pending.discard(path)
                continue
            if self.deliver(link, result):
                self.pending.discard(path)

    # Cancellations in the scheduler queue ----------------------------------------------------

    def cancel_in_queue(self, link: ProjectLink) -> None:
        try:
            items = link.api.cancellations(list(self.sites))
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning(
                "Cancellation list (%s) failed: %s", link.project.name, self.masker.mask(str(error))
            )
            return
        done = [item["jobId"] for item in items if self.cancel(item)]
        if not done:
            return
        try:
            link.api.report_cancellations(done)
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning("Cancellation report failed: %s", self.masker.mask(str(error)))
            return
        for job_id in done:
            self.ledger.forget(job_id)

    def cancel(self, item: dict[str, Any]) -> bool:
        """Remove one Job from its scheduler queue; False leaves it for the next poll."""
        job_id, site = str(item.get("jobId")), self.sites.get(str(item.get("targetId")))
        try:
            queued_id = scheduler_job_id(str(item.get("schedulerJobId") or "").encode())
        except JobShellOutputError:
            queued_id = None
        if site is None or queued_id is None:
            LOGGER.warning("Job %s cannot be removed from a scheduler queue this launcher knows", job_id)
            return True
        if site.cancel_command is None:
            LOGGER.info(
                "Site %s has no cancel_command; Job %s's runner ends when it starts", site.target_id, job_id
            )
            return True
        account_key = self.ledger.account_for(job_id) or ("shared" if site.account_mode == "shared" else None)
        account = site.account_by_key(account_key) if account_key is not None else None
        if account is None:
            LOGGER.warning("The account that queued Job %s is unknown; it stays in the queue", job_id)
            return True
        try:
            transport = self.transport_for(site, account)
            result = SiteOperations(transport, work_directory=site.work_dir(account)).cancel(
                site.cancel_command, scheduler_job_id=queued_id
            )
        except TransportError as error:
            LOGGER.warning("Cancel of Job %s deferred: %s", job_id, self.masker.mask(str(error)))
            return False
        except ConfigurationError as error:
            LOGGER.error("Cancel of Job %s impossible: %s", job_id, self.masker.mask(str(error)))
            return True
        if result.exit_code:
            # Usually the job already left the queue; retrying would only repeat the refusal.
            LOGGER.warning(
                "Cancel command for Job %s exited with %s: %s",
                job_id,
                result.exit_code,
                transport.diagnostic(result.stderr),
            )
        return True


def run_launcher(config: LauncherConfig, *, once: bool, stop: threading.Event | None = None) -> None:
    launcher = Launcher(config)
    if once:
        try:
            launcher.run_once()
        finally:
            launcher.close()
        return
    launcher.run_forever(stop or threading.Event())
