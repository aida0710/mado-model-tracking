"""Load the registered linear model (or a local weights file) and produce CPU predictions.

Besides predictions.json, every prediction becomes a short sine-wave WAV whose length encodes the
predicted value, so evaluation.py can score audio outputs the way a speech evaluation would.

In a Job, the Job token may add versions to an existing Dataset but not create a Dataset. Pass the
Dataset as the parameter ``outputDatasetId`` (for example in the automation rule's parameters) or
``--output-dataset-id``; without it a new Dataset is created, which needs a user or service token.
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
# evaluation.py matches samples by these names and paths.
AUDIO_ARTIFACT_PREFIX = "inference/audio/"


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Short CPU inference example")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--values", nargs="+", type=float, default=[0.0, 1.0, 2.0])
    parser.add_argument("--output", type=Path, default=Path("outputs/predictions.json"))
    parser.add_argument("--audio-dir", type=Path, help="Where the WAVs go (default: audio/ next to --output)")
    parser.add_argument("--output-dataset-id", help="Add the output version to this existing Dataset")
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    parameters = {}
    if os.environ.get("MMT_PARAMETERS_FILE"):
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    output_dataset_id = arguments.output_dataset_id or parameters.get("outputDatasetId")
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
        model = json.loads(weights_path.read_text())
        predictions = [{"x": x, "prediction": model["weight"] * x + model["bias"]} for x in arguments.values]
        arguments.output.write_text(json.dumps(predictions), encoding="utf-8")
        samples = write_audio(predictions, audio_directory)
        print(json.dumps(predictions), flush=True)
        if run is not None:
            run.log_metrics({"inference.predictions": len(predictions)})
            run.log_artifact(arguments.output, path="inference/predictions.json")
            for sample in samples:
                run.log_artifact(
                    audio_directory / sample["audio"],
                    path=AUDIO_ARTIFACT_PREFIX + sample["audio"],
                    mime_type="audio/wav",
                )
            outputs = [arguments.output, *(audio_directory / sample["audio"] for sample in samples)]
            # One DatasetVersion describes the whole output; evaluation reads its WAVs through the
            # upstream Run's Artifacts.
            destination = (
                {"dataset_id": output_dataset_id, "version": f"run-{run.id}"}
                if output_dataset_id
                else {"name": f"cpu-predictions-{run.id}", "version": "v1"}
            )
            run.register_output_dataset(
                **destination,
                digest=output_digest(outputs),
                uri=f"mmt-artifact://runs/{run.id}/inference",
                schema={"x": "number", "prediction": "number", "audio": "audio/wav"},
                metadata={"audioPrefix": AUDIO_ARTIFACT_PREFIX, "samples": samples},
            )


if __name__ == "__main__":
    main()
