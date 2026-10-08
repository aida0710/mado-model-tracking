"""Walk bounded source trees without accepting links, special files, or Git metadata."""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from ..code_source import MAX_SOURCE_FILES, MAX_SOURCE_PATH_LENGTH, validate_source_file_name

# Include implicit and empty directories in the same bound as archive members.
MAX_SOURCE_ENTRIES = MAX_SOURCE_FILES
MAX_SOURCE_BYTES = 4 * 1024**3
MAX_SOURCE_FILE_BYTES = 256 * 1024**2
# ZIP repeats UTF-8 names and adds ZIP64 headers; reserve framing per entry.
ZIP_MEMBER_METADATA_BYTES = 2 * (4 * MAX_SOURCE_PATH_LENGTH + 1) + 256
# Deflate may expand incompressible source; this budget exceeds its block overhead.
ZIP_COMPRESSION_OVERHEAD_BYTES = MAX_SOURCE_BYTES // 1000
ZIP_END_RECORD_BYTES = 1024
MAX_SOURCE_ARCHIVE_BYTES = (
    MAX_SOURCE_BYTES
    + MAX_SOURCE_ENTRIES * ZIP_MEMBER_METADATA_BYTES
    + ZIP_COMPRESSION_OVERHEAD_BYTES
    + ZIP_END_RECORD_BYTES
)


@dataclass(frozen=True)
class SourceEntry:
    relative_path: str
    path: Path
    mode: int

    @property
    def is_directory(self) -> bool:
        return stat.S_ISDIR(self.mode)


def source_path(root: Path, name: str) -> Path:
    validate_source_file_name(name)
    destination = root.joinpath(*name.split("/"))
    if any(parent.is_symlink() for parent in (destination, *destination.parents)):
        raise ValueError("Source contains a symlink")
    if not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError("Source path escapes its workspace")
    return destination


def walk_source_entries(root: Path, *, has_git_metadata: bool = False) -> Iterator[SourceEntry]:
    if root.is_symlink():
        raise ValueError("Source contains a symlink")
    pending_directories = [root]
    entry_count, total_bytes = 0, 0
    while pending_directories:
        directory = pending_directories.pop()
        entries = []
        with os.scandir(directory) as children:
            for child in children:
                properties = child.stat(follow_symlinks=False)
                if directory == root and child.name == ".git" and has_git_metadata:
                    if not stat.S_ISDIR(properties.st_mode):
                        raise ValueError("Git metadata must be a regular directory")
                    continue
                name = Path(child.path).relative_to(root).as_posix()
                path = source_path(root, name)
                entry_count += 1
                if entry_count > MAX_SOURCE_ENTRIES:
                    raise ValueError("Code source exceeds its file and directory count limit")
                if not stat.S_ISDIR(properties.st_mode):
                    if not stat.S_ISREG(properties.st_mode) or properties.st_nlink != 1:
                        raise ValueError("Source must not contain links or special files")
                    total_bytes += properties.st_size
                    if properties.st_size > MAX_SOURCE_FILE_BYTES or total_bytes > MAX_SOURCE_BYTES:
                        raise ValueError("Code source exceeds its binary size limit")
                entries.append(SourceEntry(name, path, properties.st_mode))
        for entry in sorted(entries, key=lambda item: item.relative_path):
            if entry.is_directory:
                pending_directories.append(entry.path)
            yield entry
