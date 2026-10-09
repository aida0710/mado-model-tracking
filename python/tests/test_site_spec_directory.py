"""The spec directory a launcher writes and the runner reads."""

from __future__ import annotations

import io
import json
import tarfile

import pytest
from site_fixtures import site_job, submission_for, write_spec_directory

from mado_tracking.errors import ConfigurationError
from mado_tracking.site.file_archive import pack_files
from mado_tracking.site.spec_directory import RunnerSettings, SpecDirectory, spec_files

RUNTIME = {"kind": "apptainer", "artifactId": "a", "sha256": "0" * 64}


def array_submission(size: int = 3) -> dict:
    jobs = [
        site_job(
            project_id="p",
            source_files={"main.py": ""},
            runtime=RUNTIME,
            runtime_kinds=["apptainer"],
            array_index=index,
            array_size=size,
        )
        for index in reversed(range(size))
    ]
    return submission_for(jobs)


def test_job_files_follow_the_array_order_and_only_they_hold_the_job_token():
    submission = array_submission()
    files = spec_files(
        submission, api_url="https://runner.example.org", settings=RunnerSettings(work_directory="/work")
    )
    assert sorted(files) == [
        "api.json",
        "jobs/0.json",
        "jobs/1.json",
        "jobs/2.json",
        "runner.json",
        "submission.json",
    ]
    assert all(mode == 0o600 for _content, mode in files.values())
    summary = json.loads(files["submission.json"][0])
    assert [job["jobToken"] for job in summary["jobs"]] == [None, None, None]
    for index in range(3):
        job = json.loads(files[f"jobs/{index}.json"][0])
        assert job["job"]["arrayIndex"] == index and job["jobToken"].startswith("mmtj_")
    assert json.loads(files["api.json"][0]) == {"apiUrl": "https://runner.example.org"}


def test_runner_settings_round_trip_and_reject_unsafe_values():
    settings = RunnerSettings(
        work_directory="/work",
        gpu_assignment="lease",
        gpu_ids=("0", "1"),
        cancel_grace_seconds=5,
        max_output_files=20,
    )
    assert RunnerSettings.from_document(settings.to_document()) == settings
    for invalid in (
        {"work_directory": "relative"},
        {"work_directory": "/work", "gpu_assignment": "random"},
        {"work_directory": "/work", "gpu_ids": ("0,1",)},
        {"work_directory": "/work", "cancel_grace_seconds": 0},
        {"work_directory": "/work", "max_output_files": 0},
    ):
        with pytest.raises(ConfigurationError):
            RunnerSettings(**invalid)


def test_the_runner_reads_its_job_and_refuses_credentials_others_can_read(tmp_path):
    submission = array_submission(2)
    secrets = {"registry": {"username": "u", "password": "p"}}
    spec = write_spec_directory(
        tmp_path,
        submission,
        api_url="http://api",
        settings=RunnerSettings(work_directory="/w"),
        secrets=secrets,
    )
    directory = SpecDirectory(spec)
    assert directory.job_payload(1)["job"]["arrayIndex"] == 1
    assert directory.secrets() == secrets and directory.api_url() == "http://api"
    assert directory.runner_settings().work_directory == "/w"
    (spec / "jobs/1.json").chmod(0o644)
    with pytest.raises(ConfigurationError, match="readable by others"):
        directory.job_payload(1)


def test_packed_files_carry_their_modes_and_parent_directories():
    archive = pack_files({"jobs/0.json": (b"{}", 0o600), "mmt-runner": (b"#!/bin/sh\n", 0o700)})
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = {member.name: member for member in tar.getmembers()}
    assert members["jobs"].isdir() and members["jobs"].mode == 0o700
    assert members["jobs/0.json"].mode == 0o600 and members["mmt-runner"].mode == 0o700
    with pytest.raises(ValueError):
        pack_files({"../escape": (b"", 0o600)})
