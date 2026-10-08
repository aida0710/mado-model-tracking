"""Send spooled offline Runs to the API (`mado-tracking sync`).

Order per Run: ``PUT /sync/runs/:id`` → batches in sequence order → Artifacts that
``/artifacts/check`` does not report present, through resumable upload sessions → media →
the terminal status last, so terminal handlers (output registration, automation) see every
Artifact. sync-state.json is saved after every step: a failure stops the Run, and the next sync
continues from there. The API also deduplicates by Run ID, batchId, Artifact sha256 and media id,
so a lost sync-state only costs resending.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from ..api_paths import path_id
from ..artifact_uploads import UploadStateStore, UploadTarget, upload_file_sync
from ..errors import ApiError
from .spool import (
    UPLOAD_SESSION_DIRECTORY,
    SpoolArtifact,
    SpoolError,
    SpoolRunRecord,
    SyncState,
    file_digest,
    find_run_directories,
    list_batches,
    load_run_record,
    read_artifacts,
    read_batch_body,
    read_media,
    read_status,
    remove_run_directory,
    sync_lock,
)

if TYPE_CHECKING:
    from ..client import Client

# POST /sync/runs/:id/artifacts/check accepts up to 1000 items (SYNC_ARTIFACT_CHECK_MAX_ITEMS).
ARTIFACT_CHECK_MAX_ITEMS = 1000

SyncOutcome = Literal["completed", "partial", "recording", "failed", "pending", "filtered"]


@dataclass
class RunSyncReport:
    """What one Run's sync did. 'partial' means everything was sent but the Run has no end yet."""

    run_directory: Path
    run_id: str
    outcome: SyncOutcome
    message: str = ""
    batches: int = 0
    uploaded_artifacts: int = 0
    present_artifacts: int = 0
    media: int = 0
    status_pending: bool = False
    warnings: list[str] = field(default_factory=list)


def sync_offline_directories(
    directories: Sequence[Path],
    *,
    client_factory: Callable[[], Client],
    dry_run: bool = False,
    project_id: str | None = None,
    prune: bool = False,
) -> list[RunSyncReport]:
    """Sync every run directory found in directories; the client is made only when needed."""
    run_directories = [run for directory in directories for run in find_run_directories(directory)]
    reports: list[RunSyncReport] = []
    client: Client | None = None
    for run_directory in run_directories:
        record = load_run_record(run_directory)
        if project_id is not None and record.project_id != project_id:
            reports.append(
                RunSyncReport(run_directory, record.run_id, "filtered", f"Project {record.project_id}")
            )
            continue
        if dry_run:
            reports.append(describe_pending(run_directory))
            continue
        client = client or client_factory()
        reports.append(sync_run_directory(client, run_directory, prune=prune))
    return reports


def describe_pending(run_directory: Path) -> RunSyncReport:
    """What sync would send, read from the spool only."""
    record = load_run_record(run_directory)
    state = SyncState.load(run_directory)
    if state.completed:
        return RunSyncReport(run_directory, record.run_id, "completed", "already synced")
    sent = set(state.sent_batch_ids)
    return RunSyncReport(
        run_directory,
        record.run_id,
        "pending",
        batches=sum(1 for batch in list_batches(run_directory) if batch.batch_id not in sent),
        uploaded_artifacts=sum(
            1
            for artifact in read_artifacts(run_directory)
            if str(artifact.line_number) not in state.artifact_ids
        ),
        media=sum(1 for media in read_media(run_directory) if media["id"] not in state.sent_media_ids),
        status_pending=read_status(run_directory) is not None and not state.status_sent,
    )


def sync_run_directory(client: Client, run_directory: Path, *, prune: bool = False) -> RunSyncReport:
    with sync_lock(run_directory) as unlocked:
        record = load_run_record(run_directory)
        if not unlocked:
            return RunSyncReport(run_directory, record.run_id, "recording", "still being recorded; skipped")
        run_sync = _RunSync(client, run_directory, record)
        try:
            run_sync.send()
        except (ApiError, SpoolError) as error:
            run_sync.report.outcome = "failed"
            run_sync.report.message = client.masker.mask(str(error))
            return run_sync.report
    if prune and run_sync.report.outcome == "completed":
        remove_run_directory(run_directory)
        run_sync.report.message = "synced and removed from the spool"
    return run_sync.report


