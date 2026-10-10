"""Logins that failed lately, so that the launcher does not keep failing them; this process only.

A site may lock an account or an address after repeated failed logins. Until a key is in the
account's authorized_keys (just after a launcher or a key changed, say), every submission and
every cancel would otherwise log in and fail again, up to hundreds of times a poll. A login is one
SshEndpoint (site, account, key). The launcher stops trying a failed login for the rest of the
poll's submissions, and for a while for cancels; a login that works again (a submission, a cancel
or a connection check) is forgotten. The cancels a failed login holds back are told why once,
not at every poll, until the login works again.
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
        # Failed logins whose waiting cancels have been told why, since the login last worked.
        self.cancels_told: set[SshEndpoint] = set()

    def start_poll(self) -> None:
        self.poll += 1

    def record(self, endpoint: SshEndpoint, reason: str, *, cancels_told: bool = False) -> None:
        """`cancels_told`: the caller has already said that cancels through the login wait."""
        self.failures[endpoint] = LoginFailure(reason=reason, at=self.clock(), poll=self.poll)
        if cancels_told:
            self.cancels_told.add(endpoint)

    def forget(self, endpoint: SshEndpoint) -> None:
        self.failures.pop(endpoint, None)
        self.cancels_told.discard(endpoint)

    def in_this_poll(self, endpoint: SshEndpoint) -> LoginFailure | None:
        failure = self.failures.get(endpoint)
        return failure if failure is not None and failure.poll == self.poll else None

    def recent(self, endpoint: SshEndpoint, seconds: float) -> LoginFailure | None:
        """The login's failure, if it was less than `seconds` ago."""
        failure = self.failures.get(endpoint)
        return failure if failure is not None and self.since(failure) < seconds else None

    def since(self, failure: LoginFailure) -> float:
        return self.clock() - failure.at

    def tell_cancels_once(self, endpoint: SshEndpoint) -> bool:
        """True the first time cancels wait for the failed login: the caller says why, once."""
        if endpoint in self.cancels_told:
            return False
        self.cancels_told.add(endpoint)
        return True
