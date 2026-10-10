"""The launcher: submit the site Jobs of the automatic sites assigned to it on the Web.

One poll:

    1. resend the reports that have not reached the API (pending_reports.py)
    2. GET /launcher/config: the sites, keys and connection checks of this launcher
    3. make and publish the listed keys, delete the others (launcher_keys.py)
    4. answer each connection check: log in as its account with its key and run `true`
    5. per site: claim, run each submission through the job shell once, report the result
    6. run the site's cancel command for Jobs canceled in the queue, as the account the API names

It never watches a Job afterwards; the runner on the compute node reports for itself. When a
submission or a cancel fails to log in (site, account, key), the poll's later submissions through
that login are failed with its reason without trying, and cancels leave it alone for a while
(login_failures.py); the next poll submits through it again, and a login that works is forgotten.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

from ..client import Client
from ..errors import ApiError, ConfigurationError, TransportError
from .file_archive import PRIVATE_DIRECTORY_MODE
from .job_shell import JobShellOutputError, scheduler_job_id
from .launcher_assignment import AssignedSite, ConnectionCheck, LauncherAssignment, SchedulerCancellation
from .launcher_config import LauncherConfig
from .launcher_keys import LauncherKeys
from .launcher_logins import SiteLogins
from .login_failures import LoginFailures
from .pending_reports import PendingReports
from .site_operations import SiteOperations
from .site_settings import SubmissionAccount, SubmissionSetup
from .submission import failed_result, submission_job_ids, submit_to_site
from .submission_api import LauncherApi
from .submission_ledger import SubmissionLedger
from .transport import SiteTransport, SshEndpoint, SshSiteTransport

LOGGER = logging.getLogger(__name__)
# A connection check runs this and nothing else.
CONNECTION_CHECK_COMMAND = ("true",)
CONNECTION_CHECK_TIMEOUT_SECONDS = 60.0
# site_connection_checks.message holds this much; the end of ssh's error says what went wrong.
MAX_CHECK_MESSAGE_CHARACTERS = 2000
# After a login (site, account, key) fails, cancels through it wait this long, rather than
# failing again at every poll until the key is in authorized_keys.
CANCEL_LOGIN_PAUSE_SECONDS = 600.0
PENDING_REPORTS_DIRECTORY = "pending-reports"
LEDGER_DIRECTORY = "submissions"
ClientFactory = Callable[..., Client]


class TransportFactory(Protocol):
    def __call__(self, endpoint: SshEndpoint, *, shared_connection: bool) -> SiteTransport: ...


class Launcher:
    def __init__(
        self,
        config: LauncherConfig,
        *,
        client_factory: ClientFactory = Client,
        transport_factory: TransportFactory | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.config = config
        self.client = client_factory(api_url=config.api_url, api_token=config.token)
        self.api = LauncherApi(self.client)
        # The client's masker knows the launcher's token; keys, transports and logs share it.
        self.masker = self.client.masker
        state = config.state_directory
        state.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
        self.keys = LauncherKeys(state, masker=self.masker)
        self.logins = SiteLogins(state, self.keys)
        self.pending = PendingReports(
            state / PENDING_REPORTS_DIRECTORY, send=self.api.report, notice=self.warn
        )
        self.ledger = SubmissionLedger(state / LEDGER_DIRECTORY)
        self.transport_factory = transport_factory or self.ssh_transport
        self.transports: dict[SshEndpoint, SiteTransport] = {}
        self.endpoints_in_use: set[SshEndpoint] = set()
        self.login_failures = LoginFailures(clock=clock)

    def warn(self, message: str) -> None:
        LOGGER.warning("%s", self.masker.mask(message))

    def ssh_transport(self, endpoint: SshEndpoint, *, shared_connection: bool) -> SiteTransport:
        return SshSiteTransport(
            endpoint,
            state_directory=self.config.state_directory,
            masker=self.masker,
            shared_connection=shared_connection,
        )

    def transport_for(self, endpoint: SshEndpoint) -> SiteTransport:
        """The shared connection of one site, account and key, kept while polls use it."""
        self.endpoints_in_use.add(endpoint)
        if endpoint not in self.transports:
            self.transports[endpoint] = self.transport_factory(endpoint, shared_connection=True)
        return self.transports[endpoint]

    def close_unused_transports(self) -> None:
        for endpoint in [endpoint for endpoint in self.transports if endpoint not in self.endpoints_in_use]:
            self.transports.pop(endpoint).close()
        self.endpoints_in_use.clear()

    def close(self) -> None:
        for transport in self.transports.values():
            transport.close()
        self.transports.clear()
        self.client.close()

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
        self.login_failures.start_poll()
        self.pending.resend()
        try:
            assignment = self.api.assignment()
        except (ApiError, ConfigurationError) as error:
            LOGGER.error("Reading this launcher's sites failed: %s", self.masker.mask(str(error)))
            return
        try:
            self.keys.synchronize(
                assignment.keys, launcher_name=assignment.launcher_name, publish=self.api.publish_key
            )
            for check in assignment.checks:
                self.answer_connection_check(assignment, check)
            for site in assignment.sites.values():
                self.submit_claimed(site)
            self.cancel_in_queue(assignment)
            self.ledger.prune()
        finally:
            self.close_unused_transports()

    # Connection checks -------------------------------------------------------------------------

    def answer_connection_check(self, assignment: LauncherAssignment, check: ConnectionCheck) -> None:
        failure = self.login_failure(assignment.sites.get(check.target_id), check.account)
        if failure is not None:
            failure = failure[-MAX_CHECK_MESSAGE_CHARACTERS:]
        LOGGER.info(
            "Connection check %s for site %s: %s",
            check.id,
            check.target_id,
            "succeeded" if failure is None else f"failed: {failure}",
        )
        try:
            self.api.report_connection_check(check.id, failure=failure)
        except ApiError as error:
            # Still queued: the next poll checks again. Answered or expired: nothing is left to do.
            LOGGER.warning("Connection check %s was not reported: %s", check.id, self.masker.mask(str(error)))

    def login_failure(self, site: AssignedSite | None, account: SubmissionAccount) -> str | None:
        """Why logging in on the site as the account failed; None when `true` ran there."""
        if site is None:
            return "This launcher does not submit to the site"
        try:
            endpoint = self.logins.endpoint(site.target_id, site.settings.connection, account)
            # A login of its own: a shared connection would hide a key the site no longer takes.
            transport = self.transport_factory(endpoint, shared_connection=False)
        except ConfigurationError as error:
            return self.masker.mask(str(error))
        try:
            result = transport.run(list(CONNECTION_CHECK_COMMAND), timeout=CONNECTION_CHECK_TIMEOUT_SECONDS)
        except TransportError as error:
            return self.masker.mask(str(error))
        finally:
            transport.close()
        if result.exit_code:
            return (
                f"Logged in, but `true` exited with status {result.exit_code}: "
                f"{transport.diagnostic(result.stderr)}"
            )
        return None

    # Submissions -------------------------------------------------------------------------------

    def submit_claimed(self, site: AssignedSite) -> None:
        try:
            submissions = self.api.claim([site.target_id], limit=site.settings.max_active_submissions)
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning("Claim for site %s failed: %s", site.label, self.masker.mask(str(error)))
            return
        for submission in submissions:
            try:
                result = self.submit(site, submission)
            except (KeyError, TypeError, ValueError) as error:
                # Without readable Job IDs nothing can be reported; the API fails them in time.
                LOGGER.error("A submission for site %s is malformed: %s", site.label, error)
                continue
            self.pending.report(result)

    def submit(self, site: AssignedSite, submission: dict[str, Any]) -> dict[str, Any]:
        job_ids = submission_job_ids(submission)
        if str(submission.get("target", {}).get("id")) != site.target_id:
            return failed_result(job_ids, "The launcher received a submission for another site")
        try:
            setup = SubmissionSetup.of(submission)
            plan = setup.plan(api_url=self.client.settings.url, secrets=self.config.spec_secrets())
            endpoint = self.logins.endpoint(site.target_id, setup.settings.connection, setup.account)
            operations = SiteOperations(
                self.transport_for(endpoint), work_directory=setup.account.work_directory
            )
        except ConfigurationError as error:
            return failed_result(
                job_ids, f"The launcher could not prepare the submission: {self.masker.mask(str(error))}"
            )
        earlier = self.login_failures.in_this_poll(endpoint)
        if earlier is not None:
            # Up to 50 submissions a site and poll would each fail the same login, with retries.
            return failed_result(
                job_ids,
                "Not tried: logging in to the site failed for an earlier submission of this poll: "
                f"{earlier.reason}",
            )
        outcome = submit_to_site(submission, operations=operations, plan=plan, masker=self.masker)
        if outcome.connection_failure is None:
            self.login_failures.forget(endpoint)
        else:
            self.login_failures.record(endpoint, outcome.connection_failure)
        result = outcome.result
        LOGGER.info(
            "Submission %s on site %s as %s: %s %s",
            ",".join(job_ids),
            site.label,
            setup.account.account_name,
            result["outcome"],
            result.get("schedulerJobId") or "",
        )
        if result["outcome"] == "submitted" and result.get("schedulerJobId"):
            self.ledger.record(
                job_ids,
                target_id=site.target_id,
                account=setup.account,
                scheduler_job_id=result["schedulerJobId"],
            )
        return result

    # Cancellations in the scheduler queue ------------------------------------------------------

    def cancel_in_queue(self, assignment: LauncherAssignment) -> None:
        if not assignment.sites:
            return
        try:
            cancellations = self.api.cancellations(list(assignment.sites))
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning("Cancellation list failed: %s", self.masker.mask(str(error)))
            return
        done = [item.job_id for item in cancellations if self.cancel(assignment, item)]
        if not done:
            return
        try:
            self.api.report_cancellations(done)
        except (ApiError, ConfigurationError) as error:
            LOGGER.warning("Cancellation report failed: %s", self.masker.mask(str(error)))
            return
        for job_id in done:
            self.ledger.forget(job_id)

    def cancel(self, assignment: LauncherAssignment, cancellation: SchedulerCancellation) -> bool:
        """Remove one Job from its scheduler queue; False leaves it for the next poll."""
        job_id, site = cancellation.job_id, assignment.sites.get(cancellation.target_id)
        try:
            queued_id = scheduler_job_id(cancellation.scheduler_job_id.encode())
        except JobShellOutputError:
            queued_id = None
        if site is None or queued_id is None:
            LOGGER.warning("Job %s cannot be removed from a scheduler queue this launcher knows", job_id)
            return True
        cancel_command = site.settings.cancel_command
        if cancel_command is None:
            LOGGER.info(
                "Site %s has no cancel command; Job %s's runner ends when it starts", site.label, job_id
            )
            return True
        account = cancellation.account
        self.warn_if_queued_as_another(job_id, account)
        try:
            endpoint = self.logins.endpoint(site.target_id, site.settings.connection, account)
        except ConfigurationError as error:
            return self.cancel_impossible(job_id, error)
        if self.login_failures.within(endpoint, CANCEL_LOGIN_PAUSE_SECONDS):
            # The login failed a moment ago, for a submission or a cancel; this cancel waits.
            LOGGER.debug("Cancel of Job %s waits: logging in as %s failed recently", job_id, endpoint.user)
            return False
        try:
            transport = self.transport_for(endpoint)
            result = SiteOperations(transport, work_directory=account.work_directory).cancel(
                cancel_command, scheduler_job_id=queued_id
            )
        except TransportError as error:
            reason = self.masker.mask(str(error))
            self.login_failures.record(endpoint, reason)
            LOGGER.warning(
                "Cancel of Job %s deferred: %s; cancels log in as %s on site %s again in %.0f seconds",
                job_id,
                reason,
                endpoint.user,
                site.label,
                CANCEL_LOGIN_PAUSE_SECONDS,
            )
            return False
        except ConfigurationError as error:
            return self.cancel_impossible(job_id, error)
        self.login_failures.forget(endpoint)
        if result.exit_code:
            # Usually the job already left the queue; retrying would only repeat the refusal.
            LOGGER.warning(
                "Cancel command for Job %s exited with %s: %s",
                job_id,
                result.exit_code,
                transport.diagnostic(result.stderr),
            )
        return True

    def cancel_impossible(self, job_id: str, error: ConfigurationError) -> bool:
        """Report the Job as done: no later poll could remove it either."""
        # Without a usable account or login the Job stays queued; its runner ends when it starts.
        LOGGER.error("Cancel of Job %s impossible: %s", job_id, self.masker.mask(str(error)))
        return True

    def warn_if_queued_as_another(self, job_id: str, account: SubmissionAccount) -> None:
        queued_as = self.ledger.account_name_for(job_id)
        if queued_as is not None and account.account_name and queued_as != account.account_name:
            LOGGER.warning(
                "Job %s was queued as %s; its cancel command runs as %s, the account the API names now",
                job_id,
                queued_as,
                account.account_name,
            )


def run_launcher(config: LauncherConfig, *, once: bool, stop: threading.Event | None = None) -> None:
    launcher = Launcher(config)
    if once:
        try:
            launcher.run_once()
        finally:
            launcher.close()
        return
    launcher.run_forever(stop or threading.Event())
