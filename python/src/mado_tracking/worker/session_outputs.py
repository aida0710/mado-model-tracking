"""Relay validated container results, acknowledging each successful API save in the journal."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from .api import WorkerApi
from .contracts import WorkerJob
from .runtime import JobExecutor


async def forward_container_outputs(
    job: WorkerJob,
    results: dict[str, Any],
    *,
    api: WorkerApi,
    executor: JobExecutor,
    acknowledgments: dict[str, Any],
    persist: Callable[[], None],
    temporary_path: Path,
) -> None:
    uploaded = acknowledgments.setdefault("artifacts", [])
    for artifact in results["artifacts"]:
        key = f"{artifact['path']}:{artifact['sha256']}"
        if key in uploaded:
            continue
        checksum, offset = hashlib.sha256(), 0
        try:
            descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as destination:
                while offset < artifact["size"]:
                    response = await executor.command(
                        "output", payload={"path": artifact["path"], "offset": offset}
                    )
                    if response.get("error"):
                        raise ConfigurationError("Container output could not be read safely after completion")
                    chunk = base64.b64decode(response["content"], validate=True)
                    next_offset = response["nextOffset"]
                    if not chunk or next_offset != offset + len(chunk) or next_offset > artifact["size"]:
                        raise ConfigurationError("Container output transfer has an invalid offset or size")
                    checksum.update(chunk)
                    destination.write(chunk)
                    offset = next_offset
                destination.flush()
                os.fsync(destination.fileno())
            if checksum.hexdigest() != artifact["sha256"]:
                raise ConfigurationError("Container output sha256 mismatch during collection")
            await api.upload_output_artifact(job, artifact, temporary_path)
            uploaded.append(key)
            persist()
        finally:
            await asyncio.to_thread(temporary_path.unlink, missing_ok=True)
    if not acknowledgments.get("metrics"):
        if results["metrics"]:
            await api.metrics(job, results["metrics"])
        acknowledgments["metrics"] = True
        persist()
