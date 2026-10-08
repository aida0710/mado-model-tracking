"""Load the registered linear model (or a local weights file) and produce CPU predictions.

Besides predictions.json, every prediction becomes a short sine-wave WAV whose length encodes the
predicted value, so evaluation.py can score audio outputs the way a speech evaluation would.

The outputs are registered in one of two ways (parameter ``outputMode`` or ``--output-mode``):

- ``sdk`` (default): the Run logs the files as Artifacts and registers the output DatasetVersion.
- ``result-json``: the files go to MMT_OUTPUTS_DIR with a result.json version 2 that declares the
  output DatasetVersion; the worker uploads the files (under ``container/``) and registers it. This
  is the path of code that does not log through the SDK, for example in a container.

In a Job, the Job token may add versions to an existing Dataset but not create a Dataset. Pass the
Dataset as the parameter ``outputDatasetId`` (for example in the automation rule's parameters) or
``--output-dataset-id``; without it the sdk mode creates a new Dataset, which needs a user or
service token, and the result-json mode cannot declare an output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import wave
from contextlib import nullcontext
from pathlib import Path

# 16 kHz mono 16-bit PCM is the usual speech format; one predicted unit lasts 0.1 seconds.
SAMPLE_RATE = 16000
SECONDS_PER_PREDICTION_UNIT = 0.1
TONE_HERTZ = 440.0
TONE_AMPLITUDE = 0.3
# evaluation.py matches samples by these names and finds the WAVs through the output's audioPrefix.
AUDIO_ARTIFACT_PREFIX = "inference/audio/"
PREDICTIONS_ARTIFACT_PATH = "inference/predictions.json"
# The worker saves result.json outputs as Run Artifacts under this prefix.
WORKER_OUTPUT_ARTIFACT_PREFIX = "container/"
OUTPUT_MODES = ("sdk", "result-json")
OUTPUT_SCHEMA = {"x": "number", "prediction": "number", "audio": "audio/wav"}


def audio_file_name(index: int) -> str:
    return f"sample-{index:03d}.wav"


def write_sine_wave(path: Path, *, duration_seconds: float) -> None:
    frame_count = max(0, round(duration_seconds * SAMPLE_RATE))
    frames = b"".join(
        struct.pack(
            "<h", round(TONE_AMPLITUDE * 32767 * math.sin(2 * math.pi * TONE_HERTZ * frame / SAMPLE_RATE))
        )
        for frame in range(frame_count)
    )
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(frames)


def write_audio(predictions: list[dict], directory: Path) -> list[dict]:
    """Write one WAV per prediction and return the per-sample descriptions."""
    directory.mkdir(parents=True, exist_ok=True)
    samples = []
    for index, prediction in enumerate(predictions):
        name = audio_file_name(index)
        write_sine_wave(
            directory / name,
            duration_seconds=max(0.0, prediction["prediction"]) * SECONDS_PER_PREDICTION_UNIT,
        )
        samples.append({"audio": name, "x": prediction["x"], "prediction": prediction["prediction"]})
    return samples


def output_digest(files: list[Path]) -> str:
    """sha256 over the (name, content digest) list, so any changed output changes the version digest."""
    manifest = [[file.name, hashlib.sha256(file.read_bytes()).hexdigest()] for file in sorted(files)]
    return "sha256:" + hashlib.sha256(json.dumps(manifest).encode()).hexdigest()


def predict(weights_path: Path, values: list[float]) -> list[dict]:
    model = json.loads(weights_path.read_text())
    return [{"x": x, "prediction": model["weight"] * x + model["bias"]} for x in values]


def write_result_manifest(
    outputs: Path, *, metrics: dict[str, float], datasets: list[dict], mime_types: dict[str, str]
) -> Path:
    """Write result.json version 2 over every file under ``outputs``, then publish it by rename."""
    artifacts = []
    for path in sorted(item for item in outputs.rglob("*") if item.is_file()):
        relative = path.relative_to(outputs).as_posix()
        artifacts.append(
            {
                "path": relative,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": path.stat().st_size,
                "mimeType": mime_types.get(path.suffix, "application/octet-stream"),
            }
        )
    result = {
        "version": 2,
        "complete": True,
        "artifacts": artifacts,
        "metrics": [{"name": name, "value": value, "step": 0} for name, value in metrics.items()],
        "datasets": datasets,
    }
    # The worker rejects .partial files, so the manifest appears only once it is whole.
    staging = outputs / "result.json.partial"
    staging.write_text(json.dumps(result), encoding="utf-8")
    final = outputs / "result.json"
    staging.rename(final)
    return final


def declare_outputs_in_result_json(
    *, predictions: list[dict], outputs: Path, output_dataset_id: str | None
) -> Path:
    """result-json mode: put the outputs in MMT_OUTPUTS_DIR and declare the DatasetVersion."""
    if not output_dataset_id:
        raise ValueError("result-json mode needs outputDatasetId: result.json can only add a version")
    predictions_path = outputs / PREDICTIONS_ARTIFACT_PATH
    predictions_path.parent.mkdir(parents=True, exist_ok=True)
    predictions_path.write_text(json.dumps(predictions), encoding="utf-8")
    audio_directory = outputs / AUDIO_ARTIFACT_PREFIX
    samples = write_audio(predictions, audio_directory)
    dataset = {
        "datasetId": output_dataset_id,
        "path": PREDICTIONS_ARTIFACT_PATH,
        "digest": output_digest(
            [predictions_path, *(audio_directory / sample["audio"] for sample in samples)]
        ),
        "schema": OUTPUT_SCHEMA,
        "metadata": {
            "audioPrefix": WORKER_OUTPUT_ARTIFACT_PREFIX + AUDIO_ARTIFACT_PREFIX,
            "samples": samples,
        },
    }
    return write_result_manifest(
        outputs,
        metrics={"inference.predictions": float(len(predictions))},
        datasets=[dataset],
        mime_types={".json": "application/json", ".wav": "audio/wav"},
    )


def input_weights_without_run(destination: Path) -> Path:
    """Weights for code that does not open a Run: the container's staged file or the pinned version."""
    staged = os.environ.get("MMT_MODEL_FILE")
    if staged:
        return Path(staged)
    from mado_tracking import Client
    from mado_tracking.model_input import download_input_model, pinned_model_version

    project_id = os.environ["MMT_PROJECT_ID"]
    pinned = pinned_model_version(
        project_id=project_id, model_version_id=os.environ.get("MMT_MODEL_VERSION_ID"), model_version=None
    )
    with Client() as client:
        return download_input_model(client, destination, project_id=project_id, model_version=pinned)


