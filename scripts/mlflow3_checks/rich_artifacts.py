"""log_table/log_image/log_dict/log_text/log_figure and audio files: listing, bytes and headers."""

from __future__ import annotations

import json
import math
import mimetypes
import struct
import wave
from pathlib import Path

import httpx
import matplotlib

matplotlib.use("Agg")  # Render figures without a display on headless verification hosts.
import matplotlib.pyplot as plt
import mlflow
import numpy as np
import pandas as pd
import yaml
from mlflow import MlflowClient

from mlflow3_checks.common import (
    HTTP_TIMEOUT_SECONDS,
    native_project_url,
    run_artifact_response,
    sha256_file,
    tracking_headers,
)

AUDIO_SAMPLE_RATE = 16000
AUDIO_SAMPLE_COUNT = 1600
# The canonical PCM WAV header is 44 bytes; ranges before and after it mimic a seeking player.
WAVE_HEADER_BYTES = 44
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
FALLBACK_MIME_TYPE = "application/octet-stream"
# The server infers these when the SDK falls back to octet-stream (apps/api/src/domain/artifactMimeType.ts).
SERVER_INFERRED_TYPES = {".wav": "audio/wav", ".flac": "audio/flac", ".png": "image/png"}


def write_sine_wave(path: Path) -> None:
    samples = [round(math.sin(index / 8) * 8000) for index in range(AUDIO_SAMPLE_COUNT)]
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(AUDIO_SAMPLE_RATE)
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def write_header_only_flac(path: Path) -> None:
    """A valid FLAC stream with STREAMINFO and no audio frames; enough for type and Range checks."""
    block_size = 4096
    # 20-bit sample rate, 3-bit (channels - 1), 5-bit (bits per sample - 1), 36-bit sample count.
    packed = (AUDIO_SAMPLE_RATE << 44) | (0 << 41) | (15 << 36) | 0
    stream_info = (
        struct.pack(">HH", block_size, block_size) + bytes(6) + packed.to_bytes(8, "big") + bytes(16)
    )
    last_block_header = bytes([0x80]) + len(stream_info).to_bytes(3, "big")
    path.write_bytes(b"fLaC" + last_block_header + stream_info)


def expected_content_type(filename: str) -> str:
    """The type the SDK declares on upload, or the server's inference when it declares none."""
    declared = mimetypes.guess_type(filename)[0] or FALLBACK_MIME_TYPE
    if declared != FALLBACK_MIME_TYPE:
        return declared
    return SERVER_INFERRED_TYPES.get(Path(filename).suffix, FALLBACK_MIME_TYPE)


def log_rich_artifacts(temporary: Path) -> tuple[str, dict[str, Path]]:
    """Log every rich artifact type in one Run and return local copies of the audio sources."""
    wave_file, flac_file = temporary / "sine.wav", temporary / "header-only.flac"
    write_sine_wave(wave_file)
    write_header_only_flac(flac_file)
    figure, axes = plt.subplots(figsize=(2, 2))
    axes.plot([0, 1, 2], [1, 3, 5])
    gradient = np.tile(np.arange(16, dtype=np.uint8) * 16, (16, 1))
    with mlflow.start_run(run_name="Rich artifacts and audio") as run:
        mlflow.log_table(
            pd.DataFrame({"audio": ["a.wav", "b.wav"], "score": [0.9, 0.7]}),
            artifact_file="tables/scores.json",
        )
        mlflow.log_image(np.stack([gradient] * 3, axis=-1), artifact_file="images/gradient.png")
        mlflow.log_dict({"labels": ["日本語", "english"]}, "config/labels.json")
        mlflow.log_dict({"sample_rate": AUDIO_SAMPLE_RATE}, "config/audio.yaml")
        mlflow.log_text("認識結果: こんにちは\n", "text/transcript.txt")
        mlflow.log_figure(figure, "figures/line.png")
        mlflow.log_artifact(str(wave_file), artifact_path="audio")
        mlflow.log_artifact(str(flac_file), artifact_path="audio")
    plt.close(figure)
    return run.info.run_id, {"audio/sine.wav": wave_file, "audio/header-only.flac": flac_file}


