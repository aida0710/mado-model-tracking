"""Install, upgrade, and inspect a worker kept running by systemd on the worker host.

The API server never logs in to worker hosts (decisions.md); an operator runs these commands there.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

from ..errors import ConfigurationError
from ..settings import ApiSettings
from .systemd_unit import (
    SERVICE_TEMPLATE_NAME,
    ServiceScope,
    WorkerUnitSettings,
    instance_unit_name,
    render_worker_unit,
)

# The worker ID names the systemd instance and the environment file, so it must be a plain file name.
WORKER_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
SERVICE_USER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,31}")
# Same alphabet as the API's Bearer header check; anything else could never authenticate.
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
PACKAGE_VERSION_PATTERN = re.compile(r"[0-9][0-9A-Za-z.+!-]*")
# systemd EnvironmentFile treats these specially; rejecting them avoids any quoting rules.
UNSAFE_ENVIRONMENT_CHARACTERS = frozenset("\"'\\$`\n\r\x00")
ENVIRONMENT_FILE_MODE = 0o600
PRIVATE_DIRECTORY_MODE = 0o700
UNIT_FILE_MODE = 0o644
PACKAGE_NAME = "mado-tracking"
PACKAGE_EXTRAS = "telemetry"
# JobJournal keeps the lock and one `<job-id>.json` per retained Job directly in the state directory.
WORKER_LOCK_FILE = "worker.lock"
JOURNAL_SUFFIX = ".json"


class InstallerError(Exception):
    """A step failed; the message is safe to print and never contains the token."""


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class CommandRunner(Protocol):
    def __call__(self, argv: Sequence[str]) -> CommandResult: ...


def run_command(argv: Sequence[str]) -> CommandResult:
    completed = subprocess.run(list(argv), capture_output=True, text=True, check=False)
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


@dataclass(frozen=True)
class ServiceLayout:
    """Where one scope keeps environment files, the unit, and default state."""

    scope: ServiceScope
    environment_directory: Path
    unit_directory: Path
    state_root: Path

    @classmethod
    def for_user(cls, home: Path, environ: Mapping[str, str] | None = None) -> ServiceLayout:
        environ = os.environ if environ is None else environ
        config_home = Path(environ.get("XDG_CONFIG_HOME") or home / ".config")
        return cls(
            scope=ServiceScope.USER,
            environment_directory=config_home / "mado-tracking-worker",
            unit_directory=config_home / "systemd/user",
            state_root=home / ".local/state/mado-tracking-worker",
        )

    @classmethod
    def for_system(cls, root: Path = Path("/")) -> ServiceLayout:
        return cls(
            scope=ServiceScope.SYSTEM,
            environment_directory=root / "etc/mado-tracking-worker",
            unit_directory=root / "etc/systemd/system",
            state_root=root / "var/lib/mado-tracking-worker",
        )

    @property
    def unit_path(self) -> Path:
        return self.unit_directory / SERVICE_TEMPLATE_NAME

    @property
    def systemctl(self) -> list[str]:
        return ["systemctl", "--user"] if self.scope is ServiceScope.USER else ["systemctl"]

    def environment_file(self, worker_id: str) -> Path:
        return self.environment_directory / f"{worker_id}.env"

    def default_state_directory(self, worker_id: str) -> Path:
        if self.scope is ServiceScope.SYSTEM:
            return self.state_root / worker_id
        # Must match WorkerSettings.from_environment so a worker first started by hand keeps its journal.
        return self.state_root / hashlib.sha256(worker_id.encode()).hexdigest()[:16]


def validate_worker_id(worker_id: str) -> None:
    if not WORKER_ID_PATTERN.fullmatch(worker_id):
        raise InstallerError(
            "Worker ID must be 1-64 characters of letters, digits, '.', '_', or '-' and start with a letter"
            " or digit"
        )


def read_token(text: str) -> str:
    token = text.strip()
    if not TOKEN_PATTERN.fullmatch(token):
        raise InstallerError("The worker token is empty or contains characters an API token cannot have")
    return token


def format_environment_file(values: Mapping[str, str]) -> str:
    lines = []
    for key, value in values.items():
        if UNSAFE_ENVIRONMENT_CHARACTERS.intersection(value):
            raise InstallerError(f"{key} must not contain quotes, backslashes, '$', backticks, or newlines")
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def parse_environment_file(path: Path) -> dict[str, str]:
    """Read the file `install` wrote (plain KEY=value lines, comments allowed)."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        raise InstallerError(f"{path} does not exist; run `mado-tracking-worker install` first") from None
    except PermissionError:
        raise InstallerError(f"Cannot read {path}; run as the user that owns it") from None
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_private_file(path: Path, content: str) -> None:
    """Create the file as 0600 from the first byte, then swap it in, so the token is never exposed."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.unlink(missing_ok=True)
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, ENVIRONMENT_FILE_MODE)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    path.chmod(ENVIRONMENT_FILE_MODE)


@dataclass(frozen=True)
class InstallRequest:
    api_url: str
    worker_id: str
    token: str
    target_ids: tuple[str, ...] = ()
    state_directory: Path | None = None
    python_executable: Path | None = None
    service_user: str | None = None


@dataclass(frozen=True)
class InstallResult:
    unit_name: str
    unit_path: Path
    environment_file: Path
    state_directory: Path


def worker_environment(request: InstallRequest, state_directory: Path) -> dict[str, str]:
    try:
        api = ApiSettings.from_environment(url=request.api_url, token=read_token(request.token))
    except ConfigurationError as error:
        raise InstallerError(str(error)) from None
    return {
        # Keep the operator's form (origin or /api); ApiSettings accepts both.
        "MMT_API_URL": request.api_url.rstrip("/"),
        "MMT_WORKER_ID": request.worker_id,
        "MMT_WORKER_TARGET_IDS": ",".join(request.target_ids),
        "MMT_WORKER_STATE_DIR": str(state_directory),
        "MMT_API_TOKEN": api.token,
    }


def prepare_state_directory(path: Path, service_user: str | None) -> None:
    if path.is_symlink():
        raise InstallerError(f"State directory {path} must not be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    path.chmod(PRIVATE_DIRECTORY_MODE)
    if service_user and os.geteuid() == 0:
        # A system install runs as root, but the worker must own its journal.
        shutil.chown(path, user=service_user)


def check_command(result: CommandResult, description: str) -> None:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise InstallerError(f"{description} failed (exit {result.returncode}): {detail}")


def install_worker(request: InstallRequest, layout: ServiceLayout, run: CommandRunner) -> InstallResult:
    validate_worker_id(request.worker_id)
    is_system = layout.scope is ServiceScope.SYSTEM
    if is_system and not (request.service_user and SERVICE_USER_PATTERN.fullmatch(request.service_user)):
        raise InstallerError("--systemd-system needs --service-user with the account the worker runs as")
    for target_id in request.target_ids:
        if not target_id or "," in target_id:
            raise InstallerError("Target IDs must be non-empty and comma separated")
    state_directory = (
        request.state_directory or layout.default_state_directory(request.worker_id)
    ).absolute()
    environment = worker_environment(request, state_directory)
    environment_text = format_environment_file(environment)
    unit_text = render_worker_unit(
        WorkerUnitSettings(
            scope=layout.scope,
            python_executable=PurePosixPath(request.python_executable or default_python_executable()),
            environment_directory=PurePosixPath(layout.environment_directory),
            service_user=request.service_user if is_system else None,
        )
    )
    prepare_state_directory(state_directory, request.service_user if is_system else None)
    environment_file = layout.environment_file(request.worker_id)
    write_private_file(environment_file, environment_text)
    layout.unit_directory.mkdir(parents=True, exist_ok=True)
    layout.unit_path.write_text(unit_text)
    layout.unit_path.chmod(UNIT_FILE_MODE)
    unit_name = instance_unit_name(request.worker_id)
    check_command(run([*layout.systemctl, "daemon-reload"]), "systemctl daemon-reload")
    check_command(
        run([*layout.systemctl, "enable", "--now", unit_name]), f"systemctl enable --now {unit_name}"
    )
    return InstallResult(unit_name, layout.unit_path, environment_file, state_directory)


def default_python_executable() -> Path:
    # sys.executable inside a venv is the venv's interpreter; resolving the symlink would escape the venv.
    return Path(sys.executable).absolute()


@dataclass(frozen=True)
class WorkerStatus:
    unit_name: str
    active_state: str
    sub_state: str
    main_pid: int | None
    lock_held: bool
    retained_job_ids: tuple[str, ...]

    @property
    def is_active(self) -> bool:
        return self.active_state in {"active", "activating", "reloading"}


def is_worker_lock_held(state_directory: Path) -> bool:
    """Probe the journal's flock; a running worker holds it exclusively for its whole lifetime."""
    try:
        descriptor = os.open(state_directory / WORKER_LOCK_FILE, os.O_RDONLY)
    except FileNotFoundError:
        return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return False
    finally:
        os.close(descriptor)


