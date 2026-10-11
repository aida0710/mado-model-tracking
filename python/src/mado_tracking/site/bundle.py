"""The runner a site executes on its compute nodes: a zipapp of this package and httpx.

`python3 mmt-runner.pyz site-run <spec dir>` is `mado-tracking site-run <spec dir>`. The
`mmt-runner` wrapper beside it starts the zipapp with the site's Python; it is what the job shell
receives as MMT_RUNNER. httpx and its pure-Python dependencies are copied from the environment
that builds the bundle, so compute nodes need nothing but Python 3.11 or later.
"""

from __future__ import annotations

import hashlib
import io
import re
import shlex
import zipfile
from dataclasses import dataclass
from functools import cache
from importlib import metadata
from pathlib import Path, PurePosixPath

from ..errors import ConfigurationError

RUNNER_BUNDLE_NAME = "mmt-runner.pyz"
RUNNER_WRAPPER_NAME = "mmt-runner"
BUNDLE_MAIN = "from mado_tracking.cli import main\nraise SystemExit(main())\n"
# The SDK's one third-party dependency (pyproject.toml); its requirements come along.
VENDORED_DISTRIBUTION = "httpx"
# Characters of the bundle digest that name an installed version on the site.
VERSION_CHARACTERS = 16
REQUIREMENT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*")
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".so", ".pyd"}
# Every entry carries this time and mode, so the bundle's bytes, and the version a site installs
# it under, follow from the files' content alone: not from when a process built it, nor from when
# the package was installed. The time is the earliest a zip can hold.
ENTRY_DATE_TIME = (1980, 1, 1, 0, 0, 0)
ENTRY_MODE = 0o644


@dataclass(frozen=True)
class RunnerInstallation:
    """The files installed on a site under <work dir>/.mmt-runner/<version>/."""

    version: str
    bundle: bytes
    wrapper: bytes


def _requirement_names(distribution: str) -> list[str]:
    names = []
    for requirement in metadata.requires(distribution) or []:
        name, _separator, marker = requirement.partition(";")
        if "extra" in marker:
            continue
        match = REQUIREMENT_NAME.match(name.strip())
        if match:
            names.append(match.group(0))
    return names


def _distribution_closure(root: str) -> list[metadata.Distribution]:
    """The distribution and everything it requires that is installed here (markers aside)."""
    pending, seen, found = [root], set(), []
    while pending:
        name = pending.pop()
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        try:
            distribution = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            if name == root:
                raise ConfigurationError(f"{root} must be installed to build the runner bundle") from None
            # A requirement for another Python version (for example typing_extensions on 3.13).
            continue
        found.append(distribution)
        pending.extend(_requirement_names(name))
    return found


def vendored_files(root: str = VENDORED_DISTRIBUTION) -> list[tuple[str, Path]]:
    """(name in the zipapp, installed file) for each importable file of the closure."""
    files: list[tuple[str, Path]] = []
    for distribution in _distribution_closure(root):
        for entry in distribution.files or []:
            path = PurePosixPath(str(entry))
            if (
                not path.parts
                or path.parts[0] == ".."
                or path.parts[0].endswith((".dist-info", ".egg-info"))
                or "__pycache__" in path.parts
                or path.suffix in EXCLUDED_SUFFIXES
            ):
                continue
            located = Path(str(distribution.locate_file(entry)))
            if located.is_file():
                files.append((path.as_posix(), located))
    return files


def _add_entry(archive: zipfile.ZipFile, name: str, content: bytes) -> None:
    entry = zipfile.ZipInfo(name, date_time=ENTRY_DATE_TIME)
    entry.compress_type = zipfile.ZIP_DEFLATED
    entry.external_attr = ENTRY_MODE << 16
    archive.writestr(entry, content)


def build_runner_bundle() -> bytes:
    package_directory = Path(__file__).resolve().parent.parent
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        _add_entry(archive, "__main__.py", BUNDLE_MAIN.encode())
        for path in sorted(package_directory.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix not in EXCLUDED_SUFFIXES:
                name = f"mado_tracking/{path.relative_to(package_directory).as_posix()}"
                _add_entry(archive, name, path.read_bytes())
        for name, path in sorted(vendored_files()):
            _add_entry(archive, name, path.read_bytes())
    return buffer.getvalue()


def runner_wrapper(python_executable: str) -> bytes:
    """MMT_RUNNER: `mmt-runner <spec dir>`; MMT_RUNNER_PYTHON overrides the site's Python."""
    if not python_executable or any(character in python_executable for character in "\r\n\x00"):
        raise ConfigurationError("runner_python must be one command without newlines")
    return (
        "#!/bin/sh\n"
        "# Installed by mado ML Tracking; starts the site runner (mado-tracking site-run).\n"
        'python="${MMT_RUNNER_PYTHON:-}"\n'
        f'if [ -z "$python" ]; then python={shlex.quote(python_executable)}; fi\n'
        f'exec "$python" "$(dirname "$0")/{RUNNER_BUNDLE_NAME}" site-run "$@"\n'
    ).encode()


@cache
def _bundle() -> bytes:
    # The package does not change while a launcher runs, so the zipapp is built once per process.
    return build_runner_bundle()


def runner_installation(python_executable: str) -> RunnerInstallation:
    bundle, wrapper = _bundle(), runner_wrapper(python_executable)
    version = hashlib.sha256(bundle + b"\n" + wrapper).hexdigest()[:VERSION_CHARACTERS]
    return RunnerInstallation(version=version, bundle=bundle, wrapper=wrapper)
