"""The job shell contract: the environment it receives and the scheduler ID it prints."""

from __future__ import annotations

from uuid import uuid4

import pytest

from mado_tracking.errors import ConfigurationError
from mado_tracking.security import SecretMasker
from mado_tracking.site.job_shell import (
    JOB_SHELL_ERROR_CHARACTERS,
    JobShellOutputError,
    format_walltime,
    job_shell_environment,
    job_shell_error,
    scheduler_job_id,
)
from mado_tracking.site.spec_directory import ordered_jobs


def member(index: int, *, gpu_count: int = 2, walltime: int | None = 90061) -> dict:
    return {
        "job": {
            "id": str(uuid4()),
            "projectId": "project-1",
            "arrayIndex": index,
            "gpuCount": gpu_count,
            "walltimeSeconds": walltime,
        }
    }


@pytest.mark.parametrize(
    ("seconds", "text"), [(None, ""), (59, "00:00:59"), (3600, "01:00:00"), (90061, "25:01:01")]
)
def test_walltime_is_hours_minutes_seconds_with_hours_past_a_day(seconds, text):
    assert format_walltime(seconds) == text


def test_the_environment_describes_the_array_in_scheduler_order():
    jobs = ordered_jobs({"jobs": [member(2), member(0), member(1)]})
    environment = job_shell_environment(
        jobs,
        spec_directory="/work/.mmt-submissions/x",
        runner="/work/.mmt-runner/v/mmt-runner",
        target_id="site-1",
        variables={"GROUP": "gxx50000"},
    )
    assert environment["MMT_JOB_IDS"] == ",".join(job["job"]["id"] for job in jobs)
    assert [job["job"]["arrayIndex"] for job in jobs] == [0, 1, 2]
    assert environment["MMT_ARRAY_SIZE"] == "3"
    assert environment["MMT_GPU_COUNT"] == "2"
    assert (environment["MMT_WALLTIME_SECONDS"], environment["MMT_WALLTIME"]) == ("90061", "25:01:01")
    assert environment["MMT_PROJECT_ID"] == "project-1" and environment["MMT_TARGET_ID"] == "site-1"
    assert environment["MMT_VAR_GROUP"] == "gxx50000"
    assert environment["MMT_SPEC_DIR"].endswith("/x") and environment["MMT_RUNNER"].endswith("/mmt-runner")


def test_a_job_without_a_time_limit_leaves_the_walltime_empty():
    environment = job_shell_environment(
        [member(0, walltime=None)], spec_directory="/s", runner="/r", target_id="t", variables={}
    )
    assert environment["MMT_WALLTIME"] == "" and environment["MMT_WALLTIME_SECONDS"] == ""


@pytest.mark.parametrize("variables", [{"1BAD": "x"}, {"GOOD": "two\nlines"}, {"A-B": "x"}])
def test_variables_must_be_shell_names_with_single_line_values(variables):
    with pytest.raises(ConfigurationError):
        job_shell_environment(
            [member(0)], spec_directory="/s", runner="/r", target_id="t", variables=variables
        )


@pytest.mark.parametrize(
    ("stdout", "expected"),
    [
        (b"", None),
        (b"\n", None),
        (b"12345.pbs1\n", "12345.pbs1"),
        (b"Submitting...\n4242[].pbs\n", "4242[].pbs"),
        (b"12345\n\n", None),
        (b"  777  \n", "777"),
        (b"no newline 1\n99", "99"),
    ],
)
def test_the_scheduler_job_id_is_the_last_line_alone(stdout, expected):
    assert scheduler_job_id(stdout) == expected


@pytest.mark.parametrize("stdout", [b"Your job 12345 has been submitted\n", b"x" * 201 + b"\n", b"id\x07\n"])
def test_a_last_line_that_is_not_an_id_is_refused(stdout):
    with pytest.raises(JobShellOutputError):
        scheduler_job_id(stdout)


def test_job_shell_errors_are_masked_and_keep_the_end_of_stderr():
    stderr = b"x" * 5000 + b" token=mmtw_secret-value qsub: Unknown queue gpu"
    error = job_shell_error(3, stderr, SecretMasker(["mmtw_secret-value"]))
    assert error.startswith("The job shell exited with status 3: ...")
    assert "mmtw_secret-value" not in error and "[REDACTED]" in error and error.endswith("Unknown queue gpu")
    assert len(error) < JOB_SHELL_ERROR_CHARACTERS + 100
