"""Run lifecycle and logging; job-owned status is completed by the worker only."""

from __future__ import annotations

import math
import mimetypes
from collections.abc import Iterator, Mapping
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any, BinaryIO, Literal, cast

from .client import path_id
from .errors import ConfigurationError
from .timestamps import utc_timestamp

if TYPE_CHECKING:
    from .client import Client

# Keep uploads bounded even for multi-gigabyte model artifacts.
ARTIFACT_CHUNK_BYTES = 1024 * 1024


class Run:
    def __init__(
        self, client: Client, project_id: str, entity: dict[str, Any], *, managed_by_worker: bool = False
    ):
        self.client = client
        self.project_id = project_id
        self.entity = entity
        self.id: str = entity["id"]
        self.managed_by_worker = managed_by_worker
        self.close_client_on_exit = False

    @property
    def api_path(self) -> str:
        return self.client.project_path(self.project_id, f"runs/{path_id(self.id)}")

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
            if self.managed_by_worker:
                return False
            if exception is None:
                self.finish()
                return False
            try:
                self.finish(status="failed")
                self.log(str(exception), level="error")
            except Exception as reporting_error:
                exception.add_note(
                    f"Failed to report Run failure: {self.client.masker.mask(str(reporting_error))}"
                )
            return False
        finally:
            if self.close_client_on_exit:
                self.client.close()

    def start(self) -> None:
        if self.managed_by_worker or self.entity.get("status") == "running":
            return
        if self.entity.get("status") in {"finished", "failed", "canceled"}:
            raise ConfigurationError("A terminal Run cannot be started again; create a new Run")
        self.entity = self.client.request("PATCH", self.api_path, json={"status": "running"}, retryable=True)

    def finish(self, *, status: str = "finished") -> None:
        if self.managed_by_worker:
            raise ConfigurationError("A job-owned Run is completed by the worker")
        if status not in {"finished", "failed", "canceled"}:
            raise ConfigurationError("Run completion requires a terminal status")
        self.entity = self.client.request("PATCH", self.api_path, json={"status": status}, retryable=True)

    def log_params(self, parameters: Mapping[str, Any]) -> None:
        self.entity = self.client.request(
            "PATCH", self.api_path, json={"parameters": dict(parameters)}, retryable=True
        )

    def set_tags(self, tags: Mapping[str, str]) -> None:
        self.entity = self.client.request("PATCH", self.api_path, json={"tags": dict(tags)}, retryable=True)

    def log_metrics(
        self, metrics: Mapping[str, float], *, step: int = 0, timestamp: str | None = None
    ) -> None:
        if not metrics:
            return
        if step < 0:
            raise ConfigurationError("Metric step must be non-negative")
        if any(not math.isfinite(value) for value in metrics.values()):
            raise ConfigurationError("Metrics must have finite values")
        self.client.request(
            "POST",
            f"{self.api_path}/metrics",
            json={
                "metrics": [
                    {"name": name, "value": value, "step": step, "timestamp": timestamp or utc_timestamp()}
                    for name, value in metrics.items()
                ]
            },
            retryable=True,
        )

    def log(self, message: str, *, level: str = "info", timestamp: str | None = None) -> None:
        if level not in {"info", "warning", "error"}:
            raise ConfigurationError("Unsupported log level")
        self.client.request(
            "POST",
            f"{self.api_path}/logs",
            json={
                "entries": [
                    {
                        "timestamp": timestamp or utc_timestamp(),
                        "level": level,
                        "message": self.client.masker.mask(message),
                    }
                ]
            },
            retryable=True,
        )

    def log_artifact(
        self, source: str | Path | BinaryIO, *, path: str | None = None, mime_type: str | None = None
    ) -> dict[str, Any]:
        owns_stream = isinstance(source, (str, Path))
        source_path = Path(source) if isinstance(source, (str, Path)) else None
        stream: BinaryIO
        if source_path is not None:
            stream = source_path.open("rb")
            path = path or source_path.name
        else:
            stream = cast(BinaryIO, source)
        if not path:
            raise ConfigurationError("path is required for a binary stream")
        content_type = mime_type or mimetypes.guess_type(path)[0] or "application/octet-stream"

        def chunks() -> Iterator[bytes]:
            while chunk := stream.read(ARTIFACT_CHUNK_BYTES):
                yield chunk

        try:
            return self.client.request(
                "PUT",
                f"{self.api_path}/artifacts",
                params={"path": path},
                headers={"Content-Type": content_type},
                content_factory=chunks,
            )
        finally:
            if owns_stream:
                stream.close()

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
