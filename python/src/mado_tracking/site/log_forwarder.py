"""Send the Job's stdout/stderr to the Run log line by line, with the runner's own messages.

CommandExecution writes the masked output of every command (image pull, git, the container) to
stdout.log and stderr.log in the workspace; the forwarder follows both from the last sent byte.
A carriage return starts a line over, as on a terminal, so a progress bar leaves its last state.
"""

from __future__ import annotations

import codecs
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ApiError, LeaseRejected
from ..security import SecretMasker
from ..timestamps import utc_timestamp

LOGGER = logging.getLogger(__name__)
# The API's log batch limit.
MAX_ENTRIES_PER_REQUEST = 1000
# A longer line, or a progress bar that never ends its line, is sent in parts of this size.
MAX_LINE_CHARACTERS = 16 * 1024
READ_CHUNK_BYTES = 1024 * 1024
# While the API is unreachable the oldest lines are dropped beyond this many.
MAX_PENDING_ENTRIES = 20_000
STREAM_LEVELS = {"stdout": "info", "stderr": "error"}

LogSender = Callable[[list[dict[str, Any]]], Awaitable[None]]


@dataclass
class _Stream:
    level: str
    offset: int = 0
    buffer: str = ""
    decoder: Any = field(default_factory=lambda: codecs.getincrementaldecoder("utf-8")("replace"))


def terminal_line(line: str) -> str:
    """What a terminal shows for the line: the text after its last carriage return."""
    return line.rstrip("\r").rsplit("\r", 1)[-1]


class LogForwarder:
    def __init__(self, workspace: Path, *, send: LogSender, masker: SecretMasker):
        self.workspace = workspace
        self.send = send
        self.masker = masker
        self.streams = {name: _Stream(level) for name, level in STREAM_LEVELS.items()}
        self.pending: list[dict[str, Any]] = []
        self.dropped = 0

    def add(self, level: str, message: str) -> None:
        """Queue one of the runner's own messages; it goes out with the next forward()."""
        self._append(level, message)

    def _append(self, level: str, message: str) -> None:
        # Masked before splitting, so no secret can straddle two parts unmasked.
        masked = self.masker.mask(message)
        for start in range(0, len(masked), MAX_LINE_CHARACTERS):
            part = masked[start : start + MAX_LINE_CHARACTERS]
            self.pending.append({"timestamp": utc_timestamp(), "level": level, "message": part})
        if len(self.pending) > MAX_PENDING_ENTRIES:
            excess = len(self.pending) - MAX_PENDING_ENTRIES
            self.dropped += excess
            del self.pending[:excess]

    def _read(self, name: str, *, final: bool) -> None:
        stream = self.streams[name]
        path = self.workspace / f"{name}.log"
        while path.exists():
            with path.open("rb") as content:
                content.seek(stream.offset)
                raw = content.read(READ_CHUNK_BYTES)
            stream.offset += len(raw)
            stream.buffer += stream.decoder.decode(raw)
            self._emit_lines(stream)
            if not final or not raw:
                break
        if final:
            stream.buffer += stream.decoder.decode(b"", final=True)
            if terminal_line(stream.buffer):
                self._append(stream.level, terminal_line(stream.buffer))
            stream.buffer = ""

    def _emit_lines(self, stream: _Stream) -> None:
        *lines, stream.buffer = stream.buffer.split("\n")
        for line in lines:
            shown = terminal_line(line)
            if shown:
                self._append(stream.level, shown)
        if len(stream.buffer) > MAX_LINE_CHARACTERS:
            stream.buffer = terminal_line(stream.buffer)
            while len(stream.buffer) > MAX_LINE_CHARACTERS:
                self._append(stream.level, stream.buffer[:MAX_LINE_CHARACTERS])
                stream.buffer = stream.buffer[MAX_LINE_CHARACTERS:]

    async def forward(self, *, final: bool = False) -> None:
        """Send everything written so far; `final` also sends unfinished last lines."""
        for name in self.streams:
            self._read(name, final=final)
        if self.dropped:
            dropped, self.dropped = self.dropped, 0
            self.pending.insert(
                0,
                {
                    "timestamp": utc_timestamp(),
                    "level": "warning",
                    "message": f"{dropped} log lines were dropped while the API was unreachable",
                },
            )
        while self.pending:
            batch = self.pending[:MAX_ENTRIES_PER_REQUEST]
            try:
                await self.send(batch)
            except LeaseRejected:
                raise
            except ApiError as error:
                if (
                    error.status_code is not None
                    and 400 <= error.status_code < 500
                    and error.status_code not in {408, 429}
                ):
                    # The API refuses this batch for good; keeping it would block every later line.
                    LOGGER.warning("Run log batch refused: %s", self.masker.mask(str(error)))
                    del self.pending[: len(batch)]
                    continue
                LOGGER.warning("Run log delivery deferred: %s", self.masker.mask(str(error)))
                return
            del self.pending[: len(batch)]
