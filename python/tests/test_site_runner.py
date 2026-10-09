"""The site runner against a localhost API: protocol order, finish semantics and stops.

The container runs through a fake Apptainer CLI that executes the registered source for real.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fake_site_api import JOB_TOKEN, SiteApi
from site_fixtures import (
    FAST_TIMINGS,
    install_fake_sif_cli,
    recorded_cli_calls,
    site_job,
    submission_for,
    write_spec_directory,
)

from mado_tracking.dataset_upload import manifest_entries_digest
from mado_tracking.site.gpu_lease import GpuLeases
from mado_tracking.site.runner import (
    EXIT_CONFIGURATION_ERROR,
    EXIT_FAILED,
    EXIT_FINISHED,
    EXIT_NOT_RUN,
    SiteRunner,
)
from mado_tracking.site.spec_directory import RunnerSettings, SpecDirectory
from mado_tracking.worker.host_state import process_identity

SIF_CONTENT = b"registered SIF image bytes; the fake CLI never executes them"
RESULT_ENTRYPOINT = r"""
import hashlib, json, os, pathlib, sys
context = json.load(open(os.environ["MMT_JOB_CONTEXT_FILE"]))
assert context["parameters"] == {"steps": 2}
print("site-entrypoint-ran " + os.environ["MY_PASSWORD"], flush=True)
print("progress 10%\rprogress 100%", flush=True)
print("an error line", file=sys.stderr, flush=True)
outputs = pathlib.Path(os.environ["MMT_OUTPUTS_DIR"])
content = b"generated speech shard"
(outputs / "shard-0.tar").write_bytes(content)
digest = hashlib.sha256(content).hexdigest()
result = {
    "version": 2, "complete": True,
    "artifacts": [{"path": "shard-0.tar", "sha256": digest, "size": len(content)}],
    "metrics": [{"name": "samples", "value": 3}],
    "datasets": [{"datasetId": "dataset-1", "path": "shard-0.tar", "digest": "sha256:" + digest}],
}
(outputs / "result.json").write_text(json.dumps(result))
"""
SLEEPING_ENTRYPOINT = r"""
import os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
pathlib.Path(os.environ["MMT_OUTPUTS_DIR"], "child.pid").write_text(str(child.pid))
print("site-ready", flush=True)
time.sleep(60)
"""


def sif_runtime(api: SiteApi) -> dict:
    return {
        "kind": "apptainer",
        "artifactId": api.add_artifact(SIF_CONTENT),
        "sha256": hashlib.sha256(SIF_CONTENT).hexdigest(),
    }


def prepare(
    tmp_path: Path, api: SiteApi, job: dict, *, settings: RunnerSettings | None = None, secrets=None
) -> Path:
    spec = tmp_path / f"spec-{job['job']['id']}"
    spec.mkdir()
    write_spec_directory(
        spec,
        submission_for([job]),
        api_url=api.url,
        settings=settings or RunnerSettings(work_directory=str(tmp_path / "work")),
        secrets=secrets,
    )
    return spec


def run_runner(spec: Path, *, array_index: int = 0, **options) -> int:
    runner = SiteRunner(
        SpecDirectory(spec),
        array_index=array_index,
        environment={},
        timings=FAST_TIMINGS,
        handle_signals=False,
        **options,
    )
    return asyncio.run(asyncio.wait_for(runner.run(), 30))


def first_index(actions: list[str], name: str) -> int:
    return actions.index(name)


def test_runner_reports_in_protocol_order_and_saves_outputs_with_the_job_token(tmp_path, monkeypatch):
    cli = install_fake_sif_cli(tmp_path, monkeypatch)
    project_id = str(uuid4())
    with SiteApi() as api:
        job = site_job(
            project_id=project_id,
            source_files={"main.py": RESULT_ENTRYPOINT},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        exit_code = run_runner(prepare(tmp_path, api, job))
    assert exit_code == EXIT_FINISHED
    actions = api.actions()
    assert actions[0] == "start" and actions[-1] == "finish"
    start = api.bodies("start")[0]
    assert start["phase"] == "waiting_resources" and start["gpuIds"] == [] and start["host"]
    running = next(
        index
        for index, (name, body) in enumerate(api.calls)
        if name == "heartbeat" and body["phase"] == "running"
    )
    uploads = [index for index, (name, _body) in enumerate(api.calls) if name == "upload"]
    assert (
        running
        < min(uploads)
        < max(uploads)
        < first_index(actions, "metrics")
        < first_index(actions, "outputs")
    )
    assert dict(api.uploads)["container/shard-0.tar"] == b"generated speech shard"
    assert {".mmt/source.zip", ".mmt/source-manifest.json"} <= {path for path, _content in api.uploads}
    assert api.bodies("metrics")[0]["metrics"][0]["name"] == "samples"
    [declaration] = api.bodies("outputs")[0]["declarations"]
    assert declaration == {
        "index": 0,
        "kind": "dataset",
        "datasetId": "dataset-1",
        "path": "shard-0.tar",
        "digest": declaration["digest"],
    }
    finish = api.bodies("finish")[0]
    assert finish["status"] == "finished" and finish["exitCode"] == 0 and "endReason" not in finish
    assert len({body["instanceId"] for _name, body in api.calls if "instanceId" in body}) == 1
    messages = api.messages()
    assert "site-entrypoint-ran [REDACTED]" in messages and "configured-site-secret" not in messages
    assert "progress 100%" in messages and "progress 10%" not in messages
    assert ("error", "an error line") in api.log_lines and JOB_TOKEN not in messages
    workspace = tmp_path / "work" / job["job"]["id"]
    assert json.loads((workspace / "state.json").read_text())["status"] == "finished"
    [execution] = [call for call in recorded_cli_calls(cli) if call["command"] == "exec"]
    assert execution["sif"] == SIF_CONTENT.decode() and not execution["nv"]
    sha256 = hashlib.sha256(SIF_CONTENT).hexdigest()
    assert (tmp_path / "work/.mmt-cache/sif" / f"artifact-{sha256}.sif").read_bytes() == SIF_CONTENT


def test_jobs_of_one_site_download_a_sif_artifact_once(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    project_id = str(uuid4())
    with SiteApi() as api:
        runtime = sif_runtime(api)
        jobs = [
            site_job(
                project_id=project_id,
                source_files={"main.py": "print('ok')"},
                runtime=runtime,
                runtime_kinds=["apptainer"],
            )
            for _ in range(2)
        ]
        exit_codes = [run_runner(prepare(tmp_path, api, job)) for job in jobs]
    assert exit_codes == [EXIT_FINISHED, EXIT_FINISHED]
    assert api.downloads[runtime["artifactId"]] == 1


def test_an_array_member_stages_only_its_share_of_the_partitioned_dataset(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    project_id = str(uuid4())
    entrypoint = r"""
