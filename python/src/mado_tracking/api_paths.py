"""Path segments of the public /api contract."""

from __future__ import annotations

from urllib.parse import quote

from .errors import ConfigurationError


def path_id(identifier: str) -> str:
    """Quote an entity ID as one path segment, so an ID can never add path levels."""
    if not identifier:
        raise ConfigurationError("An entity ID is required")
    return quote(identifier, safe="")
