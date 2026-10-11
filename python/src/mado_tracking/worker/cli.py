"""Worker entrypoint and host-side service commands; diagnostics are sanitized and never dump config."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import logging
import os
import signal
import sys
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import TextIO

from ..errors import ApiError, ConfigurationError
from ..settings import ApiSettings
from .config import WorkerSettings
from .doctor import (
    CheckLevel,
    DoctorCheck,
    check_api,
    check_private_file,
    check_ssh_files,
    check_state_directory,
    has_errors,
)
from .installer import (
    CommandRunner,
    InstallerError,
    InstallRequest,
    ServiceLayout,
    WorkerStatus,
    install_worker,
    package_spec_for_version,
    parse_environment_file,
    read_token,
    read_worker_status,
    run_command,
    upgrade_worker,
)
from .job_responses import InvalidWorkerJob
from .service import Worker
from .systemd_unit import ServiceScope

SUBCOMMANDS = ("run", "install", "upgrade", "status", "doctor")
# Containers receive the token as a Docker secret file instead of an environment value.
TOKEN_FILE_VARIABLE = "MMT_API_TOKEN_FILE"


async def run(settings: WorkerSettings, *, once: bool) -> None:
    worker = Worker(settings)
    loop = asyncio.get_running_loop()
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signal_number, worker.stopping.set)
    if not once:
        await worker.run_forever()
        return
    worker.journal.acquire_worker_lock()
    try:
        jobs = await worker.recover()
        if not jobs:
            job = await worker.api.claim(
                settings.worker_id, settings.target_ids, active_job_ids=tuple(sorted(worker.retained_job_ids))
            )
            if isinstance(job, InvalidWorkerJob):
                await worker.reject_invalid_job(job)
            elif job is not None:
                jobs = [job]
        for job in jobs:
            await worker.run_job(job)
    finally:
        worker.journal.close()
        await worker.api.close()


def load_token_file() -> None:
    """Expose a mounted token file as MMT_API_TOKEN, exactly like systemd's EnvironmentFile does."""
    token_file = os.environ.get(TOKEN_FILE_VARIABLE)
    if not token_file or os.environ.get("MMT_API_TOKEN"):
        return
    try:
        os.environ["MMT_API_TOKEN"] = read_token(Path(token_file).read_text())
    except (OSError, InstallerError):
        raise ConfigurationError(f"{TOKEN_FILE_VARIABLE} does not point to a readable API token") from None


def run_worker(arguments: argparse.Namespace) -> int:
    load_token_file()
    settings = WorkerSettings.from_environment()
    asyncio.run(run(settings, once=arguments.once))
    return 0


def service_layout(arguments: argparse.Namespace) -> ServiceLayout:
    if arguments.systemd_system:
        return ServiceLayout.for_system()
    return ServiceLayout.for_user(Path.home())


def read_install_token(arguments: argparse.Namespace, stdin: TextIO) -> str:
    # The token is never accepted as an argument: argv is visible to every user through /proc.
    if arguments.token_file:
        return read_token(Path(arguments.token_file).read_text())
    if stdin.isatty():
        return read_token(getpass.getpass("Worker API token: "))
    return read_token(stdin.read())


def install_command(arguments: argparse.Namespace, run_systemctl: CommandRunner, stdin: TextIO) -> int:
    layout = service_layout(arguments)
    request = InstallRequest(
        api_url=arguments.api_url,
        worker_id=arguments.worker_id,
        token=read_install_token(arguments, stdin),
        target_ids=tuple(value.strip() for value in arguments.target_ids.split(",") if value.strip()),
        state_directory=Path(arguments.state_dir).expanduser() if arguments.state_dir else None,
        python_executable=Path(arguments.python) if arguments.python else None,
        service_user=arguments.service_user,
    )
    result = install_worker(request, layout, run_systemctl)
    print(f"Installed {result.unit_name}")
    print(f"  unit: {result.unit_path}")
    print(f"  environment (mode 600): {result.environment_file}")
    print(f"  state directory: {result.state_directory}")
    if layout.scope is ServiceScope.USER:
        print("  To keep it running after logout: loginctl enable-linger " + getpass.getuser())
    return 0


def upgrade_command(arguments: argparse.Namespace, run_systemctl: CommandRunner) -> int:
    package_spec = arguments.package_spec or package_spec_for_version(arguments.version)
    result = upgrade_worker(arguments.worker_id, package_spec, service_layout(arguments), run_systemctl)
    print(f"Installed {result.package_spec} and restarted {result.unit_name}")
    if result.retained_job_ids:
        print(f"  {len(result.retained_job_ids)} running Job(s) kept; the worker reattaches from its journal")
    return 0


def status_command(arguments: argparse.Namespace, run_systemctl: CommandRunner) -> int:
    status = read_worker_status(arguments.worker_id, service_layout(arguments), run_systemctl)
    if arguments.json:
        print(json.dumps({**asdict(status), "is_active": status.is_active}))
    else:
        print_status(status)
    # Same convention as `systemctl status`: 3 means the unit is not running.
    return 0 if status.is_active else 3