import json, os, pathlib
for version, directory in json.loads(os.environ["MMT_FAKE_DATASET_DIRS"]).items():
    for path in sorted(pathlib.Path(directory).rglob("*")):
        if path.is_file():
            name = path.relative_to(directory).as_posix()
            print("member-file " + name + "=" + path.read_text(), flush=True)
"""
    with SiteApi() as api:
        version_id = str(uuid4())
        names = ["a/0.wav", "a/1.wav", "b/2.wav", "b/3.wav", "c/4.wav", "c/5.wav", "d/6.wav"]
        entries = []
        for name in reversed(names):
            content = name.encode()
            entries.append(
                {
                    "path": name,
                    "artifactId": api.add_artifact(content),
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            )
        api.dataset_files[version_id] = entries
        dataset = {
            "id": version_id,
            "datasetId": str(uuid4()),
            "projectId": project_id,
            "uri": f"mmt-dataset://{version_id}",
            "digest": manifest_entries_digest(entries),
            "contentKind": "artifacts",
            "fileCount": len(entries),
            "totalSize": sum(entry["size"] for entry in entries),
            "metadata": {},
        }
        job = site_job(
            project_id=project_id,
            source_files={"main.py": entrypoint},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
            array_index=1,
            array_size=3,
            partition_version_id=version_id,
            input_datasets=[dataset],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_FINISHED
    member_files = sorted(
        line.split(" ", 1)[1] for line in api.messages().splitlines() if line.startswith("member-file ")
    )
    # Positions 1 and 4 of the path order belong to member 1 of 3.
    assert member_files == ["a/1.wav=a/1.wav", "c/4.wav=c/4.wav"]
    downloaded = {entry["path"] for entry in entries if api.downloads[entry["artifactId"]]}
    assert downloaded == {"a/1.wav", "c/4.wav"}
    assert "member 1 reads 2 of 7 files" in api.messages()


def test_cancel_requested_by_heartbeat_stops_the_container_and_finishes_canceled(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        api.cancel_after_log = "site-ready"
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": SLEEPING_ENTRYPOINT},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        exit_code = run_runner(prepare(tmp_path, api, job))
    assert exit_code == EXIT_FAILED
    assert api.bodies("finish") == [
        {"instanceId": api.bodies("start")[0]["instanceId"], "status": "canceled"}
    ]
    assert not [path for path, _content in api.uploads if path.startswith("container/")]
    child_pid = int((tmp_path / "work" / job["job"]["id"] / "outputs/child.pid").read_text())
    assert process_identity(child_pid) is None


@pytest.mark.parametrize("status", [401, 410])
def test_a_rejected_heartbeat_stops_the_container_without_a_finish(tmp_path, monkeypatch, status):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        api.heartbeat_status_after_log = ("site-ready", status)
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": SLEEPING_ENTRYPOINT},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        exit_code = run_runner(prepare(tmp_path, api, job))
    assert exit_code == EXIT_NOT_RUN
    assert "finish" not in api.actions()
    workspace = tmp_path / "work" / job["job"]["id"]
    assert process_identity(int((workspace / "outputs/child.pid").read_text())) is None
    assert json.loads((workspace / "state.json").read_text())["status"] == "failed"


def test_sigterm_stops_the_container_and_finishes_as_timed_out(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": SLEEPING_ENTRYPOINT},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        spec = prepare(tmp_path, api, job)
        environment = {
            **os.environ,
            "MMT_ARRAY_INDEX": "0",
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        }
        diagnostics = tmp_path / "runner.stderr"
        with diagnostics.open("wb") as stderr:
            process = subprocess.Popen(
                [sys.executable, "-m", "mado_tracking.cli", "site-run", str(spec)],
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=stderr,
            )
        try:
            assert api.wait_for_log("site-ready", timeout=30), diagnostics.read_text()
            process.send_signal(signal.SIGTERM)
            exit_code = process.wait(timeout=60)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    assert exit_code == EXIT_FAILED
    [finish] = api.bodies("finish")
    assert finish["status"] == "failed" and finish["endReason"] == "timed_out"
    child_pid = int((tmp_path / "work" / job["job"]["id"] / "outputs/child.pid").read_text())
    assert process_identity(child_pid) is None


def test_a_job_the_api_will_not_start_leaves_no_workspace(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        api.start_status = 409
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": "print(1)"},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_NOT_RUN
    assert api.actions() == ["start"]
    assert not (tmp_path / "work" / job["job"]["id"]).exists()


def test_a_job_canceled_in_the_queue_finishes_canceled_at_start(tmp_path, monkeypatch):
    cli = install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        api.start_cancel_requested = True
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": "print(1)"},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_FAILED
    assert api.actions() == ["start", "finish"] and api.bodies("finish")[0]["status"] == "canceled"
    assert not recorded_cli_calls(cli)


def test_a_failing_entrypoint_finishes_failed_with_its_exit_code_and_saves_no_outputs(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    source = (
        "import pathlib, os, sys\n"
        "pathlib.Path(os.environ['MMT_OUTPUTS_DIR'], 'x.bin').write_bytes(b'x')\n"
        "sys.exit(7)\n"
    )
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": source},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_FAILED
    finish = api.bodies("finish")[0]
    assert finish["status"] == "failed" and finish["exitCode"] == 7 and "status 7" in finish["error"]
    assert {path for path, _content in api.uploads} == {".mmt/source.zip", ".mmt/source-manifest.json"}
    assert "metrics" not in api.actions() and "outputs" not in api.actions()


def test_undeclared_outputs_fail_the_job_before_any_output_is_saved(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    source = (
        "import pathlib, os\npathlib.Path(os.environ['MMT_OUTPUTS_DIR'], 'stray.bin').write_bytes(b'x')\n"
    )
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": source},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_FAILED
    assert "Container outputs were rejected" in api.bodies("finish")[0]["error"]
    assert not [path for path, _content in api.uploads if path.startswith("container/")]


def test_a_docker_image_is_converted_once_per_digest_and_cpu_with_registry_credentials(tmp_path, monkeypatch):
    cli = install_fake_sif_cli(tmp_path, monkeypatch)
    image = "forge.example.org/team/tts@sha256:" + "a" * 64
    secrets = {"registry": {"username": "puller", "password": "registry-password-value"}}
    with SiteApi() as api:
        jobs = [
            site_job(
                project_id=str(uuid4()),
                source_files={"main.py": "print('converted image ran')"},
                runtime={"kind": "docker", "image": image, "workingDirectory": "/mmt/source"},
                runtime_kinds=["apptainer"],
                cpu_arch="arm64",
            )
            for _ in range(2)
        ]
        exit_codes = [run_runner(prepare(tmp_path, api, job, secrets=secrets)) for job in jobs]
        manifest = json.loads(dict(api.uploads)[".mmt/source-manifest.json"])
    assert exit_codes == [EXIT_FINISHED, EXIT_FINISHED]
    calls = recorded_cli_calls(cli)
    [pull] = [call for call in calls if call["command"] == "pull"]
    assert pull["arch"] == "arm64" and pull["image"] == f"docker://{image}"
    assert (pull["username"], pull["password"]) == ("puller", "registry-password-value")
    assert pull["cacheDirectory"] == str(tmp_path / "work/.mmt-cache/sif-layers")
    executions = [call for call in calls if call["command"] == "exec"]
    assert len(executions) == 2 and all(
        call["sif"] == f"fake SIF of docker://{image} for arm64" for call in executions
    )
    assert (tmp_path / "work/.mmt-cache/sif" / f"{'a' * 64}-arm64.sif").exists()
    # The Run records the registered image; the SIF is this site's way to run it.
    assert manifest["runtime"]["kind"] == "docker" and manifest["runtime"]["image"] == image
    assert "registry-password-value" not in api.messages()


def native_checkpoint(api: SiteApi, files: dict[str, bytes]) -> dict:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
    content = archive.getvalue()
    return {
        "id": str(uuid4()),
        "runId": str(uuid4()),
        "step": 40,
        "source": "native",
        "artifacts": [
            {
                "id": api.add_artifact(content),
                "path": "checkpoint.tar",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        ],
        "manifest": {
            "files": [
                {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                for name, data in files.items()
            ],
            "includesOptimizer": False,
            "framework": None,
        },
        "metadata": {},
    }


def test_hook_inputs_reach_the_container_as_files(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    entrypoint = r"""
import json, os, pathlib
# The fake CLI hands the code host paths for the container paths it names.
directory = pathlib.Path(os.environ["MMT_INPUT_CHECKPOINT_DIR"])
print("checkpoint-dir " + directory.parent.name + "/" + directory.name, flush=True)
print("checkpoint-file " + (directory / "model.bin").read_text(), flush=True)
document = json.load(open(os.environ["MMT_INPUT_CHECKPOINT_FILE"]))
print("checkpoint-step " + str(document["step"]), flush=True)
print("payload " + json.load(open(os.environ["MMT_TRIGGER_PAYLOAD_FILE"]))["ref"], flush=True)
"""
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": entrypoint},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
        )
        job["inputCheckpoint"] = native_checkpoint(api, {"model.bin": b"weights at step 40"})
        job["run"]["tags"] = {"mmt.inputCheckpointId": job["inputCheckpoint"]["id"]}
        job["triggerPayload"] = {"ref": "refs/heads/main"}
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_FINISHED, api.bodies("finish")
    messages = api.messages()
    assert "checkpoint-dir inputs/checkpoint" in messages
    assert "checkpoint-file weights at step 40" in messages and "checkpoint-step 40" in messages
    assert "payload refs/heads/main" in messages


class BusyThenFreeHost:
    """nvidia-smi lists one GPU; a Mado container holds it for the first few looks."""

    def __init__(self, busy_looks: int):
        self.busy_looks = busy_looks
        self.looks = 0

    def __call__(self, argv: list[str]) -> str:
        if argv[0] == "nvidia-smi":
            return "0, GPU-11111111\n"
        if argv[1:3] == ["container", "ls"]:
            return "abc123\n"
        self.looks += 1
        held = '[{"Driver":"","DeviceIDs":["0"]}]' if self.looks <= self.busy_looks else "null"
        return f'"running"\t{held}\n'


def test_a_direct_host_waits_for_a_free_gpu_then_runs_on_it(tmp_path, monkeypatch):
    cli = install_fake_sif_cli(tmp_path, monkeypatch)
    host = BusyThenFreeHost(busy_looks=3)
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": "print('gpu job')"},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
            gpu_count=1,
        )
        settings = RunnerSettings(work_directory=str(tmp_path / "work"), gpu_assignment="lease")
        exit_code = run_runner(
            prepare(tmp_path, api, job, settings=settings),
            gpu_leases=lambda work_directory, job_id: GpuLeases(
                work_directory,
                hostname="gpu-host",
                job_id=job_id,
                pid=os.getpid(),
                run_command=host,
                docker_binary="docker",
            ),
        )
    assert exit_code == EXIT_FINISHED
    phases = [(body["phase"], body["gpuIds"]) for body in api.bodies("heartbeat")]
    assert ("waiting_resources", []) in phases and phases[-1] == ("running", ["0"])
    assert phases.index(("waiting_resources", [])) < phases.index(("running", ["0"]))
    assert "Waiting for 1 free GPUs on" in api.messages()
    [execution] = [call for call in recorded_cli_calls(cli) if call["command"] == "exec"]
    assert execution["nv"] and execution["cuda"] == "0"
    assert not list((tmp_path / "work/.mmt-cache/gpu-leases/gpu-host").glob("*.json"))


def test_a_scheduler_node_runs_on_the_gpus_the_scheduler_gave_it(tmp_path, monkeypatch):
    cli = install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": "print('gpu job')"},
            runtime=sif_runtime(api),
            runtime_kinds=["apptainer"],
            gpu_count=2,
        )
        spec = prepare(tmp_path, api, job)
        runner = SiteRunner(
            SpecDirectory(spec),
            array_index=0,
            environment={"CUDA_VISIBLE_DEVICES": "2,3"},
            timings=FAST_TIMINGS,
            handle_signals=False,
        )
        assert asyncio.run(runner.run()) == EXIT_FINISHED
    assert api.bodies("start")[0]["gpuIds"] == ["2", "3"]
    [execution] = [call for call in recorded_cli_calls(cli) if call["command"] == "exec"]
    assert execution["nv"] and execution["cuda"] == "2,3"


def test_a_job_that_fails_validation_is_failed_at_the_api(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": "print(1)"},
            runtime={"kind": "python"},
            runtime_kinds=["apptainer"],
        )
        assert run_runner(prepare(tmp_path, api, job)) == EXIT_CONFIGURATION_ERROR
    assert api.actions() == ["start", "finish"]
    assert "WorkerJob validation failed" in api.bodies("finish")[0]["error"]


def test_site_run_picks_the_job_of_its_array_index(tmp_path, monkeypatch):
    install_fake_sif_cli(tmp_path, monkeypatch)
    with SiteApi() as api:
        runtime = sif_runtime(api)
        jobs = [
            site_job(
                project_id=str(uuid4()),
                source_files={"main.py": f"print('member {index}')"},
                runtime=runtime,
                runtime_kinds=["apptainer"],
                array_index=index,
                array_size=2,
            )
            for index in range(2)
        ]
        spec = tmp_path / "array-spec"
        spec.mkdir()
        write_spec_directory(
            spec,
            submission_for(jobs),
            api_url=api.url,
            settings=RunnerSettings(work_directory=str(tmp_path / "work")),
        )
        started = time.monotonic()
        assert run_runner(spec, array_index=1) == EXIT_FINISHED
        assert time.monotonic() - started < 30
    assert "member 1" in api.messages() and "member 0" not in api.messages()
    assert (tmp_path / "work" / jobs[1]["job"]["id"]).is_dir() and not (
        tmp_path / "work" / jobs[0]["job"]["id"]
    ).exists()
