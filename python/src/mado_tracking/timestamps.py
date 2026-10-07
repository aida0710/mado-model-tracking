"""UTC timestamps shared by SDK and runner protocol payloads."""

from datetime import UTC, datetime


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
