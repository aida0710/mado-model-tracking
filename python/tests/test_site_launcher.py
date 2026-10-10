"""The launcher's poll with logins that run locally: claim → spec directory → job shell → report,
cancellations in the scheduler queue, its TOML, and the SSH command lines it would run."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat
import sys
import time
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

import pytest
from fake_launcher_api import LAUNCHER_TOKEN, FakeLauncherApi, LocalLogins, install_fake_ssh_keygen
from fake_site_api import JOB_TOKEN, SiteApi
from site_fixtures import (
    account_document,
    install_fake_sif_cli,
    job_shell_document,
    site_job,
    site_settings_document,
    submission_for,
)
from test_site_runner import RESULT_ENTRYPOINT

from mado_tracking.errors import ConfigurationError, TransportError
from mado_tracking.security import SecretMasker
from mado_tracking.site.launcher import Launcher
from mado_tracking.site.launcher_config import load_launcher_config
from mado_tracking.site.site_settings import SubmissionAccount
from mado_tracking.site.transport import (
    CommandResult,
    LoginRefused,
    SshEndpoint,
    SshSiteTransport,
    ssh_config_text,
)

RUNTIME = {"kind": "apptainer", "artifactId": "artifact", "sha256": "0" * 64}
JOB_SHELL = """#!/bin/sh
set -eu
env | grep '^MMT_' | sort > "$MMT_SPEC_DIR/job-shell.env"
echo "Submitting $MMT_ARRAY_SIZE job(s)"
echo "4242.pbs"
"""


@pytest.fixture
def keygen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return install_fake_ssh_keygen(tmp_path, monkeypatch)


def write_config(tmp_path: Path, **settings: str) -> Path:
    """launcher.toml beside the launcher's token file; `settings` are TOML values by key."""
    token_file = tmp_path / "launcher.token"
    token_file.write_text(LAUNCHER_TOKEN + "\n")
    token_file.chmod(0o600)
    values = {
        "api_url": '"http://api.example.invalid"',
        "token_file": '"launcher.token"',
        "state_directory": f'"{tmp_path / "state"}"',
        "poll_seconds": "1",
        **settings,
    }
    config = tmp_path / "launcher.toml"
    config.write_text("".join(f"{key} = {value}\n" for key, value in values.items()))
    return config


def launcher_for(
    tmp_path: Path,
    api: FakeLauncherApi,
    logins: LocalLogins,
    *,
    clock: Callable[[], float] = time.monotonic,
    **settings: str,
) -> Launcher:
    """A launcher with a launcher.toml of `settings` (TOML values by key) on top of the defaults."""
    return Launcher(
        load_launcher_config(write_config(tmp_path, **settings)),
        client_factory=api.client,
        transport_factory=logins,
        clock=clock,
    )


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


def queue_on_assigned_site(
    api: FakeLauncherApi,
    submission: dict,
    *,
    work_directory: str,
    job_shell: str = JOB_SHELL,
    mode: str = "shared",
    account_name: str = "mmt",
    variables: dict[str, str] | None = None,
    **settings,
) -> dict:
    """Assign the submission's site to the launcher with a key for its account, and queue it."""
    target = submission["target"]
    site_settings = site_settings_document(**settings)
    api.assign_site(target, site_settings)
    account = account_document(
        mode=mode,
        account_name=account_name,
        work_directory=work_directory,
        variables=variables,
        key_id=api.add_key(target["id"], user_id=str(uuid4()) if mode == "personal" else None),
    )
    submission.update(
        settings=site_settings,
        jobShell=job_shell_document(job_shell, target_id=target["id"], version=3),
        account=account,
    )
    api.submissions.append(submission)
    return account


def read_environment(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text().splitlines())


