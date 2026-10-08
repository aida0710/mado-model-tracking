"""Diagnose a compute target over the worker's own transport before any Job runs there.

The worker sends one fixed probe script to the target's Python, reads back raw facts as JSON,
and turns them into the API's TargetCheckResult. Values are only what the target reported:
a missing tool is reported as missing, never filled with a guessed version or GPU.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..errors import ConfigurationError, TransportError
from ..security import SecretMasker
from .sif_container import REQUIRED_SIF_FLAGS
from .transport import CommandTransport, create_target_transport

# The host runner and SDK need the same Python as pyproject.toml's requires-python.
MINIMUM_TARGET_PYTHON = (3, 11)
# The probe runs several short commands (nvidia-smi, docker, the API request) on the target.
PROBE_TIMEOUT_SECONDS = 90.0
# Matches the API's limit (apps/api/src/domain/targetCheckValidation.ts).
MAX_DETAIL_LENGTH = 200
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
# `--nv` is needed only by GPU Jobs, but a check should tell whether GPU containers can run.
CONTAINER_EXEC_FLAGS = sorted(REQUIRED_SIF_FLAGS | {"--nv"})
CONTAINER_KINDS = ("apptainer", "singularity")

# Reports the interpreter before the probe itself runs, so a too-old or broken Python is
# still identified. Kept to syntax every Python 3 accepts.
PYTHON_IDENTITY = "import json, sys; print(json.dumps([list(sys.version_info[:3]), sys.executable]))"

# Runs on the target with its own Python; only the standard library of Python 3.6+ is used so
# that an old interpreter can still report what is missing. argv: work directory, health URL,
# JSON list of container exec flags to look for.
PROBE_SCRIPT = r"""
import json, os, shutil, subprocess, sys, tempfile
try:
    from urllib.request import urlopen
except ImportError:
    urlopen = None

COMMAND_TIMEOUT = 15

