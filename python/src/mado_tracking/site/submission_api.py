"""The submission endpoints: a launcher's (project worker token) and `mado-tracking submit`'s (own token)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..client import Client
from ..errors import ConfigurationError


def _items(response: dict[str, Any], label: str) -> list[dict[str, Any]]:
    items = response.get("items")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ConfigurationError(f"{label} response must contain items")
    return items


class LauncherApi:
    def __init__(self, client: Client, *, launcher_id: str):
        self.client = client
        self.launcher_id = launcher_id

    def claim(self, target_ids: Sequence[str], *, limit: int) -> list[dict[str, Any]]:
        # Not retried: a lost answer leaves the Jobs `submitting` until the API fails them; a
        # resent claim would take further Jobs instead.
        response = self.client.request(
            "POST",
            "worker/site-submissions/claim",
            json={"launcherId": self.launcher_id, "targetIds": list(target_ids), "limit": limit},
        )
        return _items(response, "Site submission claim")

    def report(self, results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        response = self.client.request(
            "POST",
            "worker/site-submissions/report",
            json={"launcherId": self.launcher_id, "results": list(results)},
            retryable=True,
        )
        return _items(response, "Site submission report")

    def cancellations(self, target_ids: Sequence[str]) -> list[dict[str, Any]]:
        response = self.client.request(
            "POST",
            "worker/site-submissions/cancellations",
            json={"launcherId": self.launcher_id, "targetIds": list(target_ids)},
            retryable=True,
        )
        return _items(response, "Site cancellation list")

    def report_cancellations(self, job_ids: Sequence[str]) -> None:
        self.client.request(
            "POST",
            "worker/site-submissions/cancellations/report",
            json={"launcherId": self.launcher_id, "jobIds": list(job_ids)},
            retryable=True,
        )


class ManualSubmissionApi:
    def __init__(self, client: Client, *, submitter_id: str):
        self.client = client
        self.submitter_id = submitter_id

    def waiting(self) -> list[dict[str, Any]]:
        return _items(
            self.client.request("GET", "manual-submissions", retryable=True), "Manual submission list"
        )

    def claim(self, target_id: str, *, limit: int) -> list[dict[str, Any]]:
        response = self.client.request(
            "POST",
            "manual-submissions/claim",
            json={"targetId": target_id, "submitterId": self.submitter_id, "limit": limit},
        )
        return _items(response, "Manual submission claim")

    def report(self, results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        response = self.client.request(
            "POST",
            "manual-submissions/report",
            json={"submitterId": self.submitter_id, "results": list(results)},
            retryable=True,
        )
        return _items(response, "Manual submission report")