def retained_job_ids(state_directory: Path) -> tuple[str, ...]:
    if not state_directory.is_dir():
        return ()
    return tuple(sorted(path.stem for path in state_directory.glob(f"*{JOURNAL_SUFFIX}")))


def state_directory_of(layout: ServiceLayout, worker_id: str) -> Path:
    environment = parse_environment_file(layout.environment_file(worker_id))
    configured = environment.get("MMT_WORKER_STATE_DIR")
    return Path(configured) if configured else layout.default_state_directory(worker_id)


def read_unit_properties(layout: ServiceLayout, unit_name: str, run: CommandRunner) -> dict[str, str]:
    result = run([*layout.systemctl, "show", unit_name, "--property=ActiveState,SubState,MainPID"])
    check_command(result, f"systemctl show {unit_name}")
    properties = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("=")
        properties[key] = value
    return properties


def read_worker_status(worker_id: str, layout: ServiceLayout, run: CommandRunner) -> WorkerStatus:
    validate_worker_id(worker_id)
    unit_name = instance_unit_name(worker_id)
    state_directory = state_directory_of(layout, worker_id)
    properties = read_unit_properties(layout, unit_name, run)
    main_pid = int(properties.get("MainPID") or 0)
    return WorkerStatus(
        unit_name=unit_name,
        active_state=properties.get("ActiveState", "unknown"),
        sub_state=properties.get("SubState", "unknown"),
        main_pid=main_pid or None,
        lock_held=is_worker_lock_held(state_directory),
        retained_job_ids=retained_job_ids(state_directory),
    )


