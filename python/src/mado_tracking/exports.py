"""Run comparison and CSV exports (search results and comparison tables) saved as files."""

from __future__ import annotations

import os
import time
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO

import httpx

from .atomic_files import atomic_output
from .errors import ApiError, ConfigurationError
from .http import DEFAULT_ATTEMPTS, RETRYABLE_STATUS, check_response, retry_delay
from .run_search_request import build_run_search_body

if TYPE_CHECKING:
    from .client import Client

# Mirror POST /runs/compare: 2 to 50 distinct Runs and at most 200 metric keys.
COMPARE_MIN_RUNS = 2
COMPARE_MAX_RUNS = 50
COMPARE_MAX_METRIC_KEYS = 200
INTERRUPTIONS = (httpx.TransportError, httpx.StreamError)


def _validated_run_ids(run_ids: Sequence[str]) -> list[str]:
    if isinstance(run_ids, str):
        raise ConfigurationError("run_ids must be a sequence of strings")
    if not COMPARE_MIN_RUNS <= len(run_ids) <= COMPARE_MAX_RUNS or len(set(run_ids)) != len(run_ids):
        raise ConfigurationError(f"run_ids needs {COMPARE_MIN_RUNS} to {COMPARE_MAX_RUNS} distinct Run IDs")
    return list(run_ids)


def compare_runs(
    client: Client,
    project_id: str,
    run_ids: Sequence[str],
    *,
    baseline_run_id: str | None = None,
    metric_keys: Sequence[str] | None = None,
    include_history: bool = False,
) -> dict[str, Any]:
    """Return the RunComparison: one row per parameter / metric / tag with a value per Run.

    Rows carry the difference from ``baseline_run_id`` when it is given. Runs keep the given order.
    """
    body: dict[str, Any] = {"runIds": _validated_run_ids(run_ids)}
    if baseline_run_id is not None:
        if baseline_run_id not in run_ids:
            raise ConfigurationError("baseline_run_id must be one of run_ids")
        body["baselineRunId"] = baseline_run_id
    if metric_keys is not None:
        if isinstance(metric_keys, str) or len(metric_keys) > COMPARE_MAX_METRIC_KEYS:
            raise ConfigurationError(f"metric_keys must be a sequence of at most {COMPARE_MAX_METRIC_KEYS}")
        body["metricKeys"] = list(metric_keys)
    if include_history:
        body["includeHistory"] = True
    # Comparing only reads, so a lost response is retried without side effects.
    return client.request("POST", client.project_path(project_id, "runs/compare"), json=body, retryable=True)


def export_runs_csv(
    client: Client, project_id: str, destination: str | os.PathLike[str], **search: Any
) -> Path:
    """Save every Run matching the search as CSV (one Run per row) and return the file path.

    ``search`` takes the conditions of ``Client.search_runs`` (``filter``, ``order_by``,
    ``experiment_ids``, ``kinds``, ``statuses``, ...). The body is streamed to disk, and the file
    appears only after the whole export arrived. The API stops at its row limit (50000 by default)
    and marks the cut at the end of the CSV.
    """
    return _save_csv(
        client,
        destination,
        method="POST",
        path=client.project_path(project_id, "runs/search/export.csv"),
        json=build_run_search_body(**search),
    )


def export_comparison_csv(
    client: Client,
    project_id: str,
    destination: str | os.PathLike[str],
    *,
    run_ids: Sequence[str],
    baseline_run_id: str | None = None,
) -> Path:
    """Save the comparison table (row key × Run column) as CSV and return the file path."""
    params = {"runIds": ",".join(_validated_run_ids(run_ids))}
    if baseline_run_id is not None:
        params["baselineRunId"] = baseline_run_id
    return _save_csv(
        client,
        destination,
        method="GET",
        path=client.project_path(project_id, "runs/compare.csv"),
        params=params,
    )


def _save_csv(
    client: Client, destination: str | os.PathLike[str], *, method: str, path: str, **options: Any
) -> Path:
    target = Path(destination)
    with atomic_output(target) as output:
        _stream_with_retries(client, output, method=method, path=path, **options)
    return target


def _stream_with_retries(client: Client, output: BinaryIO, *, method: str, path: str, **options: Any) -> None:
    """Write a response body to ``output``; an interrupted or refused attempt starts over.

    Both exports only read, so repeating them is safe. The bytes are written as received: the
    CSV keeps its UTF-8 BOM and line endings.
    """
    for attempt in range(DEFAULT_ATTEMPTS):
        last_attempt = attempt == DEFAULT_ATTEMPTS - 1
        output.seek(0)
        output.truncate()
        try:
            with client.http.stream(method, path.lstrip("/"), **options) as response:
                if response.status_code in RETRYABLE_STATUS and not last_attempt:
                    response.read()
                    time.sleep(retry_delay(attempt, response))
                    continue
                if not response.is_success:
                    response.read()
                    check_response(response, client.masker)
                for chunk in response.iter_bytes():
                    output.write(chunk)
            return
        except INTERRUPTIONS:
            if last_attempt:
                raise ApiError("CSV export kept failing; no file was written") from None
        time.sleep(retry_delay(attempt))
