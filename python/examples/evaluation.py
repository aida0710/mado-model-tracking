"""Score the upstream inference Run's WAVs against a reference set and record metrics.

Inside a chained evaluation Job (an automation rule whose upstream is the inference rule) the
worker sets MMT_UPSTREAM_RUN_ID; the WAVs are read from that Run's Artifacts under the
``audioPrefix`` of its output DatasetVersion (``inference/audio/`` when inference.py logged them
through the SDK, ``container/inference/audio/`` when it declared them in result.json).

The reference set is the Run's input DatasetVersion that is not an upstream output. It lists the
expected length of every sample, either in a file of the version itself or in its metadata:

    {"samples": [{"audio": "sample-000.wav", "durationSeconds": 0.1}, ...]}

- A version whose files were uploaded (contentKind=artifacts) is staged by the worker before the
  code starts; MMT_INPUT_DATASET_DIRS points to it and ``reference.json`` is read from there.
- A descriptor-only version (``urn:``) carries the samples in its metadata.

The metrics are recorded through the SDK (parameter ``outputMode`` ``sdk``, the default) or
written to result.json in MMT_OUTPUTS_DIR for the worker to send (``result-json``).

The score is length agreement, not audio quality: it shows that real upstream outputs reach the
evaluation and change its metrics. Offline, pass --audio-dir and --reference (a JSON file with the
same "samples" shape).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import wave
from pathlib import Path
from typing import Any

# A 10 ms frame is the usual resolution of speech features; closer lengths count as a match.
DEFAULT_DURATION_TOLERANCE_SECONDS = 0.01
# inference.py's SDK mode stores its WAVs under this prefix; outputs that say otherwise win.
DEFAULT_AUDIO_ARTIFACT_PREFIX = "inference/audio/"
RESULTS_ARTIFACT_PATH = "eval/results.jsonl"
# The file a staged reference DatasetVersion holds its samples in.
REFERENCE_FILE_NAME = "reference.json"
OUTPUT_MODES = ("sdk", "result-json")


def wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def score_samples(
    reference_samples: list[dict[str, Any]],
    audio_directory: Path,
    *,
    audio_uri_prefix: str,
    tolerance_seconds: float = DEFAULT_DURATION_TOLERANCE_SECONDS,
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
        matched = actual is not None and abs(actual - expected) <= tolerance_seconds
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


def upstream_output_ids() -> set[str]:
    """IDs of the inputs that are the upstream Run's outputs (upstream-run.json from the worker)."""
    upstream_file = os.environ.get("MMT_UPSTREAM_RUN_FILE")
    if not upstream_file:
        return set()
    return set(json.loads(Path(upstream_file).read_text()).get("outputDatasetVersionIds") or [])


def input_dataset_versions() -> list[dict[str, Any]]:
    return json.loads(Path(os.environ["MMT_DATASET_VERSIONS_FILE"]).read_text())["inputDatasets"]


def staged_dataset_directories() -> dict[str, Path]:
    """Input DatasetVersions the worker staged before the code started, by version ID."""
    staged = json.loads(os.environ.get("MMT_INPUT_DATASET_DIRS") or "{}")
    return {version_id: Path(directory) for version_id, directory in staged.items()}


def reference_samples_of_job() -> tuple[list[dict[str, Any]], list[str]]:
    """Samples of the reference set, and where each reference version was read from."""
    upstream_outputs = upstream_output_ids()
    staged = staged_dataset_directories()
    samples: list[dict[str, Any]] = []
    sources: list[str] = []
    for dataset_version in input_dataset_versions():
        version_id = dataset_version["id"]
        if version_id in upstream_outputs:
            continue
        reference_file = staged[version_id] / REFERENCE_FILE_NAME if version_id in staged else None
        if reference_file is not None and reference_file.is_file():
            samples.extend(json.loads(reference_file.read_text())["samples"])
            sources.append(f"{version_id}:staged")
        else:
            samples.extend((dataset_version.get("metadata") or {}).get("samples", []))
            sources.append(f"{version_id}:metadata")
    return samples, sources


def upstream_audio_prefix() -> str:
    """Where the upstream Run keeps its WAVs, from the audioPrefix of its output DatasetVersion."""
    upstream_outputs = upstream_output_ids()
    for dataset_version in input_dataset_versions():
        if dataset_version["id"] in upstream_outputs:
            prefix = (dataset_version.get("metadata") or {}).get("audioPrefix")
            if prefix:
                return str(prefix)
    return DEFAULT_AUDIO_ARTIFACT_PREFIX


