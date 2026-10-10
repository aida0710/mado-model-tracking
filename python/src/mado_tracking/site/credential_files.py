"""Files that hold credentials for a launcher or `mado-tracking submit`.

A file that its group or others can read is refused: what it holds may already have leaked.

    token_file             the launcher's API token (launcher.toml)
    registry_secret_file   JSON {"username", "password"}: the registry login runners pull images
                           into SIFs with (launcher.toml, or `mado-tracking submit
                           --registry-secret-file`); it reaches the runner as secrets.json
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError

SHARED_PERMISSION_BITS = 0o077


def read_private_text(path: Path, *, label: str) -> str:
    """The file's text; `label` names the setting that gave the path, for the error."""
    try:
        if os.stat(path).st_mode & SHARED_PERMISSION_BITS:
            raise ConfigurationError(f"{label} {path} must not be readable by group or others")
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigurationError(f"{label} {path} could not be read: {error.strerror}") from None


def read_registry_secrets(path: Path, *, label: str) -> dict[str, Any]:
    """The secrets.json document for the runners: {"registry": {"username", "password"}}."""
    text = read_private_text(path, label=label)
    try:
        registry = json.loads(text)
    except ValueError:
        registry = None
    if (
        not isinstance(registry, dict)
        or not isinstance(registry.get("username"), str)
        or not isinstance(registry.get("password"), str)
    ):
        raise ConfigurationError(f"{label} {path} must be JSON with username and password")
    return {"registry": {"username": registry["username"], "password": registry["password"]}}
