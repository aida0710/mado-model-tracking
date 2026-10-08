from __future__ import annotations

import hashlib
import io
import json
import stat
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

import mado_tracking
from mado_tracking import Client, ConfigurationError
from mado_tracking.offline import spool
from mado_tracking.offline.spool import SPOOL_FSYNC_EVERY, list_batches, read_artifacts, read_batch_body

PROJECT_ID = str(uuid4())
EXPERIMENT_ID = str(uuid4())
TOKEN = "spool-test-secret-token"


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MMT_OFFLINE_DIR", str(tmp_path / "offline"))
    for name in ("MMT_JOB_ID", "MMT_RUN_ID", "MMT_MODE", "MMT_API_URL", "MMT_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*_arguments, **_options):
        raise AssertionError("an offline Run must not contact the API")

    monkeypatch.setattr(httpx.Client, "send", refuse)


def start_offline(**options):
    return mado_tracking.start_run(
        project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="offline", mode="offline", **options
    )


def test_offline_run_needs_no_api_settings_and_never_connects(no_network, tmp_path):
    with start_offline(parameters={"lr": 0.1}, tags={"team": "audio"}) as run:
        run.log_params({"epochs": 3})
        run.set_tags({"stage": "pretrain"})
        run.log_metrics({"loss": 1.0}, step=1)
        run.log("hello")

    directory = tmp_path / "offline" / run.id
    record = json.loads((directory / "run.json").read_text())
    assert record["runId"] == run.id and record["projectId"] == PROJECT_ID
    assert record["parameters"] == {"lr": 0.1} and record["tags"] == {"team": "audio"}
    body = read_batch_body(list_batches(directory)[0])
    assert body["params"] == {"epochs": 3} and body["tags"] == {"stage": "pretrain"}
    assert [(point["name"], point["step"]) for point in body["metrics"]] == [("loss", 1)]
    assert body["logs"][0]["message"] == "hello"
    assert json.loads((directory / "status.json").read_text())["status"] == "finished"
    assert run.entity["parameters"] == {"lr": 0.1, "epochs": 3}


def test_mmt_mode_offline_selects_the_spool_without_the_mode_argument(no_network, monkeypatch):
    monkeypatch.setenv("MMT_MODE", "offline")

    run = mado_tracking.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="by-env")
    run.finish()

    assert run.offline_directory is not None and run.offline_directory.name == run.id


def test_batch_lines_are_flushed_each_time_and_fsynced_every_fifty_lines(no_network, monkeypatch):
    run = start_offline()
    fsync_calls: list[int] = []
    monkeypatch.setattr(spool.os, "fsync", lambda descriptor: fsync_calls.append(descriptor))

    for step in range(SPOOL_FSYNC_EVERY * 2 + 10):
        run.log_metrics({"loss": 1.0}, step=step)
        # Flushed: another reader already sees every line written so far.
        batch_file = list_batches(run.offline_directory)[0].path
        assert batch_file.read_text().count("\n") == step + 1

    assert len(fsync_calls) == 2
    run.finish()
    # Closing the batch and writing status.json each fsync once more.
    assert len(fsync_calls) == 4


def test_batches_roll_over_at_the_record_limit_in_sequence_order(no_network, monkeypatch):
    monkeypatch.setattr(spool, "SPOOL_BATCH_MAX_RECORDS", 3)
    run = start_offline()

    for step in range(7):
        run.log_metrics({"loss": float(step)}, step=step)
    run.finish()

    batches = list_batches(run.offline_directory)
    assert [batch.sequence for batch in batches] == [1, 2, 3]
    assert [len(read_batch_body(batch)["metrics"]) for batch in batches] == [3, 3, 1]
    assert len({batch.batch_id for batch in batches}) == 3


def test_a_last_line_cut_by_a_crash_is_dropped_when_reading(no_network):
    run = start_offline()
    run.log_metrics({"loss": 1.0}, step=0)
    run.finish()
    batch = list_batches(run.offline_directory)[0]
    with batch.path.open("a") as output:
        output.write('{"type": "metric", "name": "lo')

    assert [point["step"] for point in read_batch_body(batch)["metrics"]] == [0]


