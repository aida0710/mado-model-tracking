"""Install a small stdlib runner plus SDK, then control a durable job by ID."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

from ..errors import ConfigurationError, TransportError
from ..security import SecretMasker, secret_values
from .config import WorkerSettings
from .contracts import WorkerJob
from .transport import CONTROL_TIMEOUT_SECONDS, CommandTransport, LocalTransport, SSHTransport

BOOTSTRAP = """
import hashlib, io, json, os, pathlib, sys, tempfile, zipfile
os.umask(0o077)
root = pathlib.Path(sys.argv[1]).expanduser()
root.mkdir(parents=True, exist_ok=True)
workspace = root / sys.argv[2]
if workspace.is_symlink():
    raise ValueError("Job workspace must not be a symlink")
workspace.mkdir(mode=0o700, exist_ok=True)
workspace.chmod(0o700)
workspace = workspace.resolve()
payload = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
if len(payload) > 8 * 1024 * 1024:
    raise ValueError("Runtime bundle is too large")
runtime = workspace / ("runner-" + hashlib.sha256(payload).hexdigest()[:16] + ".pyz")
if not runtime.exists():
    descriptor, temporary = tempfile.mkstemp(dir=workspace)
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, runtime)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for member in archive.infolist():
            if member.filename.startswith("sdk/mado_tracking/") and not member.is_dir():
                path = workspace / member.filename
                if not path.resolve().is_relative_to(workspace):
                    raise ValueError("Runtime bundle path escapes workspace")
                path.parent.mkdir(parents=True, exist_ok=True)
                if not (workspace / "state.json").exists() or not path.exists():
                    path.write_bytes(archive.read(member))
print(json.dumps({"workspace": str(workspace), "runtime": str(runtime)}))
"""


def build_runtime_bundle() -> bytes:
    package_directory = Path(__file__).resolve().parent.parent
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("__main__.py", "from runtime.host_runner import main\nmain()\n")
        archive.writestr("runtime/__init__.py", "")
        archive.write(package_directory / "security.py", "runtime/security.py")
        archive.write(package_directory / "timestamps.py", "runtime/timestamps.py")
        for name in ("host_runner", "host_state", "host_execution", "source", "telemetry"):
            source = (package_directory / "worker" / f"{name}.py").read_text()
            archive.writestr(
                f"runtime/{name}.py",
                source.replace("from ..security", "from .security").replace(
                    "from ..timestamps", "from .timestamps"
                ),
            )
        for path in package_directory.glob("*.py"):
            archive.write(path, f"sdk/mado_tracking/{path.name}")
        archive.write(package_directory / "py.typed", "sdk/mado_tracking/py.typed")
    return archive_buffer.getvalue()


def execution_specification(job: WorkerJob, settings: WorkerSettings) -> dict[str, Any]:
    return {
        "jobId": job.id,
        "codeVersion": job.code_version,
        "gpuIds": job.job["gpuIds"],
        "context": {
            "jobId": job.id,
            "runId": job.run["id"],
            "projectId": job.job["projectId"],
            "kind": job.run["kind"],
            "parameters": job.run["parameters"],
            "modelVersion": job.model_version,
            "inputDatasets": job.input_datasets,
            "codeVersionId": job.code_version["id"],
            "gpuIds": job.job["gpuIds"],
        },
        "sdkEnvironment": {
            "MMT_API_URL": settings.api.url,
            "MMT_API_TOKEN": settings.api.token,
            "MMT_PROJECT_ID": job.job["projectId"],
            "MMT_RUN_ID": job.run["id"],
            "MMT_EXPERIMENT_ID": job.run["experimentId"],
            "MMT_JOB_ID": job.id,
        },
        "installDependencies": settings.install_dependencies,
        "cancelGraceSeconds": settings.cancel_grace_seconds,
    }


class JobExecutor:
    def __init__(
        self, job: WorkerJob, settings: WorkerSettings, *, transport: CommandTransport | None = None
    ):
        self.job = job
        self.settings = settings
        self.masker = SecretMasker([settings.api.token, *secret_values(job.code_version["environment"])])
        self.transport = transport or self._create_transport()
        self.workspace: str | None = None
        self.runtime: str | None = None
        self.bundle = build_runtime_bundle()

    def _create_transport(self) -> CommandTransport:
        target = self.job.target
        if target["executor"] == "local":
            return LocalTransport(allow_local_executor=self.settings.allow_local_executor, masker=self.masker)
        return SSHTransport(
            host=target["host"],
            port=target["port"],
            username=target["username"],
            ssh_key_path=target["sshKeyPath"],
            known_hosts_path=target["knownHostsPath"],
            masker=self.masker,
        )

    async def install_runtime(self) -> None:
        target = self.job.target
        output = await self.transport.run(
            [target["pythonExecutable"], "-c", BOOTSTRAP, target["workDirectory"], self.job.id],
            stdin=self.bundle,
        )
        response = self._response(output)
        if not isinstance(response.get("workspace"), str) or not isinstance(response.get("runtime"), str):
            raise TransportError("Compute bootstrap did not return a workspace")
        self.workspace = response["workspace"]
        self.runtime = response["runtime"]

    async def command(
        self, name: str, *, payload: dict[str, Any] | None = None, stdin_file: Path | None = None
    ) -> dict[str, Any]:
        if self.workspace is None or self.runtime is None:
            raise ConfigurationError("Runtime must be installed before job control")
        output = await self.transport.run(
            [self.job.target["pythonExecutable"], self.runtime, name, self.workspace],
            stdin=stdin_file or json.dumps(payload or {}, allow_nan=False).encode(),
            timeout=None if stdin_file else CONTROL_TIMEOUT_SECONDS,
        )
        return self._response(output)

    async def poll(
        self, offsets: dict[str, int], *, telemetry: bool = False, step: int = 0
    ) -> dict[str, Any]:
        return await self.command("poll", payload={"offsets": offsets, "telemetry": telemetry, "step": step})

    async def start(self) -> dict[str, Any]:
        return await self.command("start", payload=execution_specification(self.job, self.settings))

    async def cancel(self) -> dict[str, Any]:
        return await self.command("cancel")

    def _response(self, raw: bytes) -> dict[str, Any]:
        try:
            response = json.loads(raw)
        except (UnicodeDecodeError, ValueError):
            raise TransportError("Compute runner returned invalid JSON") from None
        if not isinstance(response, dict):
            raise TransportError("Compute runner returned a non-object response")
        return response
