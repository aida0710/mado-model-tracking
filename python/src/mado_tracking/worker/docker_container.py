"""Own one daemon container per durable Job; client exit never releases its resources."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar, cast

from .container_layout import ContainerMount, container_environment, host_environment
from .host_execution import CommandExecution, ExecutionCanceled
from .host_state import write_json
from .runtime_capability import ContainerStateUncertain, RuntimeUnavailable, runtime_binary

# Short daemon requests permit cancellation/reconnect; pulls use the owned setup process instead.
DAEMON_CONTROL_SECONDS = 5.0
DAEMON_POLL_SECONDS = 0.2
INSPECT_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},'
    '"labels":{{json .Config.Labels}},"state":{{json .State}}}'
)
DaemonResponse = TypeVar("DaemonResponse")


class DockerContainer:
    def __init__(self, workspace: Path, specification: dict[str, Any], execution: CommandExecution):
        self.workspace = workspace
        self.specification = specification
        self.execution = execution
        self.state = execution.state
        self.binary = runtime_binary("docker")
        self.image: str = specification["codeVersion"]["runtime"]["image"]
        self.name = f"mmt-job-{specification['jobId']}"
        self.labels = {
            "io.mado-tracking.job-id": specification["jobId"],
            "io.mado-tracking.code-version-id": specification["codeVersion"]["id"],
            "io.mado-tracking.project-id": specification["context"]["projectId"],
            "io.mado-tracking.lease": hashlib.sha256(specification["leaseId"].encode()).hexdigest(),
            "io.mado-tracking.workspace": hashlib.sha256(str(workspace).encode()).hexdigest(),
        }

    def _control(self, arguments: list[str]) -> str:
        try:
            response = subprocess.run(
                [self.binary, *arguments],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                env=host_environment(),
                timeout=DAEMON_CONTROL_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise ContainerStateUncertain("Docker daemon request interrupted; retaining the lease") from None
        if response.returncode:
            diagnostic = self.execution.masker.mask(response.stderr.decode("utf-8", "replace")[:4096])
            raise ContainerStateUncertain(f"Docker daemon request failed: {diagnostic.strip()}")
        return response.stdout.decode("utf-8")

    def _persist(self) -> None:
        write_json(self.workspace / "state.json", self.state)

    def inspect_owned(self) -> dict[str, Any] | None:
        # Listing distinguishes an absent container from a daemon/permission failure.
        identifiers = self._control(
            ["container", "ls", "--all", "--filter", f"name=^/{self.name}$", "--format", "{{.ID}}"]
        ).split()
        if not identifiers:
            return None
        if len(identifiers) != 1:
            raise ContainerStateUncertain("Docker container name is not unique")
        try:
            container = json.loads(
                self._control(["container", "inspect", "--format", INSPECT_FORMAT, identifiers[0]])
            )
        except ValueError:
            raise ContainerStateUncertain("Docker returned invalid container state") from None
        if (
            container.get("name") != f"/{self.name}"
            or container.get("image") != self.image
            or any((container.get("labels") or {}).get(key) != value for key, value in self.labels.items())
            or self.state.get("container", {}).get("id") not in {None, container.get("id")}
        ):
            raise ContainerStateUncertain("Docker container ownership differs; refusing to start or stop it")
        return cast(dict[str, Any], container)

    def _retry_daemon(self, operation: Callable[[], DaemonResponse]) -> DaemonResponse:
        while True:
            try:
                return operation()
            except ContainerStateUncertain as error:
                self.state["containerError"] = str(error)
                self._persist()
                time.sleep(DAEMON_POLL_SECONDS)

    def _retry_inspection(self) -> dict[str, Any] | None:
        return self._retry_daemon(self.inspect_owned)

    def probe(self) -> None:
        try:
            endpoint = self._control(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            if not endpoint.strip().startswith("unix://"):
                raise RuntimeUnavailable("docker", "a local Unix-socket daemon is required for bind mounts")
            self._control(["info", "--format", "{{.ServerVersion}}"])
        except ContainerStateUncertain as error:
            raise RuntimeUnavailable("docker", str(error)) from None
        self.state["runtimeCapability"] = {"kind": "docker", "available": True}
        self._persist()

    def _create_argv(self, mounts: list[ContainerMount], environment_file: Path) -> list[str]:
        entrypoint = self.specification["executionSnapshot"]["entrypoint"]
        argv = [
            self.binary,
            "container",
            "create",
            "--pull",
            "never",
            "--name",
            self.name,
            "--restart",
            "no",
            "--init",
            "--network",
            "host",
            "--log-driver",
            "json-file",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--env-file",
            str(environment_file),
            "--entrypoint",
            entrypoint[0],
        ]
        for key, value in self.labels.items():
            argv.extend(["--label", f"{key}={value}"])
        for mount in mounts:
            # Docker parses --mount as CSV, including host directories that contain commas.
            buffer = io.StringIO()
            fields = ["type=bind", f"source={mount.host_path}", f"target={mount.container_path}"]
            if mount.readonly:
                fields.extend(["readonly", "bind-recursive=readonly", "bind-propagation=rprivate"])
            csv.writer(buffer, lineterminator="").writerow(fields)
            argv.extend(["--mount", buffer.getvalue()])
        directory = self.specification["codeVersion"]["runtime"].get("workingDirectory")
        if directory is not None:
            argv.extend(["--workdir", directory])
        elif self.specification["codeVersion"]["source"] is not None:
            argv.extend(["--workdir", "/mmt/source"])
        gpu_ids = self.specification["gpuIds"]
        if gpu_ids:
            argv.extend(["--gpus", '"device=' + ",".join(gpu_ids) + '"'])
        return [*argv, self.image, *entrypoint[1:]]

    def _prepare(self, mounts: list[ContainerMount]) -> dict[str, Any]:
        self.probe()
        exit_code, _cached = self.execution.run(
            [self.binary, "image", "inspect", "--format", "{{.Id}}", self.image], capture=True
        )
        if exit_code:
            # Docker verifies the immutable registry digest on pull; cached digest references work offline.
            self.execution.checked([self.binary, "image", "pull", self.image])
        environment = container_environment(self.specification)
        if any("\n" in value or "\r" in value for value in environment.values()):
            raise ValueError("Docker container environment values cannot contain newlines")
        self.state["container"] = {
            "name": self.name,
            "image": self.image,
            "labels": self.labels,
            "phase": "creating",
        }
        self._persist()
        previous = self.inspect_owned()
        if previous is not None:
            raise ContainerStateUncertain("An existing container predates this runner's create intent")
        environment_file = self.workspace / "container.env"
        with environment_file.open("w", encoding="utf-8") as output:
            for name, value in environment.items():
                output.write(f"{name}={value}\n")
        environment_file.chmod(0o600)
        try:
            self.execution.checked(self._create_argv(mounts, environment_file))
        except (RuntimeError, ExecutionCanceled) as error:
            container = self._retry_inspection()
            if container is not None:
                self.state["container"]["id"] = container["id"]
                self._persist()
                self.stop_and_remove()
            else:
                self.state["container"]["released"] = True
                self._persist()
            if isinstance(error, ExecutionCanceled):
                raise
            raise RuntimeUnavailable(
                "docker", "container creation failed; inspect the masked job stderr"
            ) from None
        finally:
            environment_file.unlink(missing_ok=True)
        container = self._retry_inspection()
        if container is None:
            raise ContainerStateUncertain("Docker create succeeded but the owned container is missing")
        self.state["container"].update(id=container["id"], phase="starting")
        self._persist()
        if self.execution.is_canceled():
            self.stop_and_remove()
            raise ExecutionCanceled()
        try:
            self._control(["container", "start", container["id"]])
        except ContainerStateUncertain:
            # A lost start response is resolved by daemon state; never replay docker start.
            container = self._retry_inspection()
            if container is None or container["state"]["Status"] == "created":
                self.stop_and_remove()
                raise RuntimeUnavailable(
                    "docker", "container start failed; check the target runtime/GPU configuration"
                ) from None
        self.state["container"]["phase"] = "started"
        self._persist()
        return self._retry_inspection() or container

    def stop(self) -> None:
        while not self._retry_daemon(self._stop_owned_container):
            pass

    def _stop_owned_container(self) -> bool:
        container = self.inspect_owned()
        if container is None:
            self._record_release()
            return True
        identifier, daemon_state = container["id"], container["state"]
        if daemon_state.get("Paused"):
            self._control(["container", "unpause", identifier])
        if daemon_state.get("Running") or daemon_state.get("Restarting"):
            grace = str(math.ceil(self.execution.cancel_grace_seconds))
            self._control(["container", "stop", "--signal", "SIGTERM", "--timeout", grace, identifier])
            return False
        return True

    def _record_release(self) -> None:
        self.state["container"]["released"] = True
        self._persist()

    def _remove_stopped_container(self) -> bool:
        container = self.inspect_owned()
        if container is None:
            self._record_release()
            return True
        if not container["state"].get("Running") and not container["state"].get("Restarting"):
            self._control(["container", "rm", "--volumes", container["id"]])
        return False

    def stop_and_remove(self) -> None:
        self.stop()
        while not self._retry_daemon(self._remove_stopped_container):
            self.stop()

    def run(self, mounts: list[ContainerMount], *, recover_only: bool = False) -> int:
        logs_stopped = threading.Event()
        follower: threading.Thread | None = None
        follower_started = False
        if recover_only:
            container = self._retry_inspection()
            if container is None:
                self._record_release()
                if self.execution.is_canceled():
                    raise ExecutionCanceled()
                if self.state["container"].get("exitCode") is None:
                    raise RuntimeError("Owned Docker container disappeared; its exit status is unknown")
                return int(self.state["container"]["exitCode"])
            if container["state"]["Status"] == "created":
                self.stop_and_remove()
                if self.execution.is_canceled():
                    raise ExecutionCanceled()
                raise RuntimeError("Recovered an unstarted Docker container; refusing to restart execution")
        else:
            container = self._prepare(mounts)
        log_failure: list[BaseException] = []

        def follow_logs() -> None:
            try:
                log_exit_code, _captured = self.execution.run(
                    [self.binary, "container", "logs", "--follow", container["id"]],
                    stop_requested=logs_stopped.is_set,
                )
                if log_exit_code and not logs_stopped.is_set():
                    raise RuntimeError("Docker logs command failed")
            except BaseException as error:
                log_failure.append(error)

        try:
            self.state["container"].update(id=container["id"], phase="monitoring")
            self._persist()
            follower = threading.Thread(target=follow_logs, name="mmt-docker-logs")
            follower.start()
            follower_started = True
            while True:
                observed = self._retry_inspection()
                if observed is None:
                    raise RuntimeError("Owned Docker container disappeared while running")
                daemon_state = observed["state"]
                self.state["container"]["pid"] = daemon_state.get("Pid", 0)
                if self.execution.is_canceled():
                    raise ExecutionCanceled()
                if not daemon_state.get("Running") and not daemon_state.get("Restarting"):
                    exit_code = int(daemon_state["ExitCode"])
                    self.state["container"]["exitCode"] = exit_code
                    self._persist()
                    # docker logs exits after all stopped-container logs have been sent.
                    follower.join(timeout=DAEMON_CONTROL_SECONDS)
                    if follower.is_alive():
                        logs_stopped.set()
                        follower.join()
                    if log_failure:
                        raise RuntimeError("Docker log collection failed") from log_failure[0]
                    return exit_code
                if not follower.is_alive():
                    # The daemon may have exited since the preceding inspect snapshot.
                    latest = self._retry_inspection()
                    if latest is not None and latest["state"].get("Running"):
                        raise RuntimeError("Docker log connection ended before container execution")
                time.sleep(DAEMON_POLL_SECONDS)
        finally:
            # A follower/client failure still requires daemon-side stop and absence confirmation.
            try:
                self.stop()
            finally:
                try:
                    logs_stopped.set()
                    # join() on a thread that failed to start would hide the original start error.
                    if follower is not None and follower_started:
                        follower.join()
                finally:
                    self.stop_and_remove()
