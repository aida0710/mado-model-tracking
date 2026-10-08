"""Save a training checkpoint to a Run, and find the checkpoint a resumed Job starts from."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .artifact_uploads import UploadTarget, upload_file_sync
from .checkpoint_archive import directory_manifest, write_checkpoint_archive
from .errors import ConfigurationError

if TYPE_CHECKING:
    from .run import Run

CHECKPOINT_ARCHIVE_MIME_TYPE = "application/x-tar"
# Set by the worker when the Job's Run continues from a checkpoint (see docs/worker.md).
RESUME_CHECKPOINT_DIR_VARIABLE = "MMT_RESUME_CHECKPOINT_DIR"
RESUME_STEP_VARIABLE = "MMT_RESUME_STEP"
RESUME_CHECKPOINT_FILE_VARIABLE = "MMT_RESUME_CHECKPOINT_FILE"


@dataclass(frozen=True)
class ResumeCheckpoint:
    """A verified, read-only checkpoint directory and the step it was saved at."""

    path: Path
    step: int
    checkpoint_id: str
    source_run_id: str
    includes_optimizer: bool
    metadata: dict[str, Any]


def checkpoint_artifact_path(step: int) -> str:
    return f"checkpoints/step-{step}.tar"


def log_checkpoint(
    run: Run,
    directory: str | Path,
    *,
    step: int,
    includes_optimizer: bool = False,
    framework: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Archive directory as one tar Artifact (resumable upload session) and register it."""
    if isinstance(step, bool) or not isinstance(step, int) or step < 0:
        raise ConfigurationError("Checkpoint step must be a non-negative integer")
    root = Path(directory)
    files = directory_manifest(root)
    with tempfile.TemporaryDirectory(prefix="mmt-checkpoint-") as staging:
        archive_path = Path(staging) / "checkpoint.tar"
        with archive_path.open("wb") as archive:
            write_checkpoint_archive(((file["path"], root / file["path"]) for file in files), archive)
        # Always a session upload: a checkpoint is the one file a long Job must not lose halfway.
        artifact = upload_file_sync(
            run.client,
            target=UploadTarget(
                api_url=run.client.settings.url,
                project_id=run.project_id,
                run_id=run.id,
                path=checkpoint_artifact_path(step),
                mime_type=CHECKPOINT_ARCHIVE_MIME_TYPE,
            ),
            source=archive_path,
        )
    return run.client.request(
        "POST",
        f"{run.api_path}/checkpoints",
        json={
            "step": step,
            "artifactId": artifact["id"],
            "manifest": {"files": files, "includesOptimizer": includes_optimizer, "framework": framework},
            "metadata": dict(metadata or {}),
        },
        retryable=True,
    )


def resume_checkpoint_from_environment(
    environment: Mapping[str, str] | None = None,
) -> ResumeCheckpoint | None:
    """The checkpoint the worker staged for this Job, or None when the Run starts from scratch."""
    variables = os.environ if environment is None else environment
    directory = variables.get(RESUME_CHECKPOINT_DIR_VARIABLE)
    if not directory:
        return None
    document_file = variables.get(RESUME_CHECKPOINT_FILE_VARIABLE)
    raw_step = variables.get(RESUME_STEP_VARIABLE, "")
    if not document_file or not raw_step.isdigit():
        raise ConfigurationError("Resume checkpoint variables are incomplete")
    try:
        document = json.loads(Path(document_file).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ConfigurationError("Resume checkpoint document is unreadable") from None
    if not isinstance(document, dict) or document.get("step") != int(raw_step):
        raise ConfigurationError("Resume checkpoint document does not match MMT_RESUME_STEP")
    return ResumeCheckpoint(
        path=Path(directory),
        step=int(raw_step),
        checkpoint_id=str(document["checkpointId"]),
        source_run_id=str(document["sourceRunId"]),
        includes_optimizer=bool(document.get("includesOptimizer", False)),
        metadata=dict(document.get("metadata") or {}),
    )
