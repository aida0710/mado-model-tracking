"""Execute one pinned CodeVersion through its selected runtime backend."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .container_layout import prepare_container_layout, verify_container_inputs
from .docker_container import DockerContainer
from .host_execution import CommandExecution
from .sif_container import execute_sif
from .source import materialize_source


def execute_registered_code(
    workspace: Path, specification: dict[str, Any], execution: CommandExecution
) -> int:
    if specification.get("recoverOnly"):
        # Recovery observes/removes the existing daemon container without repeating setup or start.
        return DockerContainer(workspace, specification, execution).run([], recover_only=True)
    source_directory = workspace / "source"
    source_directory.mkdir(mode=0o700, exist_ok=True)
    source = specification["codeVersion"]["source"]
    if source is not None:
        artifact_path = workspace / "source.archive"
        materialize_source(
            source,
            source_directory,
            artifact=artifact_path if artifact_path.exists() else None,
            command_runner=execution.checked,
        )
    runtime_kind = specification["codeVersion"]["runtime"]["kind"]
    if runtime_kind == "python":
        return _execute_python(specification, execution, source_directory=source_directory)
    mounts = prepare_container_layout(workspace, specification)
    verify_container_inputs(workspace, specification)
    if runtime_kind == "docker":
        return DockerContainer(workspace, specification, execution).run(mounts)
    return execute_sif(workspace, specification, mounts=mounts, execution=execution)


def _execute_python(
    specification: dict[str, Any], execution: CommandExecution, *, source_directory: Path
) -> int:
    python = execution.create_environment(
        sdk_directory=execution.workspace / "sdk",
        requirements=specification["codeVersion"]["requirements"],
        install_dependencies=specification["installDependencies"],
    )
    entrypoint = list(specification["codeVersion"]["entrypoint"])
    if entrypoint[0] in {"python", "python3", "${PYTHON}", "{python}"}:
        entrypoint[0] = str(python)
    exit_code, _captured = execution.run(entrypoint, cwd=source_directory)
    return exit_code
