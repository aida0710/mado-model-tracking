"""`mado-tracking submit`: submit the Jobs that wait for a manual site (logins with OTP, or a PC).

Run where the job shell can submit (the site's login node, or the PC that is the site) with one's
own API token (MMT_API_URL, MMT_API_TOKEN). The site's settings and job shell, and one's own work
directory and variables, come from the Web (GET /manual-submissions/sites/:id); --work-dir and
--var change them for this run only, and --registry-secret-file hands the runners a registry login.
A round claims the waiting Jobs, writes their spec directories, runs the job shell once per
submission and reports the scheduler job IDs. Without --watch the command is one round and nothing
keeps running; with --watch it repeats a round every --interval seconds until it is stopped, and
outlasts the API's temporary failures.
"""

from __future__ import annotations

import getpass
import os
import socket
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from ..client import Client
from ..errors import ApiError, ConfigurationError
from .api_documents import DocumentReader
from .credential_files import read_registry_secrets
from .job_shell import FORBIDDEN_VALUE_CHARACTERS, VARIABLE_NAME
from .pending_reports import PendingReports
from .site_operations import SiteOperations
from .site_settings import SubmissionAccount, SubmissionSetup
from .submission import failed_result, submission_job_ids, submit_to_site
from .submission_api import ManualSubmissionApi, refused_for_good
from .transport import LocalSiteTransport

# The API returns at most this many submissions per claim (SITE_CLAIM_MAX_SUBMISSIONS).
MAX_SUBMISSIONS = 50
DEFAULT_WATCH_INTERVAL_SECONDS = 10.0
# Jobs wait for minutes, not seconds; a shorter interval would only load the API.
MIN_WATCH_INTERVAL_SECONDS = 1.0
EXIT_OK = 0
EXIT_SUBMISSION_FAILED = 1
PENDING_REPORTS_DIRECTORY = "pending"


def default_state_directory(target_id: str) -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(base) / "mado-tracking" / "submit" / target_id


def submitter_id() -> str:
    """Stable per account and host, so a later run can recognize its own reports."""
    return f"{getpass.getuser()}@{socket.gethostname()}"


@dataclass(frozen=True)
class SubmitOptions:
    target_id: str
    # Every waiting Job of a computer one owns, not only one's own (the API's `all`).
    all_jobs: bool = False
    # This run's work directory and variables, on top of one's settings on the Web.
    work_dir: str | None = None
    variables: Mapping[str, str] = field(default_factory=dict)
    # JSON {"username", "password"} (mode 600) the runners pull images into SIFs with.
    registry_secret_file: Path | None = None
    limit: int = MAX_SUBMISSIONS
    dry_run: bool = False

    def __post_init__(self) -> None:
        if not 1 <= self.limit <= MAX_SUBMISSIONS:
            raise ConfigurationError(f"--limit must be from 1 to {MAX_SUBMISSIONS}")
        if self.work_dir is not None and (
            not self.work_dir.startswith("/")
            or any(character in self.work_dir for character in FORBIDDEN_VALUE_CHARACTERS)
        ):
            raise ConfigurationError("--work-dir must be an absolute path")
        for name, value in self.variables.items():
            if not VARIABLE_NAME.fullmatch(name):
                raise ConfigurationError(f"--var {name!r} is not a shell variable name")
            if any(character in value for character in FORBIDDEN_VALUE_CHARACTERS):
                raise ConfigurationError(f"--var {name} must be one line")

    def account_for(self, account: SubmissionAccount) -> SubmissionAccount:
        """The account with this run's --work-dir and --var on top."""
        return replace(
            account,
            work_directory=self.work_dir or account.work_directory,
            variables={**account.variables, **self.variables},
        )


def with_variables(options: SubmitOptions, assignments: Sequence[str]) -> SubmitOptions:
    variables = dict(options.variables)
    for assignment in assignments:
        name, separator, value = assignment.partition("=")
        if not separator or not name:
            raise ConfigurationError(f"--var takes NAME=VALUE, not {assignment!r}")
        variables[name] = value
    return replace(options, variables=variables)


