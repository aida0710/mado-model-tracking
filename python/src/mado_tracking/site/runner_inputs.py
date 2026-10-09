"""Bring a site Job's inputs into its workspace with the Job token before the container starts.

The same staging code as the worker's 'direct' transfer is used, run in this process: the code
archive, the SIF or a Docker image converted to one, the input weights, the resume and input
checkpoints, and the input datasets (only the array member's share of a partitioned version).
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..security import SecretMasker
from ..worker.container_layout import STAGED_INPUT_PATHS
from ..worker.contracts import WorkerJob
from ..worker.dataset_partition import DatasetPartition
from ..worker.dataset_staging import stage_input_datasets
from ..worker.session_inputs import (
    ContainerInput,
    checkpoint_inputs,
    container_inputs,
    download_checkpoint_archive,
    download_container_input,
)
from ..worker.source_tree import MAX_SOURCE_ARCHIVE_BYTES
from .file_cache import SiteFileCache
from .local_commands import LocalRunnerCommands
from .runner_api import RunnerApi
from .sif_conversion import (
    SIF_CACHE_KIND,
    convert_docker_image,
    converted_runtime,
    needs_conversion,
    site_sif_kind,
)

TRANSFER_DIRECTORY = ".transfer"
Notify = Callable[[str, str], None]


@dataclass(frozen=True)
class StagedInputs:
    # The execution specification's stagedInputs.
    files: dict[str, Any]
    # The runtime this host executes when it differs from the registered one (a converted SIF).
    host_runtime: dict[str, Any] | None


class InputStaging:
    def __init__(
        self,
        job: WorkerJob,
        *,
        api: RunnerApi,
        api_url: str,
        workspace: Path,
        work_directory: Path,
        state: dict[str, Any],
        secrets: Mapping[str, Any],
        masker: SecretMasker,
        cancel_grace_seconds: float,
        notify: Notify,
    ):
        self.job = job
        self.api = api
        self.api_url = api_url
        self.workspace = workspace
        self.state = state
        self.secrets = secrets
        self.masker = masker
        self.cancel_grace_seconds = cancel_grace_seconds
        self.notify = notify
        self.commands = LocalRunnerCommands(workspace)
        self.sif_cache = SiteFileCache.in_work_directory(work_directory, SIF_CACHE_KIND)
        self.project_id = str(job.job["projectId"])

    def transfer_path(self, kind: str) -> Path:
        directory = self.workspace / TRANSFER_DIRECTORY
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / kind
        os.close(os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600))
        return path

    def staged_path(self, kind: str) -> Path:
        path = self.workspace / STAGED_INPUT_PATHS[kind]
        path.parent.mkdir(mode=0o700, exist_ok=True)
        return path

    async def stage(self) -> StagedInputs:
        files = self.commands.staged_inputs
        await self.stage_source()
        await self.stage_container_inputs(files)
        for checkpoint_input in checkpoint_inputs(self.job):
            files[checkpoint_input.staged_key] = await download_checkpoint_archive(
                checkpoint_input.checkpoint,
                api=self.api,
                project_id=self.project_id,
                archive_path=self.staged_path(checkpoint_input.kind),
            )
        host_runtime = await self.prepare_host_runtime()
        await self.stage_datasets(files)
        return StagedInputs(files=dict(files), host_runtime=host_runtime)

    async def stage_source(self) -> None:
        source = self.job.code_version["source"]
        if source is None or source["kind"] != "artifact":
            return
        with self.staged_path("source").open("wb") as output:
            await self.api.download_artifact(
                self.project_id, source["artifactId"], output, maximum_bytes=MAX_SOURCE_ARCHIVE_BYTES
            )
            output.flush()
            os.fsync(output.fileno())

    async def stage_container_inputs(self, files: dict[str, Any]) -> None:
        for container_input in container_inputs(self.job):
            if container_input.kind == "sif":
                # One download per SIF for every Job of the site; the cache verifies its sha256.
                cached = await self.sif_cache.ensure(
                    f"artifact-{container_input.expected_sha256}.sif",
                    self.download_into(container_input),
                    expected_sha256=container_input.expected_sha256,
                )
                self.sif_cache.link(cached, self.staged_path("sif"))
                files["sif"] = {"sha256": cached.sha256, "size": cached.size}
            else:
                files[container_input.kind] = await download_container_input(
                    container_input,
                    api=self.api,
                    project_id=self.project_id,
                    destination=self.staged_path(container_input.kind),
                )

    def download_into(self, container_input: ContainerInput) -> Callable[[Path], Awaitable[None]]:
        async def fill(destination: Path) -> None:
            await download_container_input(
                container_input, api=self.api, project_id=self.project_id, destination=destination
            )

        return fill

    async def prepare_host_runtime(self) -> dict[str, Any] | None:
        runtime = self.job.runtime
        runtime_kinds = list(self.job.target.get("runtimeKinds", []))
        if not needs_conversion(runtime, runtime_kinds):
            return None
        kind = site_sif_kind(runtime_kinds)
        cpu_arch = str(self.job.target.get("cpuArch") or "amd64")
        self.notify(
            "info", f"Converting {runtime['image']} to a {kind} image for {cpu_arch} (cached per digest)"
        )
        cached = await convert_docker_image(
            runtime["image"],
            kind=kind,
            cpu_arch=cpu_arch,
            cache=self.sif_cache,
            workspace=self.workspace,
            state=self.state,
            credentials=self.secrets.get("registry") or {},
            masker=self.masker,
            cancel_grace_seconds=self.cancel_grace_seconds,
        )
        self.sif_cache.link(cached, self.staged_path("sif"))
        return converted_runtime(runtime, kind=kind, cached=cached)

    async def stage_datasets(self, files: dict[str, Any]) -> None:
        partition = DatasetPartition.for_job(self.job.job)
        input_ids = {dataset["id"] for dataset in self.job.input_datasets}
        if partition is not None and partition.version_id not in input_ids:
            raise ConfigurationError(
                "The Job's datasetPartitionVersionId is not one of its input DatasetVersions"
            )
        staged = await stage_input_datasets(
            self.job,
            api=self.api,
            executor=self.commands,
            transfer_path=self.transfer_path,
            api_url=self.api_url,
            partition=partition,
        )
        files["datasets"] = staged.paths
        for notice in staged.notices:
            self.notify("info", notice)

    async def release_datasets(self) -> None:
        """Drop this Job's dataset cache pins after a failure before launch (best effort)."""
        try:
            await self.commands.command("dataset-release")
        except (OSError, ValueError):
            pass
