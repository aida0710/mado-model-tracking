"""Check a worker host's configuration without starting the worker or printing secrets."""

from __future__ import annotations

import enum
import stat
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..settings import ApiSettings

# The worker claims Jobs and saves code snapshots and outputs as Run Artifacts (docs/worker.md).
REQUIRED_WORKER_SCOPES = ("read", "worker:execute", "artifacts:write")
# Diagnostics should answer quickly; a slow API is itself worth reporting.
DOCTOR_TIMEOUT_SECONDS = 10.0
# Secrets (token file, journal, ssh private keys) must not be reachable by group or others;
# ssh itself refuses such private keys.
GROUP_OR_OTHER_ACCESS_BITS = 0o077
# Files that decide which host or key is trusted must not be writable by group or others.
GROUP_OR_OTHER_WRITE_BITS = 0o022


class CheckLevel(enum.Enum):
    OK = "ok"
    WARNING = "warning"
    ERROR = "error"


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    level: CheckLevel
    detail: str


def file_mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def check_private_file(name: str, path: Path) -> DoctorCheck:
    if not path.is_file():
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} does not exist")
    mode = file_mode(path)
    if mode & GROUP_OR_OTHER_ACCESS_BITS:
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} is mode {mode:o}; run chmod 600 {path}")
    return DoctorCheck(name, CheckLevel.OK, f"{path} is mode {mode:o}")


def check_state_directory(path: Path) -> DoctorCheck:
    name = "state directory"
    if path.is_symlink():
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} must not be a symlink")
    if not path.exists():
        return DoctorCheck(name, CheckLevel.WARNING, f"{path} does not exist yet; the worker creates it")
    mode = file_mode(path)
    if mode & GROUP_OR_OTHER_ACCESS_BITS:
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} is mode {mode:o}; run chmod 700 {path}")
    return DoctorCheck(name, CheckLevel.OK, f"{path} is mode {mode:o}")


def check_api(api: ApiSettings, transport: httpx.BaseTransport | None = None) -> list[DoctorCheck]:
    with httpx.Client(
        base_url=api.url + "/",
        transport=transport,
        headers={"Authorization": f"Bearer {api.token}"},
        timeout=DOCTOR_TIMEOUT_SECONDS,
        follow_redirects=False,
    ) as client:
        try:
            health = client.get("health")
        except httpx.HTTPError as error:
            # The exception names the URL only; the token is in a header and is never formatted.
            return [DoctorCheck("api", CheckLevel.ERROR, f"Cannot reach {api.url}: {type(error).__name__}")]
        if not health.is_success:
            return [DoctorCheck("api", CheckLevel.ERROR, f"{api.url}/health returned {health.status_code}")]
        checks = [DoctorCheck("api", CheckLevel.OK, f"{api.url} is reachable")]
        try:
            current_token = client.get("auth/token")
        except httpx.HTTPError as error:
            return [
                *checks,
                DoctorCheck("token", CheckLevel.ERROR, f"Request failed: {type(error).__name__}"),
            ]
    return [*checks, check_token_response(current_token)]


def check_token_response(response: httpx.Response) -> DoctorCheck:
    name = "token"
    if response.status_code == 401:
        return DoctorCheck(
            name, CheckLevel.ERROR, "The API rejected the token (revoked, expired, or mistyped)"
        )
    if response.status_code == 404:
        return DoctorCheck(name, CheckLevel.WARNING, "This API cannot report token scopes; not checked")
    if not response.is_success:
        return DoctorCheck(name, CheckLevel.ERROR, f"GET /auth/token returned {response.status_code}")
    try:
        body = response.json()
    except ValueError:
        return DoctorCheck(name, CheckLevel.ERROR, "GET /auth/token returned invalid JSON")
    scopes = body.get("scopes") if isinstance(body, dict) else None
    if not isinstance(scopes, list):
        return DoctorCheck(name, CheckLevel.ERROR, "GET /auth/token returned no scopes")
    if body.get("job"):
        return DoctorCheck(name, CheckLevel.ERROR, "This is a Job token; workers need a service token")
    missing = [scope for scope in REQUIRED_WORKER_SCOPES if scope not in scopes]
    if missing:
        return DoctorCheck(name, CheckLevel.ERROR, f"Missing scopes: {', '.join(missing)}")
    project = body.get("projectId") or "all projects"
    return DoctorCheck(name, CheckLevel.OK, f"Scopes {', '.join(REQUIRED_WORKER_SCOPES)} for {project}")


def check_ssh_directory(directory: Path) -> DoctorCheck:
    name = "ssh directory"
    if not directory.exists():
        return DoctorCheck(name, CheckLevel.WARNING, f"{directory} does not exist")
    mode = file_mode(directory)
    if mode & GROUP_OR_OTHER_WRITE_BITS:
        return DoctorCheck(name, CheckLevel.ERROR, f"{directory} is mode {mode:o}; run chmod 700 {directory}")
    return DoctorCheck(name, CheckLevel.OK, f"{directory} is mode {mode:o}")


def check_private_key(path: Path) -> DoctorCheck:
    return check_private_file(f"ssh key {path.name}", path)


def check_known_hosts(path: Path) -> DoctorCheck:
    name = f"known_hosts {path.name}"
    if not path.is_file():
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} does not exist; the worker rejects unknown hosts")
    mode = file_mode(path)
    if mode & GROUP_OR_OTHER_WRITE_BITS:
        # Anyone who can write it can make the worker trust a different host key.
        return DoctorCheck(name, CheckLevel.ERROR, f"{path} is mode {mode:o}; run chmod 644 {path}")
    return DoctorCheck(name, CheckLevel.OK, f"{path} is mode {mode:o}")


def default_private_keys(ssh_directory: Path) -> list[Path]:
    if not ssh_directory.is_dir():
        return []
    return sorted(path for path in ssh_directory.glob("id_*") if path.suffix != ".pub" and path.is_file())


def check_ssh_files(
    ssh_directory: Path, key_paths: Sequence[Path], known_hosts_paths: Sequence[Path]
) -> list[DoctorCheck]:
    """Check the files compute targets name in sshKeyPath / knownHostsPath (defaults: ~/.ssh)."""
    checks = [check_ssh_directory(ssh_directory)]
    keys = list(key_paths) or default_private_keys(ssh_directory)
    checks += [check_private_key(path) for path in keys]
    default_known_hosts = ssh_directory / "known_hosts"
    if known_hosts_paths:
        checks += [check_known_hosts(path) for path in known_hosts_paths]
    elif default_known_hosts.exists():
        checks.append(check_known_hosts(default_known_hosts))
    return checks


def has_errors(checks: Iterable[DoctorCheck]) -> bool:
    return any(check.level is CheckLevel.ERROR for check in checks)
