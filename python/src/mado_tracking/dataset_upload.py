"""Create a DatasetVersion from a local directory (stub; dataset-artifact-manifest owns the real module).

Only the signature is fixed here so Client.register_dataset(files=...) can delegate to it. The
integration replaces this file with the implementation of the same name.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .client import Client


def upload_dataset_directory(
    client: Client,
    project_id: str,
    dataset_id: str,
    directory: str | os.PathLike[str],
    *,
    version: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    schema: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    raise NotImplementedError("Dataset directory upload is provided by the dataset-artifact-manifest package")
