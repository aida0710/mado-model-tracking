"""Run lifecycle and logging; job-owned status is completed by the worker only."""

from __future__ import annotations

import math
import mimetypes
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any, BinaryIO, Literal

from .checkpoints import ResumeCheckpoint, log_checkpoint, resume_checkpoint_from_environment
from .client import path_id
from .errors import ConfigurationError
from .offline.transport import ARTIFACT_CHUNK_BYTES, HttpRunTransport, RunTransport
from .security import SecretMasker, secret_values
from .system_metrics import DEFAULT_SYSTEM_METRICS_SECONDS, SystemMetricsMonitor
from .timestamps import utc_timestamp

if TYPE_CHECKING:
    from .client import Client

__all__ = ["ARTIFACT_CHUNK_BYTES", "Run"]


class Run:
    """A Run's logging API. Writes go to its RunTransport: the API, the offline spool, or both in turn.

    ``last_steps`` is given when the Run was resumed: log_metrics without a step then continues each
    metric key after its largest step instead of writing step 0.
    """

    def __init__(
        self,
        client: Client | None,
        project_id: str,
        entity: dict[str, Any],
        *,
        managed_by_worker: bool = False,
        transport: RunTransport | None = None,
        last_steps: Mapping[str, int] | None = None,
        masker: SecretMasker | None = None,
    ):
        self._client = client
        self.project_id = project_id
        self.entity = entity
        self.id: str = entity["id"]
        self.managed_by_worker = managed_by_worker
        self.close_client_on_exit = False
        if transport is None:
            if client is None:
                raise ConfigurationError("A Run without a client needs a transport")
            transport = HttpRunTransport(client, project_id, self.id)
        self.transport = transport
        if masker is None:
            masker = client.masker if client is not None else SecretMasker(secret_values(os.environ))
        self.masker = masker
        self._continues_steps = last_steps is not None
        self._last_steps: dict[str, int] = dict(last_steps or {})
        self._system_metrics: SystemMetricsMonitor | None = None

    @property
    def client(self) -> Client:
        """The API client; an offline Run has none and only records locally."""
        if self._client is None:
            raise ConfigurationError("This operation needs the API; an offline Run only records locally")
        return self._client

    @property
    def api_path(self) -> str:
        return self.client.project_path(self.project_id, f"runs/{path_id(self.id)}")

    @property
    def offline_directory(self) -> Path | None:
        """Where this Run is being recorded locally, or None while it writes to the API."""
        return self.transport.offline_directory

    def last_step(self, key: str) -> int | None:
        """The largest step logged for key, including steps recorded before the Run was resumed."""
        return self._last_steps.get(key)

    def start_system_metrics(self, *, interval_seconds: float | None = None) -> None:
        """Record GPU/CPU/memory/disk/network metrics (`system.*`) every interval until finish."""
        if self._system_metrics is not None:
            return
        monitor = SystemMetricsMonitor(
            self.transport.log_metrics,
            interval_seconds=interval_seconds or DEFAULT_SYSTEM_METRICS_SECONDS,
            pid=os.getpid(),
        )
        monitor.start()
        self._system_metrics = monitor

    def stop_system_metrics(self) -> None:
        monitor, self._system_metrics = self._system_metrics, None
        if monitor is not None:
            monitor.stop()

    def __enter__(self) -> Run:
        self.start()
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        try:
            self.stop_system_metrics()
            if self.managed_by_worker:
                return False
            if exception is None:
                self.finish()
                return False
            try:
                # The log goes first: finish closes the transport, and an offline spool sends logs
                # before the terminal status.
                self.log(str(exception), level="error")
                self.finish(status="failed")
            except Exception as reporting_error:
                exception.add_note(f"Failed to report Run failure: {self.masker.mask(str(reporting_error))}")
            return False
        finally:
            if self.close_client_on_exit and self._client is not None:
                self._client.close()

    def start(self) -> None:
        if self.managed_by_worker or self.entity.get("status") == "running":
            return
        if self.entity.get("status") in {"finished", "failed", "canceled"}:
            raise ConfigurationError("A terminal Run cannot be started again; create a new Run")
        self._apply_entity(self.transport.start(), {"status": "running"})

    def finish(self, *, status: str = "finished") -> None:
        if self.managed_by_worker:
            raise ConfigurationError("A job-owned Run is completed by the worker")
        if status not in {"finished", "failed", "canceled"}:
            raise ConfigurationError("Run completion requires a terminal status")
        # No system metrics sample may arrive after the terminal status.
        self.stop_system_metrics()
        try:
            self._apply_entity(self.transport.finish(status), {"status": status})
        finally:
            self.transport.close()
        if self.offline_directory is not None:
            print(
                f"mado-tracking: Run {self.id} was recorded in {self.offline_directory}. "
                f"Send it with `mado-tracking sync {self.offline_directory}`.",
                file=sys.stderr,
            )

    def log_params(self, parameters: Mapping[str, Any]) -> None:
        self._apply_entity(
            self.transport.log_params(parameters),
            {"parameters": {**self.entity.get("parameters", {}), **parameters}},
        )

    def set_tags(self, tags: Mapping[str, str]) -> None:
        self._apply_entity(self.transport.set_tags(tags), {"tags": {**self.entity.get("tags", {}), **tags}})

    def log_metrics(
        self, metrics: Mapping[str, float], *, step: int | None = None, timestamp: str | None = None
    ) -> None:
        """Log metrics at step. Without a step a new Run uses 0, and a resumed Run uses each key's
        last step + 1 so its curves continue."""
        if not metrics:
            return
        if step is not None and step < 0:
            raise ConfigurationError("Metric step must be non-negative")
        if any(not math.isfinite(value) for value in metrics.values()):
            raise ConfigurationError("Metrics must have finite values")
        logged_at = timestamp or utc_timestamp()
        steps = {name: self._metric_step(name, step) for name in metrics}
        self.transport.log_metrics(
            [
                {"name": name, "value": value, "step": steps[name], "timestamp": logged_at}
                for name, value in metrics.items()
            ]
        )
        for name, logged_step in steps.items():
            self._last_steps[name] = max(logged_step, self._last_steps.get(name, -1))

    def log(self, message: str, *, level: str = "info", timestamp: str | None = None) -> None:
        if level not in {"info", "warning", "error"}:
            raise ConfigurationError("Unsupported log level")
        self.transport.log_entries(
            [
                {
                    "timestamp": timestamp or utc_timestamp(),
                    "level": level,
                    "message": self.masker.mask(message),
                }
            ]
        )

    def log_artifact(
        self,
        source: str | Path | BinaryIO,
        *,
        path: str | None = None,
        mime_type: str | None = None,
        copy: bool = True,
    ) -> dict[str, Any]:
        """Online, files of SESSION_UPLOAD_THRESHOLD_BYTES or more use a resumable upload session.

        Offline, the file is copied into the spool; copy=False keeps only its path and sha256, and
        sync refuses the file if it changed in the meantime.
        """
        source = Path(source) if isinstance(source, str) else source
        if isinstance(source, Path):
            path = path or source.name
        if not path:
            raise ConfigurationError("path is required for a binary stream")
        content_type = mime_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
        return self.transport.log_artifact(source, path=path, mime_type=content_type, copy=copy)

    def _metric_step(self, name: str, step: int | None) -> int:
        if step is not None:
            return step
        if not self._continues_steps:
            return 0
        last = self._last_steps.get(name)
        return 0 if last is None else last + 1

    def _apply_entity(self, entity: dict[str, Any] | None, local_change: Mapping[str, Any]) -> None:
        """Take the API's entity when there is one; offline, apply the change locally instead."""
        self.entity = entity if entity is not None else {**self.entity, **local_change}

    def log_artifacts(self, directory: str | Path, *, path: str | None = None) -> list[dict[str, Any]]:
        """Log every file under directory, keeping relative paths below the optional path prefix."""
        root = Path(directory)
        if not root.is_dir():
            raise ConfigurationError("log_artifacts requires a directory")
        prefix = path.strip("/") + "/" if path and path.strip("/") else ""
        # rglob does not descend into symlinked directories, so the walk stays inside the tree.
        files = sorted(file for file in root.rglob("*") if file.is_file())
        return [self.log_artifact(file, path=prefix + file.relative_to(root).as_posix()) for file in files]

    def log_checkpoint(
        self,
        directory: str | Path,
        *,
        step: int,
        includes_optimizer: bool = False,
        framework: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Save directory as this Run's checkpoint at step; a later Run can continue from it."""
        return log_checkpoint(
            self,
            directory,
            step=step,
            includes_optimizer=includes_optimizer,
            framework=framework,
            metadata=metadata,
        )

    def resume_checkpoint(self) -> ResumeCheckpoint | None:
        """The checkpoint this Job continues from (path and step), or None for a fresh start.

        Log metrics from step + 1 onwards so the curve continues where the checkpoint was saved.
        """
        return resume_checkpoint_from_environment()

    def download_input_model(
        self, destination: str | Path, *, model_version: Mapping[str, Any] | None = None
    ) -> Path:
        from .model_input import download_input_model, pinned_model_version

        pinned_version = pinned_model_version(
            project_id=self.project_id,
            model_version_id=self.entity.get("modelVersionId"),
            model_version=model_version,
        )
        return download_input_model(
            self.client, Path(destination), project_id=self.project_id, model_version=pinned_version
        )

    def register_output_model(self, *, version: str | None = None, **attributes: Any) -> dict[str, Any]:
        """Register this Run's output; pass model_name= to reuse one Model across Runs."""
        if self.entity.get("kind") not in {"training", "finetuning"}:
            raise ConfigurationError("Output models require a training or finetuning Run")
        attributes.setdefault(
            "parent_model_version_ids",
            [self.entity["modelVersionId"]] if self.entity.get("modelVersionId") else [],
        )
        return self.client.register_model(
            self.project_id, version=version, source_run_id=self.id, **attributes
        )

    def register_output_dataset(
        self, *, version: str, uri: str, digest: str, **attributes: Any
    ) -> dict[str, Any]:
        attributes.setdefault("parent_dataset_version_ids", self.entity.get("inputDatasetVersionIds", []))
        return self.client.register_dataset(
            self.project_id, version=version, uri=uri, digest=digest, source_run_id=self.id, **attributes
        )
