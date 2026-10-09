"""Save what a site Job left: its source snapshot, its outputs, their metrics and declarations.

Each saved item is remembered, so a retry after an interrupted save sends only what is missing.
Outputs are read through the descriptor validate_results checked, never by path again.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..worker.container_outputs import artifact_key, open_output, parse_output_index, read_output_index
from ..worker.contracts import WorkerJob
from ..worker.session_outputs import validated_snapshot_artifacts
from ..worker.source_snapshot import SNAPSHOT_DIRECTORY, SNAPSHOT_FILENAMES
from .runner_api import RunnerApi

# Linux names an open file here; reading it again reads that file even if its path changed.
OPEN_FILE_DIRECTORY = Path("/proc/self/fd")


@contextmanager
def opened_output(outputs: Path, path: str) -> Iterator[Path]:
    """A path that reads exactly the regular file open_output opened."""
    with open_output(outputs, path) as content:
        if OPEN_FILE_DIRECTORY.is_dir():
            yield OPEN_FILE_DIRECTORY / str(content.fileno())
        else:
            yield outputs / path


class OutputSaver:
    def __init__(self, job: WorkerJob, *, api: RunnerApi, workspace: Path):
        self.job = job
        self.api = api
        self.workspace = workspace
        self.saved: set[str] = set()
        self.metrics_sent = False
        self.registered: set[int] = set()

    async def save_snapshot(self, snapshot: dict[str, Any]) -> None:
        for artifact in validated_snapshot_artifacts(self.job, snapshot):
            key = f"snapshot:{artifact_key(artifact)}"
            if key in self.saved:
                continue
            source = self.workspace / SNAPSHOT_DIRECTORY / SNAPSHOT_FILENAMES[artifact["path"]]
            await self.api.upload_snapshot_artifact(self.job, artifact, source)
            self.saved.add(key)

    async def save_outputs(self, results: dict[str, Any]) -> None:
        """Outputs as Run Artifacts `container/<path>`, then metrics, then result.json declarations."""
        outputs = self.workspace / "outputs"
        for artifact in parse_output_index(read_output_index(self.workspace, results)):
            key = artifact_key(artifact)
            if key in self.saved:
                continue
            with opened_output(outputs, artifact["path"]) as source:
                await self.api.upload_output_artifact(self.job, artifact, source)
            self.saved.add(key)
        if not self.metrics_sent:
            if results["metrics"]:
                await self.api.metrics(results["metrics"])
            self.metrics_sent = True
        # Declarations name saved Artifacts, so they are sent only after every output is saved.
        remaining = [item for item in results.get("declarations", []) if item["index"] not in self.registered]
        if remaining:
            items = await self.api.declare_outputs(remaining)
            self.registered.update(item["index"] for item in items)
            if any(item["index"] not in self.registered for item in remaining):
                raise ConfigurationError("Output declaration response omitted a declared output")
