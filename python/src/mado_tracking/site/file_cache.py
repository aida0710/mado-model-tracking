"""Immutable files shared by the Jobs of one site work directory: SIF images.

    <work dir>/.mmt-cache/<kind>/<name>        the file, read-only once complete
    <work dir>/.mmt-cache/<kind>/<name>.json   {"sha256", "size"}, written last
    <work dir>/.mmt-cache/<kind>/<name>.lock   flock held while the entry is checked or filled

The Jobs of an array wait for one another on the lock, so a file is fetched or converted once.
A Job links the file into its workspace, where it is verified again before the container starts.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import shutil
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from ..checkpoint_archive import file_sha256
from ..errors import ConfigurationError
from ..worker.dataset_cache import CACHE_DIRECTORY
from ..worker.host_state import read_json, write_json
from .daemon_thread import run_in_daemon_thread

# Waiting Jobs check the lock this often, so their heartbeats keep going meanwhile.
LOCK_POLL_SECONDS = 1.0
READ_ONLY_FILE_MODE = 0o400


@dataclass(frozen=True)
class CachedFile:
    path: Path
    sha256: str
    size: int


class SiteFileCache:
    def __init__(self, root: Path):
        self.root = root

    @classmethod
    def in_work_directory(cls, work_directory: Path, kind: str) -> SiteFileCache:
        # Beside the dataset cache (<work dir>/.mmt-cache/datasets).
        return cls(work_directory / CACHE_DIRECTORY.parent / kind)

    @asynccontextmanager
    async def _locked(self, name: str) -> AsyncIterator[None]:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.root / f"{name}.lock").open("a") as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(LOCK_POLL_SECONDS)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    async def ensure(
        self,
        name: str,
        fill: Callable[[Path], Awaitable[None]],
        *,
        expected_sha256: str | None = None,
    ) -> CachedFile:
        """The complete entry, filling it first when it is missing or was left incomplete."""
        if not name or "/" in name or name.startswith("."):
            raise ConfigurationError(f"Invalid cache entry name {name!r}")
        path, marker = self.root / name, self.root / f"{name}.json"
        async with self._locked(name):
            if marker.is_file() and path.is_file():
                record = read_json(marker)
                if path.stat().st_size == record.get("size") and (
                    expected_sha256 is None or record.get("sha256") == expected_sha256
                ):
                    return CachedFile(path, str(record["sha256"]), int(record["size"]))
            # Without its marker an entry is an interrupted fill; it is never used.
            marker.unlink(missing_ok=True)
            partial = self.root / f".{name}.partial"
            partial.unlink(missing_ok=True)
            try:
                await fill(partial)
                checksum, size = await run_in_daemon_thread(lambda: file_sha256(partial), name="mmt-hash")
                if expected_sha256 is not None and checksum != expected_sha256:
                    raise ConfigurationError(f"Cached file {name} does not match its sha256")
                partial.chmod(READ_ONLY_FILE_MODE)
                os.replace(partial, path)
                write_json(marker, {"sha256": checksum, "size": size})
            finally:
                partial.unlink(missing_ok=True)
            return CachedFile(path, checksum, size)

    def link(self, cached: CachedFile, destination: Path) -> None:
        """Put the file at destination: a hard link on the same filesystem, else a copy."""
        destination.unlink(missing_ok=True)
        try:
            os.link(cached.path, destination)
        except OSError:
            shutil.copyfile(cached.path, destination)
