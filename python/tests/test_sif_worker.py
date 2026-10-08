"""Use a target-side CLI fixture to exercise real owned processes without installing SIF runtimes."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from dataclasses import replace
from uuid import uuid4

import pytest
from test_container_inputs import container_payload
from test_docker_worker import ContainerServer, execute_job, workspace_for
from test_execution_snapshot import pin_execution

from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.host_state import process_identity
from mado_tracking.worker.service import Worker

CLI_FIXTURE = r"""
import os, sys
if sys.argv[1:] == ["--version"]:
    print("SIF CLI fixture")
    sys.exit(0)
if sys.argv[1:] == ["exec", "--help"]:
    print("--cleanenv --containall --no-eval --no-home --no-mount --pwd --nv")
    sys.exit(0)
assert "--cleanenv" in sys.argv and "--containall" in sys.argv and "--no-eval" in sys.argv
assert "--no-home" in sys.argv and "hostfs,cwd,bind-paths" in sys.argv
mounts = {}
for index, value in enumerate(sys.argv):
    if value == "--bind":
        source, destination, permission = sys.argv[index + 1].split(":")
        assert permission == ("rw" if destination == "/mmt/outputs" else "ro")
        mounts[destination] = source
assert set(mounts) == {"/mmt/inputs", "/mmt/context", "/mmt/outputs", "/mmt/source"}
def translate(value):
    for destination, source in mounts.items():
        if value == destination or value.startswith(destination + "/"):
            return source + value[len(destination):]
    return value
