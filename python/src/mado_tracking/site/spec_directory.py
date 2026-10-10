"""The spec directory: what a launcher or `mado-tracking submit` hands one job shell call.

    <spec dir>/          0700
      submission.json    the SiteSubmission without Job tokens; of the job shell, its id,
                         version and sha256 (the job shell itself is installed on its own)
      api.json           {"apiUrl"}: the API as the compute nodes reach it
      runner.json        the site's runner settings (RunnerSettings)
      jobs/<i>.json      the WorkerJob of the i-th Job in array order, with its Job token (0600)
      secrets.json       optional {"registry": {"username", "password"}} (0600)

The runner reads jobs/<MMT_ARRAY_INDEX>.json; i is the scheduler's array number from 0.
"""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..worker.config import DEFAULT_CANCEL_GRACE_SECONDS, MAX_CONFIGURABLE_OUTPUT_FILES
from ..worker.container_outputs import DEFAULT_MAX_OUTPUT_FILES
from .file_archive import PRIVATE_FILE_MODE

SUBMISSION_FILENAME = "submission.json"
API_FILENAME = "api.json"
RUNNER_SETTINGS_FILENAME = "runner.json"
JOBS_DIRECTORY = "jobs"
SECRETS_FILENAME = "secrets.json"
# scheduler: the scheduler gave this node its GPUs (CUDA_VISIBLE_DEVICES). lease: a host without
# a scheduler, where the runner picks free GPUs itself (Docker GPU servers).
GPU_ASSIGNMENTS = ("scheduler", "lease")
# MAX_SITE_CANCEL_GRACE_SECONDS of the contracts, the most a site's settings on the Web allow. A
# site should stay within its scheduler's kill delay after SIGTERM, or the scheduler kills first.
MAX_CANCEL_GRACE_SECONDS = 3600.0
# Spec documents are small; a larger file is not one this package wrote.
MAX_SPEC_FILE_BYTES = 64 * 1024**2
# What submission.json keeps of the job shell version: which one it was, not its content (up to
# 1 MiB, installed once per content under <work dir>/.mmt-job-shells/).
SUBMISSION_JOB_SHELL_FIELDS = ("id", "version", "sha256")


@dataclass(frozen=True)
class RunnerSettings:
    """runner.json: how the runner works on this site, from the launcher's or submit's settings."""

    work_directory: str
    gpu_assignment: str = "scheduler"
    # lease only: the GPUs the runner may choose from; empty means every GPU nvidia-smi lists.
    gpu_ids: tuple[str, ...] = ()
    cancel_grace_seconds: float = DEFAULT_CANCEL_GRACE_SECONDS
    max_output_files: int = DEFAULT_MAX_OUTPUT_FILES

    def __post_init__(self) -> None:
        if not self.work_directory.startswith("/") or any(
            character in self.work_directory for character in "\r\n\x00"
        ):
            raise ConfigurationError("The site work directory must be an absolute path")
        if self.gpu_assignment not in GPU_ASSIGNMENTS:
            raise ConfigurationError(f"gpu_assignment must be one of {', '.join(GPU_ASSIGNMENTS)}")
        if not all(isinstance(value, str) and value and "," not in value for value in self.gpu_ids):
            raise ConfigurationError("gpu_ids must be GPU indexes or UUIDs")
        if (
            isinstance(self.cancel_grace_seconds, bool)
            or not isinstance(self.cancel_grace_seconds, int | float)
            or not 0 < self.cancel_grace_seconds <= MAX_CANCEL_GRACE_SECONDS
        ):
            raise ConfigurationError(f"cancel_grace_seconds must be from 0 to {MAX_CANCEL_GRACE_SECONDS}")
        if type(self.max_output_files) is not int or not 1 <= self.max_output_files <= (
            MAX_CONFIGURABLE_OUTPUT_FILES
        ):
            raise ConfigurationError(f"max_output_files must be from 1 to {MAX_CONFIGURABLE_OUTPUT_FILES}")

    def to_document(self) -> dict[str, Any]:
        return {
            "workDirectory": self.work_directory,
            "gpuAssignment": self.gpu_assignment,
            "gpuIds": list(self.gpu_ids),
            "cancelGraceSeconds": self.cancel_grace_seconds,
            "maxOutputFiles": self.max_output_files,
        }

    @classmethod
    def from_document(cls, document: Any) -> RunnerSettings:
        if not isinstance(document, dict) or not isinstance(document.get("workDirectory"), str):
            raise ConfigurationError(f"{RUNNER_SETTINGS_FILENAME} needs workDirectory")
        gpu_ids = document.get("gpuIds", [])
        if not isinstance(gpu_ids, list):
            raise ConfigurationError(f"{RUNNER_SETTINGS_FILENAME} gpuIds must be a list")
        return cls(
            work_directory=document["workDirectory"],
            gpu_assignment=document.get("gpuAssignment", "scheduler"),
            gpu_ids=tuple(gpu_ids),
            cancel_grace_seconds=document.get("cancelGraceSeconds", DEFAULT_CANCEL_GRACE_SECONDS),
            max_output_files=document.get("maxOutputFiles", DEFAULT_MAX_OUTPUT_FILES),
        )


