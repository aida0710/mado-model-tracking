"""Score the upstream inference Run's WAVs against a reference set and record metrics.

Inside a chained evaluation Job (an automation rule whose upstream is the inference rule) the
worker sets MMT_UPSTREAM_RUN_ID; the WAVs are read from that Run's Artifacts. The reference set is
the Run's input DatasetVersion that is not an upstream output; its metadata lists the expected
length of every sample:

    {"samples": [{"audio": "sample-000.wav", "durationSeconds": 0.1}, ...]}

The score is length agreement, not audio quality: it shows that real upstream outputs reach the
evaluation and change its metrics. Offline, pass --audio-dir and --reference (a JSON file with the
same "samples" shape).
"""

from __future__ import annotations

import argparse
import json
import os
import wave
from pathlib import Path
from typing import Any

# A 10 ms frame is the usual resolution of speech features; closer lengths count as a match.
DURATION_TOLERANCE_SECONDS = 0.01
# inference.py stores its WAVs under this prefix of the inference Run.
AUDIO_ARTIFACT_PREFIX = "inference/audio/"
RESULTS_ARTIFACT_PATH = "eval/results.jsonl"


def wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def score_samples(
    reference_samples: list[dict[str, Any]], audio_directory: Path, *, audio_uri_prefix: str
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Compare each reference length with the WAV of the same name; a missing WAV scores 0."""
    if not reference_samples:
        raise ValueError("The reference set has no samples")
    rows = []
    errors = []
    for sample in reference_samples:
        expected = float(sample["durationSeconds"])
        audio_path = audio_directory / sample["audio"]
        actual = wav_duration_seconds(audio_path) if audio_path.is_file() else None
        matched = actual is not None and abs(actual - expected) <= DURATION_TOLERANCE_SECONDS
        if actual is not None:
            errors.append(abs(actual - expected))
        rows.append(
            {
                "audio": audio_uri_prefix + sample["audio"],
                "reference": expected,
                "prediction": actual,
                "score": 1.0 if matched else 0.0,
            }
        )
    metrics = {
        "evaluation.samples": float(len(rows)),
        "evaluation.missing_audio": float(len(rows) - len(errors)),
        "evaluation.duration_match_rate": sum(row["score"] for row in rows) / len(rows),
    }
    # Without any WAV there is no length error to average; the match rate already reports 0.
    if errors:
        metrics["evaluation.duration_mean_abs_error_seconds"] = sum(errors) / len(errors)
    return metrics, rows


def reference_samples_of_run(run_entity: dict[str, Any]) -> list[dict[str, Any]]:
    """Samples of the reference set: input DatasetVersions that are not upstream outputs."""
    upstream_outputs = set(run_entity.get("upstreamDatasetVersionIds") or [])
    descriptors = json.loads(Path(os.environ["MMT_DATASET_VERSIONS_FILE"]).read_text())["inputDatasets"]
    samples = []
    for dataset_version in descriptors:
        if dataset_version["id"] in upstream_outputs:
            continue
        samples.extend((dataset_version.get("metadata") or {}).get("samples", []))
    return samples


def write_results(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score upstream WAV lengths against a reference set")
    parser.add_argument("--audio-dir", type=Path, help="Offline: directory with the inference WAVs")
    parser.add_argument("--reference", type=Path, help='Offline: JSON file {"samples": [...]}')
    parser.add_argument("--output", type=Path, default=Path("outputs/eval/results.jsonl"))
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    if arguments.offline:
        if arguments.audio_dir is None or arguments.reference is None:
            raise ValueError("--audio-dir and --reference are required in offline mode")
        reference = json.loads(arguments.reference.read_text())["samples"]
        metrics, rows = score_samples(
            reference, arguments.audio_dir, audio_uri_prefix=f"{arguments.audio_dir.as_posix()}/"
        )
        write_results(rows, arguments.output)
        print(json.dumps({"metrics": metrics}), flush=True)
        return

    from mado_tracking import download_upstream_artifacts, start_run, upstream_run_id

    upstream = upstream_run_id()
    if upstream is None:
        raise ValueError("evaluation.py needs an upstream inference Run (MMT_UPSTREAM_RUN_ID)")
    with start_run(kind="evaluation") as run:
        download_directory = arguments.output.parent / "upstream"
        download_upstream_artifacts(download_directory, prefix=AUDIO_ARTIFACT_PREFIX, client=run.client)
        metrics, rows = score_samples(
            reference_samples_of_run(run.entity),
            download_directory / AUDIO_ARTIFACT_PREFIX,
            audio_uri_prefix=f"mmt-artifact://runs/{upstream}/{AUDIO_ARTIFACT_PREFIX}",
        )
        write_results(rows, arguments.output)
        run.log_metrics(metrics)
        run.log_artifact(arguments.output, path=RESULTS_ARTIFACT_PATH, mime_type="application/x-ndjson")
    print(json.dumps({"upstreamRunId": upstream, "metrics": metrics}), flush=True)


if __name__ == "__main__":
    main()
