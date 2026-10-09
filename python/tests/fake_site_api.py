"""Localhost fake of the API a site runner talks to: the runner protocol, Artifacts and dataset files.

It speaks real HTTP, so both the runner's httpx client and its urllib dataset downloads reach it.
Every call is recorded in order, which lets tests check the protocol sequence.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

JOB_TOKEN = "mmtj_site-runner-test-token"
RUNNER_ROUTE = re.compile(r"^/api/projects/[^/]+/jobs/(?P<job>[^/]+)/runner/(?P<action>[a-z]+)$")
CONTENT_ROUTE = re.compile(r"^/api/projects/[^/]+/artifacts/(?P<artifact>[^/]+)/content$")
FILES_ROUTE = re.compile(r"^/api/projects/[^/]+/datasets/[^/]+/versions/(?P<version>[^/]+)/files$")
UPLOAD_ROUTE = re.compile(r"^/api/projects/[^/]+/runs/[^/]+/artifacts$")


class SiteApi:
    def __init__(self, *, token: str = JOB_TOKEN):
        self.token = token
        self.lock = threading.Lock()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.artifacts: dict[str, bytes] = {}
        self.dataset_files: dict[str, list[dict[str, Any]]] = {}
        self.downloads: Counter[str] = Counter()
        self.uploads: list[tuple[str, bytes]] = []
        self.log_lines: list[tuple[str, str]] = []
        self.log_seen: dict[str, threading.Event] = {}
        # Behaviour switches the tests flip.
        self.cancel_requested = False
        self.cancel_after_log: str | None = None
        self.heartbeat_status_after_log: tuple[str, int] | None = None
        self.heartbeat_rejection: int | None = None
        self.start_status = 200
        self.start_cancel_requested = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_arguments: Any) -> None:
                pass

            def do_GET(self) -> None:
                fixture.handle(self)

            def do_POST(self) -> None:
                fixture.handle(self)

            def do_PUT(self) -> None:
                fixture.handle(self)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self) -> SiteApi:
        self.thread.start()
        return self

    def __exit__(self, *_exception: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    # Fixture content ---------------------------------------------------------------------------

    def add_artifact(self, content: bytes) -> str:
        artifact_id = str(uuid4())
        self.artifacts[artifact_id] = content
        return artifact_id

    def actions(self) -> list[str]:
        return [action for action, _body in self.calls]

    def bodies(self, action: str) -> list[dict[str, Any]]:
        return [body for name, body in self.calls if name == action]

    def messages(self) -> str:
        return "\n".join(message for _level, message in self.log_lines)

    def wait_for_log(self, text: str, timeout: float = 20.0) -> bool:
        with self.lock:
            if any(text in message for _level, message in self.log_lines):
                return True
            event = self.log_seen.setdefault(text, threading.Event())
        return event.wait(timeout)

    # HTTP --------------------------------------------------------------------------------------

    def handle(self, request: BaseHTTPRequestHandler) -> None:
        if request.headers.get("Authorization") != f"Bearer {self.token}":
            self.send_json(request, 401, {"error": "authentication required"})
            return
        location = urlsplit(request.path)
        raw = self.read_body(request)
        if match := RUNNER_ROUTE.match(location.path):
            self.runner(request, match.group("action"), json.loads(raw or b"{}"))
        elif match := CONTENT_ROUTE.match(location.path):
            artifact_id = match.group("artifact")
            content = self.artifacts.get(artifact_id)
            if content is None:
                self.send_json(request, 404, {"error": "no such artifact"})
                return
            with self.lock:
                self.downloads[artifact_id] += 1
            request.send_response(200)
            request.send_header("Content-Length", str(len(content)))
            request.send_header("ETag", f'"sha256-{hashlib.sha256(content).hexdigest()}"')
            request.end_headers()
            request.wfile.write(content)
        elif match := FILES_ROUTE.match(location.path):
            self.send_json(
                request, 200, {"items": self.dataset_files[match.group("version")], "nextCursor": None}
            )
        elif UPLOAD_ROUTE.match(location.path) and request.command == "PUT":
            path = parse_qs(location.query)["path"][0]
            with self.lock:
                self.calls.append(("upload", {"path": path}))
                self.uploads.append((path, raw))
            self.send_json(
                request,
                200,
                {
                    "id": str(uuid4()),
                    "path": path,
                    "size": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                },
            )
        else:
            self.send_json(request, 404, {"error": "route not implemented in the site fixture"})

    def runner(self, request: BaseHTTPRequestHandler, action: str, body: dict[str, Any]) -> None:
        with self.lock:
            self.calls.append((action, body))
            if action == "logs":
                for entry in body["entries"]:
                    self.log_lines.append((entry["level"], entry["message"]))
                    for text, event in self.log_seen.items():
                        if text in entry["message"]:
                            event.set()
                    if self.cancel_after_log and self.cancel_after_log in entry["message"]:
                        self.cancel_requested = True
                    if (
                        self.heartbeat_status_after_log
                        and self.heartbeat_status_after_log[0] in entry["message"]
                    ):
                        self.heartbeat_rejection = self.heartbeat_status_after_log[1]
            rejection = self.heartbeat_rejection
        if action == "start":
            if self.start_status != 200:
                self.send_json(
                    request, self.start_status, {"error": "job not startable", "code": "job_not_startable"}
                )
                return
            self.send_json(
                request, 200, {"job": {"id": "job"}, "cancelRequested": self.start_cancel_requested}
            )
        elif action == "heartbeat":
            if rejection is not None:
                self.send_json(request, rejection, {"error": "job ended", "code": "job_ended"})
                return
            self.send_json(request, 200, {"job": {"id": "job"}, "cancelRequested": self.cancel_requested})
        elif action == "outputs":
            items = [
                {
                    "index": declaration["index"],
                    "kind": declaration["kind"],
                    "modelVersionId": None,
                    "datasetVersionId": str(uuid4()),
                    "createdAt": "2026-10-09T00:00:00Z",
                }
                for declaration in body["declarations"]
            ]
            self.send_json(request, 200, {"items": items})
        elif action == "finish":
            self.send_json(request, 200, {"job": {"id": "job", "status": body["status"]}, "retryJobId": None})
        else:
            request.send_response(204)
            request.send_header("Content-Length", "0")
            request.end_headers()

    @staticmethod
    def read_body(request: BaseHTTPRequestHandler) -> bytes:
        if request.headers.get("Transfer-Encoding") == "chunked":
            content = bytearray()
            while True:
                size = int(request.rfile.readline().split(b";", 1)[0], 16)
                if size == 0:
                    request.rfile.readline()
                    return bytes(content)
                content.extend(request.rfile.read(size))
                request.rfile.read(2)
        return request.rfile.read(int(request.headers.get("Content-Length", "0")))

    @staticmethod
    def send_json(request: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
        content = json.dumps(body).encode()
        request.send_response(status)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(content)))
        request.end_headers()
        request.wfile.write(content)
