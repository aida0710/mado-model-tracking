"""Where a Run's writes go: the API (online), the local spool (offline), or online until the API
is unreachable (auto). Run only talks to a RunTransport, so it has no mode branches of its own.
"""

from __future__ import annotations

import socket
import sys
import threading
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Literal, Protocol, TypeVar

from ..api_paths import path_id
from ..artifact_uploads import (
    SESSION_UPLOAD_THRESHOLD_BYTES,
    UploadSessionFailed,
    UploadTarget,
    upload_file_sync,
)
from ..errors import ApiError, ConfigurationError
from ..timestamps import utc_timestamp
from .spool import RunSpool, SpoolRunRecord

if TYPE_CHECKING:
    from ..client import Client

RunMode = Literal["online", "offline", "auto"]
RUN_MODES: tuple[RunMode, ...] = ("online", "offline", "auto")
# Keep uploads bounded even for multi-gigabyte model artifacts.
ARTIFACT_CHUNK_BYTES = 1024 * 1024
# Run.syncOrigin accepts up to 200 characters (SYNC_ORIGIN_MAX_LENGTH).
SYNC_ORIGIN_MAX_LENGTH = 200

Result = TypeVar("Result")


@dataclass(frozen=True)
class RunMediaItem:
    """A media item to register after its file is stored at artifact_path. The id is chosen by the
    SDK so a resent registration, online or from the spool, does not add a second item."""

    id: str
    key: str
    step: int
    kind: str
    artifact_path: str
    mime_type: str
    caption: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class RunTransport(Protocol):
    """The write side of a Run. Methods that change the Run return its new entity when known."""

    @property
    def offline_directory(self) -> Path | None:
        """The spool directory once records go there, else None."""

    def start(self) -> dict[str, Any] | None: ...

    def finish(self, status: str) -> dict[str, Any] | None: ...

    def log_metrics(self, points: list[dict[str, Any]]) -> None: ...

    def log_params(self, parameters: Mapping[str, Any]) -> dict[str, Any] | None: ...

    def set_tags(self, tags: Mapping[str, str]) -> dict[str, Any] | None: ...

    def log_entries(self, entries: list[dict[str, Any]]) -> None: ...

    def log_artifact(
        self, source: Path | BinaryIO, *, path: str, mime_type: str, copy: bool
    ) -> dict[str, Any]: ...

    def log_media(self, source: Path, media: RunMediaItem) -> dict[str, Any]:
        """Store source as the Artifact media.artifact_path, then register it as Run media."""

    def close(self) -> None: ...


def resolve_mode(mode: str | None, environment: Mapping[str, str]) -> RunMode:
    """The explicit mode, else MMT_MODE, else online (W&B's WANDB_MODE plays the same role)."""
    chosen = mode or environment.get("MMT_MODE") or "online"
    for known in RUN_MODES:
        if chosen == known:
            return known
    raise ConfigurationError(f"mode must be one of {', '.join(RUN_MODES)}, not {chosen!r}")


def machine_origin() -> str:
    return socket.gethostname()[:SYNC_ORIGIN_MAX_LENGTH]


def spool_record_from_entity(entity: Mapping[str, Any], *, project_id: str, api_url: str) -> SpoolRunRecord:
    """run.json for a Run the API already created, so sync's PUT finds it and changes nothing."""
    return SpoolRunRecord(
        run_id=str(entity["id"]),
        project_id=project_id,
        api_url=api_url,
        experiment_id=str(entity["experimentId"]),
        name=str(entity.get("name") or entity["id"]),
        kind=str(entity.get("kind") or "training"),
        parameters=dict(entity.get("parameters") or {}),
        tags=dict(entity.get("tags") or {}),
        parent_run_id=entity.get("parentRunId"),
        started_at=str(entity.get("startedAt") or utc_timestamp()),
        origin=machine_origin(),
    )


def is_api_unreachable(error: ApiError) -> bool:
    """A lost connection or a 5xx left after retries; a 4xx is a real answer and is raised."""
    if isinstance(error, UploadSessionFailed):
        return False
    return error.status_code is None or error.status_code >= 500


