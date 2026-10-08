"""Install, upgrade, status, and doctor on a worker host, with systemctl and pip replaced by a recorder."""

from __future__ import annotations

import io
import json
import os
import stat
from collections.abc import Sequence
from pathlib import Path, PurePosixPath

import httpx
import pytest

from mado_tracking.settings import ApiSettings
from mado_tracking.worker import cli
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.doctor import CheckLevel, check_api, check_ssh_files
from mado_tracking.worker.installer import (
    CommandResult,
    InstallerError,
    InstallRequest,
    ServiceLayout,
    install_worker,
    read_worker_status,
    upgrade_worker,
)
from mado_tracking.worker.journal import JobJournal
from mado_tracking.worker.systemd_unit import (
    ServiceScope,
    WorkerUnitSettings,
    instance_unit_name,
    render_worker_unit,
)

TOKEN = "mmt_installer_test_secret_value"
WORKER_ID = "gpu-host-1"
UNIT_NAME = "mado-tracking-worker@gpu-host-1.service"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class RecordingRunner:
    """Stands in for systemctl and pip; answers `show` with the configured unit state."""

    def __init__(self, *, active_state: str = "active", failing_program: str | None = None):
        self.calls: list[list[str]] = []
        self.active_state = active_state
        self.failing_program = failing_program

    def __call__(self, argv: Sequence[str]) -> CommandResult:
        self.calls.append(list(argv))
        if self.failing_program and self.failing_program in argv:
            return CommandResult(1, stderr=f"{self.failing_program} failed")
        if "show" in argv:
            main_pid = 4242 if self.active_state == "active" else 0
            return CommandResult(
                0, stdout=f"ActiveState={self.active_state}\nSubState=running\nMainPID={main_pid}\n"
            )
        return CommandResult(0)

    def verbs(self) -> list[str]:
        return [
            next(part for part in call if part in {"daemon-reload", "enable", "show", "restart", "pip"})
            for call in self.calls
        ]


def file_mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home_directory = tmp_path / "home"
    home_directory.mkdir()
    monkeypatch.setenv("HOME", str(home_directory))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return home_directory


def install_from_cli(arguments: list[str], runner: RecordingRunner, stdin: str = TOKEN + "\n") -> int:
    parsed = cli.build_parser().parse_args(cli.normalize_arguments(arguments))
    return cli.dispatch(parsed, runner, io.StringIO(stdin))


def install_arguments(state_directory: Path) -> list[str]:
    return [
        "install",
        "--api-url",
        "http://127.0.0.1:4182",
        "--worker-id",
        WORKER_ID,
        "--target-ids",
        "target-a, target-b",
        "--state-dir",
        str(state_directory),
        "--python",
        "/opt/worker/venv/bin/python",
    ]


def test_install_writes_a_0600_environment_file_and_a_token_free_unit_then_enables_it(home: Path):
    runner = RecordingRunner()
    state_directory = home / "worker-state"

    assert install_from_cli(install_arguments(state_directory), runner) == 0

    environment_file = home / ".config/mado-tracking-worker/gpu-host-1.env"
    assert file_mode(environment_file) == 0o600
    assert file_mode(environment_file.parent) == 0o700
    assert environment_file.read_text().splitlines() == [
        "MMT_API_URL=http://127.0.0.1:4182",
        f"MMT_WORKER_ID={WORKER_ID}",
        "MMT_WORKER_TARGET_IDS=target-a,target-b",
        f"MMT_WORKER_STATE_DIR={state_directory}",
        f"MMT_API_TOKEN={TOKEN}",
    ]
    assert file_mode(state_directory) == 0o700
    unit_text = (home / ".config/systemd/user/mado-tracking-worker@.service").read_text()
    assert TOKEN not in unit_text
    assert all(TOKEN not in part for call in runner.calls for part in call)
    assert runner.calls == [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", UNIT_NAME],
    ]


