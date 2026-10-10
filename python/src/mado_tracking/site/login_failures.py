"""Logins that failed lately, so that the launcher does not keep failing them; this process only.

A site may lock an account or an address after repeated failed logins. Until a key is in the
account's authorized_keys (just after a launcher or a key changed, say), every submission and
every cancel would otherwise log in and fail again, up to hundreds of times a poll. A login is one
SshEndpoint (site, account, key). The launcher stops trying a failed login for the rest of the
poll's submissions, and for a while for cancels; a login that works again is forgotten.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .transport import SshEndpoint


@dataclass(frozen=True)
class LoginFailure:
    # What ssh said, masked: it becomes the error of the submissions not tried after it.
    reason: str
    at: float
    poll: int


class LoginFailures:
    def __init__(self, *, clock: Callable[[], float]):
        self.clock = clock
        self.poll = 0
        self.failures: dict[SshEndpoint, LoginFailure] = {}

    def start_poll(self) -> None:
        self.poll += 1

    def record(self, endpoint: SshEndpoint, reason: str) -> None:
        self.failures[endpoint] = LoginFailure(reason=reason, at=self.clock(), poll=self.poll)

    def forget(self, endpoint: SshEndpoint) -> None:
        self.failures.pop(endpoint, None)

    def in_this_poll(self, endpoint: SshEndpoint) -> LoginFailure | None:
        failure = self.failures.get(endpoint)
        return failure if failure is not None and failure.poll == self.poll else None

    def within(self, endpoint: SshEndpoint, seconds: float) -> bool:
        """The login failed less than `seconds` ago."""
        failure = self.failures.get(endpoint)
        return failure is not None and self.clock() - failure.at < seconds
