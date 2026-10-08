"""Project Service Accounts and the Project's API token list (Project admin operations)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

SERVICE_ACCOUNT_ROLES = {"viewer", "editor", "admin"}


def list_service_accounts(client: Client, project_id: str) -> list[dict[str, Any]]:
    return client.list_project_items(project_id, "service-accounts")


def create_service_account(
    client: Client, project_id: str, *, name: str, role: str, description: str = ""
) -> dict[str, Any]:
    """Create a Service Account: an account that belongs to the Project, not to a person."""
    if role not in SERVICE_ACCOUNT_ROLES:
        raise ConfigurationError("role must be viewer, editor or admin")
    # Not retried: a resent create would add a second account.
    return client.request(
        "POST",
        client.project_path(project_id, "service-accounts"),
        json={"name": name, "description": description, "role": role},
    )


def create_service_account_token(
    client: Client,
    project_id: str,
    service_account_id: str,
    *,
    name: str,
    scopes: Sequence[str],
    expires_at: datetime | None = None,
) -> dict[str, Any]:
    """Issue an API token owned by the Service Account and return ``{token, item}``.

    The token value is returned only by this call. Scopes cannot exceed the account's role.
    Without ``expires_at`` the API applies its maximum lifetime (365 days by default).
    """
    if isinstance(scopes, str) or not scopes:
        raise ConfigurationError("scopes must be a non-empty sequence of strings")
    body: dict[str, Any] = {"name": name, "scopes": list(scopes)}
    if expires_at is not None:
        # A naive datetime has no defined instant, so the expiry would depend on the host clock zone.
        if expires_at.tzinfo is None:
            raise ConfigurationError("expires_at must be timezone-aware")
        body["expiresAt"] = expires_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    # Not retried: a lost response would leave an unseen token behind a second one.
    return client.request(
        "POST",
        client.project_path(project_id, f"service-accounts/{path_id(service_account_id)}/tokens"),
        json=body,
    )


def list_project_tokens(client: Client, project_id: str) -> list[dict[str, Any]]:
    """Every personal and Service Account token of the Project, without the token values."""
    return client.list_project_items(project_id, "tokens")
