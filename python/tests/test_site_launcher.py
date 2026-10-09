"""The launcher with a local site: claim → spec directory → job shell → report, and cancellations."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fake_site_api import SiteApi
from site_fixtures import install_fake_sif_cli, site_job, submission_for
from test_site_runner import RESULT_ENTRYPOINT

from mado_tracking.client import Client
from mado_tracking.errors import ConfigurationError, TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.site.launcher import Launcher
from mado_tracking.site.launcher_config import load_launcher_config
from mado_tracking.site.transport import SshEndpoint, SshSiteTransport, ssh_config_text

WORKER_TOKEN = "mmtw_launcher-project-token"
RUNTIME = {"kind": "apptainer", "artifactId": "artifact", "sha256": "0" * 64}
JOB_SHELL = """#!/bin/sh
set -eu
env | grep '^MMT_' | sort > "$MMT_SPEC_DIR/job-shell.env"
echo "Submitting $MMT_ARRAY_SIZE job(s)"
echo "4242.pbs"
"""


class LauncherApi:
    """The worker site-submission endpoints, answered in memory."""

    def __init__(self) -> None:
        self.submissions: list[dict] = []
        self.cancellations: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.report_statuses: list[int] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {WORKER_TOKEN}"
        body = json.loads(request.content or b"{}")
        path = request.url.path.removeprefix("/api/worker/site-submissions")
        self.calls.append((path, body))
        if path == "/claim":
            items, self.submissions = self.submissions, []
            return httpx.Response(200, json={"items": items})
        if path == "/report":
            status = self.report_statuses.pop(0) if self.report_statuses else 200
            if status != 200:
                return httpx.Response(status, json={"error": "try again"})
            return httpx.Response(200, json={"items": []})
        if path == "/cancellations":
            items, self.cancellations = self.cancellations, []
            return httpx.Response(200, json={"items": items})
        if path == "/cancellations/report":
            return httpx.Response(204)
        return httpx.Response(404, json={"error": "unknown route"})

    def reports(self) -> list[dict]:
        return [result for path, body in self.calls if path == "/report" for result in body["results"]]

    def client(self, **options) -> Client:
        return Client(transport=httpx.MockTransport(self.serve), **options)


def write_config(
    tmp_path: Path, *, target_id: str, account_mode: str = "shared", job_shell: str = JOB_SHELL
) -> Path:
    token_file = tmp_path / "project.token"
    token_file.write_text(WORKER_TOKEN + "\n")
    token_file.chmod(0o600)
    (tmp_path / "job.sh").write_text(job_shell)
    accounts = (
        f"""
[sites.accounts."Alice@Example.org"]
user = "alice"
work_dir = "{tmp_path / "alice-work"}"
variables = {{ GROUP = "gxx50000" }}
"""
        if account_mode == "personal"
        else ""
    )
    config = tmp_path / "launcher.toml"
    config.write_text(
        f"""
launcher_id = "launcher-test"
state_directory = "{tmp_path / "state"}"
poll_seconds = 1

[[projects]]
name = "speech"
api_url = "http://api.example.invalid"
token_file = "project.token"

