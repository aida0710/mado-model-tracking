"""Validate CodeSource declarations before sending or materializing immutable code."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

# Bound legacy text sources independently; the API enforces a smaller registry JSON budget.
MAX_SOURCE_TEXT_BYTES = 16 * 1024**2
MAX_SOURCE_FILES = 100_000
MAX_SOURCE_PATH_LENGTH = 1024
PINNED_COMMIT = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


def validate_source_file_name(name: str) -> None:
    if (
        not isinstance(name, str)
        or not name
        or len(name) > MAX_SOURCE_PATH_LENGTH
        or "\\" in name
        or re.match(r"^[A-Za-z]:", name)
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
        or any(part in {"", ".", ".."} or part.lower() == ".git" for part in name.split("/"))
    ):
        raise ValueError("Source contains an unsafe path or .git metadata")


def _validate_text_files(files: object, *, allow_empty: bool) -> set[str]:
    if not isinstance(files, Mapping) or not allow_empty and not files:
        raise ValueError("Code source requires a mapping of UTF-8 text files")
    if len(files) > MAX_SOURCE_FILES:
        raise ValueError("Code source exceeds its file limit")
    total_bytes = 0
    names: set[str] = set()
    for name, content in files.items():
        validate_source_file_name(name)
        if not isinstance(content, str):
            raise ValueError("Code source content must be UTF-8 text")
        total_bytes += len(content.encode("utf-8"))
        if total_bytes > MAX_SOURCE_TEXT_BYTES:
            raise ValueError("Code source exceeds its text limit")
        names.add(name)
    _reject_ancestor_paths(names)
    return names


def _reject_ancestor_paths(names: set[str]) -> None:
    for name in names:
        parts = name.split("/")
        if any("/".join(parts[:index]) in names for index in range(1, len(parts))):
            raise ValueError("Source file paths conflict with another file or deletion")


def validate_code_source(source: Mapping[str, Any] | None) -> None:
    if source is None:
        return
    if not isinstance(source, Mapping):
        raise ValueError("Code source must be an object")
    kind = source.get("kind")
    if kind == "inline":
        if set(source) - {"kind", "files"}:
            raise ValueError("Unknown inline source settings")
        _validate_text_files(source.get("files"), allow_empty=False)
        return
    if kind == "artifact":
        if set(source) - {"kind", "artifactId"} or not isinstance(source.get("artifactId"), str):
            raise ValueError("Code artifact requires a saved Artifact ID")
        if not source["artifactId"]:
            raise ValueError("Code artifact requires a saved Artifact ID")
        return
    if kind != "git" or set(source) - {"kind", "url", "commit", "files", "deletedFiles"}:
        raise ValueError("Unknown CodeSource kind or settings")
    commit, url = source.get("commit"), source.get("url")
    if not isinstance(commit, str) or not PINNED_COMMIT.fullmatch(commit):
        raise ValueError("Git source requires a complete pinned commit hash")
    if not isinstance(url, str) or not url or url.startswith("-") or any(char in url for char in "\x00\r\n"):
        raise ValueError("Invalid Git source URL")
    parsed_url = urlsplit(url)
    if parsed_url.password or (parsed_url.username and parsed_url.scheme in {"http", "https"}):
        raise ValueError("Git URL must not contain credentials")
    files = _validate_text_files(source.get("files", {}), allow_empty=True)
    deletions = source.get("deletedFiles", [])
    if not isinstance(deletions, list) or len(deletions) > MAX_SOURCE_FILES:
        raise ValueError("Git deletedFiles must be a bounded list of paths")
    deleted_names: set[str] = set()
    for name in deletions:
        validate_source_file_name(name)
        if name in deleted_names:
            raise ValueError("Git source contains duplicate deletedFiles")
        deleted_names.add(name)
    if files & deleted_names:
        raise ValueError("Git source cannot both delete and add the same file")
    _reject_ancestor_paths(files | deleted_names)
