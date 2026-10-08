"""Model alias assignment, removal and the append-only alias history."""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError
from .pagination import iterate_listed_items

if TYPE_CHECKING:
    from .client import Client

# Mirrors GET /models/:id/alias-events: limit defaults to 50 and is capped at 200.
ALIAS_EVENT_MAX_PAGE_SIZE = 200


def _alias_path(client: Client, project_id: str, model_id: str, alias: str) -> str:
    return client.project_path(project_id, f"models/{path_id(model_id)}/aliases/{path_id(alias)}")


def set_model_alias(
    client: Client,
    project_id: str,
    model_id: str,
    alias: str,
    *,
    version_id: str,
    reason: str = "",
    evaluation_id: str | None = None,
) -> dict[str, Any]:
    """Point ``alias`` at ``version_id`` and return the Model.

    Re-assigning the same version adds no alias event, so a lost response is safe to resend.
    ``evaluation_id`` names the passed promotion evaluation that justifies changing a protected
    alias; it is sent only when given.
    """
    body: dict[str, Any] = {"versionId": version_id}
    if reason:
        body["reason"] = reason
    if evaluation_id is not None:
        body["promotionEvaluationId"] = evaluation_id
    return client.request("PUT", _alias_path(client, project_id, model_id, alias), json=body, retryable=True)


def delete_model_alias(
    client: Client, project_id: str, model_id: str, alias: str, *, reason: str = ""
) -> None:
    # Not retried: a resent removal of an alias that the first attempt already removed is a 404.
    client.request(
        "DELETE",
        _alias_path(client, project_id, model_id, alias),
        json={"reason": reason} if reason else None,
    )


def list_alias_events(
    client: Client,
    project_id: str,
    model_id: str,
    *,
    alias: str | None = None,
    page_size: int | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield ModelAliasEvents newest first, requesting further pages only as they are used."""
    if page_size is not None and not 1 <= page_size <= ALIAS_EVENT_MAX_PAGE_SIZE:
        raise ConfigurationError(f"page_size must be between 1 and {ALIAS_EVENT_MAX_PAGE_SIZE}")
    path = client.project_path(project_id, f"models/{path_id(model_id)}/alias-events")
    conditions: dict[str, str] = {}
    if alias:
        conditions["alias"] = alias
    if page_size is not None:
        conditions["limit"] = str(page_size)
    return iterate_listed_items(client, path, params=conditions, label="Alias event list")
