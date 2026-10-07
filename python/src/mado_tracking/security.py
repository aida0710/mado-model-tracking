"""Mask configured secret values, including values split across output chunks."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

SECRET_NAME = re.compile(r"(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)", re.I)
REDACTED = "[REDACTED]"


def secret_values(environment: Mapping[str, str]) -> list[str]:
    return [value for name, value in environment.items() if value and SECRET_NAME.search(name)]


class SecretMasker:
    def __init__(self, secrets: Iterable[str] = ()):
        self.secrets = tuple(sorted({value for value in secrets if value}, key=len, reverse=True))

    def mask(self, message: str) -> str:
        for value in self.secrets:
            message = message.replace(value, REDACTED)
        return message


class StreamMasker:
    """Retain possible secret prefixes so no partial token is emitted on a chunk boundary."""

    def __init__(self, masker: SecretMasker):
        self.masker = masker
        self.pending = ""

    def feed(self, chunk: str, *, final: bool = False) -> str:
        self.pending += chunk
        if final:
            final_text, self.pending = self.masker.mask(self.pending), ""
            return final_text
        emitted: list[str] = []
        cursor = 0
        maximum_secret_length = max((len(value) for value in self.masker.secrets), default=0)
        while cursor < len(self.pending):
            # A shorter secret can be a prefix of a longer secret that spans two chunks.
            remaining = len(self.pending) - cursor
            if remaining < maximum_secret_length:
                suffix = self.pending[cursor:]
                if any(len(value) > remaining and value.startswith(suffix) for value in self.masker.secrets):
                    break
            match = next(
                (value for value in self.masker.secrets if self.pending.startswith(value, cursor)), None
            )
            if match:
                emitted.append(REDACTED)
                cursor += len(match)
                continue
            emitted.append(self.pending[cursor])
            cursor += 1
        self.pending = self.pending[cursor:]
        return "".join(emitted)
