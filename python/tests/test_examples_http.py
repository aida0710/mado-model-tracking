from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from fake_http_api import TrackingServer

from mado_tracking import Client

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def test_training_and_inference_scripts_use_real_http_artifacts_and_output_registration(tmp_path):
    with TrackingServer() as server:
        environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
        environment.update(
            MMT_API_URL=server.url,
            MMT_API_TOKEN="example-only-test-token",
            MMT_PROJECT_ID="project-example",
            MMT_EXPERIMENT_ID="experiment-example",
        )
        weights, predictions = tmp_path / "weights.json", tmp_path / "predictions.json"
        subprocess.run(
            [sys.executable, str(EXAMPLES / "training.py"), "--output", str(weights)],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert server.model_versions
        assert next(iter(server.runs.values()))["status"] == "finished"
        training_losses = [point["value"] for point in server.metrics if point["name"] == "train.loss"]
        assert len(training_losses) == 40 and training_losses[-1] < training_losses[0] * 0.01
        registered_weights = server.artifacts[server.model_versions[0]["artifactId"]]
        assert registered_weights == weights.read_bytes()
        subprocess.run(
            [
                sys.executable,
                str(EXAMPLES / "inference.py"),
                "--weights",
                str(weights),
                "--output",
                str(predictions),
            ],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert all(run["status"] == "finished" for run in server.runs.values())
        actual_predictions = json.loads(predictions.read_text())
        assert abs(actual_predictions[1]["prediction"] - 3) < 0.05
        assert server.dataset_versions[0]["sourceRunId"] in server.runs
        with Client(api_url=server.url, api_token="example-only-test-token") as client:
            downloaded = b"".join(
                client.download_artifact("project-example", server.model_versions[0]["artifactId"])
            )
        assert downloaded == weights.read_bytes()


def test_offline_scripts_train_real_weights_and_infer_without_an_api(tmp_path):
    weights, predictions = tmp_path / "weights.json", tmp_path / "predictions.json"
    subprocess.run(
        [sys.executable, str(EXAMPLES / "training.py"), "--offline", "--output", str(weights)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    subprocess.run(
        [
            sys.executable,
            str(EXAMPLES / "inference.py"),
            "--offline",
            "--weights",
            str(weights),
            "--output",
            str(predictions),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    model = json.loads(weights.read_text())
    assert abs(model["weight"] - 2) < 0.03 and abs(model["bias"] - 1) < 0.03
    assert len(json.loads(predictions.read_text())) == 3
