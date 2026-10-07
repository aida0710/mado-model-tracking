"""Worker identity, polling, and explicitly enabled development execution."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from ..errors import ConfigurationError
from ..settings import ApiSettings

# Poll frequently enough to respond to cancellation without excessive API/SSH requests.
DEFAULT_HEARTBEAT_SECONDS = 5.0
DEFAULT_POLL_SECONDS = 1.0
DEFAULT_TELEMETRY_SECONDS = 10.0
DEFAULT_CANCEL_GRACE_SECONDS = 10.0
DEFAULT_PARALLEL_JOBS = 2


@dataclass(frozen=True)
class WorkerSettings:
    api: ApiSettings
    worker_id: str
    target_ids: tuple[str, ...]
    state_directory: Path
    allow_local_executor: bool = False
    heartbeat_seconds: float = DEFAULT_HEARTBEAT_SECONDS
    poll_seconds: float = DEFAULT_POLL_SECONDS
    telemetry_seconds: float = DEFAULT_TELEMETRY_SECONDS
    cancel_grace_seconds: float = DEFAULT_CANCEL_GRACE_SECONDS
    parallel_jobs: int = DEFAULT_PARALLEL_JOBS
    install_dependencies: bool = True

    @classmethod
    def from_environment(cls) -> WorkerSettings:
        worker_id = os.environ.get("MMT_WORKER_ID", "")
        if not worker_id or any(character in worker_id for character in "\r\n\x00"):
            raise ConfigurationError("MMT_WORKER_ID is required and must be stable across restarts")
        identity_directory = hashlib.sha256(worker_id.encode()).hexdigest()[:16]
        state_directory = Path(
            os.environ.get(
                "MMT_WORKER_STATE_DIR",
                str(Path.home() / ".local/state/mado-tracking-worker" / identity_directory),
            )
        ).expanduser()
        target_ids = tuple(
            value.strip() for value in os.environ.get("MMT_WORKER_TARGET_IDS", "").split(",") if value.strip()
        )
        return cls(
            api=ApiSettings.from_environment(),
            worker_id=worker_id,
            target_ids=target_ids,
            state_directory=state_directory,
            allow_local_executor=os.environ.get("MMT_ALLOW_LOCAL_EXECUTOR") == "true",
        )
