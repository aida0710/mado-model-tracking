"""`mado-tracking` command line.

`sync` sends offline Runs to the API, `submit` submits Jobs waiting for a manual site, `site-run`
is the runner a site's job shell starts, and `code register` registers a job template's image.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from . import code_cli
from .client import Client
from .errors import ConfigurationError
from .offline.spool import default_offline_directory
from .offline.sync import RunSyncReport, sync_offline_directories
from .site import runner_cli, submit_cli

EXIT_OK = 0
EXIT_SYNC_FAILED = 1
EXIT_CONFIGURATION_ERROR = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mado-tracking", description="mado ML Tracking SDK commands")
    commands = parser.add_subparsers(dest="command", required=True)
    add_sync_parser(commands)
    code_cli.add_parser(commands)
    submit_cli.add_parser(commands)
    runner_cli.add_parser(commands)
    return parser


def add_sync_parser(commands: Any) -> None:
    sync = commands.add_parser(
        "sync",
        help="send offline Runs to the API (MMT_API_URL, MMT_API_TOKEN)",
        description="Send offline Runs. Rerunning continues where the last attempt stopped.",
    )
    sync.add_argument(
        "directories",
        metavar="DIR",
        nargs="*",
        type=Path,
        help="an offline directory or one Run's directory (default: MMT_OFFLINE_DIR or "
        "~/.local/share/mado-tracking/offline)",
    )
    sync.add_argument(
        "--dry-run", action="store_true", help="show what would be sent without contacting the API"
    )
    sync.add_argument("--project-id", help="only sync Runs recorded for this Project")
    sync.add_argument("--prune", action="store_true", help="delete each Run's spool once it is fully synced")
    sync.set_defaults(handler=run_sync)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    handler: Callable[[argparse.Namespace], int] = arguments.handler
    return handler(arguments)


def run_sync(arguments: argparse.Namespace) -> int:
    directories = arguments.directories or [default_offline_directory()]
    try:
        reports = sync_offline_directories(
            directories,
            client_factory=Client,
            dry_run=arguments.dry_run,
            project_id=arguments.project_id,
            prune=arguments.prune,
        )
    except ConfigurationError as error:
        print(f"mado-tracking: {error}", file=sys.stderr)
        return EXIT_CONFIGURATION_ERROR
    for report in reports:
        print(format_report(report))
        for warning in report.warnings:
            print(f"  warning: {warning}", file=sys.stderr)
    if not reports:
        print("No offline Runs found.")
    return EXIT_SYNC_FAILED if any(report.outcome == "failed" for report in reports) else EXIT_OK


def format_report(report: RunSyncReport) -> str:
    counts = (
        f"batches={report.batches} artifacts={report.uploaded_artifacts} "
        f"present={report.present_artifacts} media={report.media}"
    )
    if report.outcome == "pending":
        counts += f" status={'pending' if report.status_pending else 'none'}"
    message = f" ({report.message})" if report.message else ""
    return f"{report.run_id}  {report.outcome}  {counts}{message}"


if __name__ == "__main__":
    raise SystemExit(main())
