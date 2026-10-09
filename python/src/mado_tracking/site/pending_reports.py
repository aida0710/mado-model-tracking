"""Submission results whose report has not reached the API yet, kept on disk until it does.

The job shell has already submitted these Jobs; without a report the API fails them after
SITE_SUBMISSION_REPORT_TIMEOUT_SECONDS while their runners may already be queued.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from ..worker.host_state import read_json, write_json


class PendingReports:
    def __init__(self, directory: Path):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory = directory

    def save(self, result: dict[str, Any]) -> Path:
        path = self.directory / f"{uuid.uuid4()}.json"
        write_json(path, result)
        return path

    def items(self) -> list[tuple[Path, dict[str, Any]]]:
        saved = []
        for path in sorted(self.directory.glob("*.json"), key=lambda item: item.stat().st_mtime):
            try:
                saved.append((path, read_json(path)))
            except (OSError, ValueError, json.JSONDecodeError):
                # A torn write is not a report; dropping it leaves the API to fail those Jobs.
                path.unlink(missing_ok=True)
        return saved

    def discard(self, path: Path) -> None:
        path.unlink(missing_ok=True)
        try:
            directory = os.open(self.directory, os.O_DIRECTORY)
        except OSError:
            return
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
