"""The site runner on a direct Docker host with a real daemon; opt in with MMT_TEST_DOCKER_IMAGE."""

from __future__ import annotations

import os
import subprocess
from uuid import uuid4

import pytest
from fake_site_api import SiteApi
from site_fixtures import site_job
from test_site_runner import RESULT_ENTRYPOINT, SLEEPING_ENTRYPOINT, prepare, run_runner

from mado_tracking.site.runner import EXIT_FAILED, EXIT_FINISHED
from mado_tracking.site.spec_directory import RunnerSettings


@pytest.fixture
def docker_image():
    image = os.environ.get("MMT_TEST_DOCKER_IMAGE")
    if not image:
        pytest.skip(
            "Set MMT_TEST_DOCKER_IMAGE to a cached python image@sha256 reference for local Docker tests"
        )
    subprocess.run(["docker", "image", "inspect", image], check=True, capture_output=True)
    return image


def container_names(job_id: str) -> str:
    return subprocess.run(
        [
            "docker",
            "container",
            "ls",
            "--all",
            "--filter",
            f"name=^/mmt-job-{job_id}$",
            "--format",
            "{{.ID}}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def docker_job(image: str, source: str) -> dict:
    return site_job(
        project_id=str(uuid4()),
        source_files={"main.py": source},
        runtime={"kind": "docker", "image": image, "workingDirectory": "/mmt/source"},
        runtime_kinds=["docker"],
    )


def test_a_direct_docker_host_runs_the_container_and_saves_its_outputs(tmp_path, docker_image):
    settings = RunnerSettings(work_directory=str(tmp_path / "work"), gpu_assignment="lease")
    with SiteApi() as api:
        job = docker_job(docker_image, RESULT_ENTRYPOINT)
        assert run_runner(prepare(tmp_path, api, job, settings=settings)) == EXIT_FINISHED, api.bodies(
            "finish"
        )
    assert dict(api.uploads)["container/shard-0.tar"] == b"generated speech shard"
    assert "site-entrypoint-ran [REDACTED]" in api.messages()
    assert api.bodies("finish")[0]["status"] == "finished"
    assert not container_names(job["job"]["id"])


def test_a_canceled_docker_job_stops_and_removes_its_container(tmp_path, docker_image):
    settings = RunnerSettings(
        work_directory=str(tmp_path / "work"), gpu_assignment="lease", cancel_grace_seconds=2
    )
    with SiteApi() as api:
        api.cancel_after_log = "site-ready"
        job = docker_job(docker_image, SLEEPING_ENTRYPOINT)
        assert run_runner(prepare(tmp_path, api, job, settings=settings)) == EXIT_FAILED
    assert api.bodies("finish")[0]["status"] == "canceled"
    assert not container_names(job["job"]["id"])
