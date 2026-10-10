"""`mado-tracking submit`: the site's settings from the Web, claim, local job shell, report, --all
and --watch."""

from __future__ import annotations

import json
import os
import signal
import stat
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from site_fixtures import (
    account_document,
    job_shell_document,
    site_job,
    site_settings_document,
    submission_for,
)

from mado_tracking.cli import build_parser
from mado_tracking.client import Client
from mado_tracking.errors import ApiError, ConfigurationError
from mado_tracking.site.manual_submit import ManualSubmitter, SubmitOptions, submitter_id, with_variables
from mado_tracking.site.submit_cli import stop_on_signals

API_TOKEN = "mmt_personal-token-of-alice"
RUNTIME = {"kind": "apptainer", "artifactId": "artifact", "sha256": "0" * 64}
JOB_SHELL = (
    "#!/bin/sh\n"
    'env | grep "^MMT_VAR_" | sort > "$MMT_SPEC_DIR/vars.env"\n'
    'echo "Job 9001.miyabi submitted"\n'
    "echo 9001.miyabi\n"
)
# A manual site: no launcher logs in, and whoever runs `submit` submits.
MANUAL_SETTINGS = site_settings_document(
    launcherId=None, connection=None, accountMode="personal", sharedAccount=""
)


def web_account(tmp_path: Path, **options: Any) -> dict:
    """One's own account on the site as the Web has it: work directory and variables."""
    values = {"work_directory": str(tmp_path / "web-work"), "variables": {"GROUP": "web", "QUEUE": "gpu"}}
    return account_document(**{**values, **options})


def manual_submission(account: dict, target: dict | None = None) -> dict:
    job = site_job(
        project_id=str(uuid4()), source_files={"main.py": ""}, runtime=RUNTIME, runtime_kinds=["apptainer"]
    )
    if target is not None:
        job["target"] = target
    return submission_for(
        [job], settings=MANUAL_SETTINGS, job_shell=JOB_SHELL, job_shell_version=2, account=account
    )


class ManualApi:
    """The manual-submission endpoints of one site, answered in memory."""

    def __init__(self, target: dict, account: dict, *, owner: bool = False):
        self.target = target
        self.owner = owner
        self.mine: list[dict] = []
        self.others: list[dict] = []
        self.configuration = {
            "target": target,
            "settings": MANUAL_SETTINGS,
            "jobShell": job_shell_document(JOB_SHELL, target_id=target["id"], version=2),
            "account": account,
        }
        # Statuses of the next GET /manual-submissions attempts (200 once they run out).
        self.waiting_statuses: list[int] = []
        self.after_waiting: Callable[[int], None] | None = None
        self.calls: list[tuple[str, str, Any]] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {API_TOKEN}"
        path = request.url.path.removeprefix("/api/manual-submissions")
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if (request.method, path) == ("GET", ""):
            return self.waiting()
        if (request.method, path) == ("GET", f"/sites/{self.target['id']}"):
            return httpx.Response(200, json=self.configuration)
        if path == "/claim":
            if body["all"] and not self.owner:
                return httpx.Response(403, json={"error": "owners only", "code": "site_owner_required"})
            taken = (self.mine + self.others if body["all"] else self.mine)[: body["limit"]]
            self.mine = [item for item in self.mine if item not in taken]
            self.others = [item for item in self.others if item not in taken]
            return httpx.Response(200, json={"items": taken})
        if path == "/report":
            return httpx.Response(200, json={"items": []})
        return httpx.Response(404, json={"error": "unknown route"})

    def waiting(self) -> httpx.Response:
        if self.after_waiting is not None:
            self.after_waiting(len(self.bodies("GET", "")))
        status = self.waiting_statuses.pop(0) if self.waiting_statuses else 200
        if status != 200:
            return httpx.Response(status, json={"error": "the API is restarting"})
        if not self.mine and not (self.owner and self.others):
            return httpx.Response(200, json={"items": []})
        entry = {
            "targetId": self.target["id"],
            "targetName": "Miyabi-G",
            "waitingJobs": len(self.mine),
            "allWaitingJobs": len(self.mine) + len(self.others) if self.owner else None,
        }
        return httpx.Response(200, json={"items": [entry]})

    def bodies(self, method: str, path: str) -> list[Any]:
        return [body for called, route, body in self.calls if (called, route) == (method, path)]

    def routes(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path, _body in self.calls]

    def client(self) -> Client:
        return Client(
            api_url="https://mmt.example.invalid",
            api_token=API_TOKEN,
            transport=httpx.MockTransport(self.serve),
        )


def submitter_for(
    api: ManualApi, options: SubmitOptions, tmp_path: Path, lines: list[str]
) -> ManualSubmitter:
    return ManualSubmitter(
        options, client=api.client(), print_line=lines.append, state_directory=tmp_path / "state"
    )


