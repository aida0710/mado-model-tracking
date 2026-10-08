"""Build the RunSearchRequest body shared by Run search and the search result CSV export."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .errors import ConfigurationError


def build_run_search_body(
    *,
    filter: str | None = None,
    order_by: Sequence[str] = (),
    experiment_ids: Sequence[str] = (),
    kinds: Sequence[str] = (),
    statuses: Sequence[str] = (),
    model_version_ids: Sequence[str] = (),
    input_dataset_version_ids: Sequence[str] = (),
    parent_run_id: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Map SDK keyword arguments to API field names, leaving out conditions that are not set.

    ``filter`` and ``order_by`` use MLflow search syntax. An empty list does not narrow the search
    on the API either, so omitting it keeps the request the same.
    """
    list_conditions = {
        "orderBy": order_by,
        "experimentIds": experiment_ids,
        "kinds": kinds,
        "statuses": statuses,
        "modelVersionIds": model_version_ids,
        "inputDatasetVersionIds": input_dataset_version_ids,
    }
    # A bare string is a Sequence too; iterating it would send one condition per character.
    if any(isinstance(values, str) for values in list_conditions.values()):
        raise ConfigurationError(
            "order_by, experiment_ids, kinds, statuses, model_version_ids and "
            "input_dataset_version_ids must be sequences of strings"
        )
    body: dict[str, Any] = {key: list(values) for key, values in list_conditions.items() if values}
    if filter:
        body["filter"] = filter
    if parent_run_id:
        body["parentRunId"] = parent_run_id
    if name:
        body["name"] = name
    return body
