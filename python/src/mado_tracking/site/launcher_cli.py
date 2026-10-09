"""`mado-tracking-launcher --config launcher.toml`: submit claimed site Jobs until stopped."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
from collections.abc import Sequence
from pathlib import Path

from ..errors import ApiError, ConfigurationError
from .launcher import run_launcher
from .launcher_config import load_launcher_config

CONFIG_VARIABLE = "MMT_LAUNCHER_CONFIG"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mado-tracking-launcher",
        description="Claim Jobs for sites, submit them with each site's job shell and report the result.",
    )
    parser.add_argument(
        "--config", type=Path, help=f"launcher TOML (default: ${CONFIG_VARIABLE}); tokens stay in token files"
    )
    parser.add_argument("--once", action="store_true", help="claim, submit and report once, then exit")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    arguments = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config_path = arguments.config or (
        Path(os.environ[CONFIG_VARIABLE]) if os.environ.get(CONFIG_VARIABLE) else None
    )
    if config_path is None:
        print(f"mado-tracking-launcher: give --config or set {CONFIG_VARIABLE}", file=sys.stderr)
        raise SystemExit(2)
    stop = threading.Event()
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signal_number, lambda _signal, _frame: stop.set())
    try:
        run_launcher(load_launcher_config(config_path), once=arguments.once, stop=stop)
    except (ConfigurationError, ApiError) as error:
        logging.getLogger("mado_tracking.site").error("%s", error)
        raise SystemExit(1) from None
    raise SystemExit(0)


if __name__ == "__main__":
    main()
