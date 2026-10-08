"""Start the development CPU worker from a private local settings file."""

from __future__ import annotations

import argparse
import json
import os
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SETTINGS_FILE = ROOT / "var/playground/worker-settings.json"
WORKER_SETTINGS = {
    "MMT_API_URL",
    "MMT_API_TOKEN",
    "MMT_WORKER_ID",
    "MMT_WORKER_TARGET_IDS",
    "MMT_WORKER_STATE_DIR",
    "MMT_ALLOW_LOCAL_EXECUTOR",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS_FILE)
    arguments = parser.parse_args()
    settings = json.loads(arguments.settings.read_text())
    if not isinstance(settings, dict) or set(settings) != WORKER_SETTINGS:
        raise SystemExit("The worker settings file has unexpected fields")
    if arguments.settings.stat().st_mode & 0o077:
        raise SystemExit("The worker settings file must have permission 600")
    for name, value in settings.items():
        if not isinstance(value, str):
            raise SystemExit("Worker settings must be strings")
        os.environ[name] = value
    runpy.run_module("mado_tracking.worker.cli", run_name="__main__")


if __name__ == "__main__":
    main()
