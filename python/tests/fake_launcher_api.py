"""The launcher's side of the API in memory, a fake ssh-keygen, and logins that run locally.

The fake ssh-keygen writes a key pair the way OpenSSH does (private 0600, public 0644, never over
an existing file) and records its argv. LocalLogins is the launcher's transport factory in
tests: each "login" runs its commands on this machine and remembers the endpoint (account, key,
known_hosts) the launcher would have logged in to.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from mado_tracking.client import Client
from mado_tracking.security import SecretMasker
from mado_tracking.site.transport import CommandResult, LocalSiteTransport, SshEndpoint

LAUNCHER_TOKEN = "mmt_launcher-test-token"
LAUNCHER_NAME = "gpu-launcher"
KEYGEN_LOG = "ssh-keygen.jsonl"
FAKE_SSH_KEYGEN = r"""
import base64, json, os, sys
from pathlib import Path
arguments = sys.argv[1:]
with (Path(__file__).resolve().parent / "ssh-keygen.jsonl").open("a") as log:
    log.write(json.dumps(arguments) + "\n")
options, index = {}, 0
while index < len(arguments):
    if arguments[index] == "-q":
        index += 1
        continue
    options[arguments[index]] = arguments[index + 1]
    index += 2
private = Path(options["-f"])
public = Path(str(private) + ".pub")
if private.exists() or public.exists():
    print(f"{private} already exists.", file=sys.stderr)
    sys.exit(1)
blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + os.urandom(32)
descriptor = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w") as output:
    output.write("fake private key written by the fake ssh-keygen\n")
