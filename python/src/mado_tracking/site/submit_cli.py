"""`mado-tracking submit --site <targetId>`: argument parsing for manual site submission."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from ..client import Client
from ..errors import ApiError, ConfigurationError
from .manual_submit import (
    MAX_SUBMISSIONS,
    ManualSubmitter,
    SubmitOptions,
    default_config_path,
    with_variables,
)

EXIT_CONFIGURATION_ERROR = 2


def add_parser(commands: Any) -> None:
    parser = commands.add_parser(
        "submit",
        help="submit your Jobs waiting for a manual site (run on its login node; MMT_API_URL, MMT_API_TOKEN)",
        description=(
            "Claim your Jobs that wait for the site, write their spec directories, run the job shell and "
            "report the scheduler job IDs. Nothing keeps running afterwards."
        ),
    )
    parser.add_argument("--site", required=True, metavar="TARGET_ID", help="the site's ComputeTarget ID")
    parser.add_argument(
        "--job-shell", type=Path, help="the site's job shell (default: from the submit config)"
    )
    parser.add_argument("--work-dir", help="absolute work directory that compute nodes see")
    parser.add_argument("--runner-python", help="Python 3.11+ on the compute nodes (default: python3)")
    parser.add_argument("--runner-api-url", help="the API as compute nodes reach it (default: MMT_API_URL)")
    parser.add_argument(
        "--var", action="append", default=[], metavar="NAME=VALUE", help="MMT_VAR_NAME for the job shell"
    )
    parser.add_argument("--limit", type=int, default=MAX_SUBMISSIONS, help="submissions to claim at most")
    parser.add_argument("--config", type=Path, help="submit TOML with per-site defaults")
    parser.add_argument("--dry-run", action="store_true", help="show the waiting Jobs without claiming them")
    parser.set_defaults(handler=run)


def run(arguments: argparse.Namespace) -> int:
    try:
        if not 1 <= arguments.limit <= MAX_SUBMISSIONS:
            raise ConfigurationError(f"--limit must be from 1 to {MAX_SUBMISSIONS}")
        options = with_variables(
            SubmitOptions(
                target_id=arguments.site,
                config_path=arguments.config or default_config_path(),
                job_shell=arguments.job_shell,
                work_dir=arguments.work_dir,
                runner_python=arguments.runner_python,
                runner_api_url=arguments.runner_api_url,
                limit=arguments.limit,
                dry_run=arguments.dry_run,
            ),
            arguments.var,
        )
        with Client() as client:
            return ManualSubmitter(options, client=client).run()
    except (ConfigurationError, ApiError) as error:
        print(f"mado-tracking submit: {error}", file=sys.stderr)
        return EXIT_CONFIGURATION_ERROR