class ManualSubmitter:
    def __init__(
        self,
        options: SubmitOptions,
        *,
        client: Client,
        print_line: Callable[[str], None] = print,
        state_directory: Path | None = None,
    ):
        self.options = options
        self.client = client
        self.print_line = print_line
        self.api = ManualSubmissionApi(client, submitter_id=submitter_id())
        self.pending = PendingReports(
            (state_directory or default_state_directory(options.target_id)) / PENDING_REPORTS_DIRECTORY,
            send=self.api.report,
            notice=print_line,
        )
        # The waiting count last shown: a watch prints it again only when it changes.
        self.shown_waiting: int | None = None

    def run_once(self) -> int:
        """One round; EXIT_SUBMISSION_FAILED when a claimed submission failed."""
        if not self.options.dry_run:
            self.pending.resend()
        name, waiting = self.waiting_jobs()
        if waiting != self.shown_waiting:
            self.print_line(f"{name}: {waiting} Job(s) wait for submission")
            self.shown_waiting = waiting
        if waiting == 0 and not self.options.dry_run:
            return EXIT_OK
        configuration = self.api.site_configuration(self.options.target_id)
        account = self.options.account_for(configuration.account)
        if configuration.job_shell is None:
            # A claim now would only fail the waiting Jobs.
            raise ConfigurationError(
                f"{configuration.target_name} has no job shell yet; its owner saves one on the Web"
            )
        if not account.work_directory:
            raise ConfigurationError(
                f"No work directory for {configuration.target_name}: set yours in its settings on the "
                "Web, or give --work-dir"
            )
        # Read every round, so an edit applies to the next one and a broken file stops any claim.
        secrets = self.spec_secrets()
        if self.options.dry_run:
            self.print_line(
                f"dry run: would submit with job shell v{configuration.job_shell.version} "
                f"in {account.work_directory}"
            )
            return EXIT_OK
        failures = 0
        claimed = self.api.claim(
            self.options.target_id, limit=self.options.limit, all_jobs=self.options.all_jobs
        )
        for submission in claimed:
            try:
                result = self.submit(submission, secrets=secrets)
            except (KeyError, TypeError, ValueError) as error:
                # Without readable Job IDs nothing can be reported; the API fails them in time.
                failures += 1
                self.print_line(f"a claimed submission is malformed: {error}")
                continue
            self.pending.report(result)
            jobs = ",".join(result["jobIds"])
            if result["outcome"] == "submitted":
                self.print_line(f"submitted {jobs} as {result.get('schedulerJobId') or '(no scheduler ID)'}")
            else:
                failures += 1
                self.print_line(f"failed {jobs}: {result.get('error')}")
        return EXIT_SUBMISSION_FAILED if failures else EXIT_OK

    def waiting_jobs(self) -> tuple[str, int]:
        """The site's name, and how many of the Jobs this run would claim wait for it."""
        entry = next(
            (item for item in self.api.waiting() if item.get("targetId") == self.options.target_id), None
        )
        if entry is None:
            return self.options.target_id, 0
        reader = DocumentReader(entry, label="waiting Jobs")
        name = reader.text("targetName")
        if not self.options.all_jobs:
            return name, reader.integer("waitingJobs")
        if reader.is_null("allWaitingJobs"):
            raise ConfigurationError(
                f"--all takes everyone's Jobs on a computer you own; {name} is not yours"
            )
        return name, reader.integer("allWaitingJobs")

    def spec_secrets(self) -> dict[str, Any] | None:
        """secrets.json for the runners: the registry login of --registry-secret-file, if given."""
        path = self.options.registry_secret_file
        return None if path is None else read_registry_secrets(path, label="--registry-secret-file")

    def submit(self, submission: dict[str, Any], *, secrets: dict[str, Any] | None = None) -> dict[str, Any]:
        job_ids = submission_job_ids(submission)
        if str(submission.get("target", {}).get("id")) != self.options.target_id:
            return failed_result(job_ids, "mado-tracking submit received a submission for another site")
        masker = self.client.masker
        try:
            setup = SubmissionSetup.of(submission)
            setup = replace(setup, account=self.options.account_for(setup.account))
            plan = setup.plan(api_url=self.client.settings.url, secrets=secrets)
            operations = SiteOperations(
                LocalSiteTransport(masker=masker), work_directory=setup.account.work_directory
            )
        except ConfigurationError as error:
            return failed_result(job_ids, f"The submission could not be prepared: {masker.mask(str(error))}")
        return submit_to_site(submission, operations=operations, plan=plan, masker=masker).result

    def watch(self, stop: threading.Event, *, interval: float) -> int:
        """A round every `interval` seconds until `stop` is set; a temporary failure waits for the next."""
        self.print_line(f"Watching {self.options.target_id} every {interval:g} seconds; Ctrl-C stops")
        while not stop.is_set():
            try:
                self.run_once()
            except ApiError as error:
                if refused_for_good(error):
                    raise
                self.print_line(f"{error}; trying again in {interval:g} seconds")
            except OSError as error:
                self.print_line(
                    f"{self.client.masker.mask(str(error))}; trying again in {interval:g} seconds"
                )
            stop.wait(interval)
        self.print_line("stopped")
        return EXIT_OK
