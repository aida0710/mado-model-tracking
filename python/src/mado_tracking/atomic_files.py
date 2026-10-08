"""Write a file under a temporary name and rename it, so a failed write leaves no partial file."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO


@contextmanager
def atomic_output(target: Path) -> Iterator[BinaryIO]:
    """Yield a seekable file that replaces ``target`` only when the block finishes without error.

    The temporary file sits next to ``target`` so the final rename stays on one filesystem.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".partial")
    try:
        with os.fdopen(descriptor, "w+b") as output:
            yield output
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
