from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest
from test_offline_sync import PROJECT_ID, FakeSyncApi

from mado_tracking import Audio, Table, http
from mado_tracking.client import start_run_offline
from mado_tracking.offline.spool import file_digest, read_media
from mado_tracking.offline.sync import sync_run_directory

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "media_logging.py"


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MMT_OFFLINE_DIR", str(tmp_path / "offline"))
    monkeypatch.delenv("MMT_JOB_ID", raising=False)
    monkeypatch.delenv("MMT_MODE", raising=False)
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)


def record_media_run():
    run = start_run_offline(project_id=PROJECT_ID, experiment_id=str(uuid4()), name="offline media")
    run.log_metrics({"loss": 0.4}, step=100)
    run.log_audio("eval/audio", np.zeros(160), sample_rate=16000, caption="silence")
    run.log_image("spectrogram", np.zeros((8, 8), dtype=np.uint8), step=100)
    run.log_table(
        "eval/table",
        Table(["audio", "score"], [[Audio(np.zeros(80), sample_rate=8000), 0.5]]),
        step=100,
    )
    run.finish()
    assert run.offline_directory is not None
    return run, run.offline_directory


def spooled_artifacts(directory):
    return [json.loads(line) for line in (directory / "artifacts.jsonl").read_text().splitlines()]


def test_offline_media_is_copied_into_the_spool_and_written_to_media_jsonl():
    _run, directory = record_media_run()

    media = read_media(directory)
    artifacts = {artifact["path"]: artifact for artifact in spooled_artifacts(directory)}
    assert [(item["key"], item["step"], item["kind"]) for item in media] == [
        ("eval/audio", 100, "audio"),
        ("spectrogram", 100, "image"),
        ("eval/table", 100, "table"),
    ]
    assert media[0]["caption"] == "silence"
    assert media[0]["metadata"] == {"sampleRate": 16000, "channels": 1}
    for item in media:
        artifact = artifacts[item["artifactPath"]]
        copy = directory / artifact["localPath"]
        assert artifact["copied"] and file_digest(copy)[0] == artifact["sha256"]
    # The table's audio cell is a spooled Artifact too, referred to by its path.
    table = json.loads((directory / artifacts[media[2]["artifactPath"]]["localPath"]).read_bytes())
    cell_path = table["data"][0][0]["filepath"]
    assert table["data"][0][0]["type"] == "audio" and cell_path in artifacts


def test_sync_registers_spooled_media_with_their_ids_and_a_second_sync_adds_nothing():
    api = FakeSyncApi()
    run, directory = record_media_run()
    spooled = read_media(directory)

    first = sync_run_directory(api.client(), directory)
    media_after_first = dict(api.media)
    second = sync_run_directory(api.client(), directory)

    assert first.outcome == "completed" and first.media == 3
    assert list(media_after_first) == [item["id"] for item in spooled]
    artifact_paths = {artifact["id"]: artifact["path"] for artifact in api.artifacts.values()}
    for item in spooled:
        sent = api.media[item["id"]]
        assert artifact_paths[sent["artifactId"]] == item["artifactPath"]
        assert (sent["key"], sent["step"], sent["kind"]) == (item["key"], item["step"], item["kind"])
    assert len(api.artifacts) == 4  # three media files and the table's audio cell
    assert second.outcome == "completed" and second.media == 0
    assert api.media == media_after_first
    assert api.runs[run.id]["status"] == "finished"


def test_the_media_example_records_audio_a_spectrogram_and_a_table_every_100_steps(tmp_path, monkeypatch):
    monkeypatch.setenv("MMT_PROJECT_ID", PROJECT_ID)
    monkeypatch.setenv("MMT_EXPERIMENT_ID", str(uuid4()))

    completed = subprocess.run(
        [sys.executable, str(EXAMPLE), "--mode", "offline", "--steps", "200"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    (directory,) = (tmp_path / "offline").iterdir()
    media = [(item["key"], item["step"], item["kind"]) for item in read_media(directory)]
    assert media == [
        (key, step, kind)
        for step in (100, 200)
        for key, kind in [
            ("inference/tone", "audio"),
            ("inference/spectrogram", "image"),
            ("evaluation/samples", "table"),
        ]
    ]
