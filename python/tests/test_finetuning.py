"""Check real CPU fine-tuning from input weights, output lineage, and visible failures."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fake_http_api import TrackingServer

from mado_tracking import Client

TRAINING_SCRIPT = Path(__file__).resolve().parent.parent / "examples" / "training.py"
# A stalled example or HTTP fixture should fail without blocking the test suite.
EXAMPLE_TIMEOUT_SECONDS = 15
INPUT_MODEL_ID = "pinned-parent-version"
INPUT_WEIGHTS = {"family": "linear", "weight": 1.0, "bias": 0.5}


def example_environment(server: TrackingServer | None = None) -> dict[str, str]:
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    if server is not None:
        environment.update(
            MMT_API_URL=server.url,
            MMT_API_TOKEN="example-only-test-token",
            MMT_PROJECT_ID="project-example",
            MMT_EXPERIMENT_ID="experiment-example",
        )
    return environment


def run_training(environment: dict[str, str], output: Path, *, offline: bool = False):
    return subprocess.run(
        [
            sys.executable,
            str(TRAINING_SCRIPT),
            "--steps",
            "1",
            "--output",
            str(output),
            *(["--offline"] if offline else []),
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=EXAMPLE_TIMEOUT_SECONDS,
    )


def assert_finetuned_weights(output: Path) -> None:
    weights = json.loads(output.read_text())
    # One actual gradient step from weight=1,bias=0.5 is weight=1.35,bias=0.7.
    assert weights["weight"] == pytest.approx(1.35)
    assert weights["bias"] == pytest.approx(0.7)


def assert_registered_parent(server: TrackingServer) -> None:
    version = server.model_versions[-1]
    assert version["parentModelVersionIds"] == [INPUT_MODEL_ID]
    assert version["sourceRunId"] in server.runs
    assert version["metadata"]["initial_weight"] == INPUT_WEIGHTS["weight"]
    assert version["metadata"]["initial_bias"] == INPUT_WEIGHTS["bias"]


@pytest.mark.parametrize("attach", [False, True], ids=["env-kind", "attached-run-kind"])
def test_finetuning_downloads_the_pinned_artifact_and_starts_from_its_real_weights(tmp_path, attach):
    with TrackingServer() as server:
        server.artifacts["input-artifact"] = json.dumps(INPUT_WEIGHTS).encode()
        model_version = {
            "id": INPUT_MODEL_ID,
            "projectId": "project-example",
            "family": "linear",
            "artifactId": "input-artifact",
            "weightsUri": None,
        }
        descriptor = tmp_path / "model-version.json"
        descriptor.write_text(json.dumps({"modelVersion": model_version}))
        environment = example_environment(server)
        environment.update(MMT_MODEL_VERSION_FILE=str(descriptor), MMT_MODEL_VERSION_ID=INPUT_MODEL_ID)
        if attach:
            with Client(api_url=server.url, api_token="example-only-test-token") as client:
                run = client.create_run(
                    "project-example",
                    experiment_id="experiment-example",
                    name="pinned fine-tuning",
                    kind="finetuning",
                    model_version_id=INPUT_MODEL_ID,
                )
            server.runs[run.id]["status"] = "running"
            environment["MMT_RUN_ID"] = run.id
        else:
            environment["MMT_JOB_KIND"] = "finetuning"
        output = tmp_path / "outputs" / "fine-tuned.json"
        execution = run_training(environment, output)
        assert execution.returncode == 0, execution.stderr
        assert_finetuned_weights(output)
        assert server.metrics[0]["name"] == "train.loss" and server.metrics[0]["value"] == pytest.approx(2.25)
        assert_registered_parent(server)
        assert ("GET", "/api/projects/project-example/artifacts/input-artifact/content") in server.operations
        assert server.artifacts[server.model_versions[-1]["artifactId"]] == output.read_bytes()
        assert next(iter(server.runs.values()))["status"] == ("running" if attach else "finished")


def test_finetuning_reads_model_file_and_keeps_the_pinned_parent(tmp_path):
    with TrackingServer() as server:
        model_file = tmp_path / "parent.json"
        model_file.write_text(json.dumps(INPUT_WEIGHTS))
        environment = example_environment(server)
        environment.update(
            MMT_JOB_KIND="finetuning", MMT_MODEL_VERSION_ID=INPUT_MODEL_ID, MMT_MODEL_FILE=str(model_file)
        )
        output = tmp_path / "fine-tuned.json"
        execution = run_training(environment, output)
        assert execution.returncode == 0, execution.stderr
        assert_finetuned_weights(output)
        assert_registered_parent(server)
        assert next(iter(server.runs.values()))["status"] == "finished"


@pytest.mark.parametrize(
    ("contents", "model_id", "message"),
    [
        (None, INPUT_MODEL_ID, "Pinned ModelVersion metadata"),
        ("not json", INPUT_MODEL_ID, "readable JSON model"),
        (json.dumps({"family": "another", "weight": 1, "bias": 0}), INPUT_MODEL_ID, "family linear"),
        (json.dumps({"family": "linear", "weight": 1}), INPUT_MODEL_ID, "numeric weight and bias"),
        (
            json.dumps({"family": "linear", "weight": True, "bias": 0}),
            INPUT_MODEL_ID,
            "numeric weight and bias",
        ),
        (
            json.dumps({"family": "linear", "weight": "1", "bias": 0}),
            INPUT_MODEL_ID,
            "numeric weight and bias",
        ),
        (
            json.dumps({"family": "linear", "weight": float("nan"), "bias": 0}),
            INPUT_MODEL_ID,
            "must be finite",
        ),
        (
            json.dumps({"family": "linear", "weight": 1, "bias": float("inf")}),
            INPUT_MODEL_ID,
            "must be finite",
        ),
        (json.dumps(INPUT_WEIGHTS), "", "pinned Run.modelVersionId"),
    ],
    ids=[
        "missing",
        "invalid-json",
        "wrong-family",
        "missing-bias",
        "boolean",
        "numeric-string",
        "nan",
        "inf",
        "unpinned",
    ],
)
def test_invalid_finetuning_input_fails_the_run_without_creating_output(
    tmp_path, contents, model_id, *, message
):
    with TrackingServer() as server:
        environment = example_environment(server)
        environment.update(MMT_JOB_KIND="finetuning", MMT_MODEL_VERSION_ID=model_id)
        if contents is not None:
            model_file = tmp_path / "invalid-parent.json"
            model_file.write_text(contents)
            environment["MMT_MODEL_FILE"] = str(model_file)
        output = tmp_path / "must-not-exist.json"
        execution = run_training(environment, output)
        assert execution.returncode != 0 and message in execution.stderr
        assert next(iter(server.runs.values()))["status"] == "failed"
        assert not output.exists() and not server.model_versions and not server.artifacts
        assert not server.metrics
        assert "example-only-test-token" not in execution.stderr


def test_offline_finetuning_starts_from_the_model_file_and_training_still_starts_from_zero(tmp_path):
    model_file = tmp_path / "input.json"
    model_file.write_text(json.dumps(INPUT_WEIGHTS))
    environment = example_environment()
    environment.update(MMT_JOB_KIND="finetuning", MMT_MODEL_FILE=str(model_file))
    output = tmp_path / "fine-tuned.json"
    execution = run_training(environment, output, offline=True)
    assert execution.returncode == 0, execution.stderr
    assert_finetuned_weights(output)
    model_file.write_text("invalid model is ignored during regular training")
    environment["MMT_JOB_KIND"] = "training"
    training_output = tmp_path / "trained.json"
    execution = run_training(environment, training_output, offline=True)
    assert execution.returncode == 0, execution.stderr
    weights = json.loads(training_output.read_text())
    assert weights["weight"] == pytest.approx(0.7) and weights["bias"] == pytest.approx(0.4)
