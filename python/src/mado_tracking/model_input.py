"""Materialize a Run's pinned input ModelVersion through its Artifact or local URI."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlsplit

from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

# Local model files use the same bounded memory budget as Artifact uploads.
MODEL_COPY_CHUNK_BYTES = 1024 * 1024


def pinned_model_version(
    *, project_id: str, model_version_id: str | None, model_version: Mapping[str, Any] | None
) -> Mapping[str, Any]:
    if not model_version_id:
        raise ConfigurationError("Input model requires a pinned Run.modelVersionId")
    if model_version is None:
        descriptor_path = os.environ.get("MMT_MODEL_VERSION_FILE") or os.environ.get("MMT_JOB_CONTEXT_FILE")
        if not descriptor_path:
            raise ConfigurationError("Pinned ModelVersion metadata or MMT_MODEL_VERSION_FILE is required")
        try:
            descriptor = json.loads(Path(descriptor_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ConfigurationError("Pinned ModelVersion metadata could not be read") from None
        model_version = descriptor.get("modelVersion") if isinstance(descriptor, dict) else None
    if not isinstance(model_version, Mapping):
        raise ConfigurationError("Pinned ModelVersion metadata must contain modelVersion")
    if model_version.get("id") != model_version_id or model_version.get("projectId") != project_id:
        raise ConfigurationError("Input ModelVersion does not match the Run's pinned version and project")
    return model_version


def download_input_model(
    client: Client, destination: Path, *, project_id: str, model_version: Mapping[str, Any]
) -> Path:
    artifact_id = model_version.get("artifactId")
    local_weights: Path | None = None
    if not artifact_id:
        weights_uri = urlsplit(model_version.get("weightsUri") or "")
        if weights_uri.scheme != "file" or weights_uri.netloc not in {"", "localhost"}:
            raise ConfigurationError("Input model requires an Artifact or a local file:// weights URI")
        local_weights = Path(unquote(weights_uri.path))
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(dir=destination.parent, prefix=".input-model-")
    try:
        with os.fdopen(descriptor, "wb") as output:
            if artifact_id:
                client.download_artifact_to(project_id, artifact_id, output)
            else:
                assert local_weights is not None
                with local_weights.open("rb") as weights:
                    shutil.copyfileobj(weights, output, length=MODEL_COPY_CHUNK_BYTES)
        os.replace(temporary_path, destination)
    finally:
        Path(temporary_path).unlink(missing_ok=True)
    return destination
