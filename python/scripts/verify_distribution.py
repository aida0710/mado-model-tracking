"""Exercise the installed wheel's remote zipapp without an API or external SSH host."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from uuid import uuid4

import mado_tracking
from mado_tracking.worker.runtime import build_runtime_bundle

# Catch broken distribution/runner imports promptly and keep protocol calls bounded.
VERIFICATION_TIMEOUT_SECONDS = 20
POLL_SECONDS = 0.1
REQUIRED_RUNTIME_MODULES = {
    "container_layout",
    "container_outputs",
    "docker_container",
    "execution_runtime",
    "job_execution",
    "runtime_capability",
    "sif_container",
}


def run_remote(runtime: Path, workspace: Path, *, command: str, payload: dict) -> dict:
    response = subprocess.run(
        [sys.executable, str(runtime), command, str(workspace)],
        input=json.dumps(payload).encode(),
        capture_output=True,
        check=True,
        timeout=VERIFICATION_TIMEOUT_SECONDS,
    )
    return json.loads(response.stdout)


def verify_runtime(bundle: bytes, *, kind: str, image: str | None = None) -> None:
    with tempfile.TemporaryDirectory(prefix="mmt-wheel-runtime-") as directory:
        workspace = Path(directory)
        runtime = workspace / "runner.pyz"
        runtime.write_bytes(bundle)
        (workspace / "sdk").mkdir()
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            for member in archive.namelist():
                if member.startswith("sdk/"):
                    archive.extract(member, workspace)
        definition = {"kind": "python"}
        source = {"kind": "inline", "files": {"main.py": "print('wheel remote Python executed')\n"}}
        entrypoint = ["python", "main.py"]
        if kind == "docker":
            definition = {"kind": "docker", "image": image, "workingDirectory": "/tmp"}
            fixture = Path(sys.prefix) / "share/mado-tracking/examples/container_fixture.py"
            source = None
            entrypoint = ["/bin/sh", "-c", runpy.run_path(str(fixture))["FIXTURE_SCRIPT"]]
        specification = {
            "jobId": str(uuid4()),
            "leaseId": str(uuid4()),
            "codeVersion": {
                "id": str(uuid4()),
                "runtime": definition,
                "source": source,
                "entrypoint": entrypoint,
                "requirements": [],
                "environment": {},
            },
            "gpuIds": [],
            "context": {
                "projectId": str(uuid4()),
                "parameters": {},
                "modelVersion": None,
                "inputDatasets": [],
                "kind": "inference",
                "gpuIds": [],
            },
            "sdkEnvironment": {
                "MMT_API_URL": "http://127.0.0.1:1/api",
                "MMT_API_TOKEN": "wheel-fixture-token",
            },
            "installDependencies": False,
            "cancelGraceSeconds": 0.15,
        }
        try:
            run_remote(runtime, workspace, command="start", payload=specification)
            deadline = time.monotonic() + VERIFICATION_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                response = run_remote(runtime, workspace, command="poll", payload={})
                state = response["state"]
                if state["status"] in {"finished", "failed", "canceled"}:
                    assert state["status"] == "finished", state.get("error")
                    break
                time.sleep(POLL_SECONDS)
            else:
                raise AssertionError("Installed remote runtime did not finish")
            if kind == "docker":
                assert state["container"]["released"] is True
                descriptor = state["results"]["artifacts"][0]
                content = (workspace / "outputs" / descriptor["path"]).read_bytes()
                assert hashlib.sha256(content).hexdigest() == descriptor["sha256"]
                assert "wheel-fixture-token" not in (workspace / "stdout.log").read_text()
                assert not (workspace / "venv").exists()
        finally:
            if (workspace / "state.json").exists():
                run_remote(runtime, workspace, command="cancel", payload={})
        print(f"Installed wheel remote {kind}: passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-image", help="Optional cached image@sha256 for a real local Docker run")
    arguments = parser.parse_args()
    assert "site-packages" in str(mado_tracking.__file__), "Run with an isolated wheel installation"
    bundle = build_runtime_bundle()
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        for module in REQUIRED_RUNTIME_MODULES:
            assert f"runtime/{module}.py" in archive.namelist()
        assert "sdk/mado_tracking/execution_runtime.py" in archive.namelist()
    verify_runtime(bundle, kind="python")
    if arguments.docker_image:
        verify_runtime(bundle, kind="docker", image=arguments.docker_image)
    print("Wheel runtime modules and SDK types: passed")


if __name__ == "__main__":
    os.umask(0o077)
    main()
