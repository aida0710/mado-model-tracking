"""The launcher's TOML: how it starts. Its sites, job shells, accounts and keys live on the Web.

    api_url = "https://mmt.example.org"        # the API as the launcher reaches it
    token_file = "/run/secrets/mado-tracking-launcher/launcher.token"   # mode 600
    state_directory = "/var/lib/mado-tracking-launcher"
    poll_seconds = 10
    registry_secret_file = "/run/secrets/mado-tracking-launcher/forge-pull.json"   # optional

token_file holds the token the Web shows once when a global administrator registers the launcher.
The state directory keeps the launcher's private SSH keys and the reports not yet delivered: keep
it across restarts and give every launcher its own. registry_secret_file is JSON
{"username", "password"} (mode 600) that the runners of every site use to pull images into SIFs.
Relative paths start from the directory of the TOML file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError
from ..settings import ApiSettings
from ..toml_tables import TableReader, load_toml
from ..worker.installer import InstallerError, read_token
from .credential_files import read_private_text, read_registry_secrets

DEFAULT_POLL_SECONDS = 10.0
SETTINGS = {"api_url", "token_file", "state_directory", "poll_seconds", "registry_secret_file"}
# What launcher.toml held before sites were set on the Web.
RETIRED_SETTINGS = {"launcher_id", "projects", "sites"}


def _read_token(path: Path) -> str:
    try:
        return read_token(read_private_text(path, label="token_file"))
    except InstallerError:
        raise ConfigurationError(f"token_file {path} must hold the launcher's token alone") from None


@dataclass(frozen=True)
class LauncherConfig:
    api_url: str
    token: str = field(repr=False)
    state_directory: Path
    poll_seconds: float = DEFAULT_POLL_SECONDS
    registry_secret_file: Path | None = None

    def spec_secrets(self) -> dict[str, Any] | None:
        """secrets.json for the runners (the registry login), read for each submission to apply edits."""
        if self.registry_secret_file is None:
            return None
        return read_registry_secrets(self.registry_secret_file, label="registry_secret_file")


def load_launcher_config(path: Path) -> LauncherConfig:
    table = load_toml(path)
    retired = sorted(RETIRED_SETTINGS & set(table))
    if retired:
        raise ConfigurationError(
            f"{path}: {', '.join(retired)} are no longer read. Sites, accounts and keys are set on the "
            "Web; launcher.toml keeps api_url, token_file, state_directory, poll_seconds and "
            "registry_secret_file"
        )
    reader = TableReader(table, label=str(path), allowed=SETTINGS, base_directory=path.resolve().parent)
    api_url = reader.string("api_url")
    token = _read_token(reader.path("token_file"))
    try:
        ApiSettings.from_environment(url=api_url, token=token)
    except ConfigurationError:
        raise ConfigurationError(
            f"{path}: api_url must be an HTTP(S) URL without credentials, query or fragment"
        ) from None
    config = LauncherConfig(
        api_url=api_url,
        token=token,
        state_directory=reader.path("state_directory"),
        poll_seconds=reader.number("poll_seconds", default=DEFAULT_POLL_SECONDS),
        registry_secret_file=reader.optional_path("registry_secret_file"),
    )
    # A broken registry login shows at start, not at the first submission that needs it.
    config.spec_secrets()
    return config
