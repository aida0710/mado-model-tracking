"""The target-side runner commands the worker's staging code calls.

JobExecutor sends them over SSH; a site's runner answers the same commands in its own process.
`staged_inputs` collects what was staged, for the execution specification's stagedInputs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol


class RunnerCommands(Protocol):
    staged_inputs: dict[str, Any]

    async def command(
        self, name: str, *, payload: dict[str, Any] | None = None, stdin_file: Path | None = None
    ) -> dict[str, Any]: ...