class _RunSync:
    def __init__(self, client: Client, run_directory: Path, record: SpoolRunRecord):
        self.client = client
        self.directory = run_directory
        self.record = record
        self.state = SyncState.load(run_directory)
        self.sync_path = client.project_path(record.project_id, f"sync/runs/{path_id(record.run_id)}")
        self.run_path = client.project_path(record.project_id, f"runs/{path_id(record.run_id)}")
        self.report = RunSyncReport(run_directory, record.run_id, "partial")
        if record.api_url and record.api_url != client.settings.url:
            self.report.warnings.append(f"recorded for {record.api_url}, sending to {client.settings.url}")

    def send(self) -> None:
        if self.state.completed:
            self.report.outcome = "completed"
            self.report.message = "already synced"
            return
        self._create_run()
        self._send_batches()
        artifact_ids = self._send_artifacts()
        self._send_media(artifact_ids)
        if self._send_status():
            self.state.completed = True
            self._save()
            self.report.outcome = "completed"
        else:
            self.report.message = "no terminal status yet; the Run stays running"

    def _save(self) -> None:
        self.state.save(self.directory)

    def _create_run(self) -> None:
        if self.state.run_created:
            return
        # 201 creates the Run, 200 returns the one created by an earlier attempt unchanged.
        self.client.request("PUT", self.sync_path, json=self.record.sync_create_body(), retryable=True)
        self.state.run_created = True
        self._save()

    def _send_batches(self) -> None:
        sent = set(self.state.sent_batch_ids)
        for batch in list_batches(self.directory):
            if batch.batch_id in sent:
                continue
            body = read_batch_body(batch)
            if set(body) - {"batchId", "sequence"}:
                # Always 200; duplicate=true means an earlier attempt already applied this batchId.
                self.client.request("POST", f"{self.sync_path}/batches", json=body, retryable=True)
                self.report.batches += 1
            self.state.sent_batch_ids.append(batch.batch_id)
            self._save()

    def _send_artifacts(self) -> dict[str, str | None]:
        """Upload what the API does not hold yet; returns path -> Artifact id of the latest entry."""
        artifacts = read_artifacts(self.directory)
        pending = [
            artifact for artifact in artifacts if str(artifact.line_number) not in self.state.artifact_ids
        ]
        for artifact in pending:
            _verify_unchanged(artifact)
        latest = _latest_entries(pending)
        present = self._present_paths(latest)
        latest_lines = {artifact.line_number for artifact in latest}
        store = UploadStateStore(self.directory / UPLOAD_SESSION_DIRECTORY)
        for artifact in pending:
            # A path logged twice is only "present" for its latest content, so every older entry is
            # uploaded first and the latest one stays the Run's current Artifact.
            artifact_id: str | None
            if artifact.line_number in latest_lines and artifact.path in present:
                artifact_id = None
                self.report.present_artifacts += 1
            else:
                artifact_id = self._upload(artifact, store)
                self.report.uploaded_artifacts += 1
            self.state.artifact_ids[str(artifact.line_number)] = artifact_id
            self._save()
        return {
            artifact.path: self.state.artifact_ids.get(str(artifact.line_number)) for artifact in artifacts
        }

    def _present_paths(self, latest: list[SpoolArtifact]) -> set[str]:
        present: set[str] = set()
        for start in range(0, len(latest), ARTIFACT_CHECK_MAX_ITEMS):
            items = [
                {"path": artifact.path, "sha256": artifact.sha256, "size": artifact.size}
                for artifact in latest[start : start + ARTIFACT_CHECK_MAX_ITEMS]
            ]
            response = self.client.request(
                "POST", f"{self.sync_path}/artifacts/check", json={"items": items}, retryable=True
            )
            present.update(str(path) for path in response.get("present", []))
        return present

    def _upload(self, artifact: SpoolArtifact, store: UploadStateStore) -> str:
        uploaded = upload_file_sync(
            self.client,
            target=UploadTarget(
                api_url=self.client.settings.url,
                project_id=self.record.project_id,
                run_id=self.record.run_id,
                path=artifact.path,
                mime_type=artifact.mime_type,
            ),
            source=artifact.local_path,
            state_store=store,
        )
        return str(uploaded["id"])

    def _send_media(self, artifact_ids: dict[str, str | None]) -> None:
        for media in read_media(self.directory):
            if media["id"] in self.state.sent_media_ids:
                continue
            item: dict[str, Any] = {
                "id": media["id"],
                "key": media["key"],
                "step": media["step"],
                "kind": media["kind"],
                "artifactId": self._artifact_id(media["artifactPath"], artifact_ids),
                "caption": media.get("caption"),
                "metadata": media.get("metadata", {}),
            }
            # The media id makes the POST idempotent, so a lost response can be retried.
            self.client.request(
                "POST", f"{self.run_path}/media", json={"items": [item]}, retryable=True
            )
            self.state.sent_media_ids.append(media["id"])
            self._save()
            self.report.media += 1

    def _artifact_id(self, path: str, artifact_ids: dict[str, str | None]) -> str:
        if path not in artifact_ids:
            raise SpoolError(f"Media refers to {path!r}, which was not logged as an Artifact of this Run")
        if known := artifact_ids[path]:
            return known
        # The Artifact was already present, so its id comes from the Run's current listing.
        listing = self.client.request(
            "GET", f"{self.run_path}/artifacts", params={"prefix": path}, retryable=True
        )
        for item in listing.get("items", []):
            if item.get("path") == path:
                return str(item["id"])
        raise SpoolError(f"Artifact {path!r} was reported present but is not listed on the Run")

    def _send_status(self) -> bool:
        status = read_status(self.directory)
        if status is None:
            return False
        if self.state.status_sent:
            return True
        sequence = 1 + max((batch.sequence for batch in list_batches(self.directory)), default=0)
        terminal: dict[str, Any] = {"status": status.status, "endedAt": status.ended_at}
        if status.error:
            terminal["error"] = status.error
        self.client.request(
            "POST",
            f"{self.sync_path}/batches",
            json={"batchId": status.batch_id, "sequence": sequence, "status": terminal},
            retryable=True,
        )
        self.state.status_sent = True
        self._save()
        return True


def _latest_entries(artifacts: list[SpoolArtifact]) -> list[SpoolArtifact]:
    """The last entry of each path, in spool order."""
    latest_by_path = {artifact.path: artifact for artifact in artifacts}
    return [artifact for artifact in artifacts if latest_by_path[artifact.path] is artifact]


def _verify_unchanged(artifact: SpoolArtifact) -> None:
    if not artifact.local_path.is_file():
        raise SpoolError(f"Artifact {artifact.path!r} is missing its file {artifact.local_path}")
    sha256, size = file_digest(artifact.local_path)
    if (sha256, size) != (artifact.sha256, artifact.size):
        raise SpoolError(
            f"{artifact.local_path} changed after it was logged as {artifact.path!r}; "
            "log it again or restore the original file"
        )