class HttpRunTransport:
    """Sends every write to the native API right away."""

    def __init__(self, client: Client, project_id: str, run_id: str):
        self.client = client
        self.project_id = project_id
        self.run_id = run_id
        self.run_path = client.project_path(project_id, f"runs/{path_id(run_id)}")

    @property
    def offline_directory(self) -> Path | None:
        return None

    def start(self) -> dict[str, Any] | None:
        return self.client.request("PATCH", self.run_path, json={"status": "running"}, retryable=True)

    def finish(self, status: str) -> dict[str, Any] | None:
        return self.client.request("PATCH", self.run_path, json={"status": status}, retryable=True)

    def log_metrics(self, points: list[dict[str, Any]]) -> None:
        self.client.request("POST", f"{self.run_path}/metrics", json={"metrics": points}, retryable=True)

    def log_params(self, parameters: Mapping[str, Any]) -> dict[str, Any] | None:
        return self.client.request(
            "PATCH", self.run_path, json={"parameters": dict(parameters)}, retryable=True
        )

    def set_tags(self, tags: Mapping[str, str]) -> dict[str, Any] | None:
        return self.client.request("PATCH", self.run_path, json={"tags": dict(tags)}, retryable=True)

    def log_entries(self, entries: list[dict[str, Any]]) -> None:
        self.client.request("POST", f"{self.run_path}/logs", json={"entries": entries}, retryable=True)

    def log_artifact(
        self, source: Path | BinaryIO, *, path: str, mime_type: str, copy: bool
    ) -> dict[str, Any]:
        """Files of SESSION_UPLOAD_THRESHOLD_BYTES or more use a resumable upload session."""
        if isinstance(source, Path) and source.stat().st_size >= SESSION_UPLOAD_THRESHOLD_BYTES:
            return upload_file_sync(
                self.client,
                target=UploadTarget(
                    api_url=self.client.settings.url,
                    project_id=self.project_id,
                    run_id=self.run_id,
                    path=path,
                    mime_type=mime_type,
                ),
                source=source,
            )
        stream = source.open("rb") if isinstance(source, Path) else source

        def chunks() -> Iterator[bytes]:
            while chunk := stream.read(ARTIFACT_CHUNK_BYTES):
                yield chunk

        try:
            return self.client.request(
                "PUT",
                f"{self.run_path}/artifacts",
                params={"path": path},
                headers={"Content-Type": mime_type},
                content_factory=chunks,
            )
        finally:
            if isinstance(source, Path):
                stream.close()

    def log_media(self, source: Path, media: RunMediaItem) -> dict[str, Any]:
        artifact = self.log_artifact(source, path=media.artifact_path, mime_type=media.mime_type, copy=True)
        item = {
            "id": media.id,
            "key": media.key,
            "step": media.step,
            "kind": media.kind,
            "artifactId": artifact["id"],
            "caption": media.caption,
            "metadata": media.metadata,
        }
        # The media id makes the POST idempotent, so a lost response can be retried.
        created = self.client.request(
            "POST", f"{self.run_path}/media", json={"items": [item]}, retryable=True
        )
        return dict(created["items"][0])

    def close(self) -> None:
        pass