def ordered_jobs(submission: Mapping[str, Any]) -> list[dict[str, Any]]:
    """WorkerJobs in array order; jobs/<i>.json and MMT_JOB_IDS follow it."""
    return sorted(
        submission["jobs"], key=lambda item: (item["job"].get("arrayIndex") or 0, str(item["job"]["id"]))
    )


def secret_values_of(secrets: Mapping[str, Any]) -> list[str]:
    """The values of a secrets.json document that no output may show: the registry password."""
    registry = secrets.get("registry")
    if isinstance(registry, dict) and isinstance(registry.get("password"), str):
        return [registry["password"]]
    return []


def _document(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True).encode()


def spec_files(
    submission: Mapping[str, Any],
    *,
    api_url: str,
    settings: RunnerSettings,
    secrets: Mapping[str, Any] | None = None,
) -> dict[str, tuple[bytes, int]]:
    """Every file of the spec directory as relative path -> (content, mode)."""
    jobs = ordered_jobs(submission)
    recorded = {**submission, "jobs": [{**job, "jobToken": None} for job in jobs]}
    job_shell = submission.get("jobShell")
    if isinstance(job_shell, Mapping):
        recorded["jobShell"] = {
            key: job_shell[key] for key in SUBMISSION_JOB_SHELL_FIELDS if key in job_shell
        }
    files = {
        SUBMISSION_FILENAME: (_document(recorded), PRIVATE_FILE_MODE),
        API_FILENAME: (_document({"apiUrl": api_url}), PRIVATE_FILE_MODE),
        RUNNER_SETTINGS_FILENAME: (_document(settings.to_document()), PRIVATE_FILE_MODE),
    }
    for index, job in enumerate(jobs):
        files[f"{JOBS_DIRECTORY}/{index}.json"] = (_document(job), PRIVATE_FILE_MODE)
    if secrets:
        files[SECRETS_FILENAME] = (_document(dict(secrets)), PRIVATE_FILE_MODE)
    return files


class SpecDirectory:
    """Read side, for the runner on the compute node."""

    def __init__(self, path: Path):
        if path.is_symlink() or not path.is_dir():
            raise ConfigurationError(f"Spec directory is not a directory: {path}")
        self.path = path.resolve()

    def read(self, name: str, *, private: bool = False) -> Any:
        path = self.path / name
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as error:
            raise ConfigurationError(
                f"{name} in the spec directory could not be read: {error.strerror}"
            ) from None
        with os.fdopen(descriptor, "rb") as content:
            properties = os.fstat(content.fileno())
            if not stat.S_ISREG(properties.st_mode):
                raise ConfigurationError(f"{name} in the spec directory must be a regular file")
            if private and properties.st_mode & 0o077:
                raise ConfigurationError(f"{name} holds credentials and must not be readable by others")
            raw = content.read(MAX_SPEC_FILE_BYTES + 1)
        if len(raw) > MAX_SPEC_FILE_BYTES:
            raise ConfigurationError(f"{name} in the spec directory is too large")
        try:
            return json.loads(raw)
        except ValueError:
            raise ConfigurationError(f"{name} in the spec directory is not JSON") from None

    def submission(self) -> dict[str, Any]:
        document = self.read(SUBMISSION_FILENAME)
        if not isinstance(document, dict) or not isinstance(document.get("jobs"), list):
            raise ConfigurationError(f"{SUBMISSION_FILENAME} is not a SiteSubmission")
        return document

    def api_url(self) -> str:
        document = self.read(API_FILENAME)
        if not isinstance(document, dict) or not isinstance(document.get("apiUrl"), str):
            raise ConfigurationError(f"{API_FILENAME} needs apiUrl")
        return str(document["apiUrl"])

    def runner_settings(self) -> RunnerSettings:
        return RunnerSettings.from_document(self.read(RUNNER_SETTINGS_FILENAME))

    def job_payload(self, array_index: int) -> dict[str, Any]:
        document = self.read(f"{JOBS_DIRECTORY}/{array_index}.json", private=True)
        if not isinstance(document, dict):
            raise ConfigurationError("The spec directory's Job file is not a WorkerJob")
        return document

    def secrets(self) -> dict[str, Any]:
        if not (self.path / SECRETS_FILENAME).exists():
            return {}
        document = self.read(SECRETS_FILENAME, private=True)
        if not isinstance(document, dict):
            raise ConfigurationError(f"{SECRETS_FILENAME} must be a JSON object")
        return document