def test_unit_stops_only_the_worker_process_restarts_on_failure_and_runs_the_service_venv():
    unit_text = render_worker_unit(
        WorkerUnitSettings(
            scope=ServiceScope.USER,
            python_executable=PurePosixPath("/opt/worker/venv/bin/python"),
            environment_directory=PurePosixPath("/home/worker/.config/mado-tracking-worker"),
        )
    )
    lines = unit_text.splitlines()
    assert "KillMode=process" in lines
    assert "Restart=on-failure" in lines
    assert "ExecStart=/opt/worker/venv/bin/python -m mado_tracking.worker.cli run" in lines
    assert "EnvironmentFile=/home/worker/.config/mado-tracking-worker/%i.env" in lines
    assert "WantedBy=default.target" in lines
    assert not any(line.startswith("User=") for line in lines)


def test_system_unit_matches_the_deploy_template():
    rendered = render_worker_unit(
        WorkerUnitSettings(
            scope=ServiceScope.SYSTEM,
            python_executable=PurePosixPath("/opt/mado-tracking-worker/venv/bin/python"),
            environment_directory=PurePosixPath("/etc/mado-tracking-worker"),
            service_user="mado-worker",
        )
    )
    template = (REPOSITORY_ROOT / "deploy/worker/mado-tracking-worker@.service").read_text()
    # The deploy copy only adds a usage header before [Unit].
    assert template[template.index("[Unit]") :] == rendered


def test_system_install_without_service_user_writes_nothing(tmp_path: Path):
    layout = ServiceLayout.for_system(tmp_path)
    runner = RecordingRunner()
    request = InstallRequest(api_url="http://api:4182", worker_id=WORKER_ID, token=TOKEN)
    with pytest.raises(InstallerError, match="--service-user"):
        install_worker(request, layout, runner)
    assert not (tmp_path / "etc").exists()
    assert runner.calls == []


@pytest.mark.parametrize(
    ("worker_id", "token"),
    [("../escape", TOKEN), ("gpu host", TOKEN), (WORKER_ID, "line\nbreak"), (WORKER_ID, "")],
)
def test_invalid_worker_id_or_token_writes_nothing_and_skips_systemctl(
    home: Path, worker_id: str, token: str
):
    runner = RecordingRunner()
    layout = ServiceLayout.for_user(home, {})
    with pytest.raises(InstallerError):
        install_worker(
            InstallRequest(api_url="http://127.0.0.1:4182", worker_id=worker_id, token=token), layout, runner
        )
    assert not layout.environment_directory.exists()
    assert runner.calls == []


def test_token_can_come_from_a_token_file_instead_of_stdin(home: Path):
    token_file = home / "token"
    token_file.write_text(TOKEN + "\n")
    runner = RecordingRunner()
    arguments = [*install_arguments(home / "state"), "--token-file", str(token_file)]
    assert install_from_cli(arguments, runner, stdin="") == 0
    assert f"MMT_API_TOKEN={TOKEN}" in (home / ".config/mado-tracking-worker/gpu-host-1.env").read_text()