def test_artifacts_are_copied_into_the_spool_by_default(no_network, tmp_path):
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights-v1")
    run = start_offline()

    logged = run.log_artifact(source, path="model/weights.bin")
    run.log_artifact(io.BytesIO(b"from a stream"), path="notes.txt")
    source.write_bytes(b"changed later")
    run.finish()

    digest = hashlib.sha256(b"weights-v1").hexdigest()
    assert logged == {"path": "model/weights.bin", "sha256": digest, "size": 10, "offline": True}
    copied, streamed = read_artifacts(run.offline_directory)
    assert copied.copied and copied.local_path == run.offline_directory / "artifact-files" / digest
    assert copied.local_path.read_bytes() == b"weights-v1"
    assert streamed.local_path.read_bytes() == b"from a stream" and streamed.mime_type == "text/plain"


def test_copy_false_records_the_original_path_and_its_sha256(no_network, tmp_path):
    source = tmp_path / "large.bin"
    source.write_bytes(b"large content")
    run = start_offline()

    run.log_artifact(source, path="data/large.bin", copy=False)
    with pytest.raises(ConfigurationError, match="stream must be copied"):
        run.log_artifact(io.BytesIO(b"x"), path="x.bin", copy=False)
    run.finish()

    (entry,) = read_artifacts(run.offline_directory)
    assert not entry.copied and entry.local_path == source.resolve()
    assert entry.sha256 == hashlib.sha256(b"large content").hexdigest()
    assert not (run.offline_directory / "artifact-files").exists()


def test_spool_files_are_private_and_never_contain_the_token(tmp_path, monkeypatch):
    monkeypatch.setenv("MMT_EXPERIMENT_ID", EXPERIMENT_ID)
    client = Client(
        api_url="http://mmt.test",
        api_token=TOKEN,
        transport=httpx.MockTransport(lambda _request: pytest.fail("offline must not send requests")),
    )
    source = tmp_path / "weights.bin"
    source.write_bytes(b"weights")
    run = client.start_run(project_id=PROJECT_ID, name="private", mode="offline")
    run.log_metrics({"loss": 1.0})
    run.log(f"token is {TOKEN}")
    run.log_artifact(source)
    run.transport.spool.add_media(key="clip", step=0, kind="audio", artifact_path="weights.bin")
    run.finish()

    root = tmp_path / "offline"
    for path in [root, *root.rglob("*")]:
        mode = stat.S_IMODE(path.stat().st_mode)
        assert mode == (0o700 if path.is_dir() else 0o600), path
        if path.is_file():
            assert TOKEN not in path.read_bytes().decode("utf-8", "replace")
    assert json.loads((run.offline_directory / "run.json").read_text())["apiUrl"] == "http://mmt.test/api"


def test_offline_runs_reject_what_only_the_api_can_do(no_network):
    with pytest.raises(ConfigurationError, match="does not support model_version_id"):
        start_offline(model_version_id="version")
    with pytest.raises(ConfigurationError, match="cannot be resumed"):
        start_offline(run_id=str(uuid4()), resume="allow")
    run = start_offline()
    with pytest.raises(ConfigurationError, match="needs the API"):
        run.register_output_model(model_name="model", family="linear")
    run.finish()


def test_offline_mode_is_refused_inside_a_worker_job(no_network, monkeypatch):
    monkeypatch.setenv("MMT_JOB_ID", str(uuid4()))

    with pytest.raises(ConfigurationError, match="worker Job records online"):
        start_offline()


def test_a_second_writer_for_the_same_run_is_refused(no_network):
    run = start_offline()

    with pytest.raises(spool.SpoolError, match="Another process is recording"):
        spool.RunSpool(run.offline_directory, run.transport.spool.record)
    run.finish()


def test_unknown_mode_is_a_configuration_error(no_network):
    with pytest.raises(ConfigurationError, match="mode must be one of"):
        mado_tracking.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="x", mode="later")


def test_default_directory_follows_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.delenv("MMT_OFFLINE_DIR")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))

    assert spool.default_offline_directory() == Path(tmp_path / "data" / "mado-tracking" / "offline")