prefix = "APPTAINERENV_" if "apptainer" in sys.argv[0] else "SINGULARITYENV_"
environment = {
    name[len(prefix):]: translate(value)
    for name, value in os.environ.items() if name.startswith(prefix)
}
environment["PATH"] = os.environ["PATH"]
expected_gpus = "2,GPU-fixture"
assert environment["CUDA_VISIBLE_DEVICES"] == expected_gpus and "--nv" in sys.argv
assert environment["MMT_API_TOKEN"] not in " ".join(sys.argv)
assert environment["MY_PASSWORD"] == "opaque-$(never-evaluate)-secret"
os.chdir(translate(sys.argv[sys.argv.index("--pwd") + 1]))
sif_index = next(index for index, value in enumerate(sys.argv) if value.endswith("runtime.sif"))
assert sys.argv[sif_index + 1] == "python"
argv = [sys.executable, *[translate(value) for value in sys.argv[sif_index + 2:]]]
os.execve(sys.executable, argv, environment)
"""

ENTRYPOINT = r"""
import hashlib, json, os, pathlib, sys
assert sys.argv[1] == "two words"
context = json.load(open(os.environ["MMT_JOB_CONTEXT_FILE"]))
assert context["parameters"] == {"steps": 3}
output = pathlib.Path(os.environ["MMT_OUTPUTS_DIR"])
content = b"SIF process executed registered source"
(output / "output.bin").write_bytes(content)
result = {"version":1,"complete":True,"artifacts":[{
    "path":"output.bin","sha256":hashlib.sha256(content).hexdigest(),"size":len(content)
}],"metrics":[]}
(output / "result.json").write_text(json.dumps(result))
print(os.environ["MY_PASSWORD"])
"""

CANCEL_ENTRYPOINT = r"""
import os, pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child_code = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"
child = subprocess.Popen([sys.executable, "-c", child_code])
pathlib.Path(os.environ["MMT_OUTPUTS_DIR"], "child.pid").write_text(str(child.pid))
print("sif-ready", flush=True)
time.sleep(60)
"""


def sif_fixture(payload, tmp_path, monkeypatch, *, kind, source):
    directory = tmp_path / "bin"
    directory.mkdir()
    executable = directory / kind
    executable.write_text(f"#!{sys.executable}\n" + CLI_FIXTURE)
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", f"{directory}:{os.environ.get('PATH', '')}")
    container_payload(payload, kind)
    content = b"local fake SIF bytes; real SIF execution is not claimed by this test"
    payload["codeVersion"].update(
        runtime={
            "kind": kind,
            "artifactId": str(uuid4()),
            "sha256": hashlib.sha256(content).hexdigest(),
            "workingDirectory": "/mmt/source",
        },
        source={"kind": "inline", "files": {"main.py": source}},
        environment={"MY_PASSWORD": "opaque-$(never-evaluate)-secret"},
        entrypoint=["python", "/mmt/source/main.py", "two words"],
    )
    payload["target"]["gpuIds"] = ["2", "GPU-fixture"]
    payload["job"]["gpuIds"] = ["2", "GPU-fixture"]
    server = ContainerServer(payload, verify_daemon_cleanup=False)
    server.artifact = content
    return server


@pytest.mark.parametrize("kind", ["singularity", "apptainer"])
@pytest.mark.parametrize("mode", ["run", "test"])
def test_sif_backend_executes_real_source_collects_results_and_keeps_secrets_out_of_argv(
    job_payload, worker_settings, tmp_path, monkeypatch, kind, mode
):
    server = sif_fixture(job_payload, tmp_path, monkeypatch, kind=kind, source=ENTRYPOINT)
    if mode == "test":
        job_payload["codeVersion"]["testEntrypoint"] = job_payload["codeVersion"]["entrypoint"]
        job_payload["codeVersion"]["entrypoint"] = ["python", "/mmt/source/must-not-run.py"]
    pin_execution(job_payload, mode)
    settings = replace(worker_settings, telemetry_seconds=float("inf"), install_dependencies=True)
    asyncio.run(execute_job(server, settings))
    assert server.completions[-1]["status"] == "finished"
    assert server.uploads == [("container/output.bin", b"SIF process executed registered source")]
    manifest = json.loads(dict(server.snapshot_uploads)[".mmt/source-manifest.json"])
    assert manifest["mode"] == mode and manifest["runtime"]["kind"] == kind
    workspace = workspace_for(job_payload)
    assert not (workspace / "venv").exists()
    assert "opaque-$(never-evaluate)-secret" not in (workspace / "stdout.log").read_text()
    assert "[REDACTED]" in (workspace / "stdout.log").read_text()
    state = json.loads((workspace / "state.json").read_text())
    assert state["runtimeCapability"] == {"kind": kind, "available": True}


@pytest.mark.parametrize("kind", ["singularity", "apptainer"])
def test_sif_cancel_waits_for_the_owned_process_group_and_ignoring_children_to_exit(
    job_payload, worker_settings, tmp_path, monkeypatch, kind
):
    server = sif_fixture(job_payload, tmp_path, monkeypatch, kind=kind, source=CANCEL_ENTRYPOINT)
    settings = replace(worker_settings, telemetry_seconds=float("inf"))

    async def scenario():
        worker = Worker(settings, api=server.client())
        ready = asyncio.Event()
        server.log_notifications["sif-ready"] = ready
        task = asyncio.create_task(worker.run_job(WorkerJob.parse(job_payload)))
        try:
            async with asyncio.timeout(15):
                await ready.wait()
                server.cancel = True
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await worker.api.close()
            (workspace_for(job_payload) / "cancel.request").touch()

    asyncio.run(scenario())
    assert server.completions[-1]["status"] == "canceled" and not server.uploads
    child_pid = int((workspace_for(job_payload) / "outputs/child.pid").read_text())
    assert process_identity(child_pid) is None


@pytest.mark.parametrize("kind", ["singularity", "apptainer"])
def test_sif_cli_missing_required_isolation_flags_fails_before_the_entrypoint(
    job_payload, worker_settings, tmp_path, monkeypatch, kind
):
    server = sif_fixture(job_payload, tmp_path, monkeypatch, kind=kind, source=ENTRYPOINT)
    executable = tmp_path / "bin" / kind
    executable.write_text(
        executable.read_text().replace(
            'print("--cleanenv --containall --no-eval --no-home --no-mount --pwd --nv")',
            'print("--cleanenv --containall --no-home --no-mount --pwd --nv")',
        )
    )
    asyncio.run(execute_job(server, replace(worker_settings, telemetry_seconds=float("inf"))))
    assert server.completions[-1]["status"] == "failed" and not server.uploads
    state = json.loads((workspace_for(job_payload) / "state.json").read_text())
    assert state["runtimeCapability"] == {"kind": kind, "available": False}
    assert "required exec flags" in state["error"]
