"""In-memory localhost HTTP API for SDK/streaming/example integration tests."""

from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4


class TrackingServer:
    def __init__(self):
        self.runs: dict[str, dict] = {}
        self.models: dict[str, dict] = {}
        self.datasets: dict[str, dict] = {}
        self.artifacts: dict[str, bytes] = {}
        self.metrics: list[dict] = []
        self.model_versions: list[dict] = []
        self.dataset_versions: list[dict] = []
        self.operations: list[tuple[str, str]] = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_arguments):
                pass

            def do_POST(self):
                self.respond()

            def do_PATCH(self):
                self.respond()

            def do_PUT(self):
                self.respond()

            def do_GET(self):
                self.respond()

            def read_body(self):
                if self.headers.get("Transfer-Encoding") == "chunked":
                    content = bytearray()
                    while True:
                        size = int(self.rfile.readline().split(b";", 1)[0], 16)
                        if size == 0:
                            self.rfile.readline()
                            return bytes(content)
                        content.extend(self.rfile.read(size))
                        assert self.rfile.read(2) == b"\r\n"
                return self.rfile.read(int(self.headers.get("Content-Length", "0")))

            def respond(self):
                if self.headers.get("Authorization") != "Bearer example-only-test-token":
                    self.send_json(401, {"error": "authentication required"})
                    return
                parsed = urlsplit(self.path)
                path = parsed.path
                fixture.operations.append((self.command, path))
                raw = self.read_body()
                body = (
                    json.loads(raw) if raw and self.headers.get("Content-Type") == "application/json" else {}
                )
                identifier = str(uuid4())
                if path.endswith("/runs"):
                    entity = {"id": identifier, "status": "queued", **body}
                    fixture.runs[identifier] = entity
                elif "/runs/" in path and path.endswith("/metrics"):
                    fixture.metrics.extend(body["metrics"])
                    entity = {}
                elif path.endswith("/logs"):
                    entity = {}
                elif path.endswith("/artifacts"):
                    fixture.artifacts[identifier] = raw
                    entity = {
                        "id": identifier,
                        "size": len(raw),
                        "sha256": hashlib.sha256(raw).hexdigest(),
                        "path": parse_qs(parsed.query)["path"][0],
                    }
                elif path.endswith("/content"):
                    content = fixture.artifacts[path.split("/")[-2]]
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                    return
                elif "/runs/" in path:
                    entity = fixture.runs[path.split("/")[-1]]
                    for name, value in body.items():
                        if name in {"tags", "parameters"}:
                            entity.setdefault(name, {}).update(value)
                        else:
                            entity[name] = value
                elif path.endswith("/models") and self.command == "GET":
                    name = parse_qs(parsed.query).get("name", [None])[0]
                    entity = {"items": [model for model in fixture.models.values() if model["name"] == name]}
                elif path.endswith("/models"):
                    entity = {"id": identifier, **body}
                    fixture.models[identifier] = entity
                elif "/models/" in path and path.endswith("/versions"):
                    entity = {"id": identifier, "modelId": path.split("/")[-2], **body}
                    fixture.model_versions.append(entity)
                elif path.endswith("/datasets"):
                    entity = {"id": identifier, **body}
                    fixture.datasets[identifier] = entity
                elif "/datasets/" in path and path.endswith("/versions"):
                    entity = {"id": identifier, "datasetId": path.split("/")[-2], **body}
                    fixture.dataset_versions.append(entity)
                else:
                    self.send_json(404, {"error": "route not implemented in test fixture"})
                    return
                self.send_json(200, entity)

            def send_json(self, status, entity):
                content = json.dumps(entity).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exception):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