def run_with_result_json(arguments: argparse.Namespace, *, output_dataset_id: str | None) -> None:
    outputs = Path(os.environ["MMT_OUTPUTS_DIR"])
    weights_path = arguments.weights or input_weights_without_run(
        arguments.output.parent / "input-weights.json"
    )
    predictions = predict(weights_path, arguments.values)
    declare_outputs_in_result_json(
        predictions=predictions, outputs=outputs, output_dataset_id=output_dataset_id
    )
    print(json.dumps(predictions), flush=True)


def run_with_sdk(arguments: argparse.Namespace, *, output_dataset_id: str | None) -> None:
    audio_directory = arguments.audio_dir or arguments.output.parent / "audio"
    if arguments.offline:
        context = nullcontext(None)
    else:
        from mado_tracking import start_run

        context = start_run(
            name=None if os.environ.get("MMT_RUN_ID") else "CPU linear inference",
            kind="inference",
            parameters={"values": arguments.values},
        )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with context as run:
        weights_path = arguments.weights
        if weights_path is None and run is not None:
            weights_path = run.download_input_model(arguments.output.parent / "input-weights.json")
        if weights_path is None:
            raise ValueError("--weights is required in offline mode")
        predictions = predict(weights_path, arguments.values)
        arguments.output.write_text(json.dumps(predictions), encoding="utf-8")
        samples = write_audio(predictions, audio_directory)
        print(json.dumps(predictions), flush=True)
        if run is None:
            return
        run.log_metrics({"inference.predictions": len(predictions)})
        run.log_artifact(arguments.output, path=PREDICTIONS_ARTIFACT_PATH)
        for sample in samples:
            run.log_artifact(
                audio_directory / sample["audio"],
                path=AUDIO_ARTIFACT_PREFIX + sample["audio"],
                mime_type="audio/wav",
            )
        outputs = [arguments.output, *(audio_directory / sample["audio"] for sample in samples)]
        # One DatasetVersion describes the whole output; evaluation reads its WAVs through the
        # upstream Run's Artifacts under audioPrefix.
        destination = (
            {"dataset_id": output_dataset_id, "version": f"run-{run.id}"}
            if output_dataset_id
            else {"name": f"cpu-predictions-{run.id}", "version": "v1"}
        )
        run.register_output_dataset(
            **destination,
            digest=output_digest(outputs),
            uri=f"mmt-artifact://runs/{run.id}/inference",
            schema=OUTPUT_SCHEMA,
            metadata={"audioPrefix": AUDIO_ARTIFACT_PREFIX, "samples": samples},
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Short CPU inference example")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--values", nargs="+", type=float, default=[0.0, 1.0, 2.0])
    parser.add_argument("--output", type=Path, default=Path("outputs/predictions.json"))
    parser.add_argument("--audio-dir", type=Path, help="Where the WAVs go (default: audio/ next to --output)")
    parser.add_argument("--output-dataset-id", help="Add the output version to this existing Dataset")
    parser.add_argument("--output-mode", choices=OUTPUT_MODES, help="sdk (default) or result-json")
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    parameters = {}
    if os.environ.get("MMT_PARAMETERS_FILE"):
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    output_dataset_id = arguments.output_dataset_id or parameters.get("outputDatasetId")
    output_mode = arguments.output_mode or parameters.get("outputMode", "sdk")
    if output_mode not in OUTPUT_MODES:
        raise ValueError(f"outputMode must be one of {', '.join(OUTPUT_MODES)}")
    if output_mode == "result-json":
        run_with_result_json(arguments, output_dataset_id=output_dataset_id)
    else:
        run_with_sdk(arguments, output_dataset_id=output_dataset_id)


if __name__ == "__main__":
    main()
