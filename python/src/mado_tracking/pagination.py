"""Follow `{items, nextCursor}` pages until the API stops returning a cursor."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from typing import TYPE_CHECKING, Any

from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

PageFetcher = Callable[[str | None], dict[str, Any]]


def iterate_cursor_pages(fetch_page: PageFetcher, *, label: str) -> Iterator[dict[str, Any]]:
    """Yield every item, requesting the next page only when the previous one is used up.

    ``fetch_page`` receives None for the first page and the previous ``nextCursor`` afterwards.
    A missing or null ``nextCursor`` ends the walk, which also covers APIs that predate paging.
    A repeated cursor would loop forever, so it stops the walk with an error.
    """
    cursor: str | None = None
    visited_cursors: set[str] = set()
    while True:
        page = fetch_page(cursor)
        items = page.get("items")
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise ConfigurationError(f"{label} response must contain items")
        yield from items
        next_cursor = page.get("nextCursor")
        if next_cursor is None:
            return
        if not isinstance(next_cursor, str) or not next_cursor:
            raise ConfigurationError(f"{label} returned an invalid pagination cursor")
        if next_cursor in visited_cursors:
            raise ConfigurationError(f"{label} returned a repeating pagination cursor")
        visited_cursors.add(next_cursor)
        cursor = next_cursor


def iterate_listed_items(
    client: Client, path: str, *, params: Mapping[str, str], label: str
) -> Iterator[dict[str, Any]]:
    """Walk a GET list whose next page is requested with ``?cursor=`` and the same conditions."""

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        page_params = {**params, "cursor": cursor} if cursor else dict(params)
        # Listing only reads, so a lost response is retried without side effects.
        return client.request("GET", path, params=page_params, retryable=True)

    return iterate_cursor_pages(fetch_page, label=label)
