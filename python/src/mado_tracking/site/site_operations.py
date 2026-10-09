"""What a launcher or `mado-tracking submit` does in a site's work directory.

    <work dir>/.mmt-runner/<version>/        mmt-runner.pyz and the mmt-runner wrapper
    <work dir>/.mmt-job-shells/<sha256>/     job.sh, one directory per job shell content
    <work dir>/.mmt-submissions/<name>/      one spec directory per submission

Each step is one command through the site's transport, and files arrive on stdin as a tar, so
no value is ever pasted into a shell script. Installed directories appear only when complete.
"""

from __future__ import annotations

import hashlib
import posixpath
from collections.abc import Mapping

from ..errors import ConfigurationError
from .bundle import RUNNER_BUNDLE_NAME, RUNNER_WRAPPER_NAME, RunnerInstallation
from .file_archive import EXECUTABLE_FILE_MODE, PRIVATE_FILE_MODE, pack_files
from .transport import CommandResult, SiteTransport

RUNNER_DIRECTORY = ".mmt-runner"
JOB_SHELL_DIRECTORY = ".mmt-job-shells"
SUBMISSIONS_DIRECTORY = ".mmt-submissions"
JOB_SHELL_NAME = "job.sh"
JOB_SHELL_VERSION_CHARACTERS = 16
SETUP_TIMEOUT_SECONDS = 300.0
# Submitting must end well inside the API's 15 minutes for an unreported submission.
JOB_SHELL_TIMEOUT_SECONDS = 600.0
CANCEL_TIMEOUT_SECONDS = 120.0
# Extract stdin's tar into <base>/<name>, publishing it by rename; keep an existing installation.
INSTALL_SCRIPT = (
    'set -e; umask 077; mkdir -p "$1"; staging=$(mktemp -d "$1/.install.XXXXXX"); '
    'tar -x -f - -C "$staging"; '
    'if [ -e "$1/$2" ]; then rm -rf "$staging"; else mv "$staging" "$1/$2"; fi'
)
# Same, replacing what an interrupted earlier attempt of this submission left.
REPLACE_SCRIPT = (
    'set -e; umask 077; mkdir -p "$1"; staging=$(mktemp -d "$1/.write.XXXXXX"); '
    'tar -x -f - -C "$staging"; rm -rf "$1/$2"; mv "$staging" "$1/$2"'
)
RUN_IN_DIRECTORY_SCRIPT = 'cd "$1" && shift && exec "$@"'
UNSAFE_NAME_CHARACTERS = "/\r\n\x00"


def _checked_name(name: str) -> str:
    if not name or name in {".", ".."} or any(character in name for character in UNSAFE_NAME_CHARACTERS):
        raise ConfigurationError(f"Invalid site directory name {name!r}")
    return name


class SiteOperations:
    def __init__(self, transport: SiteTransport, *, work_directory: str):
        if not work_directory.startswith("/") or any(c in work_directory for c in "\r\n\x00"):
            raise ConfigurationError("The site work directory must be an absolute path")
        self.transport = transport
        self.work_directory = work_directory.rstrip("/") or "/"

    def path(self, *parts: str) -> str:
        return posixpath.join(self.work_directory, *parts)

    def _checked(self, result: CommandResult, action: str) -> CommandResult:
        if result.exit_code:
            detail = self.transport.diagnostic(result.stderr)
            raise ConfigurationError(f"{action} failed on the site ({result.exit_code}): {detail}")
        return result

    def ensure_installed(
        self, base: str, name: str, files: Mapping[str, tuple[bytes, int]], *, probe: str
    ) -> str:
        """Install files under base/name once; `probe` is the file whose presence proves it."""
        directory = posixpath.join(base, _checked_name(name))
        present = self.transport.run(
            ["test", "-f", posixpath.join(directory, probe)], timeout=SETUP_TIMEOUT_SECONDS
        )
        if present.exit_code:
            self._checked(
                self.transport.run(
                    ["sh", "-c", INSTALL_SCRIPT, "mmt-install", base, name],
                    stdin=pack_files(files),
                    timeout=SETUP_TIMEOUT_SECONDS,
                ),
                "Installing files",
            )
        return directory

    def ensure_runner(self, installation: RunnerInstallation) -> str:
        """Install the runner version once; returns MMT_RUNNER."""
        directory = self.ensure_installed(
            self.path(RUNNER_DIRECTORY),
            installation.version,
            {
                RUNNER_BUNDLE_NAME: (installation.bundle, PRIVATE_FILE_MODE),
                RUNNER_WRAPPER_NAME: (installation.wrapper, EXECUTABLE_FILE_MODE),
            },
            probe=RUNNER_WRAPPER_NAME,
        )
        return posixpath.join(directory, RUNNER_WRAPPER_NAME)

    def ensure_job_shell(self, content: bytes) -> str:
        """Install this version of the job shell once; a Run's job shell is named by its content."""
        version = hashlib.sha256(content).hexdigest()[:JOB_SHELL_VERSION_CHARACTERS]
        directory = self.ensure_installed(
            self.path(JOB_SHELL_DIRECTORY),
            version,
            {JOB_SHELL_NAME: (content, EXECUTABLE_FILE_MODE)},
            probe=JOB_SHELL_NAME,
        )
        return posixpath.join(directory, JOB_SHELL_NAME)

    def write_spec_directory(self, name: str, files: Mapping[str, tuple[bytes, int]]) -> str:
        self._checked(
            self.transport.run(
                [
                    "sh",
                    "-c",
                    REPLACE_SCRIPT,
                    "mmt-write",
                    self.path(SUBMISSIONS_DIRECTORY),
                    _checked_name(name),
                ],
                stdin=pack_files(files),
                timeout=SETUP_TIMEOUT_SECONDS,
            ),
            "Writing the spec directory",
        )
        return self.path(SUBMISSIONS_DIRECTORY, name)

    def run_job_shell(
        self, job_shell: str, *, spec_directory: str, environment: Mapping[str, str]
    ) -> CommandResult:
        # `env` receives each NAME=value as its own argument; nothing is evaluated by a shell.
        assignments = [f"{name}={value}" for name, value in environment.items()]
        return self.transport.run(
            [
                "sh",
                "-c",
                RUN_IN_DIRECTORY_SCRIPT,
                "mmt-job-shell",
                spec_directory,
                "env",
                *assignments,
                job_shell,
            ],
            timeout=JOB_SHELL_TIMEOUT_SECONDS,
        )

    def cancel(self, cancel_command: str, *, scheduler_job_id: str) -> CommandResult:
        """Run the site's cancel command (shell text from its settings) for one scheduler job."""
        return self.transport.run(
            ["env", f"MMT_SCHEDULER_JOB_ID={scheduler_job_id}", "sh", "-c", cancel_command],
            timeout=CANCEL_TIMEOUT_SECONDS,
        )
