"""Build a validated immutable CodeVersion registration payload."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .code_source import validate_code_source
from .execution_runtime import ExecutionRuntime, validate_entrypoint, validate_runtime


def build_code_version_payload(
    *,
    version: str,
    source: Mapping[str, Any] | None,
    entrypoint: Sequence[str],
    test_entrypoint: Sequence[str],
    runtime: ExecutionRuntime | None,
    requirements: Sequence[str],
    environment: Mapping[str, str] | None,
    supported_model_families: Sequence[str],
    task_types: Sequence[str],
) -> dict[str, Any]:
    validate_runtime(runtime, source=source, requirements=requirements)
    validate_entrypoint(entrypoint)
    if isinstance(test_entrypoint, (str, bytes)) or not isinstance(test_entrypoint, Sequence):
        raise ValueError("CodeVersion.testEntrypoint must be an argv")
    if test_entrypoint:
        validate_entrypoint(test_entrypoint)
    validate_code_source(source)
    return {
        "version": version,
        "source": dict(source) if source is not None else None,
        **({"runtime": dict(runtime)} if runtime is not None else {}),
        "entrypoint": list(entrypoint),
        "testEntrypoint": list(test_entrypoint),
        "requirements": list(requirements),
        "environment": dict(environment or {}),
        "supportedModelFamilies": list(supported_model_families),
        "taskTypes": list(task_types),
    }
