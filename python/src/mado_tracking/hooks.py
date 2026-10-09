"""Start a manual hook (trigger 'manual'): its payload reaches the Job as trigger-payload.json."""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError

if TYPE_CHECKING:
    from .client import Client

# Mirrors HOOK_PAYLOAD_MAX_BYTES.
HOOK_PAYLOAD_MAX_BYTES = 256 * 1024


def trigger_hook(
    client: Client,
    project_id: str,
    hook_id: str,
    payload: Mapping[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Start the hook once; returns the HookExecution (queued, or skipped with its reason).

    The idempotency key makes a resend find the first start; without one a random key is used,
    so a retry after a lost answer still starts only one Job.
    """
    body: dict[str, Any] = {"idempotencyKey": idempotency_key or str(uuid.uuid4())}
    if payload is not None:
        if len(json.dumps(dict(payload), allow_nan=False).encode()) > HOOK_PAYLOAD_MAX_BYTES:
            raise ConfigurationError(f"A hook payload is at most {HOOK_PAYLOAD_MAX_BYTES} bytes of JSON")
        body["payload"] = dict(payload)
    return client.request(
        "POST",
        client.project_path(project_id, f"hooks/{path_id(hook_id)}/trigger"),
        json=body,
        retryable=True,
    )