class SpoolRunTransport:
    """Appends every write to the local spool; nothing contacts the API."""

    def __init__(self, spool: RunSpool):
        self.spool = spool

    @property
    def offline_directory(self) -> Path | None:
        return self.spool.directory

    def start(self) -> dict[str, Any] | None:
        # A spooled Run is created running by PUT /sync/runs/:runId.
        return None

    def finish(self, status: str) -> dict[str, Any] | None:
        self.spool.write_status(status, ended_at=utc_timestamp())
        return None

    def log_metrics(self, points: list[dict[str, Any]]) -> None:
        self.spool.append_metrics(points)

    def log_params(self, parameters: Mapping[str, Any]) -> dict[str, Any] | None:
        self.spool.append_params(parameters)
        return None

    def set_tags(self, tags: Mapping[str, str]) -> dict[str, Any] | None:
        self.spool.append_tags(tags)
        return None

    def log_entries(self, entries: list[dict[str, Any]]) -> None:
        self.spool.append_logs(entries)

    def log_artifact(
        self, source: Path | BinaryIO, *, path: str, mime_type: str, copy: bool
    ) -> dict[str, Any]:
        return self.spool.add_artifact(source, path=path, mime_type=mime_type, copy=copy)

    def log_media(self, source: Path, media: RunMediaItem) -> dict[str, Any]:
        self.spool.add_artifact(source, path=media.artifact_path, mime_type=media.mime_type, copy=True)
        return self.spool.add_media(
            key=media.key,
            step=media.step,
            kind=media.kind,
            artifact_path=media.artifact_path,
            caption=media.caption,
            metadata=media.metadata,
            media_id=media.id,
        )

    def close(self) -> None:
        self.spool.close()


class AutoRunTransport:
    """Online until a write cannot reach the API, then the spool for the rest of the Run.

    Writes that reached the API before the switch are not spooled again; the spool's sync-state
    records that the Run exists, so sync only sends what came after. The failed write itself is
    spooled: it may have reached the API, and resending it is preferred to losing it.
    """

    def __init__(self, online: HttpRunTransport, open_spool: Callable[[], RunSpool]):
        self.online = online
        self._open_spool = open_spool
        self._offline: SpoolRunTransport | None = None
        self._switch_lock = threading.Lock()

    @property
    def offline_directory(self) -> Path | None:
        return self._offline.offline_directory if self._offline else None

    def start(self) -> dict[str, Any] | None:
        return self._send(lambda transport: transport.start())

    def finish(self, status: str) -> dict[str, Any] | None:
        return self._send(lambda transport: transport.finish(status))

    def log_metrics(self, points: list[dict[str, Any]]) -> None:
        self._send(lambda transport: transport.log_metrics(points))

    def log_params(self, parameters: Mapping[str, Any]) -> dict[str, Any] | None:
        return self._send(lambda transport: transport.log_params(parameters))

    def set_tags(self, tags: Mapping[str, str]) -> dict[str, Any] | None:
        return self._send(lambda transport: transport.set_tags(tags))

    def log_entries(self, entries: list[dict[str, Any]]) -> None:
        self._send(lambda transport: transport.log_entries(entries))

    def log_artifact(
        self, source: Path | BinaryIO, *, path: str, mime_type: str, copy: bool
    ) -> dict[str, Any]:
        if not isinstance(source, Path):
            # A stream read by a failed upload cannot be read again for the spool.
            return self._send(
                lambda transport: transport.log_artifact(source, path=path, mime_type=mime_type, copy=copy),
                retry_offline=False,
            )
        return self._send(
            lambda transport: transport.log_artifact(source, path=path, mime_type=mime_type, copy=copy)
        )

    def log_media(self, source: Path, media: RunMediaItem) -> dict[str, Any]:
        # Spooling stores the file again: sync needs it in the spool even if the upload succeeded.
        return self._send(lambda transport: transport.log_media(source, media))

    def close(self) -> None:
        if self._offline is not None:
            self._offline.close()

    def _send(self, write: Callable[[RunTransport], Result], *, retry_offline: bool = True) -> Result:
        if self._offline is not None:
            return write(self._offline)
        try:
            return write(self.online)
        except ApiError as error:
            if not is_api_unreachable(error):
                raise
            offline = self._switch_to_offline()
            if not retry_offline:
                raise
            return write(offline)

    def _switch_to_offline(self) -> SpoolRunTransport:
        with self._switch_lock:
            if self._offline is None:
                self._offline = SpoolRunTransport(self._open_spool())
                print(
                    f"mado-tracking: the API is unreachable; Run {self.online.run_id} continues in "
                    f"{self._offline.offline_directory}. Send it later with `mado-tracking sync`.",
                    file=sys.stderr,
                )
            return self._offline
