"""Synchronous and asynchronous HTTP primitives with bounded, selective retries."""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Callable
from typing import Any

import httpx

from .errors import ApiError
from .security import SecretMasker

# Short retries cover temporary API failures without concealing a persistent outage.
DEFAULT_ATTEMPTS = 4
BACKOFF_INITIAL_SECONDS = 0.25
BACKOFF_MAX_SECONDS = 5.0
REQUEST_TIMEOUT_SECONDS = 30.0
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


def retry_delay(attempt: int, response: httpx.Response | None = None) -> float:
    if response is not None:
        try:
            return min(BACKOFF_MAX_SECONDS, max(0.0, float(response.headers["retry-after"])))
        except (KeyError, ValueError):
            pass
    return float(min(BACKOFF_MAX_SECONDS, BACKOFF_INITIAL_SECONDS * 2 ** min(attempt, 10))) * random.uniform(
        0.8, 1.2
    )


def check_response(response: httpx.Response, masker: SecretMasker) -> None:
    if response.is_success:
        return
    try:
        error_body = response.json()
    except ValueError:
        error_body = {}
    message = error_body.get("error") if isinstance(error_body, dict) else None
    code = error_body.get("code") if isinstance(error_body, dict) else None
    raise ApiError(
        masker.mask(str(message or f"API request failed ({response.status_code})")),
        status_code=response.status_code,
        code=str(code) if code else None,
    )


def request_sync(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    masker: SecretMasker,
    retryable: bool = False,
    content_factory: Callable[[], Any] | None = None,
    **options: Any,
) -> httpx.Response:
    attempts = DEFAULT_ATTEMPTS if retryable else 1
    for attempt in range(attempts):
        response = None
        try:
            content = content_factory() if content_factory else options.pop("content", None)
            response = client.request(method, path, content=content, **options)
            if response.status_code not in RETRYABLE_STATUS or attempt == attempts - 1:
                check_response(response, masker)
                return response
        except httpx.TransportError:
            if attempt == attempts - 1:
                raise ApiError(
                    "API connection failed; the operation may not have reached the server"
                ) from None
        time.sleep(retry_delay(attempt, response))
    raise AssertionError("retry attempts exhausted")


async def request_async(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    masker: SecretMasker,
    retryable: bool = False,
    content_factory: Callable[[], Any] | None = None,
    **options: Any,
) -> httpx.Response:
    attempts = DEFAULT_ATTEMPTS if retryable else 1
    for attempt in range(attempts):
        response = None
        try:
            # A streamed body is consumed by one attempt, so retries need a fresh one from the factory.
            content = content_factory() if content_factory else options.pop("content", None)
            response = await client.request(method, path, content=content, **options)
            if response.status_code not in RETRYABLE_STATUS or attempt == attempts - 1:
                check_response(response, masker)
                return response
        except httpx.TransportError:
            if attempt == attempts - 1:
                raise ApiError(
                    "API connection failed; the operation may not have reached the server"
                ) from None
        await asyncio.sleep(retry_delay(attempt, response))
    raise AssertionError("retry attempts exhausted")
