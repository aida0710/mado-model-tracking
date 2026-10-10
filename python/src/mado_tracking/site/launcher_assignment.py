"""What the API gives a launcher to do, besides the submissions it claims.

GET /launcher/config lists the sites, keys and connection checks assigned to this launcher; the
launcher reads it at the start of every poll, so a site edited on the Web applies from the next
poll on. A claimed submission still carries the settings of its own claim (site_settings.py); the
assignment's settings serve the connection checks and the cancellations, the Jobs to remove from
a scheduler queue (POST /launcher/site-submissions/cancellations).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..errors import ConfigurationError
from .api_documents import DocumentReader
from .site_settings import SiteSettings, SubmissionAccount

# SiteKeyStatus: 'requested' until the launcher has published the key's public half.
KEY_REQUESTED = "requested"
KEY_STATUSES = (KEY_REQUESTED, "ready")


@dataclass(frozen=True)
class AssignedSite:
    target_id: str
    name: str
    settings: SiteSettings

    @classmethod
    def parse(cls, reader: DocumentReader) -> AssignedSite:
        target = reader.child("target")
        return cls(
            target_id=target.uuid("id"),
            name=target.text("name"),
            settings=SiteSettings.parse(reader.child("settings")),
        )

    @property
    def label(self) -> str:
        """How logs name the site: its name for people, its ID to find it."""
        return f"{self.name} ({self.target_id})"


@dataclass(frozen=True)
class LauncherKey:
    """A live key of this launcher: a site's shared account's, or one person's for their own."""

    id: str
    target_id: str
    status: str
    # The public half the API holds; None until the launcher has published one.
    public_key: str | None

    @classmethod
    def parse(cls, reader: DocumentReader) -> LauncherKey:
        status = reader.text("status")
        if status not in KEY_STATUSES:
            raise ConfigurationError(f"{reader.label}.status must be one of {', '.join(KEY_STATUSES)}")
        return cls(
            id=reader.uuid("id"),
            target_id=reader.uuid("targetId"),
            status=status,
            public_key=reader.optional_text("publicKey"),
        )

    @property
    def requested(self) -> bool:
        return self.status == KEY_REQUESTED


@dataclass(frozen=True)
class ConnectionCheck:
    """Log in once as the account with its key and run `true`; nothing is submitted."""

    id: str
    target_id: str
    account: SubmissionAccount

    @classmethod
    def parse(cls, reader: DocumentReader) -> ConnectionCheck:
        return cls(
            id=reader.uuid("id"),
            target_id=reader.uuid("targetId"),
            account=SubmissionAccount.parse(reader.child("account")),
        )


@dataclass(frozen=True)
class SchedulerCancellation:
    """A Job that ended while it waited in the scheduler queue, which this launcher queued."""

    job_id: str
    target_id: str
    scheduler_job_id: str
    # The account its cancel command runs as; '' and no key when the API no longer knows it.
    account: SubmissionAccount

    @classmethod
    def parse(cls, document: Any) -> SchedulerCancellation:
        reader = DocumentReader(document, label="cancellation")
        return cls(
            job_id=reader.uuid("jobId"),
            target_id=reader.uuid("targetId"),
            scheduler_job_id=reader.text("schedulerJobId"),
            account=SubmissionAccount.parse(reader.child("account")),
        )


@dataclass(frozen=True)
class LauncherAssignment:
    launcher_name: str
    sites: Mapping[str, AssignedSite]
    keys: tuple[LauncherKey, ...]
    checks: tuple[ConnectionCheck, ...]

    @classmethod
    def parse(cls, document: Any) -> LauncherAssignment:
        reader = DocumentReader(document, label="launcher configuration")
        sites = [AssignedSite.parse(site) for site in reader.children("sites")]
        return cls(
            launcher_name=reader.child("launcher").text("name"),
            sites={site.target_id: site for site in sites},
            keys=tuple(LauncherKey.parse(key) for key in reader.children("keys")),
            checks=tuple(ConnectionCheck.parse(check) for check in reader.children("checks")),
        )
