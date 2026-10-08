from __future__ import annotations

import copy
import json
import os
import threading

import pytest
from test_container_inputs import container_payload
from test_execution_snapshot import pin_execution

from mado_tracking.security import SecretMasker
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.docker_container import DockerContainer
from mado_tracking.worker.host_execution import CommandExecution
from mado_tracking.worker.host_runner import cancel
from mado_tracking.worker.host_state import process_identity, read_state, write_json
from mado_tracking.worker.runtime import execution_specification
from mado_tracking.worker.runtime_capability import ContainerStateUncertain, RuntimeUnavailable


def docker_owner(payload, settings, workspace, *, monkeypatch):
    container_payload(payload)
    specification = execution_specification(WorkerJob.parse(payload), settings)
    execution = CommandExecution(
        workspace,
        {"status": "running", "supervisorPid": 999_999_999, "processPid": 0},
        environment={},
        masker=SecretMasker([settings.api.token]),
        cancel_grace_seconds=0.01,
    )
    monkeypatch.setattr("mado_tracking.worker.docker_container.runtime_binary", lambda _kind: "/test/docker")
    owner = DockerContainer(workspace, specification, execution)
    owner.state["container"] = {"id": "owned-container", "phase": "started"}
    observed = {
        "id": "owned-container",
        "name": "/" + owner.name,
        "image": owner.image,
        "labels": owner.labels,
        "state": {"Status": "running", "Running": True},
    }
    return owner, copy.deepcopy(observed)


@pytest.mark.parametrize("alter", ["job", "code", "lease", "workspace", "image", "id"])
def test_container_ownership_mismatch_cannot_stop_remove_or_restart_someone_elses_container(
    job_payload, worker_settings, tmp_path, monkeypatch, alter
):
    owner, observed = docker_owner(job_payload, worker_settings, tmp_path, monkeypatch=monkeypatch)
    if alter == "image":
        observed["image"] = "other-image@sha256:" + "2" * 64
    elif alter == "id":
        observed["id"] = "replacement-container"
    else:
        key = {"job": "job-id", "code": "code-version-id", "lease": "lease", "workspace": "workspace"}[alter]
        observed["labels"]["io.mado-tracking." + key] = "different-owner"
    commands = []

    def control(arguments):
        commands.append(arguments[1])
        return "owned-container\n" if arguments[1] == "ls" else json.dumps(observed)

    monkeypatch.setattr(owner, "_control", control)
    with pytest.raises(ContainerStateUncertain, match="ownership"):
        owner.inspect_owned()
    assert commands == ["ls", "inspect"]


@pytest.mark.parametrize("supervisor_alive", [False, True])
def test_unreachable_daemon_during_cancel_retains_resources_until_stop_and_absence_are_confirmed(
    job_payload, worker_settings, tmp_path, monkeypatch, supervisor_alive
):
    owner, observed = docker_owner(job_payload, worker_settings, tmp_path, monkeypatch=monkeypatch)
    owner.state["status"] = "unknown"
    if supervisor_alive:
        owner.state.update(supervisorPid=os.getpid(), supervisorIdentity=process_identity(os.getpid()))
    interrupted, restored = threading.Event(), threading.Event()
    removed = False
    mutations = []

    def control(arguments):
        nonlocal removed
        action = arguments[1]
        if action == "ls":
            return "" if removed else "owned-container\n"
        if action == "inspect":
            return json.dumps(observed)
        mutations.append(action)
        if action == "stop":
            if not restored.is_set():
                interrupted.set()
                raise ContainerStateUncertain("daemon offline")
            observed["state"].update(Status="exited", Running=False, ExitCode=137)
        elif action == "rm":
            assert observed["state"]["Running"] is False
            removed = True
        return ""

    monkeypatch.setattr(owner, "_control", control)
    write_json(tmp_path / "state.json", owner.state)
    thread = threading.Thread(target=owner.stop_and_remove)
    thread.start()
    try:
        assert interrupted.wait(5)
        state = read_state(tmp_path)
        assert state["status"] == "unknown" and state["processAlive"] is True
        assert not owner.state["container"].get("released") and "rm" not in mutations
    finally:
        restored.set()
        thread.join(timeout=5)
    assert not thread.is_alive() and removed and owner.state["container"]["released"] is True
    assert read_state(tmp_path)["processAlive"] is supervisor_alive


def test_initial_daemon_capability_failure_is_distinct_from_an_uncertain_running_container(
    job_payload, worker_settings, tmp_path, monkeypatch
):
    owner, _observed = docker_owner(job_payload, worker_settings, tmp_path, monkeypatch=monkeypatch)
    owner.state.pop("container")

    def failed_control(_arguments):
        raise ContainerStateUncertain("permission denied")

    monkeypatch.setattr(owner, "_control", failed_control)
    with pytest.raises(RuntimeUnavailable, match="unavailable") as error:
        owner.probe()
    assert error.value.kind == "docker" and "container" not in owner.state


def test_cancel_with_no_supervisor_never_releases_a_daemon_container_by_killing_only_a_client(
    tmp_path, monkeypatch
):
    write_json(
        tmp_path / "state.json",
        {
            "status": "running",
            "supervisorPid": 999_999_999,
            "processPid": 0,
            "container": {"id": "owned-container", "phase": "started"},
        },
    )
    monkeypatch.setattr("mado_tracking.worker.host_runner.resume_docker_supervisor", lambda _workspace: None)
    state = cancel(tmp_path)
    assert state["status"] == "unknown" and state["processAlive"] is True
    assert (tmp_path / "cancel.request").exists()
    assert json.loads((tmp_path / "state.json").read_text())["status"] == "running"


@pytest.mark.parametrize("mode", ["run", "test"])
def test_docker_uses_the_snapshot_command_for_normal_or_test_execution(
    job_payload, worker_settings, tmp_path, monkeypatch, mode
):
    container_payload(job_payload)
    job_payload["codeVersion"].update(
        entrypoint=["/app/train", "normal arguments"], testEntrypoint=["/app/test", "test arguments"]
    )
    pin_execution(job_payload, mode)
    specification = execution_specification(WorkerJob.parse(job_payload), worker_settings)
    execution = CommandExecution(
        tmp_path,
        {"status": "running"},
        environment={},
        masker=SecretMasker([]),
        cancel_grace_seconds=0.01,
    )
    monkeypatch.setattr("mado_tracking.worker.docker_container.runtime_binary", lambda _kind: "/test/docker")
    owner = DockerContainer(tmp_path, specification, execution)
    argv = owner._create_argv([], tmp_path / "container.env")
    command = job_payload["run"]["executionSnapshot"]["entrypoint"]
    assert argv[argv.index("--entrypoint") + 1] == command[0]
    assert argv[-1] == command[1]
