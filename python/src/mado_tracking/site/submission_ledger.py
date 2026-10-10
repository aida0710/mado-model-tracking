"""Which account queued which Job: the launcher's own record of what it submitted.

    <state dir>/submissions/<jobId>.json
        {"targetId", "accountName", "keyId", "schedulerJobId", "submittedAt"}

A cancellation from the API names the account its cancel command runs as. When the record names
another one (the person changed their account on the Web since), the scheduler may refuse the
cancel, and the launcher says why. Entries outlive any scheduler queue (30 days at most,
queueTimeoutSeconds' limit) and are pruned after.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from pathlib import Path

from ..worker.contracts import require_uuid
from ..worker.host_state import read_json, write_json
from .site_settings import SubmissionAccount

# A Job waits in a scheduler queue for at most MAX queueTimeoutSeconds (30 days).
LEDGER_RETENTION_SECONDS = 31 * 24 * 3600


class SubmissionLedger:
    def __init__(self, directory: Path):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory = directory

    def _path(self, job_id: str) -> Path:
        return self.directory / f"{require_uuid(job_id, 'jobId')}.json"

    def record(
        self,
        job_ids: Sequence[str],
        *,
        target_id: str,
        account: SubmissionAccount,
        scheduler_job_id: str,
    ) -> None:
        for job_id in job_ids:
            write_json(
                self._path(job_id),
                {
                    "targetId": target_id,
                    "accountName": account.account_name,
                    "keyId": account.key_id,
                    "schedulerJobId": scheduler_job_id,
                    "submittedAt": time.time(),
                },
            )

    def account_name_for(self, job_id: str) -> str | None:
        """The account the Job was queued as; None when this launcher kept no record of it."""
        try:
            account_name = read_json(self._path(job_id)).get("accountName")
        except (OSError, ValueError):
            return None
        return account_name if isinstance(account_name, str) else None

    def forget(self, job_id: str) -> None:
        self._path(job_id).unlink(missing_ok=True)

    def prune(self, *, now: float | None = None) -> None:
        cutoff = (now if now is not None else time.time()) - LEDGER_RETENTION_SECONDS
        for path in self.directory.glob("*.json"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
            except OSError:
                continue
