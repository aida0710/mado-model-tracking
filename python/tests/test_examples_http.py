from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from fake_http_api import TrackingServer

from mado_tracking import Client
from mado_tracking.worker.container_outputs import validate_results

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


def write_reference(path: Path, durations: list[float]) -> Path:
    path.write_text(
        json.dumps(
            {
                "samples": [
                    {"audio": f"sample-{index:03d}.wav", "durationSeconds": duration}
                    for index, duration in enumerate(durations)
                ]
            }
        )
    )
    return path


def test_offline_evaluation_scores_real_inference_wav_lengths_against_the_reference(tmp_path):
    weights = tmp_path / "weights.json"
    weights.write_text(json.dumps({"family": "linear", "weight": 2.0, "bias": 1.0}))
    audio = tmp_path / "audio"
    subprocess.run(
        [
            sys.executable,
            str(EXAMPLES / "inference.py"),
            "--offline",
            "--weights",
            str(weights),
            "--output",
            str(tmp_path / "predictions.json"),
            "--audio-dir",
            str(audio),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    # y = 2x + 1 for x = 0, 1, 2 lasts 0.1 s per unit; the third reference is deliberately wrong
    # and a fourth reference sample has no WAV at all.
    reference = write_reference(tmp_path / "reference.json", [0.1, 0.3, 0.9, 0.2])
    results = tmp_path / "results.jsonl"
    completed = subprocess.run(
        [
            sys.executable,
            str(EXAMPLES / "evaluation.py"),
            "--offline",
            "--audio-dir",
            str(audio),
            "--reference",
            str(reference),
            "--output",
            str(results),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    metrics = json.loads(completed.stdout)["metrics"]
    assert metrics["evaluation.duration_match_rate"] == 0.5
    assert metrics["evaluation.missing_audio"] == 1
    assert abs(metrics["evaluation.duration_mean_abs_error_seconds"] - 0.4 / 3) < 1e-9
    rows = [json.loads(line) for line in results.read_text().splitlines()]
    assert [row["score"] for row in rows] == [1.0, 1.0, 0.0, 0.0]
    assert rows[2]["prediction"] == 0.5 and rows[3]["prediction"] is None


def test_evaluation_job_reads_the_upstream_runs_wavs_and_records_metrics_over_http(tmp_path):
    with TrackingServer() as server:
        environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
        environment.update(
            MMT_API_URL=server.url,
            MMT_API_TOKEN="example-only-test-token",
            MMT_PROJECT_ID="project-example",
            MMT_EXPERIMENT_ID="experiment-example",
        )
        weights = tmp_path / "weights.json"
        weights.write_text(json.dumps({"family": "linear", "weight": 2.0, "bias": 1.0}))
        subprocess.run(
            [
                sys.executable,
                str(EXAMPLES / "inference.py"),
                "--weights",
                str(weights),
                "--output",
                str(tmp_path / "inference" / "predictions.json"),
            ],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        (inference_output,) = server.dataset_versions
        inference_run_id = inference_output["sourceRunId"]
        assert {sample["audio"] for sample in inference_output["metadata"]["samples"]} == {
            "sample-000.wav",
            "sample-001.wav",
            "sample-002.wav",
        }
        # The worker hands the evaluation Job its Run (whose upstream inputs are the inference
        # output), the input DatasetVersion descriptors and the upstream Run ID.
        reference_set = {
            "id": "reference-set",
            "metadata": json.loads(write_reference(tmp_path / "reference.json", [0.1, 0.3, 0.6]).read_text()),
        }
        evaluation_run_id = "evaluation-run"
        server.runs[evaluation_run_id] = {
            "id": evaluation_run_id,
            "kind": "evaluation",
            "status": "running",
            "inputDatasetVersionIds": [reference_set["id"], inference_output["id"]],
            "upstreamDatasetVersionIds": [inference_output["id"]],
        }
        descriptors = tmp_path / "dataset-versions.json"
        descriptors.write_text(json.dumps({"inputDatasets": [reference_set, inference_output]}))
        upstream_run = tmp_path / "upstream-run.json"
        upstream_run.write_text(
            json.dumps({"runId": inference_run_id, "outputDatasetVersionIds": [inference_output["id"]]})
        )
        environment.update(
            MMT_RUN_ID=evaluation_run_id,
            MMT_UPSTREAM_RUN_ID=inference_run_id,
            MMT_UPSTREAM_RUN_FILE=str(upstream_run),
            MMT_DATASET_VERSIONS_FILE=str(descriptors),
        )
        subprocess.run(
            [sys.executable, str(EXAMPLES / "evaluation.py"), "--output", str(tmp_path / "eval" / "r.jsonl")],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        recorded = {point["name"]: point["value"] for point in server.metrics}
        assert abs(recorded["evaluation.duration_match_rate"] - 2 / 3) < 1e-9
        assert recorded["evaluation.samples"] == 3
        (results,) = [
            artifact for artifact in server.artifact_entities if artifact["runId"] == evaluation_run_id
        ]
        assert results["path"] == "eval/results.jsonl"
        rows = [json.loads(line) for line in server.artifacts[results["id"]].decode().splitlines()]
        assert rows[0]["audio"] == f"mmt-artifact://runs/{inference_run_id}/inference/audio/sample-000.wav"
        # The worker, not the Job's code, completes a worker-managed Run.
        assert server.runs[evaluation_run_id]["status"] == "running"


def test_inference_result_json_declares_the_output_dataset_the_worker_accepts(tmp_path):
    weights = tmp_path / "weights.json"
    weights.write_text(json.dumps({"family": "linear", "weight": 2.0, "bias": 1.0}))
    outputs = tmp_path / "workspace" / "outputs"
    outputs.mkdir(parents=True)
    parameters = tmp_path / "parameters.json"
    parameters.write_text(json.dumps({"outputMode": "result-json", "outputDatasetId": "ds-1"}))
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    environment.update(MMT_OUTPUTS_DIR=str(outputs), MMT_PARAMETERS_FILE=str(parameters))
    subprocess.run(
        [sys.executable, str(EXAMPLES / "inference.py"), "--weights", str(weights)],
        check=True,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        cwd=tmp_path,
    )
    # The worker's own validation: every file declared with its checksum, nothing extra.
    summary = validate_results(outputs)
    assert summary is not None and summary["version"] == 2
    assert summary["artifactCount"] == 4
    assert [(metric["name"], metric["value"]) for metric in summary["metrics"]] == [
        ("inference.predictions", 3.0)
    ]
    (declaration,) = summary["declarations"]
    assert declaration["kind"] == "dataset" and declaration["datasetId"] == "ds-1"
    assert declaration["path"] == "inference/predictions.json"
    assert declaration["metadata"]["audioPrefix"] == "container/inference/audio/"
    assert [sample["audio"] for sample in declaration["metadata"]["samples"]] == [
        "sample-000.wav",
        "sample-001.wav",
        "sample-002.wav",
    ]


def test_inference_result_json_without_an_output_dataset_fails_before_writing_a_manifest(tmp_path):
    weights = tmp_path / "weights.json"
    weights.write_text(json.dumps({"family": "linear", "weight": 2.0, "bias": 1.0}))
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    environment["MMT_OUTPUTS_DIR"] = str(outputs)
    completed = subprocess.run(
        [
            sys.executable,
            str(EXAMPLES / "inference.py"),
            "--weights",
            str(weights),
            "--output-mode",
            "result-json",
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        cwd=tmp_path,
    )
    assert completed.returncode != 0 and "outputDatasetId" in completed.stderr
    assert not (outputs / "result.json").exists()


def test_evaluation_reads_a_staged_reference_and_result_json_wavs_and_writes_result_json(tmp_path):
    """The second path: a reference staged by the worker and inference outputs under container/."""
    weights = tmp_path / "weights.json"
    weights.write_text(json.dumps({"family": "linear", "weight": 2.0, "bias": 1.0}))
    inference_outputs = tmp_path / "inference" / "outputs"
    inference_outputs.mkdir(parents=True)
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    environment["MMT_OUTPUTS_DIR"] = str(inference_outputs)
    subprocess.run(
        [
            sys.executable,
            str(EXAMPLES / "inference.py"),
            "--weights",
            str(weights),
            "--output-mode",
            "result-json",
            "--output-dataset-id",
            "inference-outputs",
        ],
        check=True,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        cwd=tmp_path,
    )
    declared = json.loads((inference_outputs / "result.json").read_text())
    with TrackingServer() as server:
        inference_run_id = "inference-run"
        # What the worker uploaded from the inference outputs: Run Artifacts under container/.
        for artifact in declared["artifacts"]:
            artifact_id = f"artifact-{len(server.artifact_entities)}"
            server.artifacts[artifact_id] = (inference_outputs / artifact["path"]).read_bytes()
            server.artifact_entities.append(
                {"id": artifact_id, "runId": inference_run_id, "path": "container/" + artifact["path"]}
            )
        (dataset_declaration,) = declared["datasets"]
        inference_output = {"id": "inference-output-version", "metadata": dataset_declaration["metadata"]}
        # A reference version uploaded as files, staged read-only by the worker. Its metadata has
        # no samples, so scoring proves the staged file was read.
        staged_reference = tmp_path / "inputs" / "datasets" / "reference-set"
        staged_reference.mkdir(parents=True)
        write_reference(staged_reference / "reference.json", [0.1, 0.3, 0.5])
        reference_set = {"id": "reference-set", "metadata": {}}
        descriptors = tmp_path / "dataset-versions.json"
        descriptors.write_text(json.dumps({"inputDatasets": [reference_set, inference_output]}))
        upstream_run = tmp_path / "upstream-run.json"
        upstream_run.write_text(
            json.dumps({"runId": inference_run_id, "outputDatasetVersionIds": [inference_output["id"]]})
        )
        evaluation_outputs = tmp_path / "evaluation" / "outputs"
        evaluation_outputs.mkdir(parents=True)
        environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
        environment.update(
            MMT_API_URL=server.url,
            MMT_API_TOKEN="example-only-test-token",
            MMT_PROJECT_ID="project-example",
            MMT_RUN_ID="evaluation-run",
            MMT_UPSTREAM_RUN_ID=inference_run_id,
            MMT_UPSTREAM_RUN_FILE=str(upstream_run),
            MMT_DATASET_VERSIONS_FILE=str(descriptors),
            MMT_INPUT_DATASET_DIRS=json.dumps({"reference-set": str(staged_reference)}),
            MMT_OUTPUTS_DIR=str(evaluation_outputs),
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(EXAMPLES / "evaluation.py"),
                "--output-mode",
                "result-json",
                "--output",
                str(tmp_path / "evaluation" / "work" / "r.jsonl"),
            ],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        # The code only read: the metrics travel in result.json, not through the SDK.
        assert not server.metrics
        assert {method for method, _path in server.operations} == {"GET"}
    summary = json.loads(completed.stdout)
    assert summary["audioPrefix"] == "container/inference/audio/"
    assert summary["referenceSources"] == ["reference-set:staged"]
    result = validate_results(evaluation_outputs)
    assert result is not None and result["artifactCount"] == 1
    metrics = {metric["name"]: metric["value"] for metric in result["metrics"]}
    # y = 2x + 1 for x = 0, 1, 2 lasts 0.1, 0.3 and 0.5 seconds: every staged reference matches.
    assert metrics["evaluation.samples"] == 3
    assert metrics["evaluation.duration_match_rate"] == 1.0
    results = (evaluation_outputs / "eval" / "results.jsonl").read_text().splitlines()
    first = json.loads(results[0])
    assert (
        first["audio"] == f"mmt-artifact://runs/{inference_run_id}/container/inference/audio/sample-000.wav"
    )