public.write_text(f"ssh-ed25519 {base64.b64encode(blob).decode()} {options['-C']}\n")
public.chmod(0o644)
"""


def install_fake_ssh_keygen(tmp_path: Path, monkeypatch: Any) -> Path:
    directory = tmp_path / "bin"
    directory.mkdir(exist_ok=True)
    executable = directory / "ssh-keygen"
    executable.write_text(f"#!{sys.executable}\n" + FAKE_SSH_KEYGEN)
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", f"{directory}:{os.environ.get('PATH', '')}")
    return directory


def recorded_keygen_calls(directory: Path) -> list[list[str]]:
    log = directory / KEYGEN_LOG
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


class FakeLauncherApi:
    """GET /launcher/config and the /launcher endpoints, answered from what a test puts in."""

    def __init__(self, *, launcher_name: str = LAUNCHER_NAME):
        self.launcher = {"id": str(uuid4()), "name": launcher_name}
        self.sites: list[dict[str, Any]] = []
        self.keys: list[dict[str, Any]] = []
        self.checks: list[dict[str, Any]] = []
        self.submissions: list[dict[str, Any]] = []
        self.cancellations: list[dict[str, Any]] = []
        self.report_statuses: list[int] = []
        # Keys revoked after the configuration listed them: publishing one is refused.
        self.revoked: set[str] = set()
        self.calls: list[tuple[str, str, Any]] = []

    def assign_site(self, target: dict[str, Any], settings: dict[str, Any]) -> None:
        self.sites.append({"target": target, "settings": settings, "jobShell": None})

    def add_key(
        self,
        target_id: str,
        *,
        user_id: str | None = None,
        status: str = "requested",
        public_key: str | None = None,
    ) -> str:
        key_id = str(uuid4())
        self.keys.append(
            {
                "id": key_id,
                "targetId": target_id,
                "userId": user_id,
                "status": status,
                "publicKey": public_key,
            }
        )
        return key_id

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {LAUNCHER_TOKEN}"
        path = request.url.path.removeprefix("/api/")
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if (request.method, path) == ("GET", "launcher/config"):
            return httpx.Response(
                200,
                json={
                    "launcher": self.launcher,
                    "sites": self.sites,
                    "keys": self.keys,
                    "checks": self.checks,
                },
            )
        if request.method == "PUT" and path.startswith("launcher/keys/"):
            return self.publish(path.removeprefix("launcher/keys/"), body["publicKey"])
        if request.method == "POST" and path.startswith("launcher/connection-checks/"):
            check_id = path.removeprefix("launcher/connection-checks/")
            self.checks = [check for check in self.checks if check["id"] != check_id]
            return httpx.Response(204)
        if path == "launcher/site-submissions/claim":
            wanted = set(body["targetIds"])
            taken = [item for item in self.submissions if item["target"]["id"] in wanted][: body["limit"]]
            self.submissions = [item for item in self.submissions if item not in taken]
            return httpx.Response(200, json={"items": taken})
        if path == "launcher/site-submissions/report":
            status = self.report_statuses.pop(0) if self.report_statuses else 200
            if status != 200:
                return httpx.Response(status, json={"error": "try again"})
            return httpx.Response(200, json={"items": []})
        if path == "launcher/site-submissions/cancellations":
            items, self.cancellations = self.cancellations, []
            return httpx.Response(200, json={"items": items})
        if path == "launcher/site-submissions/cancellations/report":
            return httpx.Response(204)
        return httpx.Response(404, json={"error": "unknown route"})

    def publish(self, key_id: str, public_key: str) -> httpx.Response:
        key = next((key for key in self.keys if key["id"] == key_id), None)
        if key is None or key_id in self.revoked:
            return httpx.Response(409, json={"error": "the key was revoked", "code": "site_key_revoked"})
        key.update(status="ready", publicKey=public_key)
        return httpx.Response(200, json=key)

    def bodies(self, method: str, path: str) -> list[Any]:
        return [body for called, route, body in self.calls if (called, route) == (method, path)]

    def reports(self) -> list[dict[str, Any]]:
        return [
            result
            for body in self.bodies("POST", "launcher/site-submissions/report")
            for result in body["results"]
        ]

    def published(self) -> list[tuple[str, str]]:
        return [
            (route.removeprefix("launcher/keys/"), body["publicKey"])
            for method, route, body in self.calls
            if method == "PUT" and route.startswith("launcher/keys/")
        ]

    def check_results(self) -> dict[str, Any]:
        return {
            route.removeprefix("launcher/connection-checks/"): body
            for method, route, body in self.calls
            if method == "POST" and route.startswith("launcher/connection-checks/")
        }

    def client(self, **options: Any) -> Client:
        return Client(transport=httpx.MockTransport(self.serve), **options)


class LocalLogin(LocalSiteTransport):
    """A launcher's site commands, run on this machine as if it had logged in to the endpoint."""

    def __init__(
        self,
        endpoint: SshEndpoint,
        *,
        shared_connection: bool,
        refusal: Exception | CommandResult | None = None,
    ):
        super().__init__(masker=SecretMasker())
        # What SshSiteTransport checks before it connects: the key and known_hosts files.
        endpoint.check_files()
        self.endpoint = endpoint
        self.shared_connection = shared_connection
        self.refusal = refusal
        self.commands: list[list[str]] = []
        self.closed = False

    def run(self, argv: Any, *, stdin: bytes = b"", timeout: float = 600.0) -> CommandResult:
        self.commands.append(list(argv))
        if isinstance(self.refusal, Exception):
            raise self.refusal
        if self.refusal is not None:
            return self.refusal
        return super().run(argv, stdin=stdin, timeout=timeout)

    def close(self) -> None:
        self.closed = True


class LocalLogins:
    """The launcher's transport factory in tests; set `refusal` to make the next logins fail.

    `refusals` names the refusal of the next logins as one account, over `refusal`.
    """

    def __init__(self) -> None:
        self.made: list[LocalLogin] = []
        self.refusal: Exception | CommandResult | None = None
        self.refusals: dict[str, Exception | CommandResult] = {}

    def __call__(self, endpoint: SshEndpoint, *, shared_connection: bool) -> LocalLogin:
        refusal = self.refusals.get(endpoint.user, self.refusal)
        login = LocalLogin(endpoint, shared_connection=shared_connection, refusal=refusal)
        self.made.append(login)
        return login

    def shared(self) -> list[LocalLogin]:
        return [login for login in self.made if login.shared_connection]
