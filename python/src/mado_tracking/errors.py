"""Errors carry sanitized diagnostics, never HTTP request credentials."""


class ConfigurationError(ValueError):
    """Required SDK / worker configuration is missing or unsafe."""


class ApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class LeaseRejected(ApiError):
    """The API refused ownership; starting or mutating a job is forbidden."""


class TransportError(RuntimeError):
    """A transport operation failed; an existing remote process may still be alive."""
