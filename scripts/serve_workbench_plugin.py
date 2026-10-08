"""Serve a labelled local HTTP plugin fixture for dashboard interaction checks."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
# Separate from the application and test-server ports; listen only on loopback.
DEFAULT_PORT = 4195
# A fixture needs only small searches and lifecycle events, never uploaded files.
MAX_REQUEST_BYTES = 4 * 1024 * 1024
TOKEN_ENV = "MMT_WORKBENCH_PLUGIN_TOKEN"
DATASET = {
    "externalId": "workbench-samples-v1",
    "namespace": "workbench-fixture",
    "name": "CPUサンプルの入力",
    "version": "v1",
    "uri": "urn:mmt:workbench:samples:v1",
    "digest": "fixture:linear-samples-v1",
    "schema": {"x": "number", "y": "number"},
    "metadata": {"fixture": True, "samples": [[0, 1], [1, 3], [2, 5]]},
}


class FixtureState:
    def __init__(self, token: str):
        self.token = token
        self.event_ids: set[str] = set()
        self.lock = threading.Lock()

    def metrics(self) -> str:
        payload_bytes = len(json.dumps(DATASET, ensure_ascii=False).encode())
        labels = 'connection_id="workbench-fixture",bucket="samples"'
        return (
            "# HELP mado_storage_bucket_bytes Local fixture dataset metadata bytes.\n"
            "# TYPE mado_storage_bucket_bytes gauge\n"
            'mado_storage_connection_info{connection_id="workbench-fixture",'
            'connection_name="Local fixture"} 1\n'
            f"mado_storage_bucket_bytes{{{labels}}} {payload_bytes}\n"
            f"mado_storage_bucket_objects{{{labels}}} 1\n"
            f"mmt_workbench_events_total {len(self.event_ids)}\n"
        )


def request_handler(state: FixtureState) -> type[BaseHTTPRequestHandler]:
    class PluginHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_arguments: object) -> None:
            # Verification must not print request data or authentication headers.
            return

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            self.send_payload(
                status,
                json.dumps(payload, ensure_ascii=False).encode(),
                "application/json",
            )

        def send_payload(self, status: int, payload: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def is_authenticated(self) -> bool:
            if hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + state.token
            ):
                return True
            self.send_json(401, {"error": "Unauthorized"})
            return False

        def do_GET(self) -> None:
            if not self.is_authenticated():
                return
            path = urlsplit(self.path).path
            if path == "/manifest":
                self.send_json(
                    200,
                    {
                        "id": "mmt.workbench.fixture",
                        "name": "Mado HTTP fixture",
                        "version": "1.0.0",
                        "protocolVersion": "1.0",
                        "capabilities": [
                            "datasets:search",
                            "lineage:publish",
                            "storage:metrics",
                        ],
                    },
                )
            elif path == "/metrics":
                self.send_payload(
                    200, state.metrics().encode(), "text/plain; version=0.0.4"
                )
            else:
                self.send_json(404, {"error": "Not found"})

        def do_POST(self) -> None:
            if not self.is_authenticated():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST_BYTES:
                    self.send_json(413, {"error": "Request too large"})
                    return
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise TypeError("A JSON object is required")
            except (ValueError, TypeError):
                self.send_json(400, {"error": "Invalid request"})
                return
            path = urlsplit(self.path).path
            if path == "/datasets/search":
                query = payload.get("query", "")
                if not isinstance(query, str):
                    self.send_json(400, {"error": "Invalid query"})
                    return
                self.send_json(
                    200,
                    {
                        "items": [DATASET]
                        if query.lower() in DATASET["name"].lower() or not query
                        else []
                    },
                )
            elif path == "/events" and isinstance(payload.get("id"), str):
                if "executionSnapshot" in payload.get("run", {}):
                    self.send_json(
                        422, {"error": "Execution source must stay in the tracking app"}
                    )
                    return
                with state.lock:
                    state.event_ids.add(payload["id"])
                self.send_json(200, {"accepted": True})
            else:
                self.send_json(404, {"error": "Not found"})

    return PluginHandler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    arguments = parser.parse_args()
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith(TOKEN_ENV + "="):
                token = line.partition("=")[2].strip().strip('"')
                break
    if not token:
        raise SystemExit(f"Configure {TOKEN_ENV} before starting the fixture")
    server = ThreadingHTTPServer(
        ("127.0.0.1", arguments.port), request_handler(FixtureState(token))
    )
    print(f"Workbench HTTP fixture listening on loopback:{arguments.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
