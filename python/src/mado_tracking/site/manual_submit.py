"""`mado-tracking submit`: submit one's own Jobs that wait for a manual site (logins with OTP).

Run on the site's login node with one's own API token (MMT_API_URL, MMT_API_TOKEN). It claims the
waiting Jobs, writes their spec directories into the work directory, runs the local job shell,
reports the scheduler job IDs, and exits; nothing stays running on the login node.

Per-site defaults come from ~/.config/mado-tracking/submit.toml (or MMT_SUBMIT_CONFIG):

    [sites."<ComputeTarget id>"]
    job_shell = "~/mmt/job.sh"
    work_dir = "/work/group/me/mmt"
    variables = { GROUP = "gxx50000" }
"""

from __future__ import annotations

import getpass
import os
import socket
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from ..client import Client
from ..errors import ApiError, ConfigurationError
from ..toml_tables import TableReader, load_toml
from .pending_reports import PendingReports
from .site_operations import SiteOperations
from .site_settings import SITE_SUBMISSION_KEYS, SiteSubmissionSettings
from .submission import submit_to_site
from .submission_api import ManualSubmissionApi
from .transport import LocalSiteTransport

CONFIG_VARIABLE = "MMT_SUBMIT_CONFIG"
# The API returns at most this many submissions per claim (SITE_CLAIM_MAX_SUBMISSIONS).
MAX_SUBMISSIONS = 50
INVALID_SUBMISSION_STATUS = 409


def default_config_path() -> Path:
    configured = os.environ.get(CONFIG_VARIABLE)
    if configured:
        return Path(configured).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "mado-tracking" / "submit.toml"


def default_state_directory(target_id: str) -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(base) / "mado-tracking" / "submit" / target_id


def submitter_id() -> str:
    """Stable per account and login node, so a later run can recognize its own reports."""
    return f"{getpass.getuser()}@{socket.gethostname()}"


@dataclass(frozen=True)
class SubmitOptions:
    target_id: str
    config_path: Path
    job_shell: Path | None = None
    work_dir: str | None = None
    runner_python: str | None = None
    runner_api_url: str | None = None
    variables: Mapping[str, str] = field(default_factory=dict)
    limit: int = MAX_SUBMISSIONS
    dry_run: bool = False


def site_settings(options: SubmitOptions) -> SiteSubmissionSettings:
    """The site's table of the submit config, with the command line's values on top."""
    table: dict[str, Any] = {}
    if options.config_path.exists():
        sites = load_toml(options.config_path).get("sites", {})
        table = dict(sites.get(options.target_id, {})) if isinstance(sites, dict) else {}
    overrides = {
        "job_shell": str(options.job_shell) if options.job_shell else None,
        "work_dir": options.work_dir,
        "runner_python": options.runner_python,
        "runner_api_url": options.runner_api_url,
    }
    table.update({key: value for key, value in overrides.items() if value is not None})
    table["variables"] = {**dict(table.get("variables") or {}), **options.variables}
    if "job_shell" not in table or "work_dir" not in table:
        raise ConfigurationError(
            f'Give --job-shell and --work-dir, or set them under [sites."{options.target_id}"] '
            f"in {options.config_path}"
        )
    reader = TableReader(
        table,
        label=f"sites.{options.target_id}",
        allowed=SITE_SUBMISSION_KEYS,
        base_directory=options.config_path.parent,
    )
    return SiteSubmissionSettings.from_reader(reader)


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
            (state_directory or default_state_directory(options.target_id)) / "pending"
        )

    def run(self) -> int:
        settings = site_settings(self.options)
        if not self.options.dry_run:
            self.resend_pending_reports()
        waiting = next(
            (item for item in self.api.waiting() if item.get("targetId") == self.options.target_id), None
        )
        count = int(waiting["waitingJobs"]) if waiting else 0
        name = waiting["targetName"] if waiting else self.options.target_id
        self.print_line(f"{name}: {count} Job(s) wait for submission")
        if self.options.dry_run or count == 0:
            if self.options.dry_run:
                self.print_line(f"dry run: would submit with {settings.job_shell} in {settings.work_dir}")
            return 0
        plan = settings.plan(api_url=self.client.settings.url)
        operations = SiteOperations(
            LocalSiteTransport(masker=self.client.masker), work_directory=settings.work_dir
        )
        failures = 0
        for submission in self.api.claim(self.options.target_id, limit=self.options.limit):
            result = submit_to_site(submission, operations=operations, plan=plan, masker=self.client.masker)
            path = self.pending.save(result)
            if self.deliver(result):
                self.pending.discard(path)
            jobs = ",".join(result["jobIds"])
            if result["outcome"] == "submitted":
                self.print_line(f"submitted {jobs} as {result.get('schedulerJobId') or '(no scheduler ID)'}")
            else:
                failures += 1
                self.print_line(f"failed {jobs}: {result.get('error')}")
        return 1 if failures else 0

    def deliver(self, result: dict[str, Any]) -> bool:
        try:
            self.api.report([result])
            return True
        except ApiError as error:
            if (
                error.status_code is not None
                and 400 <= error.status_code < 500
                and error.status_code not in {408, 429}
            ):
                # 409: reported before (a lost answer) or no longer waiting for this report.
                self.print_line(f"report for {','.join(result['jobIds'])} refused: {error}")
                return True
            self.print_line(f"report for {','.join(result['jobIds'])} deferred to the next run: {error}")
            return False

    def resend_pending_reports(self) -> None:
        for path, result in self.pending.items():
            if self.deliver(result):
                self.pending.discard(path)


def with_variables(options: SubmitOptions, assignments: list[str]) -> SubmitOptions:
    variables = dict(options.variables)
    for assignment in assignments:
        name, separator, value = assignment.partition("=")
        if not separator or not name:
            raise ConfigurationError(f"--var takes NAME=VALUE, not {assignment!r}")
        variables[name] = value
    return replace(options, variables=variables)