def test_default_state_directory_is_the_journal_of_a_manually_started_worker(
    home: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MMT_API_URL", "http://127.0.0.1:4182")
    monkeypatch.setenv("MMT_API_TOKEN", TOKEN)
    monkeypatch.setenv("MMT_WORKER_ID", WORKER_ID)
    monkeypatch.delenv("MMT_WORKER_STATE_DIR", raising=False)
    manual = WorkerSettings.from_environment().state_directory
    assert ServiceLayout.for_user(home, {}).default_state_directory(WORKER_ID) == manual


def installed_layout(home: Path, state_directory: Path) -> ServiceLayout:
    install_from_cli(install_arguments(state_directory), RecordingRunner())
    return ServiceLayout.for_user(home, {})


def test_upgrade_keeps_running_job_journals_and_installs_before_restarting(home: Path):
    state_directory = home / "state"
    layout = installed_layout(home, state_directory)
    running_worker = JobJournal(state_directory)
    running_worker.acquire_worker_lock()
    journal_file = state_directory / "11111111-1111-4111-8111-111111111111.json"
    journal_file.write_text('{"snapshot": {}}')
    try:
        runner = RecordingRunner()
        result = upgrade_worker(WORKER_ID, "mado-tracking[telemetry]==0.2.0", layout, runner)
    finally:
        running_worker.close()

    assert runner.verbs() == ["show", "pip", "restart"]
    assert runner.calls[1] == [
        "/opt/worker/venv/bin/python",
        "-m",
        "pip",
        "install",
        "--upgrade",
        "mado-tracking[telemetry]==0.2.0",
    ]
    assert runner.calls[2] == ["systemctl", "--user", "restart", UNIT_NAME]
    assert result.retained_job_ids == ("11111111-1111-4111-8111-111111111111",)
    assert journal_file.read_text() == '{"snapshot": {}}'
    assert (state_directory / "worker.lock").exists()


def test_upgrade_refuses_while_a_worker_outside_the_unit_holds_the_lock(home: Path):
    state_directory = home / "state"
    layout = installed_layout(home, state_directory)
    manual_worker = JobJournal(state_directory)
    manual_worker.acquire_worker_lock()
    try:
        runner = RecordingRunner(active_state="inactive")
        with pytest.raises(InstallerError, match="manually started worker"):
            upgrade_worker(WORKER_ID, "mado-tracking==0.2.0", layout, runner)
    finally:
        manual_worker.close()
    assert runner.verbs() == ["show"]


def test_failed_pip_install_does_not_restart_the_worker(home: Path):
    layout = installed_layout(home, home / "state")
    runner = RecordingRunner(failing_program="pip")
    with pytest.raises(InstallerError, match="pip install failed"):
        upgrade_worker(WORKER_ID, "mado-tracking==0.2.0", layout, runner)
    assert runner.verbs() == ["show", "pip"]


def test_upgrade_version_becomes_a_pinned_requirement_and_rejects_garbage(home: Path):
    installed_layout(home, home / "state")
    runner = RecordingRunner()
    parsed = cli.build_parser().parse_args(["upgrade", "--worker-id", WORKER_ID, "--version", "0.2.0"])
    assert cli.dispatch(parsed, runner) == 0
    assert runner.calls[1][-1] == "mado-tracking[telemetry]==0.2.0"
    parsed = cli.build_parser().parse_args(["upgrade", "--worker-id", WORKER_ID, "--version", "1; rm -rf /"])
    with pytest.raises(InstallerError):
        cli.dispatch(parsed, RecordingRunner())


def test_status_reports_unit_state_worker_lock_and_retained_jobs(
    home: Path, capsys: pytest.CaptureFixture[str]
):
    state_directory = home / "state"
    layout = installed_layout(home, state_directory)
    (state_directory / "22222222-2222-4222-8222-222222222222.json").write_text("{}")
    (state_directory / "33333333-3333-4333-8333-333333333333.rejected").write_text("{}")

    status = read_worker_status(WORKER_ID, layout, RecordingRunner())
    assert status.unit_name == UNIT_NAME
    assert status.is_active and status.main_pid == 4242
    assert status.lock_held is False
    assert status.retained_job_ids == ("22222222-2222-4222-8222-222222222222",)

    capsys.readouterr()
    parsed = cli.build_parser().parse_args(["status", "--worker-id", WORKER_ID, "--json"])
    assert cli.dispatch(parsed, RecordingRunner(active_state="failed")) == 3
    reported = json.loads(capsys.readouterr().out)
    assert reported["active_state"] == "failed"
    assert TOKEN not in json.dumps(reported)


def token_api(scopes: list[str], *, job: bool = False, token_status: int = 200) -> httpx.MockTransport:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/health":
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/api/auth/token":
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            return httpx.Response(
                token_status, json={"id": "token-id", "projectId": "project-id", "scopes": scopes, "job": job}
            )
        return httpx.Response(404)

    return httpx.MockTransport(respond)


API = ApiSettings.from_environment(url="http://api.test", token=TOKEN)


def test_doctor_detects_missing_worker_scopes():
    checks = check_api(API, token_api(["read", "worker:execute"]))
    assert [check.level for check in checks] == [CheckLevel.OK, CheckLevel.ERROR]
    assert "artifacts:write" in checks[1].detail
    assert all(TOKEN not in check.detail for check in checks)


def test_doctor_accepts_a_complete_service_token_and_rejects_job_tokens():
    complete = ["read", "worker:execute", "artifacts:write"]
    assert check_api(API, token_api(complete))[1].level is CheckLevel.OK
    assert check_api(API, token_api(complete, job=True))[1].level is CheckLevel.ERROR
    assert check_api(API, token_api([], token_status=401))[1].level is CheckLevel.ERROR
    # An API without GET /auth/token cannot be checked, which is not the token's fault.
    assert check_api(API, token_api([], token_status=404))[1].level is CheckLevel.WARNING


def test_doctor_reports_an_unreachable_api():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    checks = check_api(API, httpx.MockTransport(refuse))
    assert [check.level for check in checks] == [CheckLevel.ERROR]


def test_doctor_detects_readable_private_keys_and_writable_known_hosts(tmp_path: Path):
    ssh_directory = tmp_path / ".ssh"
    ssh_directory.mkdir(mode=0o700)
    key = ssh_directory / "id_ed25519"
    key.write_text("private")
    key.chmod(0o644)
    (ssh_directory / "id_ed25519.pub").write_text("public")
    known_hosts = ssh_directory / "known_hosts"
    known_hosts.write_text("host key")
    known_hosts.chmod(0o666)

    checks = {check.name: check.level for check in check_ssh_files(ssh_directory, [], [])}
    assert checks == {
        "ssh directory": CheckLevel.OK,
        "ssh key id_ed25519": CheckLevel.ERROR,
        "known_hosts known_hosts": CheckLevel.ERROR,
    }

    key.chmod(0o600)
    known_hosts.chmod(0o644)
    assert all(check.level is CheckLevel.OK for check in check_ssh_files(ssh_directory, [], []))
    missing = check_ssh_files(ssh_directory, [tmp_path / "target-key"], [tmp_path / "target_known_hosts"])
    assert [check.level for check in missing[1:]] == [CheckLevel.ERROR, CheckLevel.ERROR]


def test_doctor_checks_the_installed_environment_file_mode(home: Path, capsys: pytest.CaptureFixture[str]):
    installed_layout(home, home / "state")
    environment_file = home / ".config/mado-tracking-worker/gpu-host-1.env"
    environment_file.chmod(0o644)
    checks = cli.doctor_checks(cli.build_parser().parse_args(["doctor", "--worker-id", WORKER_ID]))
    assert checks[0].name == "environment file" and checks[0].level is CheckLevel.ERROR
    assert all(TOKEN not in check.detail for check in checks)


def test_bare_command_and_once_still_run_the_worker():
    assert cli.normalize_arguments([]) == ["run"]
    assert cli.normalize_arguments(["--once"]) == ["run", "--once"]
    assert cli.normalize_arguments(["status", "--worker-id", WORKER_ID])[0] == "status"


def test_token_file_is_loaded_as_the_api_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    token_file = tmp_path / "secret"
    token_file.write_text(TOKEN + "\n")
    monkeypatch.delenv("MMT_API_TOKEN", raising=False)
    monkeypatch.setenv("MMT_API_TOKEN_FILE", str(token_file))
    cli.load_token_file()
    assert os.environ["MMT_API_TOKEN"] == TOKEN


def test_instance_name_is_the_worker_id():
    assert instance_unit_name(WORKER_ID) == UNIT_NAME