def write_results(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def write_result_manifest(outputs: Path, *, metrics: dict[str, float], results_path: Path) -> Path:
    """result.json version 1: the results file and the metrics, published by rename."""
    relative = results_path.relative_to(outputs).as_posix()
    result = {
        "version": 1,
        "complete": True,
        "artifacts": [
            {
                "path": relative,
                "sha256": hashlib.sha256(results_path.read_bytes()).hexdigest(),
                "size": results_path.stat().st_size,
                "mimeType": "application/x-ndjson",
            }
        ],
        "metrics": [{"name": name, "value": value, "step": 0} for name, value in metrics.items()],
    }
    # The worker rejects .partial files, so the manifest appears only once it is whole.
    staging = outputs / "result.json.partial"
    staging.write_text(json.dumps(result), encoding="utf-8")
    final = outputs / "result.json"
    staging.rename(final)
    return final


def evaluate_upstream(
    *, download_directory: Path, tolerance_seconds: float, client: Any = None
) -> dict[str, Any]:
    """Download the upstream WAVs and score them against the reference set of this Job."""
    from mado_tracking import download_upstream_artifacts, upstream_run_id

    upstream = upstream_run_id()
    if upstream is None:
        raise ValueError("evaluation.py needs an upstream inference Run (MMT_UPSTREAM_RUN_ID)")
    prefix = upstream_audio_prefix()
    download_upstream_artifacts(download_directory, prefix=prefix, client=client)
    samples, sources = reference_samples_of_job()
    metrics, rows = score_samples(
        samples,
        download_directory / prefix,
        audio_uri_prefix=f"mmt-artifact://runs/{upstream}/{prefix}",
        tolerance_seconds=tolerance_seconds,
    )
    return {
        "upstreamRunId": upstream,
        "audioPrefix": prefix,
        "referenceSources": sources,
        "metrics": metrics,
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Score upstream WAV lengths against a reference set")
    parser.add_argument("--audio-dir", type=Path, help="Offline: directory with the inference WAVs")
    parser.add_argument("--reference", type=Path, help='Offline: JSON file {"samples": [...]}')
    parser.add_argument("--output", type=Path, default=Path("outputs/eval/results.jsonl"))
    parser.add_argument("--tolerance-seconds", type=float, default=DEFAULT_DURATION_TOLERANCE_SECONDS)
    parser.add_argument("--output-mode", choices=OUTPUT_MODES, help="sdk (default) or result-json")
    parser.add_argument("--offline", action="store_true", help="Run locally without the tracking API")
    arguments = parser.parse_args()
    if arguments.offline:
        if arguments.audio_dir is None or arguments.reference is None:
            raise ValueError("--audio-dir and --reference are required in offline mode")
        reference = json.loads(arguments.reference.read_text())["samples"]
        metrics, rows = score_samples(
            reference,
            arguments.audio_dir,
            audio_uri_prefix=f"{arguments.audio_dir.as_posix()}/",
            tolerance_seconds=arguments.tolerance_seconds,
        )
        write_results(rows, arguments.output)
        print(json.dumps({"metrics": metrics}), flush=True)
        return

    parameters = {}
    if os.environ.get("MMT_PARAMETERS_FILE"):
        parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    output_mode = arguments.output_mode or parameters.get("outputMode", "sdk")
    if output_mode not in OUTPUT_MODES:
        raise ValueError(f"outputMode must be one of {', '.join(OUTPUT_MODES)}")
    if output_mode == "result-json":
        outputs = Path(os.environ["MMT_OUTPUTS_DIR"])
        evaluation = evaluate_upstream(
            download_directory=arguments.output.parent / "upstream",
            tolerance_seconds=arguments.tolerance_seconds,
        )
        results_path = outputs / RESULTS_ARTIFACT_PATH
        write_results(evaluation["rows"], results_path)
        write_result_manifest(outputs, metrics=evaluation["metrics"], results_path=results_path)
    else:
        from mado_tracking import start_run

        with start_run(kind="evaluation") as run:
            evaluation = evaluate_upstream(
                download_directory=arguments.output.parent / "upstream",
                tolerance_seconds=arguments.tolerance_seconds,
                client=run.client,
            )
            write_results(evaluation["rows"], arguments.output)
            run.log_metrics(evaluation["metrics"])
            run.log_artifact(arguments.output, path=RESULTS_ARTIFACT_PATH, mime_type="application/x-ndjson")
    summary = {
        key: evaluation[key] for key in ("upstreamRunId", "audioPrefix", "referenceSources", "metrics")
    }
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
