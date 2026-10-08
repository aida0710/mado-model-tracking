from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from test_offline_sync import EXPERIMENT_ID, PROJECT_ID, FakeSyncApi

from mado_tracking import http
from mado_tracking.offline.spool import list_batches, read_artifacts, read_batch_body
from mado_tracking.offline.sync import sync_run_directory

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "research_features.py"
STEPS = 30
# research_features.py evaluates every 10 steps.
MEDIA_STEPS = [9, 19, 29]
CHECKPOINT_MIB = 1


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch):
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)


def run_example(offline_directory: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    environment.update(
        MMT_MODE="offline",
        MMT_OFFLINE_DIR=str(offline_directory),
        MMT_PROJECT_ID=PROJECT_ID,
        MMT_EXPERIMENT_ID=EXPERIMENT_ID,
    )
    return subprocess.run(
        [sys.executable, str(EXAMPLE), *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def record_offline(tmp_path: Path) -> tuple[dict, Path]:
    completed = run_example(
        tmp_path / "offline", "--steps", str(STEPS), "--checkpoint-mib", str(CHECKPOINT_MIB)
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    return result, Path(result["offlineDirectory"])


def test_the_offline_example_needs_no_api_and_reports_its_spool(tmp_path):
    result, directory = record_offline(tmp_path)

    assert result["mode"] == "offline" and result["lastStep"] == STEPS - 1
    assert directory.parent == tmp_path / "offline" and directory.name == result["runId"]
    spooled_metrics = [
        point for batch in list_batches(directory) for point in read_batch_body(batch).get("metrics", [])
    ]
    assert sorted(point["step"] for point in spooled_metrics if point["name"] == "loss") == list(range(STEPS))
    (checkpoint,) = [
        artifact for artifact in read_artifacts(directory) if artifact.path == "checkpoints/model.bin"
    ]
    assert checkpoint.size == CHECKPOINT_MIB * 1024 * 1024 and checkpoint.copied


def test_syncing_the_example_sends_metrics_media_and_the_checkpoint_once(tmp_path):
    result, directory = record_offline(tmp_path)
    api = FakeSyncApi()

    with api.client() as client:
        first = sync_run_directory(client, directory)
        requests_after_first = len(api.requests)
        second = sync_run_directory(client, directory)

    assert first.outcome == "completed" and second.outcome == "completed"
    run = api.runs[result["runId"]]
    assert run["status"] == "finished" and run["name"] == "research-features"
    loss_steps = sorted(point["step"] for point in api.metrics if point["name"] == "loss")
    assert loss_steps == list(range(STEPS))
    media = sorted((item["key"], item["step"], item["kind"]) for item in api.media.values())
    assert media == sorted(
        (key, step, kind)
        for key, kind in (
            ("inference/tone", "audio"),
            ("inference/spectrogram", "image"),
            ("evaluation/samples", "table"),
        )
        for step in MEDIA_STEPS
    )
    stored = {artifact["path"]: artifact for artifact in api.artifacts.values()}
    (spooled_checkpoint,) = [
        artifact for artifact in read_artifacts(directory) if artifact.path == "checkpoints/model.bin"
    ]
    assert stored["checkpoints/model.bin"]["sha256"] == spooled_checkpoint.sha256
    # Every media item points at an Artifact of the same Run.
    assert {item["artifactId"] for item in api.media.values()} <= set(api.artifacts)
    assert len(api.requests) == requests_after_first, "the second sync of a synced spool sent requests"


def test_the_synced_table_keeps_audio_cells_as_artifact_paths(tmp_path):
    _result, directory = record_offline(tmp_path)
    api = FakeSyncApi()

    with api.client() as client:
        sync_run_directory(client, directory)

    (table,) = [item for item in api.media.values() if item["kind"] == "table" and item["step"] == 29]
    stored_paths = {artifact["path"] for artifact in api.artifacts.values()}
    (table_file,) = [
        artifact
        for artifact in read_artifacts(directory)
        if artifact.path.startswith("media/evaluation/samples/step-29/") and artifact.path.endswith(".json")
    ]
    content = json.loads(table_file.local_path.read_text())
    assert content["columns"] == ["audio", "transcript", "score"]
    assert [row[1] for row in content["data"]] == ["こんにちは", "ありがとう", "さようなら"]
    assert all(row[0]["type"] == "audio" and row[0]["filepath"] in stored_paths for row in content["data"])
    assert table["artifactId"] in api.artifacts


def test_the_example_refuses_to_resume_an_offline_run(tmp_path):
    completed = run_example(tmp_path / "offline", "--resume", "a7b2a0ce-5f87-4ad8-8ae1-a9a8f1f2c1d0")

    assert completed.returncode != 0
    assert "cannot be resumed" in completed.stderr
    assert not (tmp_path / "offline").exists() or not any((tmp_path / "offline").iterdir())
