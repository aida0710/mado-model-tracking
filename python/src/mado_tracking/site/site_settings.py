"""How one site submits, shared by the launcher's [[sites]] and `mado-tracking submit`'s tables.

job_shell             local file; installed on the site per content (<work dir>/.mmt-job-shells)
work_dir              absolute directory on the site that compute nodes also see
runner_python         Python 3.11+ on the compute nodes (default python3)
runner_api_url        the API as compute nodes reach it (default: the API the caller uses)
gpu_assignment        scheduler (default) or lease (hosts without a scheduler)
gpu_ids               lease only: the GPUs a runner may choose from
cancel_grace_seconds  how long a stopped container may take to exit
max_output_files      outputs one Job may save
registry_secret_file  JSON {"username", "password"} for pulling images into SIFs (mode 600)
variables             MMT_VAR_<name> values for the job shell
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..toml_tables import TableReader
from ..worker.config import DEFAULT_CANCEL_GRACE_SECONDS
from ..worker.container_outputs import DEFAULT_MAX_OUTPUT_FILES
from .spec_directory import RunnerSettings
from .submission import SubmissionPlan

DEFAULT_RUNNER_PYTHON = "python3"
SITE_SUBMISSION_KEYS = {
    "job_shell",
    "work_dir",
    "runner_python",
    "runner_api_url",
    "gpu_assignment",
    "gpu_ids",
    "cancel_grace_seconds",
    "max_output_files",
    "registry_secret_file",
    "variables",
}
# A job shell is a script, not data; a larger file is a mistake.
MAX_JOB_SHELL_BYTES = 1024 * 1024


@dataclass(frozen=True)
class SiteSubmissionSettings:
    job_shell: Path
    work_dir: str
    runner_python: str = DEFAULT_RUNNER_PYTHON
    runner_api_url: str | None = None
    gpu_assignment: str = "scheduler"
    gpu_ids: tuple[str, ...] = ()
    cancel_grace_seconds: float = DEFAULT_CANCEL_GRACE_SECONDS
    max_output_files: int = DEFAULT_MAX_OUTPUT_FILES
    registry_secret_file: Path | None = None
    variables: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # RunnerSettings validates the values the runner reads.
        self.runner_settings()

    @classmethod
    def from_reader(cls, reader: TableReader) -> SiteSubmissionSettings:
        return cls(
            job_shell=reader.path("job_shell"),
            work_dir=reader.string("work_dir"),
            runner_python=reader.string("runner_python", default=DEFAULT_RUNNER_PYTHON),
            runner_api_url=reader.optional_string("runner_api_url"),
            gpu_assignment=reader.string("gpu_assignment", default="scheduler"),
            gpu_ids=reader.string_list("gpu_ids", default=()),
            cancel_grace_seconds=reader.number("cancel_grace_seconds", default=DEFAULT_CANCEL_GRACE_SECONDS),
            max_output_files=reader.integer("max_output_files", default=DEFAULT_MAX_OUTPUT_FILES, minimum=1),
            registry_secret_file=reader.optional_path("registry_secret_file"),
            variables=reader.string_table("variables"),
        )

    def runner_settings(self) -> RunnerSettings:
        return RunnerSettings(
            work_directory=self.work_dir,
            gpu_assignment=self.gpu_assignment,
            gpu_ids=self.gpu_ids,
            cancel_grace_seconds=self.cancel_grace_seconds,
            max_output_files=self.max_output_files,
        )

    def plan(self, *, api_url: str, variables: Mapping[str, str] | None = None) -> SubmissionPlan:
        """Read the job shell and the registry secret now, so an edit applies to the next submission."""
        try:
            job_shell = self.job_shell.read_bytes()
        except OSError as error:
            raise ConfigurationError(
                f"The job shell {self.job_shell} could not be read: {error.strerror}"
            ) from None
        if not job_shell or len(job_shell) > MAX_JOB_SHELL_BYTES:
            raise ConfigurationError(f"The job shell {self.job_shell} is empty or larger than 1 MiB")
        return SubmissionPlan(
            job_shell=job_shell,
            runner_python=self.runner_python,
            api_url=self.runner_api_url or api_url,
            runner_settings=self.runner_settings(),
            variables={**self.variables, **(variables or {})},
            secrets=self.secrets(),
        )

    def secrets(self) -> dict[str, Any] | None:
        if self.registry_secret_file is None:
            return None
        path = self.registry_secret_file
        try:
            if os.stat(path).st_mode & 0o077:
                raise ConfigurationError(
                    f"{path} holds a registry password and must not be readable by others"
                )
            registry = json.loads(path.read_text(encoding="utf-8"))
        except OSError as error:
            raise ConfigurationError(f"{path} could not be read: {error.strerror}") from None
        except ValueError:
            raise ConfigurationError(f"{path} must be JSON with username and password") from None
        if (
            not isinstance(registry, dict)
            or not isinstance(registry.get("username"), str)
            or not isinstance(registry.get("password"), str)
        ):
            raise ConfigurationError(f"{path} must be JSON with username and password")
        return {"registry": {"username": registry["username"], "password": registry["password"]}}
