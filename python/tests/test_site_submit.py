"""`mado-tracking submit` on a login node: waiting Jobs, claim, local job shell, report."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from site_fixtures import site_job, submission_for

from mado_tracking.client import Client
from mado_tracking.errors import ConfigurationError
from mado_tracking.site.manual_submit import (
    ManualSubmitter,
    SubmitOptions,
    site_settings,
    submitter_id,
    with_variables,
)

API_TOKEN = "mmt_personal-token-of-alice"
RUNTIME = {"kind": "apptainer", "artifactId": "artifact", "sha256": "0" * 64}


class ManualApi:
    def __init__(self, target_id: str, submissions: list[dict]):
        self.target_id = target_id
        self.submissions = submissions
        self.calls: list[tuple[str, str, dict]] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {API_TOKEN}"
        body = json.loads(request.content or b"{}")
        path = request.url.path.removeprefix("/api/manual-submissions")
        self.calls.append((request.method, path, body))
        if request.method == "GET" and path == "":
            waiting = [
                {"targetId": self.target_id, "targetName": "Miyabi-G", "waitingJobs": len(self.submissions)}
            ]
            return httpx.Response(200, json={"items": waiting})
        if path == "/claim":
            items, self.submissions = self.submissions, []
            return httpx.Response(200, json={"items": items})
        if path == "/report":
            return httpx.Response(200, json={"items": []})
        return httpx.Response(404, json={"error": "unknown route"})

    def client(self) -> Client:
        return Client(
            api_url="https://mmt.example.invalid",
            api_token=API_TOKEN,
            transport=httpx.MockTransport(self.serve),
        )


def options_for(tmp_path: Path, target_id: str, **overrides) -> SubmitOptions:
    job_shell = tmp_path / "job.sh"
    job_shell.write_text(
        "#!/bin/sh\n"
        'env | grep "^MMT_VAR_" > "$MMT_SPEC_DIR/vars.env"\n'
        'echo "Job 9001.miyabi submitted"\n'
        "echo 9001.miyabi\n"
    )
    values = {
        "target_id": target_id,
        "config_path": tmp_path / "missing.toml",
        "job_shell": job_shell,
        "work_dir": str(tmp_path / "work"),
    }
    return SubmitOptions(**{**values, **overrides})


def test_submit_claims_own_jobs_runs_the_local_job_shell_and_reports(tmp_path):
    submission = submission_for(
        [
            site_job(
                project_id=str(uuid4()),
                source_files={"main.py": ""},
                runtime=RUNTIME,
                runtime_kinds=["apptainer"],
            )
        ]
    )
    target_id = submission["target"]["id"]
    api = ManualApi(target_id, [submission])
    lines: list[str] = []
    options = with_variables(options_for(tmp_path, target_id), ["GROUP=gxx50000"])
    with api.client() as client:
        exit_code = ManualSubmitter(
            options, client=client, print_line=lines.append, state_directory=tmp_path / "state"
        ).run()
    assert exit_code == 0
    job_id = submission["jobs"][0]["job"]["id"]
    claim = next(body for method, path, body in api.calls if path == "/claim")
    assert claim == {"targetId": target_id, "submitterId": submitter_id(), "limit": 50}
    report = next(body for method, path, body in api.calls if path == "/report")
    assert report["submitterId"] == submitter_id()
    assert report["results"] == [
        {"jobIds": [job_id], "outcome": "submitted", "schedulerJobId": "9001.miyabi", "error": None}
    ]
    assert lines == ["Miyabi-G: 1 Job(s) wait for submission", f"submitted {job_id} as 9001.miyabi"]
    spec = tmp_path / "work/.mmt-submissions" / job_id
    assert (spec / "vars.env").read_text() == "MMT_VAR_GROUP=gxx50000\n"
    # The runner on the compute node reaches the API the person used.
    assert json.loads((spec / "api.json").read_text()) == {"apiUrl": "https://mmt.example.invalid/api"}
    assert not list((tmp_path / "state/pending").iterdir())


def test_a_dry_run_shows_the_waiting_jobs_without_claiming(tmp_path):
    submission = submission_for(
        [
            site_job(
                project_id=str(uuid4()),
                source_files={"main.py": ""},
                runtime=RUNTIME,
                runtime_kinds=["apptainer"],
            )
        ]
    )
    target_id = submission["target"]["id"]
    api = ManualApi(target_id, [submission])
    lines: list[str] = []
    with api.client() as client:
        exit_code = ManualSubmitter(
            options_for(tmp_path, target_id, dry_run=True),
            client=client,
            print_line=lines.append,
            state_directory=tmp_path / "state",
        ).run()
    assert exit_code == 0 and [path for _method, path, _body in api.calls] == [""]
    assert lines[0] == "Miyabi-G: 1 Job(s) wait for submission" and lines[1].startswith(
        "dry run: would submit with"
    )


def test_site_defaults_come_from_the_submit_config_and_the_command_line_wins(tmp_path):
    target_id = str(uuid4())
    (tmp_path / "shells").mkdir()
    (tmp_path / "shells/job.sh").write_text("#!/bin/sh\n")
    config = tmp_path / "submit.toml"
    config.write_text(
        f'[sites."{target_id}"]\n'
        'job_shell = "shells/job.sh"\n'
        'work_dir = "/work/me/mmt"\n'
        'variables = { GROUP = "a", QUEUE = "gpu" }\n'
    )
    options = with_variables(
        SubmitOptions(target_id=target_id, config_path=config, work_dir="/work/other"), ["GROUP=b"]
    )
    settings = site_settings(options)
    assert settings.job_shell == tmp_path / "shells/job.sh" and settings.work_dir == "/work/other"
    assert dict(settings.variables) == {"GROUP": "b", "QUEUE": "gpu"}
    with pytest.raises(ConfigurationError, match="--job-shell"):
        site_settings(SubmitOptions(target_id=str(uuid4()), config_path=config))
    with pytest.raises(ConfigurationError, match="NAME=VALUE"):
        with_variables(options, ["novalue"])
