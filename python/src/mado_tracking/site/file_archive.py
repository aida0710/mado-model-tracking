"""Pack files into one tar so a single command on a site can write them with their modes."""

from __future__ import annotations

import io
import posixpath
import tarfile
import time
from collections.abc import Mapping

PRIVATE_FILE_MODE = 0o600
EXECUTABLE_FILE_MODE = 0o700
PRIVATE_DIRECTORY_MODE = 0o700


def pack_files(files: Mapping[str, tuple[bytes, int]]) -> bytes:
    """A tar of relative path -> (content, mode); parent directories are added as 0700."""
    buffer = io.BytesIO()
    now = int(time.time())
    directories: set[str] = set()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(files):
            if posixpath.isabs(path) or any(part in {"", ".", ".."} for part in path.split("/")):
                raise ValueError(f"Packed file paths must be relative: {path!r}")
            parent = posixpath.dirname(path)
            missing = []
            while parent and parent not in directories:
                missing.append(parent)
                parent = posixpath.dirname(parent)
            for directory in reversed(missing):
                entry = tarfile.TarInfo(directory)
                entry.type, entry.mode, entry.mtime = tarfile.DIRTYPE, PRIVATE_DIRECTORY_MODE, now
                archive.addfile(entry)
                directories.add(directory)
            content, mode = files[path]
            entry = tarfile.TarInfo(path)
            entry.size, entry.mode, entry.mtime = len(content), mode, now
            archive.addfile(entry, io.BytesIO(content))
    return buffer.getvalue()
