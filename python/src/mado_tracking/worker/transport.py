"""Argv-based local/OpenSSH transport; remote shell arguments are individually quoted."""

from __future__ import annotations

import asyncio
import os
import shlex
from collections.abc import Sequence
from pathlib import Path

from ..errors import ConfigurationError, TransportError
from ..security import SecretMasker

# Runner protocol responses are small; reject accidental unbounded command output.
CONTROL_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 2 * 1024**2
TRANSFER_CHUNK_BYTES = 64 * 1024
SSH_CONNECT_TIMEOUT_SECONDS = 10


class CommandTransport:
    def __init__(self, *, masker: SecretMasker):
        self.masker = masker

    def command_argv(self, command: Sequence[str]) -> list[str]:
        return list(command)

    async def run(
        self,
        command: Sequence[str],
        *,
        stdin: bytes | Path = b"",
        timeout: float | None = CONTROL_TIMEOUT_SECONDS,  # noqa: ASYNC109 -- one complete transport operation
    ) -> bytes:
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command_argv(command),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError:
            raise TransportError("Could not start the compute transport") from None
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise TransportError("Compute transport pipes are unavailable")
        input_writer = process.stdin

        async def transfer_input() -> None:
            try:
                if isinstance(stdin, Path):
                    with stdin.open("rb") as source:
                        while chunk := source.read(TRANSFER_CHUNK_BYTES):
                            input_writer.write(chunk)
                            await input_writer.drain()
                else:
                    input_writer.write(stdin)
                    await input_writer.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                input_writer.close()

        async def read_output(reader: asyncio.StreamReader) -> bytes:
            output = bytearray()
            while chunk := await reader.read(TRANSFER_CHUNK_BYTES):
                if len(output) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise TransportError("Compute transport response exceeded the size limit")
                output.extend(chunk)
            return bytes(output)

        try:
            async with asyncio.timeout(timeout):
                _uploaded, stdout, stderr = await asyncio.gather(
                    transfer_input(), read_output(process.stdout), read_output(process.stderr)
                )
                exit_code = await process.wait()
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if exit_code:
            diagnostic = self.masker.mask(stderr.decode("utf-8", "replace")[:4096]).strip()
            raise TransportError(f"Compute transport exited ({exit_code}): {diagnostic}")
        return stdout


class LocalTransport(CommandTransport):
    def __init__(self, *, allow_local_executor: bool, masker: SecretMasker):
        if not allow_local_executor:
            raise ConfigurationError("Local execution requires MMT_ALLOW_LOCAL_EXECUTOR=true in development")
        super().__init__(masker=masker)


class SSHTransport(CommandTransport):
    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        ssh_key_path: str,
        known_hosts_path: str,
        masker: SecretMasker,
    ):
        super().__init__(masker=masker)
        if not host or host.startswith("-") or any(character in host for character in "\r\n\x00"):
            raise ConfigurationError("Invalid SSH host")
        if not username or any(character in username for character in "@\r\n\x00"):
            raise ConfigurationError("Invalid SSH username")
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ConfigurationError("Invalid SSH port")
        self.host = host
        self.port = port
        self.username = username
        self.ssh_key_path = Path(ssh_key_path).expanduser()
        self.known_hosts_path = Path(known_hosts_path).expanduser()
        if not self.ssh_key_path.is_file() or not self.known_hosts_path.is_file():
            raise ConfigurationError("SSH key and existing known_hosts files are required")
        if os.stat(self.ssh_key_path).st_mode & 0o077:
            raise ConfigurationError("SSH private key file must not be readable by group or others")

    def command_argv(self, command: Sequence[str]) -> list[str]:
        return [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={self.known_hosts_path}",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            f"ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}",
            "-p",
            str(self.port),
            "-i",
            str(self.ssh_key_path),
            "--",
            f"{self.username}@{self.host}",
            shlex.join(command),
        ]
