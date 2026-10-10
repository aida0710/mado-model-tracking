"""Where the launcher logs in for one site and account: an SshEndpoint and the files it names.

    <state dir>/known-hosts/<targetId>   the site's known_hosts from the Web (0600)

The account's key is <state dir>/keys/<keyId> (launcher_keys.py). Host keys come only from the
site's settings, so a host whose key the Web does not list is never accepted.
"""

from __future__ import annotations

from pathlib import Path

from ..errors import ConfigurationError
from ..worker.contracts import require_uuid
from ..worker.installer import write_private_file
from .file_archive import PRIVATE_DIRECTORY_MODE
from .launcher_keys import LauncherKeys
from .site_settings import SiteConnection, SubmissionAccount
from .transport import SshEndpoint

KNOWN_HOSTS_DIRECTORY = "known-hosts"


class SiteLogins:
    def __init__(self, state_directory: Path, keys: LauncherKeys):
        self.directory = state_directory / KNOWN_HOSTS_DIRECTORY
        self.directory.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
        self.keys = keys

    def endpoint(
        self, target_id: str, connection: SiteConnection | None, account: SubmissionAccount
    ) -> SshEndpoint:
        if connection is None:
            raise ConfigurationError("The site has no connection settings on the Web")
        if not account.account_name:
            raise ConfigurationError("The account to log in as is not known")
        if account.key_id is None:
            raise ConfigurationError("No launcher key is named for the account")
        return SshEndpoint(
            host=connection.host,
            port=connection.port,
            user=account.account_name,
            identity_file=self.keys.private_key(account.key_id),
            known_hosts=self.known_hosts(target_id, connection.known_hosts),
            jump_hosts=connection.jump_hosts,
        )

    def known_hosts(self, target_id: str, content: str) -> Path:
        """The site's known_hosts file, rewritten only when the Web's lines changed."""
        if not content.strip():
            raise ConfigurationError(
                "The site's known_hosts is empty; list the host keys of the site and of its jump hosts "
                "on the Web"
            )
        path = self.directory / require_uuid(target_id, "targetId")
        text = content if content.endswith("\n") else content + "\n"
        try:
            unchanged = path.read_text(encoding="utf-8") == text
        except (OSError, UnicodeDecodeError):
            unchanged = False
        if not unchanged:
            write_private_file(path, text)
        return path