[[sites]]
target_id = "{target_id}"
job_shell = "job.sh"
work_dir = "{tmp_path / "work"}"
runner_python = "python3.12"
runner_api_url = "https://runner.example.invalid"
account_mode = "{account_mode}"
cancel_command = 'echo "$MMT_SCHEDULER_JOB_ID" >> "{tmp_path / "canceled.txt"}"'
variables = {{ QUEUE = "gpu" }}
connection = {{ local = true, user = "mmt" }}
{accounts}
"""
    )
    return config


def site_submission(count: int = 1, **options) -> dict:
    project_id = str(uuid4())
    jobs = [
        site_job(
            project_id=project_id,
            source_files={"main.py": ""},
            runtime=RUNTIME,
            runtime_kinds=["apptainer"],
            **options,
        )
        for _ in range(count)
    ]
    return submission_for(jobs)


def launcher_for(config: Path, api: LauncherApi) -> Launcher:
    return Launcher(load_launcher_config(config), client_factory=api.client)


def read_environment(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().splitlines())


def test_a_claimed_submission_is_written_submitted_and_reported_then_canceled_in_the_queue(tmp_path):
    submission = site_submission()
    target_id = submission["target"]["id"]
    job_id = submission["jobs"][0]["job"]["id"]
    config = write_config(tmp_path, target_id=target_id)
    api = LauncherApi()
    api.submissions = [submission]
    launcher = launcher_for(config, api)
    launcher.run_once()
    assert api.calls[0] == ("/claim", {"launcherId": "launcher-test", "targetIds": [target_id], "limit": 10})
    assert api.reports() == [
        {"jobIds": [job_id], "outcome": "submitted", "schedulerJobId": "4242.pbs", "error": None}
    ]
    spec = tmp_path / "work/.mmt-submissions" / job_id
    assert stat.S_IMODE(os.stat(spec).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(spec / "jobs/0.json").st_mode) == 0o600
    assert json.loads((spec / "jobs/0.json").read_text())["jobToken"].startswith("mmtj_")
    assert json.loads((spec / "submission.json").read_text())["jobs"][0]["jobToken"] is None
    assert json.loads((spec / "api.json").read_text()) == {"apiUrl": "https://runner.example.invalid"}
    environment = read_environment(spec / "job-shell.env")
    assert environment["MMT_SPEC_DIR"] == str(spec) and environment["MMT_JOB_IDS"] == job_id
    assert (environment["MMT_ARRAY_SIZE"], environment["MMT_WALLTIME"], environment["MMT_VAR_QUEUE"]) == (
        "1",
        "01:00:00",
        "gpu",
    )
    runner = Path(environment["MMT_RUNNER"])
    assert os.access(runner, os.X_OK) and "python3.12" in runner.read_text()
    assert not list((tmp_path / "state/pending-reports").iterdir())

    api.cancellations = [{"jobId": job_id, "targetId": target_id, "schedulerJobId": "4242.pbs"}]
    launcher.run_once()
    assert (tmp_path / "canceled.txt").read_text() == "4242.pbs\n"
    assert ("/cancellations/report", {"launcherId": "launcher-test", "jobIds": [job_id]}) in api.calls
    assert not list((tmp_path / "state/submissions").iterdir())
    launcher.close()


def test_an_array_on_an_array_site_is_one_job_shell_call(tmp_path):
    submission = site_submission(3, array_index=0, array_size=3)
    for index, job in enumerate(reversed(submission["jobs"])):
        job["job"]["arrayIndex"] = index
    api = LauncherApi()
    api.submissions = [submission]
    launcher = launcher_for(write_config(tmp_path, target_id=submission["target"]["id"]), api)
    launcher.run_once()
    [report] = api.reports()
    ordered = sorted(submission["jobs"], key=lambda job: job["job"]["arrayIndex"])
    assert report["jobIds"] == [job["job"]["id"] for job in ordered]
    spec = tmp_path / "work/.mmt-submissions" / ordered[0]["job"]["id"]
    assert read_environment(spec / "job-shell.env")["MMT_ARRAY_SIZE"] == "3"
    for index, job in enumerate(ordered):
        assert json.loads((spec / f"jobs/{index}.json").read_text())["job"]["id"] == job["job"]["id"]
    launcher.close()


def test_a_refusing_job_shell_reports_failed_with_a_masked_short_error(tmp_path):
    submission = site_submission()
    job_shell = f'#!/bin/sh\necho "qsub: token {WORKER_TOKEN} is not a project" >&2\nexit 3\n'
    api = LauncherApi()
    api.submissions = [submission]
    launcher = launcher_for(
        write_config(tmp_path, target_id=submission["target"]["id"], job_shell=job_shell), api
    )
    launcher.run_once()
    [report] = api.reports()
    assert report["outcome"] == "failed" and report["schedulerJobId"] is None
    assert report["error"].startswith("The job shell exited with status 3")
    assert WORKER_TOKEN not in report["error"] and "[REDACTED]" in report["error"]
    launcher.close()


def test_an_unreported_result_is_kept_and_resent_by_the_next_cycle(tmp_path):
    submission = site_submission()
    api = LauncherApi()
    api.submissions = [submission]
    api.report_statuses = [503] * 4
    launcher = launcher_for(write_config(tmp_path, target_id=submission["target"]["id"]), api)
    launcher.run_once()
    assert len(list((tmp_path / "state/pending-reports").iterdir())) == 1
    launcher.run_once()
    assert not list((tmp_path / "state/pending-reports").iterdir())
    assert api.reports()[-1]["schedulerJobId"] == "4242.pbs"
    launcher.close()


def test_personal_sites_submit_as_the_requester_or_fail_without_an_account(tmp_path):
    known, unknown = site_submission(), site_submission()
    unknown["requester"]["email"] = "bob@example.org"
    known["target"] = unknown["target"]
    api = LauncherApi()
    api.submissions = [known, unknown]
    launcher = launcher_for(
        write_config(tmp_path, target_id=known["target"]["id"], account_mode="personal"), api
    )
    launcher.run_once()
    outcomes = {report["jobIds"][0]: report for report in api.reports()}
    known_report = outcomes[known["jobs"][0]["job"]["id"]]
    assert known_report["outcome"] == "submitted"
    spec = tmp_path / "alice-work/.mmt-submissions" / known["jobs"][0]["job"]["id"]
    assert read_environment(spec / "job-shell.env")["MMT_VAR_GROUP"] == "gxx50000"
    unknown_report = outcomes[unknown["jobs"][0]["job"]["id"]]
    assert unknown_report["outcome"] == "failed" and "bob@example.org" in unknown_report["error"]
    launcher.close()


def test_personal_and_local_sites_name_no_shared_user(tmp_path):
    config = write_config(tmp_path, target_id=str(uuid4()), account_mode="personal")
    shared = 'connection = { local = true, user = "mmt" }'
    local = config.read_text().replace(shared, "connection = { local = true }")
    config.write_text(local)
    assert load_launcher_config(config).sites[0].connection.user == ""
    known_hosts = tmp_path / "known_hosts"
    known_hosts.write_text("")
    ssh = f'connection = {{ host = "login.example", known_hosts = "{known_hosts}" }}'
    config.write_text(local.replace("connection = { local = true }", ssh))
    connection = load_launcher_config(config).sites[0].connection
    assert (connection.host, connection.user) == ("login.example", "")


def test_the_configuration_refuses_readable_tokens_and_unknown_settings(tmp_path):
    config = write_config(tmp_path, target_id=str(uuid4()))
    (tmp_path / "project.token").chmod(0o644)
    with pytest.raises(ConfigurationError, match="readable"):
        load_launcher_config(config)
    (tmp_path / "project.token").chmod(0o600)
    config.write_text(config.read_text().replace("poll_seconds = 1", "poll_seconds = 1\npoll_secnds = 2"))
    with pytest.raises(ConfigurationError, match="poll_secnds"):
        load_launcher_config(config)


def test_ssh_sites_share_one_connection_and_jump_hosts_get_the_same_settings(tmp_path):
    key, known_hosts = tmp_path / "key", tmp_path / "known_hosts"
    key.write_text("private")
    key.chmod(0o600)
    known_hosts.write_text("login.example.org ssh-ed25519 AAAA\n")
    endpoint = SshEndpoint(
        host="login.example.org",
        port=2222,
        user="alice",
        identity_file=key,
        known_hosts=known_hosts,
        jump_hosts=("access.example.org", "bob@bastion:2200"),
    )
    transport = SshSiteTransport(endpoint, state_directory=tmp_path / "state", masker=SecretMasker())
    argv = transport.command_argv(["sh", "-c", 'echo "$1"', "_", "it's"])
    assert argv[:3] == ["ssh", "-F", str(transport.config_file)]
    assert f"ControlPath={transport.control_path}" in argv and "ControlMaster=no" in argv
    assert argv[argv.index("-J") + 1] == "access.example.org,bob@bastion:2200"
    assert argv[argv.index("-p") + 1] == "2222" and argv[argv.index("-l") + 1] == "alice"
    assert argv[-2:] == ["login.example.org", "sh -c 'echo \"$1\"' _ 'it'\"'\"'s'"]
    config = transport.config_file.read_text()
    assert config == ssh_config_text(endpoint)
    assert (
        "BatchMode yes" in config
        and "StrictHostKeyChecking yes" in config
        and f'IdentityFile "{key}"' in config
    )
    assert stat.S_IMODE(os.stat(transport.config_file).st_mode) == 0o600
    from mado_tracking.site.transport import CommandResult

    with pytest.raises(TransportError):
        transport.check_connection(CommandResult(255, b"", b"Permission denied (publickey)"))
    transport.check_connection(CommandResult(1, b"", b"command failed"))
    for invalid in ({"host": "-oProxyCommand=x"}, {"user": "a b"}, {"jump_hosts": ("bad host",)}):
        with pytest.raises(ConfigurationError):
            SshEndpoint(**{**endpoint.__dict__, **invalid})


def test_launcher_job_shell_and_installed_runner_complete_a_job(tmp_path, monkeypatch):
    """The whole chain on a direct host: the job shell starts MMT_RUNNER, which reports by itself."""
    install_fake_sif_cli(tmp_path, monkeypatch)
    # The installed zipapp must not borrow this checkout's package.
    monkeypatch.delenv("PYTHONPATH", raising=False)
    direct_shell = (
        "#!/bin/sh\nset -eu\n"
        'MMT_ARRAY_INDEX=0 "$MMT_RUNNER" "$MMT_SPEC_DIR" 2> "$MMT_SPEC_DIR/runner.log"\n'
        'echo ""\n'
    )
    with SiteApi() as site:
        sif = b"sif bytes"
        runtime = {
            "kind": "apptainer",
            "artifactId": site.add_artifact(sif),
            "sha256": hashlib.sha256(sif).hexdigest(),
        }
        job = site_job(
            project_id=str(uuid4()),
            source_files={"main.py": RESULT_ENTRYPOINT},
            runtime=runtime,
            runtime_kinds=["apptainer"],
        )
        submission = submission_for([job])
        config = write_config(tmp_path, target_id=submission["target"]["id"], job_shell=direct_shell)
        config.write_text(
            config.read_text()
            .replace('runner_python = "python3.12"', f'runner_python = "{sys.executable}"')
            .replace("https://runner.example.invalid", site.url)
        )
        api = LauncherApi()
        api.submissions = [submission]
        launcher = launcher_for(config, api)
        launcher.run_once()
        launcher.close()
    [report] = api.reports()
    assert report == {
        "jobIds": [job["job"]["id"]],
        "outcome": "submitted",
        "schedulerJobId": None,
        "error": None,
    }
    assert site.actions()[0] == "start" and site.bodies("finish")[0]["status"] == "finished"
    assert dict(site.uploads)["container/shard-0.tar"] == b"generated speech shard"
