"""The launcher's SSH keys: ssh-keygen makes them here, and only their public halves go to the API.

    <state dir>/keys/        0700
      <keyId>                the private key (0600); it never leaves this host
      <keyId>.pub            its public half, as PUT /launcher/keys/:id sends it

Every poll compares the files with the keys GET /launcher/config lists. A listed key without
files is made and published; a key still `requested`, or one whose published half is not the one
on disk, is published again; the files of keys no longer listed (revoked or replaced) are deleted.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path

from ..errors import ApiError, ConfigurationError
from ..security import SecretMasker
from ..worker.contracts import require_uuid
from .file_archive import PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE
from .launcher_assignment import LauncherKey

LOGGER = logging.getLogger(__name__)
KEYS_DIRECTORY = "keys"
PUBLIC_KEY_SUFFIX = ".pub"
# The API takes ed25519 keys only (invalid_public_key otherwise).
KEY_TYPE = "ed25519"
PUBLIC_KEY_LINE = re.compile(r"^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n\x00]*)?$")
# ssh-keygen needs well under a second for an ed25519 key.
KEYGEN_TIMEOUT_SECONDS = 60.0
# The API takes comments of up to 300 characters; the name part keeps well inside that.
MAX_COMMENT_NAME_CHARACTERS = 100
# (keyId, public key line) -> None; raises ApiError when the API refuses it.
KeyPublisher = Callable[[str, str], None]


def key_comment(launcher_name: str, key_id: str) -> str:
    """mmt-launcher:<launcher name>:<keyId>, one word, so the key line keeps its three fields."""
    name = "".join(
        character if character.isprintable() and not character.isspace() else "-"
        for character in launcher_name[:MAX_COMMENT_NAME_CHARACTERS]
    )
    return f"mmt-launcher:{name}:{key_id}"


def key_material(public_key: str) -> str:
    """The key type and blob: a different comment does not make a different key."""
    return " ".join(public_key.split()[:2])


def _key_id_of(file_name: str) -> str | None:
    try:
        return require_uuid(file_name.removesuffix(PUBLIC_KEY_SUFFIX), "keyId")
    except ConfigurationError:
        return None


class LauncherKeys:
    def __init__(self, state_directory: Path, *, masker: SecretMasker):
        self.directory = state_directory / KEYS_DIRECTORY
        self.directory.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
        # An existing directory keeps its mode on mkdir; private keys need it closed.
        os.chmod(self.directory, PRIVATE_DIRECTORY_MODE)
        self.masker = masker

    def private_key(self, key_id: str) -> Path:
        return self.directory / require_uuid(key_id, "keyId")

    def _public_key_file(self, key_id: str) -> Path:
        return self.directory / f"{require_uuid(key_id, 'keyId')}{PUBLIC_KEY_SUFFIX}"

    def public_key(self, key_id: str) -> str | None:
        """The public key line of a complete key on disk; None when either half is missing."""
        if not self.private_key(key_id).is_file():
            return None
        try:
            line = self._public_key_file(key_id).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            return None
        return line if PUBLIC_KEY_LINE.fullmatch(line) else None

    def create(self, key_id: str, *, comment: str) -> str:
        """Make the key with ssh-keygen, replacing an incomplete earlier attempt; returns its public half."""
        private_key = self.private_key(key_id)
        private_key.unlink(missing_ok=True)
        self._public_key_file(key_id).unlink(missing_ok=True)
        # Separate arguments, no shell: the comment carries the launcher's name from the Web.
        argv = ["ssh-keygen", "-q", "-t", KEY_TYPE, "-N", "", "-C", comment, "-f", str(private_key)]
        try:
            completed = subprocess.run(
                argv,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=KEYGEN_TIMEOUT_SECONDS,
                check=False,
            )
        except OSError:
            raise ConfigurationError("ssh-keygen could not be started; the launcher needs OpenSSH") from None
        except subprocess.TimeoutExpired:
            raise ConfigurationError(
                f"ssh-keygen did not finish within {KEYGEN_TIMEOUT_SECONDS:.0f} seconds"
            ) from None
        if completed.returncode:
            detail = self.masker.mask(completed.stderr.decode("utf-8", "replace")).strip()
            raise ConfigurationError(f"ssh-keygen exited with status {completed.returncode}: {detail}")
        os.chmod(private_key, PRIVATE_FILE_MODE)
        public_key = self.public_key(key_id)
        if public_key is None:
            raise ConfigurationError("ssh-keygen wrote no ssh-ed25519 key pair")
        return public_key

    def synchronize(self, keys: Sequence[LauncherKey], *, launcher_name: str, publish: KeyPublisher) -> None:
        """Make and publish what the API lists, then delete the keys it no longer lists."""
        for key in keys:
            try:
                self._synchronize(key, launcher_name=launcher_name, publish=publish)
            except (ConfigurationError, OSError) as error:
                LOGGER.error(
                    "Key %s for site %s could not be made or published: %s",
                    key.id,
                    key.target_id,
                    self.masker.mask(str(error)),
                )
            except ApiError as error:
                # 409 site_key_revoked: the next configuration no longer lists it, and it is deleted.
                LOGGER.warning(
                    "Key %s for site %s was not published: %s",
                    key.id,
                    key.target_id,
                    self.masker.mask(str(error)),
                )
        self.remove_unlisted({key.id for key in keys})

    def _synchronize(self, key: LauncherKey, *, launcher_name: str, publish: KeyPublisher) -> None:
        public_key = self.public_key(key.id)
        if public_key is None:
            public_key = self.create(key.id, comment=key_comment(launcher_name, key.id))
            LOGGER.info("Made key %s for site %s", key.id, key.target_id)
        elif (
            not key.requested
            and key.public_key is not None
            and key_material(key.public_key) == key_material(public_key)
        ):
            return
        publish(key.id, public_key)
        LOGGER.info("Published key %s for site %s", key.id, key.target_id)

    def remove_unlisted(self, live_key_ids: set[str]) -> None:
        for path in self.directory.iterdir():
            key_id = _key_id_of(path.name)
            if key_id is None or key_id in live_key_ids or path.is_dir():
                continue
            path.unlink(missing_ok=True)
            if not path.name.endswith(PUBLIC_KEY_SUFFIX):
                LOGGER.info("Deleted key %s, which the API no longer lists", key_id)
