"""SshSiteTransport against a fake `ssh` on PATH: how often it logs in, and its shared connection.

The fake records each call. A master (`ControlMaster=yes`) creates the control socket and marks
itself alive; `-O check` and `-O exit` answer only while it is; a command reports whether it ran
over the shared connection. A `refusal` file beside it makes every login fail with its text.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from mado_tracking.errors import TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.site.transport import (
    MAX_CONTROL_PATH_BYTES,
    LoginRefused,
    SshEndpoint,
    SshSiteTransport,
    connections_can_be_shared,
)

FAKE_SSH = r"""
import json
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
arguments = sys.argv[1:]
with (here / "ssh.jsonl").open("a") as log:
    log.write(json.dumps(arguments) + "\n")
options = [arguments[index + 1] for index, value in enumerate(arguments[:-1]) if value == "-o"]
paths = [value.split("=", 1)[1] for value in options if value.startswith("ControlPath=")]
socket = Path(paths[0]) if paths else None
master = here / "master-alive"
shared = socket is not None and socket.exists() and master.exists()
if "-O" in arguments:
    if shared and arguments[arguments.index("-O") + 1] == "exit":
        socket.unlink()
        master.unlink()
    sys.exit(0 if shared else 255)
refusal = here / "refusal"
if refusal.exists():
    sys.stderr.write(refusal.read_text())
    sys.exit(255)
if "ControlMaster=yes" in options:
    socket.write_text("")
    master.write_text("")
    sys.exit(0)
print("shared" if shared else "alone")
"""
REFUSED_KEY = "mmt@login.example.org: Permission denied (publickey).\r\n"
UNKNOWN_HOST_KEY = (
    "No ED25519 host key is known for login.example.org and you have requested strict checking.\r\n"
    "Host key verification failed.\r\n"
)
UNREACHABLE = "ssh: connect to host login.example.org port 22: Connection timed out\r\n"


@pytest.fixture
def fake_ssh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "bin"
    directory.mkdir()
    executable = directory / "ssh"
    executable.write_text(f"#!{sys.executable}\n" + FAKE_SSH)
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", f"{directory}:{os.environ.get('PATH', '')}")
    return directory


def calls(fake_ssh: Path) -> list[str]:
    """What each ssh call was: a master, a command, or the -O control command it sent."""
    log = fake_ssh / "ssh.jsonl"
    kinds = []
    for line in log.read_text().splitlines() if log.exists() else []:
        argv = json.loads(line)
        if "-O" in argv:
            kinds.append(argv[argv.index("-O") + 1])
        else:
            kinds.append("master" if "ControlMaster=yes" in argv else "command")
    return kinds


def transport_under(tmp_path: Path, state_directory: Path) -> SshSiteTransport:
    key, known_hosts = tmp_path / "key", tmp_path / "known_hosts"
    key.write_text("private")
    key.chmod(0o600)
    known_hosts.write_text("login.example.org ssh-ed25519 AAAA\n")
    endpoint = SshEndpoint(
        host="login.example.org", port=22, user="mmt", identity_file=key, known_hosts=known_hosts
    )
    return SshSiteTransport(endpoint, state_directory=state_directory, masker=SecretMasker())


def test_a_refused_login_fails_once_and_says_that_retrying_cannot_help(
    tmp_path, fake_ssh, ssh_state_directory
):
    transport = transport_under(tmp_path, ssh_state_directory)
    (fake_ssh / "refusal").write_text(REFUSED_KEY)
    with pytest.raises(LoginRefused, match=r"Permission denied \(publickey\)"):
        transport.run(["true"])
    # The master's failed login is the only one: the command does not log in again on its own.
    assert calls(fake_ssh) == ["master"]

    (fake_ssh / "refusal").write_text(UNKNOWN_HOST_KEY)
    with pytest.raises(LoginRefused, match="Host key verification failed"):
        transport.run(["true"])
    # A host that does not answer may answer later: that is no refusal.
    (fake_ssh / "refusal").write_text(UNREACHABLE)
    with pytest.raises(TransportError, match="Connection timed out") as unreachable:
        transport.run(["true"])
    assert not isinstance(unreachable.value, LoginRefused)
    assert calls(fake_ssh) == ["master", "master", "master"]


def test_one_login_serves_the_commands_and_a_socket_left_by_a_killed_master_is_replaced(
    tmp_path, fake_ssh, ssh_state_directory
):
    transport = transport_under(tmp_path, ssh_state_directory)
    assert transport.run(["true"]).stdout == b"shared\n"
    assert transport.run(["true"]).stdout == b"shared\n"
    assert calls(fake_ssh) == ["master", "command", "check", "command"]

    # The master died with a killed launcher; its socket stayed in the state directory.
    (fake_ssh / "master-alive").unlink()
    assert transport.control_path.exists()
    assert transport.run(["true"]).stdout == b"shared\n"
    assert calls(fake_ssh)[4:] == ["check", "master", "command"]

    transport.close()
    assert calls(fake_ssh)[-1] == "exit" and not transport.control_path.exists()


def test_under_a_state_directory_too_deep_for_a_control_socket_each_command_logs_in(
    tmp_path, fake_ssh, ssh_state_directory
):
    deep = ssh_state_directory / ("d" * MAX_CONTROL_PATH_BYTES)
    assert connections_can_be_shared(ssh_state_directory) and not connections_can_be_shared(deep)
    transport = transport_under(tmp_path, deep)
    # OpenSSH could not bind the socket, so no master is started: the commands log in alone.
    assert transport.run(["true"]).stdout == b"alone\n"
    assert transport.run(["true"]).stdout == b"alone\n"
    assert calls(fake_ssh) == ["command", "command"]
    (fake_ssh / "refusal").write_text(REFUSED_KEY)
    with pytest.raises(LoginRefused):
        transport.run(["true"])
    transport.close()
    assert calls(fake_ssh) == ["command", "command", "command"]