def run(argv):
    try:
        completed = subprocess.run(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=COMMAND_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None, ""
    return completed.returncode, completed.stdout[:65536]

def first_line(text):
    lines = text.strip().splitlines()
    return lines[0] if lines else None

def importable(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False

def tool(name, argv):
    path = shutil.which(name)
    if path is None:
        return {"found": False}
    code, output = run([path] + argv)
    return {"found": True, "exitCode": code, "version": first_line(output) if code == 0 else None}

def docker_socket():
    host = os.environ.get("DOCKER_HOST", "")
    if host and not host.startswith("unix://"):
        return None
    path = host[len("unix://"):] if host else "/var/run/docker.sock"
    if not os.path.exists(path):
        return {"exists": False, "accessible": False}
    return {"exists": True, "accessible": os.access(path, os.R_OK | os.W_OK)}

def docker():
    facts = tool("docker", ["--version"])
    if not facts["found"]:
        return facts
    code, output = run([shutil.which("docker"), "version", "--format", "{{.Server.Version}}"])
    facts["serverReachable"] = code == 0
    facts["serverVersion"] = first_line(output) if code == 0 else None
    facts["socket"] = docker_socket()
    return facts

def container(name, flags):
    facts = tool(name, ["--version"])
    if facts["found"]:
        code, output = run([shutil.which(name), "exec", "--help"])
        facts["execFlags"] = [flag for flag in flags if code == 0 and flag in output]
    return facts

def nvidia():
    path = shutil.which("nvidia-smi")
    if path is None:
        return {"found": False}
    code, output = run([path, "--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"])
    return {"found": True, "exitCode": code, "rows": output.splitlines()[:256] if code == 0 else []}

def nearest_existing(path):
    while not os.path.exists(path):
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return path

def work_directory(path):
    path = os.path.abspath(os.path.expanduser(path))
    existing = nearest_existing(path)
    writable = False
    if os.path.isdir(existing):
        try:
            descriptor, temporary = tempfile.mkstemp(dir=existing, prefix=".mmt-check-")
            os.close(descriptor)
            os.unlink(temporary)
            writable = True
        except OSError:
            writable = False
    try:
        statistics = os.statvfs(existing)
        free = statistics.f_bavail * statistics.f_frsize
    except OSError:
        free = None
    return {"exists": existing == path, "writable": writable, "freeBytes": free}

def api(url):
    if urlopen is None:
        return {"reachable": False, "status": None}
    try:
        response = urlopen(url, timeout=5)
        return {"reachable": 200 <= response.status < 300, "status": response.status}
    except Exception as error:
        return {"reachable": False, "status": getattr(error, "code", None)}

pip_code, pip_output = run([sys.executable, "-m", "pip", "--version"])
print(json.dumps({
    "venv": importable("venv"),
    "ensurepip": importable("ensurepip"),
    "pip": {"found": pip_code == 0, "version": first_line(pip_output) if pip_code == 0 else None},
    "git": tool("git", ["--version"]),
    "docker": docker(),
    "containers": {name: container(name, json.loads(sys.argv[3])) for name in ("apptainer", "singularity")},
    "nvidia": nvidia(),
    "workDirectory": work_directory(sys.argv[1]),
    "api": api(sys.argv[2]),
}))
"""


def item(name: str, status: str, code: str | None = None, detail: str | None = None) -> dict[str, Any]:
    return {"name": name, "status": status, "code": code, "detail": detail}


def failed_result(name: str, code: str) -> dict[str, Any]:
    """A result for a check that stopped before the target could report anything."""
    return {
        "version": 1,
        "items": [item(name, "ng", code)],
        "gpus": None,
        "runtimeKinds": [],
        "workDirectoryFreeBytes": None,
    }


def parse_gpu_rows(rows: list[str]) -> list[dict[str, Any]]:
    """Parse `nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits`."""
    gpus = []
    for row in rows:
        # The model name may contain commas, so index/uuid come from the left and memory from the right.
        head = row.split(",", 2)
        if len(head) != 3:
            continue
        name, separator, memory = head[2].rpartition(",")
        index, uuid, name, memory = head[0].strip(), head[1].strip(), name.strip(), memory.strip()
        if not separator or not index.isdigit() or not uuid or not name or not memory.isdigit():
            continue
        gpus.append({"index": index, "uuid": uuid, "name": name, "memoryTotalMiB": int(memory)})
    return gpus


def python_item(identity: tuple[list[int], str]) -> dict[str, Any]:
    version, executable = identity
    detail = f"{'.'.join(str(part) for part in version)} {executable}"
    if tuple(version[:2]) < MINIMUM_TARGET_PYTHON:
        return item("python", "ng", "python_too_old", detail)
    return item("python", "ok", detail=detail)


def docker_item(facts: dict[str, Any]) -> dict[str, Any]:
    if not facts.get("found"):
        return item("docker", "unavailable", "docker_missing")
    if facts.get("serverReachable"):
        return item("docker", "ok", detail=facts.get("serverVersion"))
    socket = facts.get("socket")
    if socket and socket.get("exists") and not socket.get("accessible"):
        return item("docker", "ng", "docker_socket_denied", facts.get("version"))
    return item("docker", "ng", "docker_daemon_unreachable", facts.get("version"))


def container_item(kind: str, facts: dict[str, Any]) -> dict[str, Any]:
    if not facts.get("found"):
        return item(kind, "unavailable", "container_cli_missing")
    supported = set(facts.get("execFlags") or [])
    if facts.get("exitCode") != 0 or not supported.issuperset(CONTAINER_EXEC_FLAGS):
        return item(kind, "ng", "container_flags_missing", facts.get("version"))
    return item(kind, "ok", detail=facts.get("version"))


def gpu_item(
    facts: dict[str, Any], *, gpus_expected: bool
) -> tuple[dict[str, Any], list[dict[str, Any]] | None]:
    if not facts.get("found"):
        # A CPU-only target does not need nvidia-smi; one configured with GPUs does.
        return item("gpu", "ng" if gpus_expected else "unavailable", "nvidia_smi_missing"), None
    if facts.get("exitCode") != 0:
        return item("gpu", "ng", "nvidia_smi_failed"), None
    gpus = parse_gpu_rows(list(facts.get("rows") or []))
    return item("gpu", "ok", detail=str(len(gpus))), gpus


def build_result(
    identity: tuple[list[int], str], facts: dict[str, Any], *, target: dict[str, Any]
) -> dict[str, Any]:
    """Turn the probe's raw facts into a TargetCheckResult."""
    python = python_item(identity)
    venv = item("venv", "ok") if facts.get("venv") else item("venv", "ng", "venv_missing")
    pip_facts = facts.get("pip") or {}
    if pip_facts.get("found"):
        pip = item("pip", "ok", detail=pip_facts.get("version"))
    elif facts.get("ensurepip"):
        # The host runner bootstraps pip into the Job's venv with ensurepip.
        pip = item("pip", "ok", detail="ensurepip")
    else:
        pip = item("pip", "ng", "pip_missing")
    git_facts = facts.get("git") or {}
    git = (
        item("git", "ok", detail=git_facts.get("version"))
        if git_facts.get("found") and git_facts.get("exitCode") == 0
        # Only Git code sources need it; inline and Artifact sources run without git.
        else item("git", "unavailable", "git_missing")
    )
    docker = docker_item(facts.get("docker") or {})
    containers = {
        kind: container_item(kind, (facts.get("containers") or {}).get(kind) or {})
        for kind in CONTAINER_KINDS
    }
    gpu, gpus = gpu_item(facts.get("nvidia") or {}, gpus_expected=bool(target.get("gpuIds")))
    work_facts = facts.get("workDirectory") or {}
    work_directory = (
        item("work_directory", "ok")
        if work_facts.get("writable")
        else item("work_directory", "ng", "work_directory_not_writable")
    )
    api_facts = facts.get("api") or {}
    status = api_facts.get("status")
    api = (
        item("api", "ok")
        if api_facts.get("reachable")
        else item("api", "ng", "api_unreachable", f"HTTP {status}" if isinstance(status, int) else None)
    )
    runtime_kinds = []
    if all(entry["status"] == "ok" for entry in (python, venv, pip)):
        runtime_kinds.append("python")
    if docker["status"] == "ok":
        runtime_kinds.append("docker")
    runtime_kinds += [kind for kind in ("singularity", "apptainer") if containers[kind]["status"] == "ok"]
    free_bytes = work_facts.get("freeBytes")
    return {
        "version": 1,
        "items": [
            item("connection", "ok"),
            python,
            venv,
            pip,
            git,
            docker,
            containers["apptainer"],
            containers["singularity"],
            gpu,
            work_directory,
            api,
        ],
        "gpus": gpus,
        "runtimeKinds": runtime_kinds,
        "workDirectoryFreeBytes": free_bytes if isinstance(free_bytes, int) and free_bytes >= 0 else None,
    }


def sanitize_text(value: str | None, *, masker: SecretMasker, secret_paths: list[str]) -> str | None:
    """Keep a short single-line fact; drop anything that names the target's key files."""
    if value is None:
        return None
    text = CONTROL_CHARACTERS.sub(" ", masker.mask(str(value))).strip()[:MAX_DETAIL_LENGTH]
    if not text or any(path in text for path in secret_paths):
        return None
    return text


def sanitize_result(
    result: dict[str, Any], *, target: dict[str, Any], masker: SecretMasker
) -> dict[str, Any]:
    secret_paths = [path for path in (target.get("sshKeyPath"), target.get("knownHostsPath")) if path]

    def clean(value: str | None) -> str | None:
        return sanitize_text(value, masker=masker, secret_paths=secret_paths)

    items = [{**entry, "detail": clean(entry["detail"])} for entry in result["items"]]
    gpus = result["gpus"]
    if gpus is not None:
        gpus = [
            {**gpu, "uuid": uuid, "name": name}
            for gpu in gpus
            if (uuid := clean(gpu["uuid"])) is not None and (name := clean(gpu["name"])) is not None
        ]
    return {**result, "items": items, "gpus": gpus}


def parse_identity(raw: bytes) -> tuple[list[int], str]:
    try:
        version, executable = json.loads(raw)
    except (UnicodeDecodeError, ValueError, TypeError):
        raise TransportError("Target Python returned an invalid identity") from None
    if (
        not isinstance(version, list)
        or len(version) != 3
        or not all(isinstance(part, int) for part in version)
        or not isinstance(executable, str)
    ):
        raise TransportError("Target Python returned an invalid identity")
    return version, executable


def parse_facts(raw: bytes) -> dict[str, Any]:
    try:
        facts = json.loads(raw)
    except (UnicodeDecodeError, ValueError):
        raise TransportError("Target probe returned invalid JSON") from None
    if not isinstance(facts, dict):
        raise TransportError("Target probe returned a non-object response")
    return facts


async def probe_target(
    target: dict[str, Any], *, transport: CommandTransport, health_url: str, masker: SecretMasker
) -> dict[str, Any]:
    """Probe in three steps so the first failing step names the problem.

    Transport error text can carry ssh's stderr (key paths, host names), so failures are
    reported as codes only.
    """
    try:
        await transport.run(["true"])
    except (TransportError, TimeoutError):
        return failed_result(
            "connection", "ssh_failed" if target["executor"] == "ssh" else "connection_failed"
        )
    python_executable = target["pythonExecutable"]
    try:
        identity = parse_identity(await transport.run([python_executable, "-c", PYTHON_IDENTITY]))
    except (TransportError, TimeoutError):
        return with_connection(failed_result("python", "python_missing"))
    try:
        facts = parse_facts(
            await transport.run(
                [
                    python_executable,
                    "-c",
                    PROBE_SCRIPT,
                    target["workDirectory"],
                    health_url,
                    json.dumps(CONTAINER_EXEC_FLAGS),
                ],
                timeout=PROBE_TIMEOUT_SECONDS,
            )
        )
    except (TransportError, TimeoutError):
        # The interpreter answered but could not run the probe (often a very old Python).
        result = with_connection(failed_result("python", "probe_failed"))
        result["items"][1]["detail"] = python_item(identity)["detail"]
        return sanitize_result(result, target=target, masker=masker)
    return sanitize_result(build_result(identity, facts, target=target), target=target, masker=masker)


def with_connection(result: dict[str, Any]) -> dict[str, Any]:
    return {**result, "items": [item("connection", "ok"), *result["items"]]}


async def check_target(
    target: dict[str, Any], *, allow_local_executor: bool, health_url: str, masker: SecretMasker
) -> tuple[str, dict[str, Any]]:
    """Return the completion status and result; `failed` means the worker could not probe at all."""
    try:
        transport = create_target_transport(target, allow_local_executor=allow_local_executor, masker=masker)
    except ConfigurationError:
        # Missing key/known_hosts files on the worker host, or local execution not allowed here.
        return "failed", failed_result("connection", "ssh_configuration")
    return "finished", await probe_target(target, transport=transport, health_url=health_url, masker=masker)
