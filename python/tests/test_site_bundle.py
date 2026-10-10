"""The runner zipapp and the work directory steps a launcher or `submit` performs on a site."""

from __future__ import annotations

import io
import os
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from mado_tracking.security import SecretMasker
from mado_tracking.site.bundle import (
    ENTRY_DATE_TIME,
    RUNNER_BUNDLE_NAME,
    RUNNER_WRAPPER_NAME,
    build_runner_bundle,
    runner_installation,
)
from mado_tracking.site.site_operations import SiteOperations
from mado_tracking.site.transport import CommandResult, LocalSiteTransport


class RecordingTransport(LocalSiteTransport):
    def __init__(self) -> None:
        super().__init__(masker=SecretMasker())
        self.commands: list[list[str]] = []

    def run(self, argv, *, stdin=b"", timeout=60.0) -> CommandResult:
        self.commands.append(list(argv))
        return super().run(argv, stdin=stdin, timeout=timeout)


def test_the_bundle_holds_the_package_and_httpx_and_runs_from_the_zip(tmp_path):
    installation = runner_installation(sys.executable)
    with zipfile.ZipFile(io.BytesIO(installation.bundle)) as archive:
        names = set(archive.namelist())
    assert {
        "__main__.py",
        "mado_tracking/cli.py",
        "mado_tracking/site/runner.py",
        "httpx/__init__.py",
    } <= names
    assert "certifi/cacert.pem" in names and not [name for name in names if "__pycache__" in name]
    bundle = tmp_path / RUNNER_BUNDLE_NAME
    bundle.write_bytes(installation.bundle)
    wrapper = tmp_path / RUNNER_WRAPPER_NAME
    wrapper.write_bytes(installation.wrapper)
    wrapper.chmod(0o700)
    # -I: only the zipapp's own copies of the package and httpx are importable.
    help_text = subprocess.run(
        [sys.executable, "-I", str(bundle), "site-run", "--help"],
        capture_output=True,
        text=True,
        check=True,
        cwd=tmp_path,
    ).stdout
    assert "SPEC_DIR" in help_text
    through_wrapper = subprocess.run(
        [str(wrapper), "--help"],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "MMT_RUNNER_PYTHON": sys.executable},
    )
    assert "SPEC_DIR" in through_wrapper.stdout


def test_the_bundle_is_the_same_whenever_a_process_builds_it(monkeypatch):
    # Every launcher process and every `mado-tracking submit` builds the bundle anew; when the
    # bytes changed with the clock, each of them installed another copy of the runner on the site.
    first = build_runner_bundle()
    an_hour_later = time.time() + 3600
    monkeypatch.setattr(time, "time", lambda: an_hour_later)
    assert build_runner_bundle() == first
    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert {entry.date_time for entry in archive.infolist()} == {ENTRY_DATE_TIME}


def test_the_runner_and_job_shell_are_installed_once_per_version(tmp_path):
    transport = RecordingTransport()
    operations = SiteOperations(transport, work_directory=str(tmp_path / "work"))
    installation = runner_installation("python3")
    runner = operations.ensure_runner(installation)
    assert runner == str(tmp_path / "work/.mmt-runner" / installation.version / RUNNER_WRAPPER_NAME)
    assert stat.S_IMODE(os.stat(runner).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(Path(runner).parent / RUNNER_BUNDLE_NAME).st_mode) == 0o600
    installs = len([command for command in transport.commands if command[:2] == ["sh", "-c"]])
    assert operations.ensure_runner(installation) == runner
    assert len([command for command in transport.commands if command[:2] == ["sh", "-c"]]) == installs
    first = operations.ensure_job_shell(b"#!/bin/sh\necho 1\n")
    second = operations.ensure_job_shell(b"#!/bin/sh\necho 2\n")
    assert first != second and Path(first).read_bytes() == b"#!/bin/sh\necho 1\n"


def test_a_spec_directory_replaces_an_interrupted_attempt_and_the_job_shell_runs_inside_it(tmp_path):
    operations = SiteOperations(RecordingTransport(), work_directory=str(tmp_path / "work"))
    operations.write_spec_directory("job-1", {"stale.json": (b"{}", 0o600)})
    spec = operations.write_spec_directory("job-1", {"jobs/0.json": (b'{"a": 1}', 0o600)})
    assert (
        not (Path(spec) / "stale.json").exists() and (Path(spec) / "jobs/0.json").read_bytes() == b'{"a": 1}'
    )
    assert stat.S_IMODE(os.stat(spec).st_mode) == 0o700
    job_shell = Path(operations.ensure_job_shell(b'#!/bin/sh\npwd\necho "$MMT_VALUE"\necho 31.pbs\n'))
    result = operations.run_job_shell(
        str(job_shell), spec_directory=spec, environment={"MMT_VALUE": "it's $(not) evaluated"}
    )
    assert result.exit_code == 0
    assert result.stdout.decode().splitlines() == [spec, "it's $(not) evaluated", "31.pbs"]
