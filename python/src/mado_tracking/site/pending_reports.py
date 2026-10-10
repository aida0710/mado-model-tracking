"""Submission results whose report has not reached the API yet, kept on disk until it does.

The job shell has already submitted these Jobs; without a report the API fails them after
SITE_SUBMISSION_REPORT_TIMEOUT_SECONDS while their runners may already be queued. A result is
saved before it is sent, so a crash in between loses nothing, and it stays saved until the API has
it or refuses it for good (409: an earlier copy arrived, or the Jobs left `submitting` meanwhile).
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from ..errors import ApiError
from ..worker.host_state import read_json, write_json
from .submission_api import refused_for_good

ReportSender = Callable[[Sequence[dict[str, Any]]], object]


def _is_result(document: dict[str, Any]) -> bool:
    job_ids = document.get("jobIds")
    return isinstance(job_ids, list) and bool(job_ids) and all(isinstance(job_id, str) for job_id in job_ids)


class PendingReports:
    def __init__(self, directory: Path, *, send: ReportSender, notice: Callable[[str], None]):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory = directory
        self.send = send
        self.notice = notice

    def report(self, result: dict[str, Any]) -> None:
        # Saved first: the job shell has submitted, so the report must survive a crash from here.
        path = self.directory / f"{uuid.uuid4()}.json"
        write_json(path, result)
        if self._deliver(result):
            self._discard(path)

    def resend(self) -> None:
        for path, saved in self._saved():
            if not _is_result(saved):
                # Saved by a launcher of one Project's worker token; the API takes those no more.
                self.notice(f"Dropped the saved report {path.name}, which this version cannot send")
                self._discard(path)
            elif self._deliver(saved):
                self._discard(path)

    def _deliver(self, result: dict[str, Any]) -> bool:
        """True when the report needs no resend (delivered, or refused for good)."""
        jobs = ",".join(result["jobIds"])
        try:
            self.send([result])
            return True
        except ApiError as error:
            if refused_for_good(error):
                self.notice(f"Report for {jobs} refused: {error}")
                return True
            self.notice(f"Report for {jobs} deferred: {error}")
            return False

    def _saved(self) -> list[tuple[Path, dict[str, Any]]]:
        saved = []
        for path in sorted(self.directory.glob("*.json"), key=lambda item: item.stat().st_mtime):
            try:
                saved.append((path, read_json(path)))
            except (OSError, ValueError, json.JSONDecodeError):
                # A torn write is not a report; dropping it leaves the API to fail those Jobs.
                path.unlink(missing_ok=True)
        return saved

    def _discard(self, path: Path) -> None:
        path.unlink(missing_ok=True)
        try:
            directory = os.open(self.directory, os.O_DIRECTORY)
        except OSError:
            return
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