def mode_of(path: Path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def test_launcher_toml_holds_only_how_the_launcher_starts(tmp_path):
    secret = tmp_path / "pull.json"
    secret.write_text(json.dumps({"username": "puller", "password": "pull-secret"}))
    secret.chmod(0o600)
    config = load_launcher_config(
        write_config(tmp_path, poll_seconds="5", registry_secret_file='"pull.json"')
    )
    assert (config.api_url, config.token, config.state_directory, config.poll_seconds) == (
        "http://api.example.invalid",
        LAUNCHER_TOKEN,
        tmp_path / "state",
        5.0,
    )
    assert config.spec_secrets() == {"registry": {"username": "puller", "password": "pull-secret"}}
    assert LAUNCHER_TOKEN not in repr(config)
    path = write_config(tmp_path)
    text = path.read_text()
    for refused, message in (
        (text + '[[sites]]\ntarget_id = "x"\n[sites.connection]\nlocal = true\n', "sites are no longer read"),
        (text + '[[projects]]\nname = "speech"\n', "projects are no longer read"),
        (text + "poll_secnds = 2\n", "poll_secnds"),
        (text.replace('"http://api.example.invalid"', '"api.example.invalid"'), "api_url"),
        (
            "".join(line + "\n" for line in text.splitlines() if not line.startswith("state_")),
            "state_directory",
        ),
    ):
        path.write_text(refused)
        with pytest.raises(ConfigurationError, match=message):
            load_launcher_config(path)
    path = write_config(tmp_path)
    (tmp_path / "launcher.token").chmod(0o640)
    with pytest.raises(ConfigurationError, match="readable by group or others"):
        load_launcher_config(path)
    (tmp_path / "launcher.token").write_text("not a token\n")
    (tmp_path / "launcher.token").chmod(0o600)
    with pytest.raises(ConfigurationError, match="launcher's token alone"):
        load_launcher_config(path)
    with_secret = write_config(tmp_path, registry_secret_file='"pull.json"')
    secret.chmod(0o644)
    with pytest.raises(ConfigurationError, match="readable by group or others"):
        load_launcher_config(with_secret)
    secret.chmod(0o600)
    secret.write_text("not json")
    with pytest.raises(ConfigurationError, match="username and password"):
        load_launcher_config(with_secret)


def test_a_state_directory_too_deep_for_ssh_control_sockets_is_named_at_start(
    tmp_path, ssh_state_directory, caplog
):
    for state_directory, warned in ((ssh_state_directory, False), (tmp_path / ("d" * 100), True)):
        caplog.clear()
        config = load_launcher_config(write_config(tmp_path, state_directory=f'"{state_directory}"'))
        Launcher(config, client_factory=FakeLauncherApi().client).close()
        assert ("too deep for SSH control sockets" in caplog.text) is warned


def test_a_claimed_submission_runs_as_its_account_and_is_reported_then_canceled_in_the_queue(
    tmp_path, keygen
):
    api, logins = FakeLauncherApi(), LocalLogins()
    submission = site_submission()
    target_id, job_id = submission["target"]["id"], submission["jobs"][0]["job"]["id"]
    account = queue_on_assigned_site(
        api,
        submission,
        work_directory=str(tmp_path / "alice-work"),
        mode="personal",
        account_name="alice",
        variables={"QUEUE": "gpu", "GROUP": "gxx50000"},
        accountMode="personal",
        runnerPython="python3.12",
        runnerApiUrl="https://runner.example.invalid",
        cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{tmp_path / "canceled.txt"}"',
        cancelGraceSeconds=600,
        maxActiveSubmissions=7,
    )
    launcher = launcher_for(tmp_path, api, logins)
    launcher.run_once()
    # The API knows the launcher by its token: no request names it.
    assert api.bodies("POST", "launcher/site-submissions/claim") == [{"targetIds": [target_id], "limit": 7}]
    [report_body] = api.bodies("POST", "launcher/site-submissions/report")
    assert report_body == {
        "results": [{"jobIds": [job_id], "outcome": "submitted", "schedulerJobId": "4242.pbs", "error": None}]
    }

    # It logged in as the account the submission names, with that account's key and the
    # site's known_hosts from the Web.
    state = tmp_path / "state"
    [login] = logins.shared()
    assert (login.endpoint.host, login.endpoint.port, login.endpoint.user) == (
        "login.example.org",
        22,
        "alice",
    )
    assert login.endpoint.identity_file == state / "keys" / account["keyId"]
    assert login.endpoint.known_hosts == state / "known-hosts" / target_id
    assert login.endpoint.known_hosts.read_text() == submission["settings"]["connection"]["knownHosts"]
    assert mode_of(login.endpoint.known_hosts) == 0o600

    # The job shell is the submission's version; work directory and variables are the account's.
    spec = tmp_path / "alice-work/.mmt-submissions" / job_id
    assert mode_of(spec) == 0o700 and mode_of(spec / "jobs/0.json") == 0o600
    assert json.loads((spec / "jobs/0.json").read_text())["jobToken"].startswith("mmtj_")
    recorded = json.loads((spec / "submission.json").read_text())
    assert recorded["jobs"][0]["jobToken"] is None
    # Which job shell version it was, not its content: that is installed once, on its own.
    assert recorded["jobShell"] == {key: submission["jobShell"][key] for key in ("id", "version", "sha256")}
    assert json.loads((spec / "api.json").read_text()) == {"apiUrl": "https://runner.example.invalid"}
    runner_settings = json.loads((spec / "runner.json").read_text())
    assert (runner_settings["workDirectory"], runner_settings["cancelGraceSeconds"]) == (
        str(tmp_path / "alice-work"),
        600,
    )
    environment = read_environment(spec / "job-shell.env")
    assert environment["MMT_SPEC_DIR"] == str(spec) and environment["MMT_JOB_IDS"] == job_id
    assert (environment["MMT_VAR_QUEUE"], environment["MMT_VAR_GROUP"], environment["MMT_WALLTIME"]) == (
        "gpu",
        "gxx50000",
        "01:00:00",
    )
    job_shells = list((tmp_path / "alice-work/.mmt-job-shells").glob("*/job.sh"))
    assert [path.read_text() for path in job_shells] == [JOB_SHELL]
    runner = Path(environment["MMT_RUNNER"])
    assert os.access(runner, os.X_OK) and "python3.12" in runner.read_text()
    assert not list((state / "pending-reports").iterdir())
    record = json.loads((state / "submissions" / f"{job_id}.json").read_text())
    assert (record["accountName"], record["keyId"]) == ("alice", account["keyId"])

    # Canceled in the queue: the site's cancel command runs as the account the API names.
    api.cancellations = [
        {"jobId": job_id, "targetId": target_id, "schedulerJobId": "4242.pbs", "account": account}
    ]
    launcher.run_once()
    assert (tmp_path / "canceled.txt").read_text() == "4242.pbs\n"
    assert api.bodies("POST", "launcher/site-submissions/cancellations")[-1] == {"targetIds": [target_id]}
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == [{"jobIds": [job_id]}]
    assert logins.shared() == [login] and login.commands[-1][:2] == ["env", "MMT_SCHEDULER_JOB_ID=4242.pbs"]
    assert not list((state / "submissions").iterdir())
    launcher.close()
    assert login.closed


def test_an_array_on_an_array_site_is_one_job_shell_call(tmp_path, keygen):
    submission = site_submission(3, array_index=0, array_size=3)
    for index, job in enumerate(reversed(submission["jobs"])):
        job["job"]["arrayIndex"] = index
    api, logins = FakeLauncherApi(), LocalLogins()
    queue_on_assigned_site(api, submission, work_directory=str(tmp_path / "work"))
    launcher = launcher_for(tmp_path, api, logins)
    launcher.run_once()
    [report] = api.reports()
    ordered = sorted(submission["jobs"], key=lambda job: job["job"]["arrayIndex"])
    assert report["jobIds"] == [job["job"]["id"] for job in ordered]
    spec = tmp_path / "work/.mmt-submissions" / ordered[0]["job"]["id"]
    assert read_environment(spec / "job-shell.env")["MMT_ARRAY_SIZE"] == "3"
    for index, job in enumerate(ordered):
        assert json.loads((spec / f"jobs/{index}.json").read_text())["job"]["id"] == job["job"]["id"]
    launcher.close()


def test_a_refusing_job_shell_reports_failed_without_the_tokens(tmp_path, keygen):
    job_shell = (
        "#!/bin/sh\n"
        f'echo "qsub: token {LAUNCHER_TOKEN} is not a project" >&2\n'
        """grep -o '"jobToken": "[^"]*"' "$MMT_SPEC_DIR/jobs/0.json" >&2\n"""
        'cat "$MMT_SPEC_DIR/secrets.json" >&2\n'
        "exit 3\n"
    )
    registry_login = tmp_path / "pull.json"
    registry_login.write_text(json.dumps({"username": "puller", "password": "pull-secret"}))
    registry_login.chmod(0o600)
    submission = site_submission()
    api, logins = FakeLauncherApi(), LocalLogins()
    queue_on_assigned_site(api, submission, work_directory=str(tmp_path / "work"), job_shell=job_shell)
    launcher = launcher_for(tmp_path, api, logins, registry_secret_file='"pull.json"')
    launcher.run_once()
    [report] = api.reports()
    assert report["outcome"] == "failed" and report["schedulerJobId"] is None
    assert report["error"].startswith("The job shell exited with status 3")
    assert LAUNCHER_TOKEN not in report["error"] and JOB_TOKEN not in report["error"]
    assert '"jobToken": "[REDACTED]"' in report["error"]
    assert "pull-secret" not in report["error"] and '"password": "[REDACTED]"' in report["error"]
    assert not list((tmp_path / "state/submissions").iterdir())
    launcher.close()


def test_an_unreported_result_is_kept_and_resent_by_the_next_poll(tmp_path, keygen):
    submission = site_submission()
    api, logins = FakeLauncherApi(), LocalLogins()
    queue_on_assigned_site(api, submission, work_directory=str(tmp_path / "work"))
    api.report_statuses = [503] * 4
    launcher = launcher_for(tmp_path, api, logins)
    pending = tmp_path / "state/pending-reports"
    # Left by a launcher of one Project's worker token, whose reports the API takes no more.
    old_job_id = str(uuid4())
    (pending / "old.json").write_text(json.dumps({"project": "speech", "result": {"jobIds": [old_job_id]}}))
    launcher.run_once()
    [kept] = list(pending.iterdir())
    assert json.loads(kept.read_text())["jobIds"] == [submission["jobs"][0]["job"]["id"]]
    launcher.run_once()
    assert not list(pending.iterdir())
    assert api.reports()[-1]["schedulerJobId"] == "4242.pbs"
    assert all(old_job_id not in result["jobIds"] for result in api.reports())
    launcher.close()


def test_a_submission_without_usable_login_settings_fails_with_the_reason(tmp_path, keygen):
    api, logins = FakeLauncherApi(), LocalLogins()
    no_host_keys, no_connection = site_submission(), site_submission()
    connection = {**site_settings_document()["connection"], "knownHosts": "  \n"}
    queue_on_assigned_site(api, no_host_keys, work_directory=str(tmp_path / "work"), connection=connection)
    queue_on_assigned_site(api, no_connection, work_directory=str(tmp_path / "work"), connection=None)
    launcher = launcher_for(tmp_path, api, logins)
    launcher.run_once()
    errors = {report["jobIds"][0]: report["error"] for report in api.reports()}
    assert "known_hosts is empty" in errors[no_host_keys["jobs"][0]["job"]["id"]]
    assert "no connection settings" in errors[no_connection["jobs"][0]["job"]["id"]]
    assert all(report["outcome"] == "failed" for report in api.reports()) and not logins.made
    launcher.close()


def test_cancellations_run_as_the_account_the_api_names_or_stay_queued(tmp_path, keygen, caplog):
    api, logins = FakeLauncherApi(), LocalLogins()
    target_id = str(uuid4())
    canceled = tmp_path / "canceled.txt"
    api.assign_site(
        {"id": target_id, "name": "ABCI"},
        site_settings_document(cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{canceled}"'),
    )
    key_id = api.add_key(target_id, user_id=str(uuid4()))
    launcher = launcher_for(tmp_path, api, logins)
    renamed, forgotten, elsewhere, deferred = (str(uuid4()) for _ in range(4))
    launcher.ledger.record(
        [renamed],
        target_id=target_id,
        account=SubmissionAccount(
            account_name="alice", work_directory="/work/alice", variables={}, key_id=key_id
        ),
        scheduler_job_id="1.pbs",
    )
    api.cancellations = [
        # The person changed their account since: it runs as the new one, and the log says so.
        {
            "jobId": renamed,
            "targetId": target_id,
            "schedulerJobId": "1.pbs",
            "account": account_document(account_name="alice2", key_id=key_id),
        },
        # The API no longer knows the account: the Job stays queued, and its runner ends at start.
        {"jobId": forgotten, "targetId": target_id, "schedulerJobId": "2.pbs", "account": account_document()},
        {
            "jobId": elsewhere,
            "targetId": str(uuid4()),
            "schedulerJobId": "3.pbs",
            "account": account_document(account_name="alice2", key_id=key_id),
        },
    ]
    launcher.run_once()
    assert canceled.read_text() == "1.pbs\n"
    assert [login.endpoint.user for login in logins.shared()] == ["alice2"]
    assert f"Job {renamed} was queued as alice; its cancel command runs as alice2" in caplog.text
    assert f"Cancel of Job {forgotten} impossible: The account to log in as is not known" in caplog.text
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == [
        {"jobIds": [renamed, forgotten, elsewhere]}
    ]

    # A lost connection leaves the cancellation for the next poll.
    logins.refusal = TransportError("SSH connection to the site failed: Connection timed out")
    other_key = api.add_key(target_id, user_id=str(uuid4()))
    api.cancellations = [
        {
            "jobId": deferred,
            "targetId": target_id,
            "schedulerJobId": "4.pbs",
            "account": account_document(account_name="bob", key_id=other_key),
        }
    ]
    launcher.run_once()
    assert f"Cancel of Job {deferred} deferred" in caplog.text
    assert len(api.bodies("POST", "launcher/site-submissions/cancellations/report")) == 1
    launcher.close()


def test_a_cancel_whose_login_fails_leaves_that_login_alone_for_a_while(tmp_path, keygen, caplog):
    api, logins = FakeLauncherApi(), LocalLogins()
    target_id = str(uuid4())
    canceled = tmp_path / "canceled.txt"
    api.assign_site(
        {"id": target_id, "name": "ABCI"},
        site_settings_document(cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{canceled}"'),
    )
    key_id = api.add_key(target_id)
    now = [1000.0]
    launcher = launcher_for(tmp_path, api, logins, clock=lambda: now[0])
    first, second, other = (str(uuid4()) for _ in range(3))
    mmt = account_document(account_name="mmt", key_id=key_id)
    cancellations = [
        {"jobId": first, "targetId": target_id, "schedulerJobId": "1.pbs", "account": mmt},
        {"jobId": second, "targetId": target_id, "schedulerJobId": "2.pbs", "account": mmt},
        {
            "jobId": other,
            "targetId": target_id,
            "schedulerJobId": "3.pbs",
            "account": account_document(account_name="other", key_id=key_id),
        },
    ]
    # The key is not in authorized_keys yet (the launcher changed a moment ago, say).
    logins.refusal = TransportError(
        "SSH connection to the site failed: mmt@login: Permission denied (publickey)"
    )
    api.cancellations = list(cancellations)
    launcher.run_once()
    # One failed login per login, not per Job: the second Job of the same login is not tried.
    assert [(login.endpoint.user, len(login.commands)) for login in logins.shared()] == [
        ("mmt", 1),
        ("other", 1),
    ]
    assert f"Cancel of Job {first} deferred" in caplog.text and "again in 600 seconds" in caplog.text
    assert f"Cancel of Job {second} deferred" not in caplog.text

    # The next polls inside the pause log in nowhere and report nothing.
    for seconds in (10.0, 590.0):
        now[0] = 1000.0 + seconds
        api.cancellations = list(cancellations)
        launcher.run_once()
    assert len(logins.made) == 2 and sum(len(login.commands) for login in logins.made) == 2
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == []

    # After the pause each login is tried again; it works now, and every Job leaves the queue.
    logins.refusal = None
    now[0] = 1000.0 + 601.0
    api.cancellations = list(cancellations)
    launcher.run_once()
    assert canceled.read_text() == "1.pbs\n2.pbs\n3.pbs\n"
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == [
        {"jobIds": [first, second, other]}
    ]
    launcher.close()


def test_after_a_failed_login_the_polls_later_submissions_through_it_fail_untried(
    tmp_path, keygen, monkeypatch
):
    monkeypatch.setattr("mado_tracking.site.submission.SETUP_RETRY_SECONDS", 0.0)
    api, logins = FakeLauncherApi(), LocalLogins()
    first, second, elsewhere, third, next_poll = (site_submission() for _ in range(5))
    target = first["target"]
    canceled = tmp_path / "canceled.txt"
    settings = site_settings_document(cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{canceled}"')
    api.assign_site(target, settings)
    key_id = api.add_key(target["id"])
    work = str(tmp_path / "work")
    mmt = account_document(mode="shared", account_name="mmt", work_directory=work, key_id=key_id)
    other = account_document(mode="shared", account_name="other", work_directory=work, key_id=key_id)

    def queue(submission: dict, account: dict) -> str:
        submission.update(
            target=target,
            settings=settings,
            jobShell=job_shell_document(JOB_SHELL, target_id=target["id"]),
            account=account,
        )
        api.submissions.append(submission)
        return submission["jobs"][0]["job"]["id"]

    job_ids = [queue(first, mmt), queue(second, mmt), queue(elsewhere, other), queue(third, mmt)]
    queued = str(uuid4())
    cancellation = {"jobId": queued, "targetId": target["id"], "schedulerJobId": "9.pbs", "account": mmt}
    api.cancellations = [cancellation]
    # mmt's key is not in authorized_keys yet; the connection as `other` is lost on the way.
    refused = "SSH connection to the site failed: mmt@login: Permission denied (publickey)."
    lost = "SSH connection to the site failed: Connection closed by 192.0.2.1 port 22"
    logins.refusals = {"mmt": LoginRefused(refused), "other": TransportError(lost)}
    launcher = launcher_for(tmp_path, api, logins)
    launcher.run_once()
    errors = {report["jobIds"][0]: report["error"] for report in api.reports()}
    untried = f"Not tried: logging in to the site failed for an earlier submission of this poll: {refused}"
    assert [errors[job_id] for job_id in job_ids] == [
        f"The site could not be prepared: {refused}",
        untried,
        # Another account is another login: it is tried.
        f"The site could not be prepared: {lost}",
        untried,
    ]
    # One failed login per refused login and poll; a lost connection is tried three times. The
    # poll's later submissions through either login do not log in at all.
    assert [(login.endpoint.user, len(login.commands)) for login in logins.shared()] == [
        ("mmt", 1),
        ("other", 3),
    ]
    # The cancel through the failed login waits too, in this poll and the ones after.
    assert (
        not canceled.exists() and api.bodies("POST", "launcher/site-submissions/cancellations/report") == []
    )

    # The next poll tries the login again; it works now, so the cancel no longer waits either.
    logins.refusals = {}
    for login in logins.made:
        login.refusal = None
    queue(next_poll, mmt)
    api.cancellations = [cancellation]
    launcher.run_once()
    assert api.reports()[-1]["jobIds"] == [next_poll["jobs"][0]["job"]["id"]]
    assert api.reports()[-1]["outcome"] == "submitted"
    assert canceled.read_text() == "9.pbs\n"
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == [{"jobIds": [queued]}]
    launcher.close()


def refuse_logins(logins: LocalLogins, refusal: Exception | None) -> None:
    """From now on every login fails with `refusal` (None: they work), the made ones too."""
    logins.refusal = refusal
    for login in logins.made:
        login.refusal = refusal


def waiting_notices(caplog: pytest.LogCaptureFixture) -> list[str]:
    """What the launcher said, at INFO or above, about cancels that wait for a failed login."""
    return [
        record.getMessage()
        for record in caplog.records
        if record.levelno >= logging.INFO and "waits: logging in as" in record.getMessage()
    ]


def test_a_connection_check_that_logs_in_lets_the_waiting_cancels_go_ahead(tmp_path, keygen, caplog):
    caplog.set_level(logging.INFO, logger="mado_tracking.site.launcher")
    api, logins = FakeLauncherApi(), LocalLogins()
    target_id = str(uuid4())
    canceled = tmp_path / "canceled.txt"
    api.assign_site(
        {"id": target_id, "name": "ABCI"},
        site_settings_document(cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{canceled}"'),
    )
    mmt = account_document(account_name="mmt", key_id=api.add_key(target_id))
    job_id = str(uuid4())
    cancellation = {"jobId": job_id, "targetId": target_id, "schedulerJobId": "1.pbs", "account": mmt}
    now = [1000.0]
    launcher = launcher_for(tmp_path, api, logins, clock=lambda: now[0])
    # The key is not in authorized_keys yet: the cancel fails, and its warning says when it retries.
    refuse_logins(logins, LoginRefused("SSH connection to the site failed: mmt@login: Permission denied"))
    api.cancellations = [cancellation]
    launcher.run_once()
    assert f"Cancel of Job {job_id} deferred" in caplog.text

    # Someone registers the key. Without a check the cancel waits out its pause, quietly.
    refuse_logins(logins, None)
    now[0] += 10.0
    api.cancellations = [cancellation]
    launcher.run_once()
    assert not canceled.exists() and waiting_notices(caplog) == []

    # A connection check that logs in as the account lets the cancel go ahead in that same poll.
    check_id = str(uuid4())
    api.checks = [{"id": check_id, "targetId": target_id, "account": mmt}]
    now[0] += 10.0
    api.cancellations = [cancellation]
    launcher.run_once()
    assert api.check_results()[check_id] == {"outcome": "succeeded", "message": None}
    assert canceled.read_text() == "1.pbs\n"
    assert api.bodies("POST", "launcher/site-submissions/cancellations/report") == [{"jobIds": [job_id]}]
    launcher.close()


def test_cancels_held_back_by_a_failed_submission_say_why_once_until_the_login_works(
    tmp_path, keygen, monkeypatch, caplog
):
    monkeypatch.setattr("mado_tracking.site.submission.SETUP_RETRY_SECONDS", 0.0)
    caplog.set_level(logging.INFO, logger="mado_tracking.site.launcher")
    api, logins = FakeLauncherApi(), LocalLogins()
    target = site_submission()["target"]
    canceled = tmp_path / "canceled.txt"
    settings = site_settings_document(cancelCommand=f'echo "$MMT_SCHEDULER_JOB_ID" >> "{canceled}"')
    api.assign_site(target, settings)
    mmt = account_document(
        mode="shared",
        account_name="mmt",
        work_directory=str(tmp_path / "work"),
        key_id=api.add_key(target["id"]),
    )
    refused = "SSH connection to the site failed: mmt@login: Permission denied (publickey)."
    now = [1000.0]
    launcher = launcher_for(tmp_path, api, logins, clock=lambda: now[0])

    def poll(cancel_job_id: str, *, refusal: Exception | None) -> list[str]:
        """One poll with a submission and one cancel through mmt; its notices of waiting cancels."""
        refuse_logins(logins, refusal)
        submission = site_submission()
        submission.update(
            target=target,
            settings=settings,
            jobShell=job_shell_document(JOB_SHELL, target_id=target["id"]),
            account=mmt,
        )
        api.submissions.append(submission)
        api.cancellations = [
            {
                "jobId": cancel_job_id,
                "targetId": target["id"],
                "schedulerJobId": f"{cancel_job_id}.pbs",
                "account": mmt,
            }
        ]
        caplog.clear()
        launcher.run_once()
        now[0] += 10.0
        return waiting_notices(caplog)

    first, second = str(uuid4()), str(uuid4())
    # The poll's submission fails to log in, so the cancel waits: the log says why, and until when.
    [notice] = poll(first, refusal=LoginRefused(refused))
    assert notice.startswith(f"Cancel of Job {first} waits: logging in as mmt on site")
    assert refused in notice and "again in 600 seconds" in notice
    # While the login keeps failing, the polls after that wait without saying it again.
    assert poll(first, refusal=LoginRefused(refused)) == []
    assert not canceled.exists()
    # A submission that logs in ends the wait; a later failure is told once more.
    assert poll(first, refusal=None) == []
    assert canceled.read_text() == f"{first}.pbs\n"
    [again] = poll(second, refusal=LoginRefused(refused))
    assert again.startswith(f"Cancel of Job {second} waits")
    launcher.close()


def test_ssh_sites_share_one_connection_and_jump_hosts_get_the_same_settings(tmp_path, ssh_state_directory):
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
    transport = SshSiteTransport(endpoint, state_directory=ssh_state_directory, masker=SecretMasker())
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
    assert mode_of(transport.config_file) == 0o600

    with pytest.raises(TransportError):
        transport.check_connection(CommandResult(255, b"", b"Permission denied (publickey)"))
    transport.check_connection(CommandResult(1, b"", b"command failed"))
    for invalid in ({"host": "-oProxyCommand=x"}, {"user": "a b"}, {"jump_hosts": ("bad host",)}):
        with pytest.raises(ConfigurationError):
            SshEndpoint(**{**endpoint.__dict__, **invalid})

    # A connection check logs in on its own: no shared connection is used or left behind.
    alone = SshSiteTransport(
        endpoint, state_directory=ssh_state_directory, masker=SecretMasker(), shared_connection=False
    )
    argv = alone.command_argv(["true"])
    assert not [value for value in argv if value.startswith(("ControlPath", "ControlMaster"))]
    assert argv[-2:] == ["login.example.org", "true"] and argv[argv.index("-l") + 1] == "alice"
    key.chmod(0o640)
    with pytest.raises(ConfigurationError, match="readable"):
        SshSiteTransport(endpoint, state_directory=ssh_state_directory, masker=SecretMasker())


def test_launcher_job_shell_and_installed_runner_complete_a_job(tmp_path, monkeypatch, keygen):
    """The whole chain on a direct host: the job shell starts MMT_RUNNER, which reports by itself."""
    install_fake_sif_cli(tmp_path, monkeypatch)
    # The installed zipapp must not borrow this checkout's package.
    monkeypatch.delenv("PYTHONPATH", raising=False)
    direct_shell = (
        "#!/bin/sh\nset -eu\n"
        'MMT_ARRAY_INDEX=0 "$MMT_RUNNER" "$MMT_SPEC_DIR" 2> "$MMT_SPEC_DIR/runner.log"\n'
        'echo ""\n'
    )
    api, logins = FakeLauncherApi(), LocalLogins()
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
        queue_on_assigned_site(
            api,
            submission_for([job]),
            work_directory=str(tmp_path / "work"),
            job_shell=direct_shell,
            runnerPython=sys.executable,
            runnerApiUrl=site.url,
        )
        launcher = launcher_for(tmp_path, api, logins)
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
