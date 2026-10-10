"""The launcher's SSH keys and connection checks: made with ssh-keygen, published, deleted, tried."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from uuid import uuid4

import pytest
from fake_launcher_api import (
    LAUNCHER_TOKEN,
    FakeLauncherApi,
    LocalLogins,
    install_fake_ssh_keygen,
    recorded_keygen_calls,
)
from site_fixtures import account_document, site_settings_document

from mado_tracking.errors import TransportError
from mado_tracking.site.launcher import MAX_CHECK_MESSAGE_CHARACTERS, Launcher
from mado_tracking.site.launcher_config import load_launcher_config
from mado_tracking.site.launcher_keys import key_comment
from mado_tracking.site.transport import CommandResult


@pytest.fixture
def keygen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return install_fake_ssh_keygen(tmp_path, monkeypatch)


def launcher_for(tmp_path: Path, api: FakeLauncherApi, logins: LocalLogins | None = None) -> Launcher:
    token_file = tmp_path / "launcher.token"
    token_file.write_text(LAUNCHER_TOKEN + "\n")
    token_file.chmod(0o600)
    config = tmp_path / "launcher.toml"
    config.write_text(
        'api_url = "http://api.example.invalid"\n'
        'token_file = "launcher.token"\n'
        f'state_directory = "{tmp_path / "state"}"\n'
    )
    return Launcher(
        load_launcher_config(config), client_factory=api.client, transport_factory=logins or LocalLogins()
    )


def mode_of(path: Path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def test_keys_are_made_published_again_when_needed_and_deleted_once_unlisted(tmp_path, keygen):
    api = FakeLauncherApi(launcher_name="GPU launcher 1")
    target_id = str(uuid4())
    requested = api.add_key(target_id)
    # Ready on the API, but its files are gone from this host (a lost state volume): made anew.
    lost = api.add_key(target_id, user_id=str(uuid4()), status="ready", public_key="ssh-ed25519 AAAAold old")
    launcher = launcher_for(tmp_path, api)
    launcher.run_once()
    keys = tmp_path / "state/keys"
    assert mode_of(keys) == 0o700
    calls = recorded_keygen_calls(keygen)
    assert calls == [
        [
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            f"mmt-launcher:GPU-launcher-1:{key_id}",
            "-f",
            str(keys / key_id),
        ]
        for key_id in (requested, lost)
    ]
    assert all(mode_of(keys / key_id) == 0o600 for key_id in (requested, lost))
    public_keys = {key_id: (keys / f"{key_id}.pub").read_text().strip() for key_id in (requested, lost)}
    assert dict(api.published()) == public_keys
    assert all(key.startswith("ssh-ed25519 AAAA") for key in public_keys.values())

    # Ready keys whose public half the API holds are left alone, whatever the comment says.
    api.keys[0]["publicKey"] = public_keys[requested].rsplit(" ", 1)[0] + " edited comment"
    launcher.run_once()
    assert len(recorded_keygen_calls(keygen)) == 2 and len(api.published()) == 2

    # Another public half on the API, or a key still requested, is published again unchanged.
    api.keys[0].update(publicKey="ssh-ed25519 AAAAsomethingelse")
    api.keys[1].update(status="requested", publicKey=None)
    launcher.run_once()
    assert api.published()[2:] == [(requested, public_keys[requested]), (lost, public_keys[lost])]
    assert len(recorded_keygen_calls(keygen)) == 2

    # A key with half its files is made again; a key the API no longer lists is deleted.
    (keys / f"{requested}.pub").unlink()
    api.keys = [key for key in api.keys if key["id"] != lost]
    (keys / "notes.txt").write_text("not a key")
    launcher.run_once()
    assert len(recorded_keygen_calls(keygen)) == 3
    assert api.published()[-1] == (requested, (keys / f"{requested}.pub").read_text().strip())
    assert sorted(path.name for path in keys.iterdir()) == sorted(
        [requested, f"{requested}.pub", "notes.txt"]
    )
    launcher.close()


def test_a_key_that_cannot_be_made_or_published_stops_neither_the_others_nor_the_poll(
    tmp_path, keygen, monkeypatch, caplog
):
    api = FakeLauncherApi()
    target_id = str(uuid4())
    api.assign_site({"id": target_id, "name": "ABCI"}, site_settings_document())
    revoked, kept = api.add_key(target_id), api.add_key(target_id, user_id=str(uuid4()))
    # Revoked on the Web between the configuration and the publication.
    api.revoked.add(revoked)
    launcher = launcher_for(tmp_path, api)
    launcher.run_once()
    assert [key_id for key_id, _public_key in api.published()] == [revoked, kept]
    assert "was not published" in caplog.text and "the key was revoked" in caplog.text
    assert api.keys[1]["status"] == "ready"

    # Without ssh-keygen a new key is not made, and the poll still claims.
    monkeypatch.setenv("PATH", str(tmp_path / "nowhere"))
    api.add_key(target_id, user_id=str(uuid4()))
    launcher.run_once()
    assert "ssh-keygen could not be started" in caplog.text
    assert len(api.bodies("POST", "launcher/site-submissions/claim")) == 2
    launcher.close()


def test_key_comments_stay_one_word_whatever_the_launcher_is_called():
    key_id = str(uuid4())
    assert key_comment("研究室 launcher\t2", key_id) == f"mmt-launcher:研究室-launcher-2:{key_id}"
    # The API keeps comments of up to 300 characters, whatever the launcher's name.
    assert key_comment("x" * 200, key_id) == f"mmt-launcher:{'x' * 100}:{key_id}"


def test_connection_checks_log_in_on_their_own_and_report_what_ssh_said(tmp_path, keygen):
    api, logins = FakeLauncherApi(), LocalLogins()
    target_id = str(uuid4())
    settings = site_settings_document()
    api.assign_site({"id": target_id, "name": "ABCI"}, settings)
    key_id = api.add_key(target_id)
    account = account_document(mode="shared", account_name="mmt", key_id=key_id)
    succeeded, elsewhere, unknown_key = (str(uuid4()) for _ in range(3))
    api.checks = [
        {"id": succeeded, "targetId": target_id, "account": account},
        {"id": elsewhere, "targetId": str(uuid4()), "account": account},
        {"id": unknown_key, "targetId": target_id, "account": {**account, "keyId": str(uuid4())}},
    ]
    launcher = launcher_for(tmp_path, api, logins)
    launcher.run_once()
    [login] = logins.made
    assert login.shared_connection is False and login.closed and login.commands == [["true"]]
    state = tmp_path / "state"
    assert (login.endpoint.user, login.endpoint.host) == ("mmt", "login.example.org")
    assert login.endpoint.identity_file == state / "keys" / key_id
    assert login.endpoint.known_hosts == state / "known-hosts" / target_id
    assert login.endpoint.known_hosts.read_text() == settings["connection"]["knownHosts"]
    assert mode_of(login.endpoint.known_hosts) == 0o600 and mode_of(state / "known-hosts") == 0o700
    results = api.check_results()
    assert results[succeeded] == {"outcome": "succeeded", "message": None}
    assert results[elsewhere] == {"outcome": "failed", "message": "This launcher does not submit to the site"}
    assert results[unknown_key]["outcome"] == "failed" and "SSH key" in results[unknown_key]["message"]

    # ssh's own words go back, without the token, and no longer than the API keeps.
    refused, not_available = str(uuid4()), str(uuid4())
    logins.refusal = TransportError(
        "SSH connection to the site failed: " + "x" * 3000 + f" mmt@login: Permission denied {LAUNCHER_TOKEN}"
    )
    api.checks = [{"id": refused, "targetId": target_id, "account": account}]
    launcher.run_once()
    message = api.check_results()[refused]["message"]
    assert message.endswith("mmt@login: Permission denied [REDACTED]") and LAUNCHER_TOKEN not in message
    assert len(message) == MAX_CHECK_MESSAGE_CHARACTERS
    logins.refusal = CommandResult(1, b"", b"This account is currently not available.\n")
    api.checks = [{"id": not_available, "targetId": target_id, "account": account}]
    launcher.run_once()
    assert api.check_results()[not_available] == {
        "outcome": "failed",
        "message": "Logged in, but `true` exited with status 1: This account is currently not available.",
    }
    launcher.close()
