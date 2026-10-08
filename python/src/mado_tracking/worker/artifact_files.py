"""Read a declared regular file without following any directory, symlink, or hardlink."""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO


@contextmanager
def open_regular_file(root: Path, parts: Sequence[str]) -> Iterator[BinaryIO]:
    if not parts or any(part in {"", ".", ".."} or "/" in part or "\x00" in part for part in parts):
        raise ValueError("File path must stay inside its declared directory")
    directory_descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nested_descriptor = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_descriptor
            )
            os.close(directory_descriptor)
            directory_descriptor = nested_descriptor
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_descriptor
        )
        with os.fdopen(descriptor, "rb") as content:
            properties = os.fstat(content.fileno())
            if not stat.S_ISREG(properties.st_mode) or properties.st_nlink != 1:
                raise ValueError("Files must be regular, without symlinks or hardlinks")
            yield content
    finally:
        os.close(directory_descriptor)