def test_submit_runs_the_job_shell_from_the_web_with_this_runs_overrides(tmp_path):
    account = web_account(tmp_path)
    submission = manual_submission(account)
    target_id, job_id = submission["target"]["id"], submission["jobs"][0]["job"]["id"]
    api = ManualApi(submission["target"], account)
    api.mine = [submission]
    lines: list[str] = []
    options = with_variables(
        SubmitOptions(target_id=target_id, work_dir=str(tmp_path / "work")), ["GROUP=gxx50000"]
    )
    assert submitter_for(api, options, tmp_path, lines).run_once() == 0
    site_route = f"/sites/{target_id}"
    assert api.routes() == [("GET", ""), ("GET", site_route), ("POST", "/claim"), ("POST", "/report")]
    assert api.bodies("POST", "/claim") == [
        {"targetId": target_id, "submitterId": submitter_id(), "limit": 50, "all": False}
    ]
    [report] = api.bodies("POST", "/report")
    assert report == {
        "submitterId": submitter_id(),
        "results": [
            {"jobIds": [job_id], "outcome": "submitted", "schedulerJobId": "9001.miyabi", "error": None}
        ],
    }
    assert lines == ["Miyabi-G: 1 Job(s) wait for submission", f"submitted {job_id} as 9001.miyabi"]
    # --work-dir and --var apply on top of one's settings on the Web, for this run only.
    spec = tmp_path / "work/.mmt-submissions" / job_id
    assert (spec / "vars.env").read_text() == "MMT_VAR_GROUP=gxx50000\nMMT_VAR_QUEUE=gpu\n"
    assert [path.read_text() for path in (tmp_path / "work/.mmt-job-shells").glob("*/job.sh")] == [JOB_SHELL]
    # The runner on the compute node reaches the API the person used.
    assert json.loads((spec / "api.json").read_text()) == {"apiUrl": "https://mmt.example.invalid/api"}
    assert not (tmp_path / "web-work").exists()
    assert not list((tmp_path / "state/pending").iterdir())


def test_all_takes_everyones_jobs_on_a_computer_one_owns_and_only_there(tmp_path):
    account = web_account(tmp_path)
    of_bob = manual_submission(account)
    api = ManualApi(of_bob["target"], account, owner=True)
    api.others = [of_bob]
    lines: list[str] = []
    options = SubmitOptions(target_id=of_bob["target"]["id"], all_jobs=True)
    assert submitter_for(api, options, tmp_path, lines).run_once() == 0
    assert api.bodies("POST", "/claim")[0]["all"] is True
    assert lines[0] == "Miyabi-G: 1 Job(s) wait for submission" and lines[1].startswith("submitted ")
    # Without --work-dir the work directory and variables are one's own from the Web.
    spec = tmp_path / "web-work/.mmt-submissions" / of_bob["jobs"][0]["job"]["id"]
    assert (spec / "vars.env").read_text() == "MMT_VAR_GROUP=web\nMMT_VAR_QUEUE=gpu\n"

    mine = manual_submission(account)
    not_owned = ManualApi(mine["target"], account)
    not_owned.mine = [mine]
    with pytest.raises(ConfigurationError, match="is not yours"):
        submitter_for(
            not_owned, SubmitOptions(target_id=mine["target"]["id"], all_jobs=True), tmp_path, []
        ).run_once()
    assert ("POST", "/claim") not in not_owned.routes()


def test_a_registry_login_reaches_the_runners_and_a_readable_one_stops_before_any_claim(tmp_path):
    account = web_account(tmp_path)
    submission = manual_submission(account)
    target_id, job_id = submission["target"]["id"], submission["jobs"][0]["job"]["id"]
    api = ManualApi(submission["target"], account)
    api.mine = [submission]
    registry_login = tmp_path / "pull.json"
    registry_login.write_text(json.dumps({"username": "puller", "password": "pull-secret"}))
    registry_login.chmod(0o640)
    options = SubmitOptions(target_id=target_id, registry_secret_file=registry_login)
    with pytest.raises(ConfigurationError, match="--registry-secret-file .* must not be readable by group"):
        submitter_for(api, options, tmp_path, []).run_once()
    assert ("POST", "/claim") not in api.routes()
    registry_login.chmod(0o600)
    assert submitter_for(api, options, tmp_path, []).run_once() == 0
    secrets = tmp_path / "web-work/.mmt-submissions" / job_id / "secrets.json"
    assert json.loads(secrets.read_text()) == {"registry": {"username": "puller", "password": "pull-secret"}}
    assert stat.S_IMODE(os.stat(secrets).st_mode) == 0o600


