"""Split an 'artifacts' DatasetVersion among the members of a Job array.

Member i of an array of n reads the files whose position in path order p has p % n == i, so the
members together read every file exactly once. A member's share is its own dataset cache entry.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from ..errors import ConfigurationError


@dataclass(frozen=True)
class DatasetPartition:
    version_id: str
    array_size: int
    array_index: int

    @classmethod
    def for_job(cls, job: dict[str, Any]) -> DatasetPartition | None:
        """The Job's share of Job.datasetPartitionVersionId; a Job outside an array reads it all."""
        version_id = job.get("datasetPartitionVersionId")
        if not version_id:
            return None
        size, index = job.get("arraySize"), job.get("arrayIndex")
        if size is None and index is None:
            return cls(str(version_id), 1, 0)
        if type(size) is not int or type(index) is not int or size < 1 or not 0 <= index < size:
            raise ConfigurationError("Job arraySize and arrayIndex do not describe an array member")
        return cls(str(version_id), size, index)


def partition_files(
    files: list[dict[str, Any]], *, array_size: int, array_index: int
) -> list[dict[str, Any]]:
    # Python orders str by code point, which is also the order of their UTF-8 bytes.
    ordered = sorted(files, key=lambda file: str(file["path"]))
    return [file for position, file in enumerate(ordered) if position % array_size == array_index]


def partition_cache_key(digest: str, *, array_size: int, array_index: int) -> str:
    # The whole version's digest plus the member's place names exactly the files of its share.
    return "p-" + hashlib.sha256(f"{digest}\n{array_size}\n{array_index}".encode()).hexdigest()