def assert_audio_served(run_id: str, path: str, source: Path) -> dict:
    """Whole download keeps bytes and type; a Range request returns 206 with the same type."""
    size = source.stat().st_size
    content_type = expected_content_type(source.name)
    whole = run_artifact_response(run_id, path)
    assert whole.status_code == 200 and whole.headers["content-type"] == content_type, whole.headers
    assert whole.content == source.read_bytes()
    header = run_artifact_response(run_id, path, byte_range="bytes=0-11")
    assert header.status_code == 206, header.status_code
    assert header.headers["content-type"] == content_type
    assert header.headers["content-range"] == f"bytes 0-11/{size}"
    assert header.content == source.read_bytes()[:12]
    return {"contentType": content_type, "bytes": size, "rangeStatus": header.status_code}


def assert_native_audio_preview(run_id: str, path: str, source: Path) -> dict:
    """The native content URL used by the audio viewer serves the MLflow upload inline with Range."""
    listing = httpx.get(
        f"{native_project_url()}/runs/{run_id}/artifacts",
        headers=tracking_headers(),
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    listing.raise_for_status()
    artifact = next(item for item in listing.json()["items"] if item["path"] == path)
    tail = httpx.get(
        f"{native_project_url()}/artifacts/{artifact['id']}/content",
        headers=tracking_headers() | {"Range": f"bytes={WAVE_HEADER_BYTES}-"},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    assert tail.status_code == 206, tail.status_code
    assert tail.headers["content-disposition"].startswith("inline;"), tail.headers["content-disposition"]
    assert tail.content == source.read_bytes()[WAVE_HEADER_BYTES:]
    return {"contentType": tail.headers["content-type"], "disposition": "inline", "rangeStatus": 206}


def verify_rich_artifacts(client: MlflowClient, temporary: Path) -> dict:
    run_id, audio_sources = log_rich_artifacts(temporary)
    listed = {
        entry.path
        for directory in ("tables", "images", "config", "text", "figures", "audio")
        for entry in client.list_artifacts(run_id, directory)
    }
    assert listed == {
        "tables/scores.json",
        "images/gradient.png",
        "config/labels.json",
        "config/audio.yaml",
        "text/transcript.txt",
        "figures/line.png",
        *audio_sources,
    }, listed
    downloads = Path(client.download_artifacts(run_id, "", str(temporary / "download")))
    table = json.loads((downloads / "tables/scores.json").read_text())
    assert table == {"columns": ["audio", "score"], "data": [["a.wav", 0.9], ["b.wav", 0.7]]}, table
    assert json.loads((downloads / "config/labels.json").read_text(encoding="utf-8")) == {
        "labels": ["日本語", "english"]
    }
    assert yaml.safe_load((downloads / "config/audio.yaml").read_text()) == {"sample_rate": AUDIO_SAMPLE_RATE}
    assert (downloads / "text/transcript.txt").read_text(encoding="utf-8") == "認識結果: こんにちは\n"
    for image in ("images/gradient.png", "figures/line.png"):
        assert (downloads / image).read_bytes().startswith(PNG_SIGNATURE), image
        assert run_artifact_response(run_id, image).headers["content-type"] == expected_content_type(image)
    for path, source in audio_sources.items():
        assert sha256_file(downloads / path) == sha256_file(source), path
    logged_tag = json.loads(client.get_run(run_id).data.tags["mlflow.loggedArtifacts"])
    assert {"path": "tables/scores.json", "type": "table"} in logged_tag, logged_tag
    return {
        "runId": run_id,
        "artifacts": sorted(listed),
        "audio": {path: assert_audio_served(run_id, path, source) for path, source in audio_sources.items()},
        "nativeAudioPreview": assert_native_audio_preview(
            run_id, "audio/sine.wav", audio_sources["audio/sine.wav"]
        ),
    }
