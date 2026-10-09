"""The launcher's TOML configuration: the Projects it claims for and the sites it submits to.

    launcher_id = "gpu-launcher-1"          # stable: the API ties claimed submissions to it
    state_directory = "/var/lib/mado-tracking-launcher"
    poll_seconds = 10

    [[projects]]
    name = "speech"                          # names the Project in logs and pending reports
    api_url = "https://mmt.example.org"
    token_file = "/etc/mado-tracking/launcher/speech.token"   # a project worker token, mode 600

    [[sites]]
    target_id = "<ComputeTarget id>"
    job_shell = "sites/abci/job.sh"
    work_dir = "/groups/gxx/mmt"
    cancel_command = 'qdel "$MMT_SCHEDULER_JOB_ID"'
    account_mode = "personal"                # or "shared"
    max_active_submissions = 10              # submissions claimed per site and poll
    [sites.connection]
    host = "login.example.org"
    user = "mmt"                             # shared accounts
    identity_file = "keys/mmt"               # mode 600
    known_hosts = "known_hosts"
    jump_hosts = ["access.example.org"]
    [sites.accounts."alice@example.org"]     # personal accounts, by the requester's email
    user = "alice"
    identity_file = "keys/alice"
    variables = { GROUP = "gxx50000" }

A site may also say `connection = { local = true }` when the launcher runs on the site itself.
The keys of site_settings.py (runner_python, runner_api_url, gpu_assignment, ...) apply as well.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import ConfigurationError
from ..toml_tables import TableReader, load_toml
from ..worker.installer import InstallerError, read_token
from .job_shell import FORBIDDEN_VALUE_CHARACTERS
from .site_settings import SITE_SUBMISSION_KEYS, SiteSubmissionSettings
from .transport import SshEndpoint

ACCOUNT_MODES = ("shared", "personal")
DEFAULT_POLL_SECONDS = 10.0
DEFAULT_MAX_ACTIVE_SUBMISSIONS = 10
# The API returns at most this many submissions per claim (SITE_CLAIM_MAX_SUBMISSIONS).
MAX_ACTIVE_SUBMISSIONS = 50
DEFAULT_SSH_PORT = 22
SHARED_ACCOUNT_KEY = "shared"


@dataclass(frozen=True)
class ProjectConnection:
    name: str
    api_url: str
    token: str = field(repr=False)


@dataclass(frozen=True)
class SiteAccount:
    """Who the job shell runs as: the shared account, or the requester's own."""

    key: str
    user: str
    identity_file: Path | None
    work_dir: str | None = None
    variables: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SiteConnection:
    local: bool
    host: str = ""
    port: int = DEFAULT_SSH_PORT
    user: str = ""
    identity_file: Path | None = None
    known_hosts: Path | None = None
    jump_hosts: tuple[str, ...] = ()

    def endpoint(self, account: SiteAccount) -> SshEndpoint:
        identity_file = account.identity_file or self.identity_file
        if identity_file is None or self.known_hosts is None:
            raise ConfigurationError("An SSH site needs identity_file and known_hosts")
        return SshEndpoint(
            host=self.host,
            port=self.port,
            user=account.user,
            identity_file=identity_file,
            known_hosts=self.known_hosts,
            jump_hosts=self.jump_hosts,
        )


@dataclass(frozen=True)
class SiteConfig:
    target_id: str
    submission: SiteSubmissionSettings
    connection: SiteConnection
    account_mode: str
    accounts: dict[str, SiteAccount]
    cancel_command: str | None
    max_active_submissions: int

    def account_for(self, email: str) -> SiteAccount | None:
        if self.account_mode == SHARED_ACCOUNT_KEY:
            return SiteAccount(SHARED_ACCOUNT_KEY, self.connection.user, self.connection.identity_file)
        return self.accounts.get(email.strip().lower())

    def account_by_key(self, key: str) -> SiteAccount | None:
        if key == SHARED_ACCOUNT_KEY:
            return self.account_for("") if self.account_mode == SHARED_ACCOUNT_KEY else None
        return self.accounts.get(key)

    def work_dir(self, account: SiteAccount) -> str:
        return account.work_dir or self.submission.work_dir


@dataclass(frozen=True)
class LauncherConfig:
    launcher_id: str
    state_directory: Path
    poll_seconds: float
    projects: tuple[ProjectConnection, ...]
    sites: tuple[SiteConfig, ...]