def print_status(status: WorkerStatus) -> None:
    print(f"{status.unit_name}: {status.active_state} ({status.sub_state})")
    print(f"  main PID: {status.main_pid or '-'}")
    print(f"  worker lock: {'held' if status.lock_held else 'free'}")
    print(f"  retained Jobs: {', '.join(status.retained_job_ids) or 'none'}")


def doctor_checks(arguments: argparse.Namespace) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    if arguments.worker_id:
        environment_file = service_layout(arguments).environment_file(arguments.worker_id)
        checks.append(check_private_file("environment file", environment_file))
        if not environment_file.exists():
            return checks
        environment = parse_environment_file(environment_file)
    else:
        try:
            load_token_file()
        except ConfigurationError as error:
            checks.append(DoctorCheck("token file", CheckLevel.ERROR, str(error)))
        environment = dict(os.environ)
    state_directory = environment.get("MMT_WORKER_STATE_DIR")
    if state_directory:
        checks.append(check_state_directory(Path(state_directory)))
    try:
        api = ApiSettings.from_environment(
            url=environment.get("MMT_API_URL", ""), token=environment.get("MMT_API_TOKEN", "")
        )
    except ConfigurationError as error:
        checks.append(DoctorCheck("api", CheckLevel.ERROR, str(error)))
    else:
        checks += check_api(api)
    checks += check_ssh_files(
        Path.home() / ".ssh",
        [Path(path).expanduser() for path in arguments.ssh_key],
        [Path(path).expanduser() for path in arguments.known_hosts],
    )
    return checks


def doctor_command(arguments: argparse.Namespace) -> int:
    checks = doctor_checks(arguments)
    for check in checks:
        print(f"[{check.level.value}] {check.name}: {check.detail}")
    return 1 if has_errors(checks) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mado-tracking-worker", description="mado ML Tracking compute worker"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    run_parser = commands.add_parser("run", help="Run the worker in the foreground (default)")
    run_parser.add_argument("--once", action="store_true", help="Recover / claim one batch, then exit")

    scope_parser = argparse.ArgumentParser(add_help=False)
    scope = scope_parser.add_mutually_exclusive_group()
    scope.add_argument("--systemd-user", action="store_true", help="User unit for this account (default)")
    scope.add_argument("--systemd-system", action="store_true", help="System unit; run as root")

    install_parser = commands.add_parser(
        "install",
        parents=[scope_parser],
        help="Write the environment file and systemd unit, then enable --now (token from stdin)",
    )
    install_parser.add_argument("--api-url", required=True)
    install_parser.add_argument("--worker-id", required=True, help="Stable across restarts and upgrades")
    install_parser.add_argument("--target-ids", default="", help="Comma separated; empty = all allowed")
    install_parser.add_argument("--state-dir", help="Journal directory (keep it across reinstalls)")
    install_parser.add_argument("--token-file", help="Read the token from this file instead of stdin")
    install_parser.add_argument("--python", help="Interpreter of the worker venv (default: this one)")
    install_parser.add_argument("--service-user", help="Account a system unit runs as")

    upgrade_parser = commands.add_parser(
        "upgrade", parents=[scope_parser], help="pip install into the service venv, then restart"
    )
    upgrade_parser.add_argument("--worker-id", required=True)
    package = upgrade_parser.add_mutually_exclusive_group(required=True)
    package.add_argument("--version", help="mado-tracking version to install")
    package.add_argument("--package-spec", help="Any pip requirement, e.g. a wheel path")

    status_parser = commands.add_parser(
        "status", parents=[scope_parser], help="Unit state, worker lock, and retained Jobs"
    )
    status_parser.add_argument("--worker-id", required=True)
    status_parser.add_argument("--json", action="store_true")

    doctor_parser = commands.add_parser(
        "doctor", parents=[scope_parser], help="Check API reach, token scopes, and ssh file modes"
    )
    doctor_parser.add_argument("--worker-id", help="Use the installed environment file (default: env vars)")
    doctor_parser.add_argument("--ssh-key", action="append", default=[], help="Private key a target uses")
    doctor_parser.add_argument("--known-hosts", action="append", default=[], help="known_hosts a target uses")
    return parser


def normalize_arguments(argv: Sequence[str]) -> list[str]:
    # Before subcommands existed the worker was started bare or with --once; both still mean `run`.
    if argv and (argv[0] in SUBCOMMANDS or argv[0] in {"-h", "--help"}):
        return list(argv)
    return ["run", *argv]


def dispatch(
    arguments: argparse.Namespace, run_systemctl: CommandRunner = run_command, stdin: TextIO = sys.stdin
) -> int:
    if arguments.command == "run":
        return run_worker(arguments)
    if arguments.command == "install":
        return install_command(arguments, run_systemctl, stdin)
    if arguments.command == "upgrade":
        return upgrade_command(arguments, run_systemctl)
    if arguments.command == "status":
        return status_command(arguments, run_systemctl)
    return doctor_command(arguments)


def main(argv: Sequence[str] | None = None) -> None:
    arguments = build_parser().parse_args(normalize_arguments(sys.argv[1:] if argv is None else argv))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        exit_code = dispatch(arguments)
    except (ConfigurationError, ApiError, InstallerError) as error:
        logging.getLogger("mado_tracking.worker").error("%s", str(error))
        raise SystemExit(1) from None
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
