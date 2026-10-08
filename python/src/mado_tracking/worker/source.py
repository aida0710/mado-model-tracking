"""Materialize sources atomically without trusting archive paths, overlays, or links."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..code_source import validate_code_source
from .source_tree import (
    MAX_SOURCE_ARCHIVE_BYTES,
    MAX_SOURCE_BYTES,
    MAX_SOURCE_ENTRIES,
    MAX_SOURCE_FILE_BYTES,
    source_path,
    walk_source_entries,
)

# Copy binary sources in bounded chunks independently of archive compression.
SOURCE_COPY_BYTES = 1024 * 1024
# Missing POSIX directory metadata uses ordinary searchable source directories.
DEFAULT_DIRECTORY_MODE = 0o755


def _archive_path(root: Path, name: str) -> Path:
    # Standard tar includes './' prefixes and a '.' directory; never normalize '..' or empty parts.
    while name.startswith("./"):
        name = name[2:]
    return root if name == "." else source_path(root, name)


def extract_archive(archive: Path, destination: Path) -> None:
    if archive.stat().st_size > MAX_SOURCE_ARCHIVE_BYTES:
        raise ValueError("Code archive exceeds its download size limit")
    if destination.is_symlink():
        raise ValueError("Source contains a symlink")
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        _extract_zip(archive, destination)
        return
    if tarfile.is_tarfile(archive):
        _extract_tar(archive, destination)
        return
    raise ValueError("Code artifact must be a zip or tar archive")


def _extract_zip(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        _check_size(len(members), sum(member.file_size for member in members))
        entry_paths: set[Path] = set()
        for member in members:
            path = _archive_path(destination, member.filename.rstrip("/"))
            _count_archive_paths(path, destination, entry_paths)
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError("Code archive must not contain links or special files")
            _check_file_size(member.file_size)
            if path == destination and not member.is_dir():
                raise ValueError("Code archive file must have a filename")
        directory_modes = {}
        for member in members:
            path = _archive_path(destination, member.filename.rstrip("/"))
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                mode = member.external_attr >> 16
                directory_modes[path] = mode & 0o777 if stat.S_ISDIR(mode) else DEFAULT_DIRECTORY_MODE
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as content, path.open("xb") as output:
                shutil.copyfileobj(content, output, length=SOURCE_COPY_BYTES)
            path.chmod(0o755 if member.external_attr >> 16 & stat.S_IXUSR else 0o644)
        _apply_directory_modes(directory_modes)


def _extract_tar(archive: Path, destination: Path) -> None:
    with tarfile.open(archive) as source:
        members = source.getmembers()
        _check_size(len(members), sum(member.size for member in members))
        entry_paths: set[Path] = set()
        for member in members:
            path = _archive_path(destination, member.name.rstrip("/"))
            _count_archive_paths(path, destination, entry_paths)
            if not member.isfile() and not member.isdir():
                raise ValueError("Code archive must not contain links or special files")
            if path == destination and not member.isdir():
                raise ValueError("Code archive file must have a filename")
            _check_file_size(member.size)
        directory_modes = {}
        for member in members:
            path = _archive_path(destination, member.name.rstrip("/"))
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                directory_modes[path] = member.mode & 0o777
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            content = source.extractfile(member)
            if content is None:
                raise ValueError("Archive file has no content")
            with content, path.open("xb") as output:
                shutil.copyfileobj(content, output, length=SOURCE_COPY_BYTES)
            path.chmod(0o755 if member.mode & stat.S_IXUSR else 0o644)
        _apply_directory_modes(directory_modes)


def _apply_directory_modes(directory_modes: dict[Path, int]) -> None:
    # Finish children before read-only chmod; the owner must still be able to walk restored sources.
    for path in sorted(directory_modes, key=lambda item: len(item.parts), reverse=True):
        path.chmod(directory_modes[path] | stat.S_IRUSR | stat.S_IXUSR)


def _count_archive_paths(path: Path, root: Path, entry_paths: set[Path]) -> None:
    # Implicit parents can outnumber explicit archive members; bound them before writing anything.
    while path != root:
        entry_paths.add(path)
        if len(entry_paths) > MAX_SOURCE_ENTRIES:
            raise ValueError("Code source exceeds its file and directory count limit")
        path = path.parent


def _check_size(entry_count: int, total_bytes: int) -> None:
    if entry_count > MAX_SOURCE_ENTRIES or total_bytes > MAX_SOURCE_BYTES:
        raise ValueError("Code source exceeds extraction limits")


def _check_file_size(size: int) -> None:
    if size > MAX_SOURCE_FILE_BYTES:
        raise ValueError("Code source file exceeds its binary size limit")


def materialize_source(
    source: dict[str, Any],
    destination: Path,
    *,
    artifact: Path | None = None,
    command_runner: Callable[[list[str]], str] | None = None,
) -> str | None:
    validate_code_source(source)
    if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents):
        raise ValueError("Source contains a symlink")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("Source is already materialized; refusing to overwrite an existing execution")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Only publish a complete tree; an interrupted setup never exposes partially applied edits.
    with tempfile.TemporaryDirectory(prefix=".source-", dir=destination.parent) as temporary:
        staged_directory = Path(temporary) / "source"
        staged_directory.mkdir(mode=0o700)
        actual_commit = _materialize_base(
            source, staged_directory, artifact=artifact, command_runner=command_runner
        )
        for _entry in walk_source_entries(staged_directory, has_git_metadata=actual_commit is not None):
            pass
        if source["kind"] == "git":
            _apply_git_edits(source, staged_directory)
            for _entry in walk_source_entries(staged_directory, has_git_metadata=True):
                pass
        os.replace(staged_directory, destination)
    return actual_commit


def _materialize_base(
    source: dict[str, Any],
    destination: Path,
    *,
    artifact: Path | None,
    command_runner: Callable[[list[str]], str] | None,
) -> str | None:
    kind = source["kind"]
    if kind == "inline":
        for name, content in source["files"].items():
            path = source_path(destination, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return None
    if kind == "artifact":
        if artifact is None:
            raise ValueError("Code artifact was not downloaded")
        extract_archive(artifact, destination)
        return None
    return _checkout_git(source, destination, command_runner=command_runner)


def _checkout_git(
    source: dict[str, Any],
    destination: Path,
    *,
    command_runner: Callable[[list[str]], str] | None,
) -> str:
    def run(command: list[str]) -> str:
        if command_runner is not None:
            return command_runner(command)
        return subprocess.check_output(command, text=True)

    init_arguments = ["git", "init", "--quiet"]
    if len(source["commit"]) == 64:
        init_arguments.append("--object-format=sha256")
    run([*init_arguments, str(destination)])
    run(["git", "-C", str(destination), "remote", "add", "origin", source["url"]])
    run(
        [
            "git",
            "-C",
            str(destination),
            "fetch",
            "--quiet",
            "--depth",
            "1",
            "origin",
            source["commit"].lower(),
        ]
    )
    actual_commit = run(["git", "-C", str(destination), "rev-parse", "FETCH_HEAD"]).strip()
    if actual_commit.lower() != source["commit"].lower():
        raise ValueError("Fetched Git commit does not match the pinned CodeVersion")
    run(
        [
            "git",
            "-C",
            str(destination),
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.symlinks=true",
            "checkout",
            "--quiet",
            "--detach",
            actual_commit,
        ]
    )
    checked_out = run(["git", "-C", str(destination), "rev-parse", "HEAD"]).strip()
    if checked_out.lower() != actual_commit.lower():
        raise ValueError("Checked out Git commit does not match the pinned CodeVersion")
    return checked_out.lower()


def _apply_git_edits(source: dict[str, Any], destination: Path) -> None:
    for name in source.get("deletedFiles", []):
        path = source_path(destination, name)
        if path.exists() and not path.is_file():
            raise ValueError("Git deletedFiles may only delete regular files")
        path.unlink(missing_ok=True)
    for name, content in source.get("files", {}).items():
        path = source_path(destination, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