def package_spec_for_version(version: str) -> str:
    if not PACKAGE_VERSION_PATTERN.fullmatch(version):
        raise InstallerError(f"{version!r} is not a package version")
    return f"{PACKAGE_NAME}[{PACKAGE_EXTRAS}]=={version}"


def service_python_executable(layout: ServiceLayout) -> str:
    """Upgrade the interpreter the unit actually runs, not whichever one invoked this command."""
    try:
        unit_text = layout.unit_path.read_text()
    except FileNotFoundError:
        raise InstallerError(
            f"{layout.unit_path} does not exist; run `mado-tracking-worker install`"
        ) from None
    for line in unit_text.splitlines():
        if line.startswith("ExecStart="):
            return shlex.split(line.removeprefix("ExecStart="))[0]
    raise InstallerError(f"{layout.unit_path} has no ExecStart")


@dataclass(frozen=True)
class UpgradeResult:
    unit_name: str
    package_spec: str
    retained_job_ids: tuple[str, ...]
    was_active: bool


def upgrade_worker(
    worker_id: str, package_spec: str, layout: ServiceLayout, run: CommandRunner
) -> UpgradeResult:
    """Install the new package beside the running worker, then restart only the worker process.

    Running Jobs are detached and keep running (KillMode=process); the new worker reattaches to them
    from the journal, which this function never modifies.
    """
    status = read_worker_status(worker_id, layout, run)
    if status.lock_held and not status.is_active:
        raise InstallerError(
            f"Another process holds {WORKER_LOCK_FILE} while {status.unit_name} is {status.active_state};"
            " stop the manually started worker first"
        )
    python_executable = service_python_executable(layout)
    # Imports of the running worker are already loaded; it picks up the new code only after the restart.
    check_command(run([python_executable, "-m", "pip", "install", "--upgrade", package_spec]), "pip install")
    check_command(
        run([*layout.systemctl, "restart", status.unit_name]), f"systemctl restart {status.unit_name}"
    )
    return UpgradeResult(status.unit_name, package_spec, status.retained_job_ids, status.is_active)
