from __future__ import annotations

import copy

import pytest

from mado_tracking.errors import ConfigurationError
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.runtime import execution_specification


def pin_execution(payload, mode="run"):
    code = payload["codeVersion"]
    payload["run"].update(
        executionMode=mode,
        executionSnapshot=copy.deepcopy(
            {
                "codeVersionId": code["id"],
                "version": code["version"],
                "mode": mode,
                "source": code["source"],
                "runtime": code.get("runtime", {"kind": "python"}),
                "entrypoint": code["testEntrypoint"] if mode == "test" else code["entrypoint"],
                "requirements": code["requirements"],
                "environment": code["environment"],
            }
        ),
    )
    return payload


@pytest.mark.parametrize(
    "field,value",
    [
        ("codeVersionId", "other-version"),
        ("version", "changed"),
        ("mode", "test"),
        ("source", {"kind": "inline", "files": {"other.py": "changed"}}),
        ("runtime", {"kind": "docker", "image": "other@sha256:" + "1" * 64}),
        ("entrypoint", ["python", "different.py"]),
        ("requirements", ["injected-dependency"]),
        ("environment", {"OTHER": "value"}),
        ("unexpectedField", True),
    ],
)
def test_changed_execution_snapshot_is_rejected_before_any_runner_instruction(job_payload, field, value):
    pin_execution(job_payload)
    job_payload["run"]["executionSnapshot"][field] = value
    with pytest.raises(ConfigurationError, match="executionSnapshot"):
        WorkerJob.parse(job_payload)


@pytest.mark.parametrize("mode", ["invalid", "test", "run"])
def test_explicit_mode_requires_a_saved_matching_snapshot(job_payload, mode):
    job_payload["codeVersion"]["testEntrypoint"] = ["python", "test.py"]
    job_payload["run"]["executionMode"] = mode
    with pytest.raises(ConfigurationError, match="executionMode|executionSnapshot"):
        WorkerJob.parse(job_payload)


def test_test_mode_selects_the_saved_test_command_and_owns_a_copy_of_its_instructions(
    job_payload, worker_settings
):
    job_payload["codeVersion"]["testEntrypoint"] = ["python", "test.py", "two words"]
    pin_execution(job_payload, "test")
    job = WorkerJob.parse(job_payload)
    specification = execution_specification(job, worker_settings)
    assert specification["executionSnapshot"]["entrypoint"] == ["python", "test.py", "two words"]
    assert specification["codeVersion"]["entrypoint"] == ["python", "main.py"]
    snapshot = job.execution_snapshot
    snapshot["source"]["files"]["main.py"] = "changed copy"
    assert job.execution_snapshot["source"] == job_payload["codeVersion"]["source"]


def test_test_mode_without_a_saved_test_command_cannot_execute_the_regular_entrypoint(job_payload):
    pin_execution(job_payload)
    job_payload["run"]["executionMode"] = "test"
    with pytest.raises(ConfigurationError, match="testEntrypoint"):
        WorkerJob.parse(job_payload)


def test_run_runtime_must_match_the_immutable_execution_snapshot(job_payload):
    pin_execution(job_payload)
    job_payload["run"]["runtime"] = {"kind": "docker", "image": "other@sha256:" + "1" * 64}
    with pytest.raises(ConfigurationError, match="Run.runtime"):
        WorkerJob.parse(job_payload)


def test_legacy_journal_without_snapshot_fields_can_only_use_the_regular_command(job_payload):
    job_payload["codeVersion"]["testEntrypoint"] = ["python", "test.py"]
    job = WorkerJob.parse(job_payload)
    assert job.execution_snapshot["mode"] == "run"
    assert job.execution_snapshot["entrypoint"] == job_payload["codeVersion"]["entrypoint"]
