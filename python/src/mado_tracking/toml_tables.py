"""Typed, strict reading of TOML tables for the launcher, `mado-tracking submit` and job templates.

Unknown keys are refused, so a misspelt setting fails at startup instead of being ignored.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .errors import ConfigurationError

_REQUIRED: Any = object()


def load_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as content:
            return tomllib.load(content)
    except OSError as error:
        raise ConfigurationError(f"{path} could not be read: {error.strerror or error}") from None
    except tomllib.TOMLDecodeError as error:
        raise ConfigurationError(f"{path} is not valid TOML: {error}") from None


class TableReader:
    def __init__(self, table: Any, *, label: str, allowed: set[str], base_directory: Path | None = None):
        if not isinstance(table, Mapping):
            raise ConfigurationError(f"{label} must be a table")
        unknown = sorted(set(table) - allowed)
        if unknown:
            raise ConfigurationError(f"{label} has unknown settings: {', '.join(unknown)}")
        self.table = table
        self.label = label
        self.base_directory = base_directory

    def _value(self, key: str, default: Any) -> Any:
        if key in self.table:
            return self.table[key]
        if default is _REQUIRED:
            raise ConfigurationError(f"{self.label} needs {key}")
        return default

    def has(self, key: str) -> bool:
        return key in self.table

    def string(self, key: str, *, default: Any = _REQUIRED) -> str:
        value = self._value(key, default)
        if not isinstance(value, str) or not value or any(character in value for character in "\r\n\x00"):
            raise ConfigurationError(f"{self.label}.{key} must be a non-empty single-line string")
        return value

    def optional_string(self, key: str) -> str | None:
        return self.string(key) if key in self.table else None

    def integer(
        self, key: str, *, default: Any = _REQUIRED, minimum: int = 0, maximum: int | None = None
    ) -> int:
        value = self._value(key, default)
        if type(value) is not int or value < minimum or maximum is not None and value > maximum:
            limit = f"from {minimum}" + (f" to {maximum}" if maximum is not None else "")
            raise ConfigurationError(f"{self.label}.{key} must be an integer {limit}")
        return value

    def number(self, key: str, *, default: Any = _REQUIRED) -> float:
        value = self._value(key, default)
        if isinstance(value, bool) or not isinstance(value, int | float) or value <= 0:
            raise ConfigurationError(f"{self.label}.{key} must be a positive number")
        return float(value)

    def boolean(self, key: str, *, default: Any = _REQUIRED) -> bool:
        value = self._value(key, default)
        if not isinstance(value, bool):
            raise ConfigurationError(f"{self.label}.{key} must be true or false")
        return value

    def string_list(self, key: str, *, default: Any = _REQUIRED) -> tuple[str, ...]:
        value = self._value(key, default)
        if isinstance(value, tuple):
            value = list(value)
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            raise ConfigurationError(f"{self.label}.{key} must be a list of strings")
        return tuple(value)

    def string_table(self, key: str) -> dict[str, str]:
        value = self._value(key, {})
        if not isinstance(value, Mapping) or not all(
            isinstance(name, str) and isinstance(item, str) for name, item in value.items()
        ):
            raise ConfigurationError(f"{self.label}.{key} must be a table of strings")
        return dict(value)

    def table_value(self, key: str, *, default: Any = _REQUIRED) -> Any:
        return self._value(key, default)

    def path(self, key: str, *, default: Any = _REQUIRED) -> Path:
        """A local path; `~` is expanded and a relative path is read from the file's directory."""
        if key not in self.table and default is not _REQUIRED:
            return Path(default)
        path = Path(self.string(key)).expanduser()
        if not path.is_absolute() and self.base_directory is not None:
            path = self.base_directory / path
        return path

    def optional_path(self, key: str) -> Path | None:
        return self.path(key) if key in self.table else None
