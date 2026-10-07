"""Materialize immutable sources without trusting archive paths or links."""

from __future__ import annotations

import re
import shutil
import stat
import subprocess
import tarfile
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

# Bound extracted sources, rather than letting an archive exhaust the compute filesystem.
MAX_SOURCE_BYTES = 4 * 1024**3
MAX_SOURCE_FILES = 100_000
PINNED_COMMIT = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


def source_path(root: Path, name: str) -> Path:
    path = PurePosixPath(name)
    if not name or "\x00" in name or "\\" in name or ":" in name or path.is_absolute() or ".." in path.parts:
        raise ValueError("Source contains an unsafe path")
    destination = root.joinpath(*path.parts)
    if not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError("Source path escapes its workspace")
    if any(parent.is_symlink() for parent in (destination, *destination.parents)):
        raise ValueError("Source contains a symlink")
    return destination


def extract_archive(archive: Path, destination: Path) -> None:
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
        for member in members:
            path = source_path(destination, member.filename.rstrip("/"))
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}):
                raise ValueError("Code archive must not contain links or special files")
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as content, path.open("xb") as output:
                shutil.copyfileobj(content, output)
            path.chmod(0o755 if mode & stat.S_IXUSR else 0o644)


def _extract_tar(archive: Path, destination: Path) -> None:
    with tarfile.open(archive) as source:
        # Validate every member before writing; never use tarfile.extract/extractall.
        members = source.getmembers()
        _check_size(len(members), sum(member.size for member in members))
        for member in members:
            source_path(destination, member.name.rstrip("/"))
            if not member.isfile() and not member.isdir():
                raise ValueError("Code archive must not contain links or special files")
        for member in members:
            path = source_path(destination, member.name.rstrip("/"))
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            content = source.extractfile(member)
            if content is None:
                raise ValueError("Archive file has no content")
            with content, path.open("xb") as output:
                shutil.copyfileobj(content, output)
            path.chmod(0o755 if member.mode & stat.S_IXUSR else 0o644)


def _check_size(file_count: int, total_bytes: int) -> None:
    if file_count > MAX_SOURCE_FILES or total_bytes > MAX_SOURCE_BYTES:
        raise ValueError("Code source exceeds extraction limits")


def materialize_source(
    source: dict[str, Any],
    destination: Path,
    *,
    artifact: Path | None = None,
    command_runner: Callable[[list[str]], str] | None = None,
) -> None:
    kind = source.get("kind")
    if kind == "inline":
        files = source.get("files")
        if not isinstance(files, dict) or not files:
            raise ValueError("Inline source requires files")
        if not all(isinstance(content, str) for content in files.values()):
            raise ValueError("Inline source content must be UTF-8 text")
        _check_size(len(files), sum(len(content.encode()) for content in files.values()))
        for name, content in files.items():
            path = source_path(destination, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return
    if kind == "artifact":
        if artifact is None:
            raise ValueError("Code artifact was not downloaded")
        extract_archive(artifact, destination)
        return
    if kind != "git":
        raise ValueError("Unknown CodeSource kind")
    commit, url = source.get("commit", ""), source.get("url", "")
    if not isinstance(commit, str) or not PINNED_COMMIT.fullmatch(commit):
        raise ValueError("Git source requires a complete pinned commit hash")
    parsed_url = urlsplit(url)
    if not isinstance(url, str) or url.startswith("-") or "\x00" in url:
        raise ValueError("Invalid Git source URL")
    if parsed_url.password or (parsed_url.username and parsed_url.scheme in {"http", "https"}):
        raise ValueError("Git URL must not contain credentials")
    destination.mkdir(parents=True, exist_ok=True)
    commands = [
        ["git", "init", "--quiet", str(destination)],
        ["git", "-C", str(destination), "remote", "add", "origin", url],
        ["git", "-C", str(destination), "fetch", "--quiet", "--depth", "1", "origin", commit],
    ]

    def run(command: list[str]) -> str:
        if command_runner is not None:
            return command_runner(command)
        return subprocess.check_output(command, text=True)

    for command in commands:
        run(command)
    actual_commit = run(["git", "-C", str(destination), "rev-parse", "FETCH_HEAD"]).strip()
    if actual_commit.lower() != commit.lower():
        raise ValueError("Fetched Git commit does not match the pinned CodeVersion")
    run(
        [
            "git",
            "-C",
            str(destination),
            "-c",
            "core.hooksPath=/dev/null",
            "checkout",
            "--quiet",
            "--detach",
            actual_commit,
        ]
    )
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise ValueError("Git source must not contain symlinks")