def test_a_dry_run_shows_the_waiting_jobs_and_settings_without_claiming(tmp_path):
    account = web_account(tmp_path)
    submission = manual_submission(account)
    api = ManualApi(submission["target"], account)
    api.mine = [submission]
    lines: list[str] = []
    options = SubmitOptions(target_id=submission["target"]["id"], dry_run=True)
    assert submitter_for(api, options, tmp_path, lines).run_once() == 0
    assert api.routes() == [("GET", ""), ("GET", f"/sites/{submission['target']['id']}")]
    assert lines == [
        "Miyabi-G: 1 Job(s) wait for submission",
        f"dry run: would submit with job shell v2 in {tmp_path / 'web-work'}",
    ]


def test_nothing_is_claimed_without_a_job_shell_or_a_work_directory(tmp_path):
    account = web_account(tmp_path, work_directory="")
    submission = manual_submission(account)
    target_id = submission["target"]["id"]
    api = ManualApi(submission["target"], account)
    api.mine = [submission]
    with pytest.raises(ConfigurationError, match="No work directory"):
        submitter_for(api, SubmitOptions(target_id=target_id), tmp_path, []).run_once()
    api.configuration["jobShell"] = None
    with pytest.raises(ConfigurationError, match="no job shell yet"):
        submitter_for(
            api, SubmitOptions(target_id=target_id, work_dir=str(tmp_path / "work")), tmp_path, []
        ).run_once()
    assert ("POST", "/claim") not in api.routes()


def test_watch_keeps_submitting_outlasts_temporary_failures_and_stops(tmp_path, monkeypatch):
    monkeypatch.setattr("mado_tracking.http.retry_delay", lambda _attempt, _response=None: 0.0)
    account = web_account(tmp_path)
    submission = manual_submission(account)
    target_id, job_id = submission["target"]["id"], submission["jobs"][0]["job"]["id"]
    api = ManualApi(submission["target"], account)
    api.mine = [submission]
    # Round 1 submits; round 2 meets an API that answers 503 to every retry; round 3 finds nothing.
    api.waiting_statuses = [200, 503, 503, 503, 503]
    stop = threading.Event()
    api.after_waiting = lambda calls: stop.set() if calls == 6 else None
    lines: list[str] = []
    submitter = submitter_for(api, SubmitOptions(target_id=target_id), tmp_path, lines)
    assert submitter.watch(stop, interval=0.01) == 0
    assert lines == [
        f"Watching {target_id} every 0.01 seconds; Ctrl-C stops",
        "Miyabi-G: 1 Job(s) wait for submission",
        f"submitted {job_id} as 9001.miyabi",
        "the API is restarting; trying again in 0.01 seconds",
        f"{target_id}: 0 Job(s) wait for submission",
        "stopped",
    ]
    # A refusal that a later round would meet again (a revoked token) ends the watch.
    api.waiting_statuses = [401]
    with pytest.raises(ApiError):
        submitter.watch(threading.Event(), interval=0.01)


def test_the_command_line_takes_the_new_options_and_refuses_the_old_ones(capsys):
    target_id = str(uuid4())
    parser = build_parser()
    arguments = parser.parse_args(
        ["submit", "--site", target_id, "--all", "--watch", "--interval", "5", "--limit", "3", "--var", "A=b"]
        + ["--registry-secret-file", "pull.json"]
    )
    assert (arguments.all_jobs, arguments.watch, arguments.interval, arguments.limit, arguments.var) == (
        True,
        True,
        5.0,
        3,
        ["A=b"],
    )
    assert arguments.registry_secret_file == Path("pull.json")
    for retired in (["--job-shell", "job.sh"], ["--config", "submit.toml"], ["--watch", "--dry-run"]):
        with pytest.raises(SystemExit):
            parser.parse_args(["submit", "--site", target_id, *retired])
    capsys.readouterr()
    for refused, message in (
        (["--interval", "5"], "--interval goes with --watch"),
        (["--watch", "--interval", "0.5"], "--interval must be at least 1 (seconds)"),
        (["--work-dir", "relative/dir"], "--work-dir must be an absolute path"),
        (["--var", "1A=b"], "is not a shell variable name"),
        (["--var", "novalue"], "NAME=VALUE"),
        (["--limit", "0"], "--limit must be from 1 to 50"),
    ):
        arguments = parser.parse_args(["submit", "--site", target_id, *refused])
        assert arguments.handler(arguments) == 2
        assert message in capsys.readouterr().err


def test_the_first_signal_ends_the_watch_after_its_round_and_gives_the_next_back():
    originals = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    stop = threading.Event()
    try:
        stop_on_signals(stop)
        assert signal.getsignal(signal.SIGTERM) not in originals.values()
        signal.raise_signal(signal.SIGTERM)
        assert stop.wait(1)
        assert {number: signal.getsignal(number) for number in originals} == originals
    finally:
        for number, handler in originals.items():
            signal.signal(number, handler)
