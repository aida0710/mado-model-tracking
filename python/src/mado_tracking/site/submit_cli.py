"""`mado-tracking submit --site <targetId>`: argument parsing and stopping for manual site submission."""

from __future__ import annotations

import argparse
import signal
import sys
import threading
from pathlib import Path
from types import FrameType
from typing import Any

from ..client import Client
from ..errors import ApiError, ConfigurationError
from .manual_submit import (
    DEFAULT_WATCH_INTERVAL_SECONDS,
    MAX_SUBMISSIONS,
    MIN_WATCH_INTERVAL_SECONDS,
    ManualSubmitter,
    SubmitOptions,
    with_variables,
)

EXIT_CONFIGURATION_ERROR = 2
# 128 + SIGINT, as a shell reports a command stopped by Ctrl-C.
EXIT_INTERRUPTED = 130
STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM)


def add_parser(commands: Any) -> None:
    parser = commands.add_parser(
        "submit",
        help="submit the Jobs waiting for a manual site, where its job shell runs (MMT_API_URL, "
        "MMT_API_TOKEN)",
        description=(
            "Claim the Jobs that wait for the site, write their spec directories, run the site's job shell "
            "from the Web and report the scheduler job IDs. Without --watch nothing keeps running afterwards."
        ),
    )
    parser.add_argument("--site", required=True, metavar="TARGET_ID", help="the site's ComputeTarget ID")
    parser.add_argument(
        "--all",
        dest="all_jobs",
        action="store_true",
        help="every waiting Job of a computer you own, not only yours",
    )
    rounds = parser.add_mutually_exclusive_group()
    rounds.add_argument(
        "--watch", action="store_true", help="keep submitting until Ctrl-C or SIGTERM (a PC that is the site)"
    )
    rounds.add_argument(
        "--dry-run", action="store_true", help="show the waiting Jobs and the settings without claiming them"
    )
    parser.add_argument(
        "--interval",
        type=float,
        metavar="SECONDS",
        help=f"with --watch: seconds between rounds (default {DEFAULT_WATCH_INTERVAL_SECONDS:g})",
    )
    parser.add_argument(
        "--limit", type=int, default=MAX_SUBMISSIONS, help="submissions to claim per round at most"
    )
    parser.add_argument(
        "--work-dir", help="for this run: the work directory instead of your setting on the Web"
    )
    parser.add_argument(
        "--var",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="for this run: MMT_VAR_NAME on top of the site's and your variables",
    )
    parser.add_argument(
        "--registry-secret-file",
        type=Path,
        metavar="PATH",
        help='registry login {"username", "password"} (JSON, mode 600) for pulling images into SIFs',
    )
    parser.set_defaults(handler=run)


def watch_interval(arguments: argparse.Namespace) -> float:
    if arguments.interval is None:
        return DEFAULT_WATCH_INTERVAL_SECONDS
    if not arguments.watch:
        raise ConfigurationError("--interval goes with --watch")
    # Written so that NaN is refused too.
    if not arguments.interval >= MIN_WATCH_INTERVAL_SECONDS:
        raise ConfigurationError(f"--interval must be at least {MIN_WATCH_INTERVAL_SECONDS:g} (seconds)")
    return float(arguments.interval)


def stop_on_signals(stop: threading.Event) -> None:
    """The first SIGINT or SIGTERM ends the watch after its round; a second one stops at once."""
    previous = {number: signal.getsignal(number) for number in STOP_SIGNALS}

    def handle(_number: int, _frame: FrameType | None) -> None:
        stop.set()
        for number, handler in previous.items():
            signal.signal(number, handler if handler is not None else signal.SIG_DFL)

    for number in STOP_SIGNALS:
        signal.signal(number, handle)


def run(arguments: argparse.Namespace) -> int:
    try:
        interval = watch_interval(arguments)
        options = with_variables(
            SubmitOptions(
                target_id=arguments.site,
                all_jobs=arguments.all_jobs,
                work_dir=arguments.work_dir,
                registry_secret_file=arguments.registry_secret_file,
                limit=arguments.limit,
                dry_run=arguments.dry_run,
            ),
            arguments.var,
        )
        with Client() as client:
            submitter = ManualSubmitter(options, client=client)
            if not arguments.watch:
                return submitter.run_once()
            stop = threading.Event()
            stop_on_signals(stop)
            return submitter.watch(stop, interval=interval)
    except (ConfigurationError, ApiError) as error:
        print(f"mado-tracking submit: {error}", file=sys.stderr)
        return EXIT_CONFIGURATION_ERROR
    except KeyboardInterrupt:
        print("mado-tracking submit: interrupted", file=sys.stderr)
        return EXIT_INTERRUPTED