def _read_token_file(path: Path, *, label: str) -> str:
    try:
        if os.stat(path).st_mode & 0o077:
            raise ConfigurationError(f"{label} token file must not be readable by group or others")
        return read_token(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ConfigurationError(f"{label} token file could not be read: {error.strerror}") from None
    except InstallerError as error:
        raise ConfigurationError(f"{label} token file: {error}") from None


def _project(table: object, index: int, base: Path) -> ProjectConnection:
    reader = TableReader(
        table, label=f"projects[{index}]", allowed={"name", "api_url", "token_file"}, base_directory=base
    )
    token_file = reader.path("token_file")
    return ProjectConnection(
        name=reader.string("name", default=token_file.stem),
        api_url=reader.string("api_url"),
        token=_read_token_file(token_file, label=f"projects[{index}]"),
    )


def _connection(table: object, *, label: str, base: Path) -> SiteConnection:
    reader = TableReader(
        table,
        label=label,
        allowed={"local", "host", "port", "user", "identity_file", "known_hosts", "jump_hosts"},
        base_directory=base,
    )
    # Personal sites and local hosts name no shared account, so user may be absent.
    user = reader.optional_string("user") or ""
    if reader.boolean("local", default=False):
        return SiteConnection(local=True, user=user)
    return SiteConnection(
        local=False,
        host=reader.string("host"),
        port=reader.integer("port", default=DEFAULT_SSH_PORT, minimum=1, maximum=65535),
        user=user,
        identity_file=reader.optional_path("identity_file"),
        known_hosts=reader.path("known_hosts"),
        jump_hosts=reader.string_list("jump_hosts", default=()),
    )


def _accounts(table: object, *, label: str, base: Path) -> dict[str, SiteAccount]:
    if not isinstance(table, dict):
        raise ConfigurationError(f"{label} must be a table of accounts by email")
    accounts = {}
    for email, entry in table.items():
        reader = TableReader(
            entry,
            label=f"{label}.{email}",
            allowed={"user", "identity_file", "work_dir", "variables"},
            base_directory=base,
        )
        key = str(email).strip().lower()
        accounts[key] = SiteAccount(
            key=key,
            user=reader.string("user"),
            identity_file=reader.optional_path("identity_file"),
            work_dir=reader.optional_string("work_dir"),
            variables=reader.string_table("variables"),
        )
    return accounts


def _site(table: object, index: int, base: Path) -> SiteConfig:
    label = f"sites[{index}]"
    reader = TableReader(
        table,
        label=label,
        allowed=SITE_SUBMISSION_KEYS
        | {"target_id", "connection", "account_mode", "accounts", "cancel_command", "max_active_submissions"},
        base_directory=base,
    )
    account_mode = reader.string("account_mode", default=SHARED_ACCOUNT_KEY)
    if account_mode not in ACCOUNT_MODES:
        raise ConfigurationError(f"{label}.account_mode must be shared or personal")
    connection = _connection(reader.table_value("connection"), label=f"{label}.connection", base=base)
    accounts = _accounts(reader.table_value("accounts", default={}), label=f"{label}.accounts", base=base)
    if account_mode == SHARED_ACCOUNT_KEY and not connection.local and not connection.user:
        raise ConfigurationError(f"{label}.connection needs the shared account's user")
    if account_mode == "personal" and not accounts:
        raise ConfigurationError(f"{label} uses personal accounts but lists none")
    cancel_command = reader.optional_string("cancel_command")
    if cancel_command is not None and any(
        character in cancel_command for character in FORBIDDEN_VALUE_CHARACTERS
    ):
        raise ConfigurationError(f"{label}.cancel_command must be one line")
    return SiteConfig(
        target_id=reader.string("target_id"),
        submission=SiteSubmissionSettings.from_reader(reader),
        connection=connection,
        account_mode=account_mode,
        accounts=accounts,
        cancel_command=cancel_command,
        max_active_submissions=reader.integer(
            "max_active_submissions",
            default=DEFAULT_MAX_ACTIVE_SUBMISSIONS,
            minimum=1,
            maximum=MAX_ACTIVE_SUBMISSIONS,
        ),
    )


def default_state_directory(launcher_id: str) -> Path:
    identity = hashlib.sha256(launcher_id.encode()).hexdigest()[:16]
    return Path.home() / ".local/state/mado-tracking-launcher" / identity


def load_launcher_config(path: Path) -> LauncherConfig:
    base = path.resolve().parent
    reader = TableReader(
        load_toml(path),
        label=str(path),
        allowed={"launcher_id", "state_directory", "poll_seconds", "projects", "sites"},
        base_directory=base,
    )
    launcher_id = reader.string("launcher_id")
    projects = reader.table_value("projects")
    sites = reader.table_value("sites")
    if not isinstance(projects, list) or not projects:
        raise ConfigurationError(f"{path} needs at least one [[projects]] entry")
    if not isinstance(sites, list) or not sites:
        raise ConfigurationError(f"{path} needs at least one [[sites]] entry")
    config = LauncherConfig(
        launcher_id=launcher_id,
        state_directory=reader.path("state_directory", default=default_state_directory(launcher_id)),
        poll_seconds=reader.number("poll_seconds", default=DEFAULT_POLL_SECONDS),
        projects=tuple(_project(table, index, base) for index, table in enumerate(projects)),
        sites=tuple(_site(table, index, base) for index, table in enumerate(sites)),
    )
    names = [project.name for project in config.projects]
    if len(set(names)) != len(names):
        raise ConfigurationError(f"{path}: every [[projects]] entry needs its own name")
    targets = [site.target_id for site in config.sites]
    if len(set(targets)) != len(targets):
        raise ConfigurationError(f"{path}: each target_id may appear in one [[sites]] entry only")
    return config
