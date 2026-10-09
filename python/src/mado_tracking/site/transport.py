"""Run argv commands on a site: locally, or over OpenSSH with one shared connection per account.

The SSH settings live in a private ssh_config the launcher writes, so jump hosts (`-J`) get the
same known_hosts, key and BatchMode as the login host; a ControlMaster keeps one connection per
(site, account) open between commands.
"""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import ConfigurationError, TransportError
from ..security import SecretMasker
from ..worker.transport import SSH_CONNECT_TIMEOUT_SECONDS

# A launcher waits this long for one site command unless the caller sets its own limit.
DEFAULT_COMMAND_TIMEOUT_SECONDS = 600.0
# The shared connection closes this long after its last command.
CONTROL_PERSIST_SECONDS = 60
SERVER_ALIVE_INTERVAL_SECONDS = 30
# OpenSSH exits 255 when the connection itself failed.
SSH_CONNECTION_FAILED_EXIT_CODE = 255
DIAGNOSTIC_CHARACTERS = 2000
# [user@]host[:port] of a jump host.
JUMP_HOST = re.compile(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?$")
UNSAFE_CONFIG_CHARACTERS = '"\r\n\x00'


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: bytes
    stderr: bytes


class SiteTransport:
    """Runs argv as given; subclasses wrap it (SSH) and tell connection failures apart."""

    def __init__(self, *, masker: SecretMasker):
        self.masker = masker

    def command_argv(self, argv: Sequence[str]) -> list[str]:
        return list(argv)

    def run(
        self, argv: Sequence[str], *, stdin: bytes = b"", timeout: float = DEFAULT_COMMAND_TIMEOUT_SECONDS
    ) -> CommandResult:
        try:
            completed = subprocess.run(
                self.command_argv(argv), input=stdin, capture_output=True, timeout=timeout, check=False
            )
        except OSError:
            raise TransportError("Could not start the site transport") from None
        except subprocess.TimeoutExpired:
            raise TransportError(f"The site command did not finish within {timeout:.0f} seconds") from None
        result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
        self.check_connection(result)
        return result

    def check_connection(self, result: CommandResult) -> None:
        """Raise TransportError when the result says the connection, not the command, failed."""

    def diagnostic(self, stderr: bytes) -> str:
        return self.masker.mask(stderr.decode("utf-8", "replace"))[-DIAGNOSTIC_CHARACTERS:].strip()

    def close(self) -> None:
        """Release a shared connection; local transports hold nothing."""


class LocalSiteTransport(SiteTransport):
    """Commands run on this machine: `mado-tracking submit` on a login node, or a launcher on the site."""


@dataclass(frozen=True)
class SshEndpoint:
    host: str
    port: int
    user: str
    identity_file: Path
    known_hosts: Path
    jump_hosts: tuple[str, ...] = field(default=())

    def __post_init__(self) -> None:
        if not self.host or self.host.startswith("-") or any(c in self.host for c in " \r\n\x00@"):
            raise ConfigurationError("Invalid SSH host")
        if not self.user or self.user.startswith("-") or any(c in self.user for c in " @\r\n\x00"):
            raise ConfigurationError("Invalid SSH user")
        if not isinstance(self.port, int) or isinstance(self.port, bool) or not 1 <= self.port <= 65535:
            raise ConfigurationError("Invalid SSH port")
        for jump in self.jump_hosts:
            if not JUMP_HOST.fullmatch(jump):
                raise ConfigurationError(f"Invalid jump host {jump!r}; use [user@]host[:port]")
        for path in (self.identity_file, self.known_hosts):
            if any(character in str(path) for character in UNSAFE_CONFIG_CHARACTERS):
                raise ConfigurationError("SSH key and known_hosts paths must not contain quotes or newlines")

    def check_files(self) -> None:
        if not self.identity_file.is_file() or not self.known_hosts.is_file():
            raise ConfigurationError("SSH key and existing known_hosts files are required")
        if os.stat(self.identity_file).st_mode & 0o077:
            raise ConfigurationError("SSH private key file must not be readable by group or others")

    @property
    def key(self) -> str:
        identity = "\n".join(
            [self.host, str(self.port), self.user, str(self.identity_file), *self.jump_hosts]
        )
        return hashlib.sha256(identity.encode()).hexdigest()[:16]


def _config_path(path: Path) -> str:
    # ssh_config expands %-tokens in these values; a literal % is written twice.
    return '"' + str(path).replace("%", "%%") + '"'


def ssh_config_text(endpoint: SshEndpoint) -> str:
    """Settings for the login host and every jump host (`ssh -F` passes the file on to jumps)."""
    return "\n".join(
        [
            "Host *",
            f"  User {endpoint.user}",
            "  BatchMode yes",
            "  StrictHostKeyChecking yes",
            f"  UserKnownHostsFile {_config_path(endpoint.known_hosts)}",
            "  GlobalKnownHostsFile /dev/null",
            "  IdentitiesOnly yes",
            f"  IdentityFile {_config_path(endpoint.identity_file)}",
            f"  ConnectTimeout {SSH_CONNECT_TIMEOUT_SECONDS}",
            f"  ServerAliveInterval {SERVER_ALIVE_INTERVAL_SECONDS}",
            "",
        ]
    )


class SshSiteTransport(SiteTransport):
    def __init__(self, endpoint: SshEndpoint, *, state_directory: Path, masker: SecretMasker):
        super().__init__(masker=masker)
        endpoint.check_files()
        self.endpoint = endpoint
        directory = state_directory / "ssh"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.config_file = directory / f"{endpoint.key}.config"
        self.control_path = directory / f"{endpoint.key}.socket"
        descriptor = os.open(self.config_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(ssh_config_text(endpoint))

    def _base_argv(self) -> list[str]:
        argv = ["ssh", "-F", str(self.config_file), "-o", f"ControlPath={self.control_path}"]
        argv += ["-p", str(self.endpoint.port), "-l", self.endpoint.user]
        if self.endpoint.jump_hosts:
            argv += ["-J", ",".join(self.endpoint.jump_hosts)]
        return argv

    def command_argv(self, argv: Sequence[str]) -> list[str]:
        # The remote login shell parses the command line; every argument is quoted on its own.
        return [*self._base_argv(), "-o", "ControlMaster=no", "--", self.endpoint.host, shlex.join(argv)]

    def run(
        self, argv: Sequence[str], *, stdin: bytes = b"", timeout: float = DEFAULT_COMMAND_TIMEOUT_SECONDS
    ) -> CommandResult:
        if not self.control_path.exists():
            self.start_master()
        return super().run(argv, stdin=stdin, timeout=timeout)

    def start_master(self) -> None:
        """Open the shared connection in the background, detached from this process's pipes.

        A master started by a command with captured output could hold those pipes open until
        ControlPersist ends; starting it on its own avoids that. A failure is left to the
        command, which then connects without the master and reports the error itself.
        """
        try:
            subprocess.run(
                [
                    *self._base_argv(),
                    "-o",
                    "ControlMaster=yes",
                    "-o",
                    f"ControlPersist={CONTROL_PERSIST_SECONDS}",
                    "-f",
                    "-N",
                    "--",
                    self.endpoint.host,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=SSH_CONNECT_TIMEOUT_SECONDS * (len(self.endpoint.jump_hosts) + 2),
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    def check_connection(self, result: CommandResult) -> None:
        if result.exit_code == SSH_CONNECTION_FAILED_EXIT_CODE:
            raise TransportError(f"SSH connection to the site failed: {self.diagnostic(result.stderr)}")

    def close(self) -> None:
        if not self.control_path.exists():
            return
        try:
            subprocess.run(
                [*self._base_argv(), "-O", "exit", "--", self.endpoint.host],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=SSH_CONNECT_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
