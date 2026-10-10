"""Typed reading of the JSON documents the API hands a launcher or `mado-tracking submit`.

Fields this package does not read are ignored, so the API may add some; a field it reads with
the wrong type is a ConfigurationError that names the field.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..errors import ConfigurationError
from ..worker.contracts import require_uuid


class DocumentReader:
    def __init__(self, document: Any, *, label: str):
        if not isinstance(document, Mapping):
            raise ConfigurationError(f"{label} must be an object")
        self.document = document
        self.label = label

    def _name(self, key: str) -> str:
        return f"{self.label}.{key}"

    def is_null(self, key: str) -> bool:
        return self.document.get(key) is None

    def text(self, key: str) -> str:
        value = self.document.get(key)
        if not isinstance(value, str):
            raise ConfigurationError(f"{self._name(key)} must be a string")
        return value

    def optional_text(self, key: str) -> str | None:
        return None if self.is_null(key) else self.text(key)

    def uuid(self, key: str) -> str:
        return require_uuid(self.document.get(key), self._name(key))

    def optional_uuid(self, key: str) -> str | None:
        return None if self.is_null(key) else self.uuid(key)

    def integer(self, key: str) -> int:
        value = self.document.get(key)
        if type(value) is not int:
            raise ConfigurationError(f"{self._name(key)} must be an integer")
        return value

    def number(self, key: str) -> float:
        value = self.document.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ConfigurationError(f"{self._name(key)} must be a number")
        return float(value)

    def text_list(self, key: str) -> tuple[str, ...]:
        value = self.document.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ConfigurationError(f"{self._name(key)} must be a list of strings")
        return tuple(value)

    def text_map(self, key: str) -> dict[str, str]:
        value = self.document.get(key)
        if not isinstance(value, Mapping) or not all(
            isinstance(name, str) and isinstance(item, str) for name, item in value.items()
        ):
            raise ConfigurationError(f"{self._name(key)} must be an object of strings")
        return dict(value)

    def child(self, key: str) -> DocumentReader:
        return DocumentReader(self.document.get(key), label=self._name(key))

    def optional_child(self, key: str) -> DocumentReader | None:
        return None if self.is_null(key) else self.child(key)

    def children(self, key: str) -> list[DocumentReader]:
        value = self.document.get(key)
        if not isinstance(value, list):
            raise ConfigurationError(f"{self._name(key)} must be a list")
        return [DocumentReader(item, label=f"{self._name(key)}[{index}]") for index, item in enumerate(value)]
