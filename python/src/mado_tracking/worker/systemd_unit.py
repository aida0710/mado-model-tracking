"""Render the systemd template unit that keeps a worker running; no I/O, no secrets."""

from __future__ import annotations

import enum
from dataclasses import dataclass
from pathlib import PurePosixPath

# One template serves every worker on the host; the instance name (%i) is the worker ID.
SERVICE_TEMPLATE_NAME = "mado-tracking-worker@.service"
# Long enough to ride out an API restart, short enough that an outage is noticed in the Workers list.
RESTART_DELAY_SECONDS = 10


class ServiceScope(enum.Enum):
    USER = "user"
    SYSTEM = "system"


@dataclass(frozen=True)
class WorkerUnitSettings:
    scope: ServiceScope
    python_executable: PurePosixPath
    # Holds `<worker-id>.env`; the unit references it as `<directory>/%i.env`.
    environment_directory: PurePosixPath
    # Only system units switch user; a user unit already runs as its owner.
    service_user: str | None = None


def instance_unit_name(worker_id: str) -> str:
    return SERVICE_TEMPLATE_NAME.replace("@.", f"@{worker_id}.")


def _require_plain_absolute_path(path: PurePosixPath, label: str) -> None:
    # systemd splits ExecStart on whitespace and expands `%` and `$`; such paths would change meaning.
    if not path.is_absolute() or any(character in str(path) for character in " \t\n%$\"'\\"):
        raise ValueError(f"{label} must be an absolute path without whitespace, quotes, %, or $")


def render_worker_unit(settings: WorkerUnitSettings) -> str:
    _require_plain_absolute_path(settings.python_executable, "Python executable")
    _require_plain_absolute_path(settings.environment_directory, "Environment directory")
    is_system = settings.scope is ServiceScope.SYSTEM
    if is_system and not settings.service_user:
        raise ValueError("A system unit needs the user the worker runs as")
    unit_lines = [
        "[Unit]",
        "Description=mado ML Tracking worker %i",
    ]
    if is_system:
        # A user manager cannot order against system targets, so only the system unit waits for network.
        unit_lines += ["Wants=network-online.target", "After=network-online.target"]
    service_lines = [
        "",
        "[Service]",
        "Type=simple",
    ]
    if is_system:
        service_lines.append(f"User={settings.service_user}")
    service_lines += [
        "# The API token lives only in this mode-600 file, never in the unit or in argv.",
        f"EnvironmentFile={settings.environment_directory}/%i.env",
        f"ExecStart={settings.python_executable} -m mado_tracking.worker.cli run",
        "Restart=on-failure",
        f"RestartSec={RESTART_DELAY_SECONDS}",
        # Written into the unit so whoever edits it later sees why the default must not come back.
        "# SIGTERM reaches only the worker, which stops monitoring and keeps its journal. Detached Job",
        "# supervisors stay in this cgroup; KillMode=control-group would kill running Jobs on every",
        "# restart or upgrade, while the restarted worker is meant to reattach to them.",
        "KillMode=process",
        "# The worker writes journals and Job tokens; keep new files private.",
        "UMask=0077",
        "NoNewPrivileges=yes",
        "",
        "[Install]",
        f"WantedBy={'multi-user.target' if is_system else 'default.target'}",
    ]
    return "\n".join(unit_lines + service_lines) + "\n"
