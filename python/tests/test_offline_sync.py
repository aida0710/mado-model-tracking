from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from mado_tracking import Client, http
from mado_tracking.cli import main as cli_main
from mado_tracking.client import start_run_offline
from mado_tracking.offline import spool
from mado_tracking.offline.spool import SyncState
from mado_tracking.offline.sync import sync_offline_directories, sync_run_directory

PROJECT_ID = str(uuid4())
EXPERIMENT_ID = str(uuid4())
TOKEN = "sync-test-secret"


class FakeSyncApi:
    """In-memory /sync, /artifact-uploads and /runs/:r/media with the contract's idempotency rules."""

    def __init__(self):
        self.runs: dict[str, dict] = {}
        self.batches: dict[tuple[str, str], dict] = {}
        self.metrics: list[dict] = []
        self.logs: list[dict] = []
        self.artifacts: dict[str, dict] = {}
        self.uploads: dict[str, dict] = {}
        self.media: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.batch_sequences: list[int] = []
        self.disconnect_on_sequence: int | None = None
        self.unreachable = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> Client:
        return Client(api_url="http://mmt.test", api_token=TOKEN, transport=self.transport())

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        if self.unreachable:
            raise httpx.ConnectError("API host is unreachable")
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}/")
        segments = path.split("/")
        body = request.read()
        self.requests.append((request.method, path))
        if segments[:2] == ["sync", "runs"]:
            return self.sync(request.method, segments[2], segments[3:], body)
        if segments[0] == "artifact-uploads":
            return self.upload(request, segments[1:], body)
        if segments[0] == "artifacts" and request.method == "GET":
            return httpx.Response(200, json=self.artifacts[segments[1]])
        if segments[0] == "runs" and segments[2:] == ["media"]:
            # RunMediaCreate {items}; a resent id returns the stored item, still with 201.
            items = json.loads(body)["items"]
            for item in items:
                self.media.setdefault(item["id"], item)
            return httpx.Response(201, json={"items": [self.media[item["id"]] for item in items]})
        if segments[0] == "runs" and segments[2:] == ["artifacts"]:
            prefix = request.url.params["prefix"]
            items = [
                item
                for item in self.current_artifacts(segments[1]).values()
                if item["path"].startswith(prefix)
            ]
            return httpx.Response(200, json={"items": items, "nextCursor": None})
        raise AssertionError(f"Unexpected request {request.method} {request.url.path}")

    def sync(self, method: str, run_id: str, rest: list[str], body: bytes) -> httpx.Response:
        payload = json.loads(body)
        if method == "PUT" and not rest:
            if run_id in self.runs:
                return httpx.Response(200, json=self.runs[run_id])
            self.runs[run_id] = {"id": run_id, "status": "running", "params": {}, "tags": {}, **payload}
            return httpx.Response(201, json=self.runs[run_id])
        if rest == ["batches"]:
            return self.batch(run_id, payload)
        if rest == ["artifacts", "check"]:
            current = self.current_artifacts(run_id)
            present = [
                item["path"]
                for item in payload["items"]
                if item["path"] in current
                and (current[item["path"]]["sha256"], current[item["path"]]["size"])
                == (item["sha256"], item["size"])
            ]
            return httpx.Response(200, json={"present": present})
        raise AssertionError(f"Unexpected sync request {method} {rest}")

    def batch(self, run_id: str, payload: dict) -> httpx.Response:
        self.batch_sequences.append(payload["sequence"])
        if payload["sequence"] == self.disconnect_on_sequence:
            raise httpx.ConnectError("connection dropped")
        assert run_id in self.runs, "batches must follow the PUT"
        key = (run_id, payload["batchId"])
        if key in self.batches:
            return httpx.Response(200, json={**self.batches[key], "applied": False, "duplicate": True})
        run = self.runs[run_id]
        self.metrics.extend(payload.get("metrics", []))
        self.logs.extend(payload.get("logs", []))
        run["params"].update(payload.get("params", {}))
        run["tags"].update(payload.get("tags", {}))
        if status := payload.get("status"):
            run["status"] = status["status"]
            run["endedAt"] = status["endedAt"]
        counts = {name: len(payload.get(name, [])) for name in ("metrics", "logs", "params", "tags")}
        self.batches[key] = {"counts": counts, "sequence": payload["sequence"]}
        return httpx.Response(200, json={"applied": True, "duplicate": False, "counts": counts})

    def current_artifacts(self, run_id: str) -> dict[str, dict]:
        latest: dict[str, dict] = {}
        for artifact in self.artifacts.values():
            if artifact["runId"] == run_id:
                latest[artifact["path"]] = artifact
        return latest

    def upload(self, request: httpx.Request, segments: list[str], body: bytes) -> httpx.Response:
        if request.method == "POST" and not segments:
            payload = json.loads(body)
            upload_id = str(uuid4())
            self.uploads[upload_id] = {"id": upload_id, "status": "open", "parts": {}, **payload}
            return httpx.Response(201, json=self.session(upload_id))
        upload = self.uploads[segments[0]]
        if request.method == "GET":
            return httpx.Response(200, json=self.session(segments[0]))
        if segments[1:2] == ["parts"]:
            upload["parts"][int(segments[2])] = body
            return httpx.Response(200, json={})
        content = b"".join(part for _number, part in sorted(upload["parts"].items()))
        artifact_id = str(uuid4())
        self.artifacts[artifact_id] = {
            "id": artifact_id,
            "runId": upload["runId"],
            "path": upload["path"],
            "sha256": hashlib.sha256(content).hexdigest(),
            "size": len(content),
        }
        upload.update(status="completed", artifactId=artifact_id)
        return httpx.Response(200, json=self.session(segments[0]))

    def session(self, upload_id: str) -> dict:
        upload = self.uploads[upload_id]
        received = [
            {"partNumber": number, "size": len(part), "sha256": hashlib.sha256(part).hexdigest()}
            for number, part in sorted(upload["parts"].items())
        ]
        return {**{key: value for key, value in upload.items() if key != "parts"}, "receivedParts": received}


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MMT_OFFLINE_DIR", str(tmp_path / "offline"))
    monkeypatch.delenv("MMT_JOB_ID", raising=False)
    monkeypatch.delenv("MMT_RUN_ID", raising=False)
    monkeypatch.delenv("MMT_MODE", raising=False)
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)
    # record_offline_run writes a metric and a log per loop, so each loop becomes one batch file.
    monkeypatch.setattr(spool, "SPOOL_BATCH_MAX_RECORDS", 2)


def record_offline_run(
    tmp_path: Path, *, batches: int = 1, finish: bool = True, artifact: bytes | None = b"weights"
):
    run = start_run_offline(
        project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="offline", parameters={"lr": 0.1}
    )
    for batch in range(batches):
        run.log_metrics({"loss": 1.0 / (batch + 1)}, step=batch)
        run.log(f"batch {batch}")
    if artifact is not None:
        source = tmp_path / "model.bin"
        source.write_bytes(artifact)
        run.log_artifact(source, path="model/model.bin")
    if finish:
        run.finish()
    else:
        run.transport.close()
    assert run.offline_directory is not None
    return run, run.offline_directory


def test_sync_sends_the_run_then_batches_then_artifacts_then_the_status_last(tmp_path):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, batches=2)

    report = sync_run_directory(api.client(), directory)

    assert report.outcome == "completed"
    kinds = []
    for method, path in api.requests:
        if path.endswith(f"sync/runs/{run.id}") and method == "PUT":
            kinds.append("create")
        elif path.endswith("/batches"):
            kinds.append("batch")
        elif path.startswith("artifact-uploads") and method == "POST" and path.endswith("complete"):
            kinds.append("artifact")
    assert kinds == ["create", "batch", "batch", "artifact", "batch"]
    stored = api.runs[run.id]
    assert stored["status"] == "finished" and stored["parameters"] == {"lr": 0.1}
    assert stored["experimentId"] == EXPERIMENT_ID and stored["origin"]
    assert [point["step"] for point in api.metrics] == [0, 1]
    assert [entry["message"] for entry in api.logs] == ["batch 0", "batch 1"]
    assert [(item["path"], item["size"]) for item in api.artifacts.values()] == [("model/model.bin", 7)]
    assert SyncState.load(directory).completed


def test_disconnect_at_batch_three_resumes_without_resending_batches_one_and_two(tmp_path):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, batches=4)
    api.disconnect_on_sequence = 3

    first = sync_run_directory(api.client(), directory)

    assert first.outcome == "failed" and first.batches == 2
    assert api.runs[run.id]["status"] == "running"
    api.disconnect_on_sequence = None
    api.batch_sequences.clear()

    second = sync_run_directory(api.client(), directory)

    assert second.outcome == "completed" and second.batches == 2
    # Batch 3 and 4, then the status as sequence 5; batches 1 and 2 are not sent again.
    assert api.batch_sequences == [3, 4, 5]
    assert sorted(point["step"] for point in api.metrics) == [0, 1, 2, 3]


def test_syncing_the_same_directory_twice_adds_nothing_on_the_api(tmp_path):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, batches=2)
    sync_run_directory(api.client(), directory)
    counts = (len(api.runs), len(api.batches), len(api.metrics), len(api.artifacts), len(api.uploads))

    again = sync_run_directory(api.client(), directory)
    # Even a lost sync-state only costs resending: the API deduplicates by run, batch and sha256.
    (directory / "sync-state.json").unlink()
    after_lost_state = sync_run_directory(api.client(), directory)

    assert again.outcome == "completed" and again.message == "already synced"
    assert after_lost_state.outcome == "completed"
    assert after_lost_state.uploaded_artifacts == 0 and after_lost_state.present_artifacts == 1
    assert (len(api.runs), len(api.batches), len(api.metrics), len(api.artifacts), len(api.uploads)) == counts


def test_artifacts_reported_present_by_check_are_not_uploaded(tmp_path):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, batches=1)
    content = b"weights"
    api.artifacts["existing"] = {
        "id": "existing",
        "runId": run.id,
        "path": "model/model.bin",
        "sha256": hashlib.sha256(content).hexdigest(),
        "size": len(content),
    }

    report = sync_run_directory(api.client(), directory)

    assert report.outcome == "completed"
    assert report.present_artifacts == 1 and report.uploaded_artifacts == 0
    assert not api.uploads
    assert ("POST", f"sync/runs/{run.id}/artifacts/check") in api.requests


def test_a_file_logged_with_copy_false_that_changed_is_refused(tmp_path):
    api = FakeSyncApi()
    run = start_run_offline(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="referenced")
    source = tmp_path / "large.bin"
    source.write_bytes(b"original")
    run.log_artifact(source, path="data/large.bin", copy=False)
    run.finish()
    source.write_bytes(b"modified")

    report = sync_run_directory(api.client(), run.offline_directory)

    assert report.outcome == "failed" and "changed after it was logged" in report.message
    assert not api.uploads and api.runs[run.id]["status"] == "running"


def test_media_is_sent_with_its_id_and_the_artifact_id_before_the_status(tmp_path):
    api = FakeSyncApi()
    run = start_run_offline(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="media")
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF....WAVE")
    run.log_artifact(clip, path="media/sample/step-1.wav")
    media = run.transport.spool.add_media(  # type: ignore[attr-defined]
        key="sample", step=1, kind="audio", artifact_path="media/sample/step-1.wav", caption="first"
    )
    run.finish()

    sync_run_directory(api.client(), run.offline_directory)
    sync_run_directory(api.client(), run.offline_directory)

    assert list(api.media) == [media["id"]]
    sent = api.media[media["id"]]
    assert sent["artifactId"] in api.artifacts and sent["kind"] == "audio" and sent["caption"] == "first"
    media_index = api.requests.index(("POST", f"runs/{run.id}/media"))
    assert api.requests[-1][1].endswith("/batches") and media_index < len(api.requests) - 1


def test_a_run_still_being_recorded_is_skipped(tmp_path):
    api = FakeSyncApi()
    run = start_run_offline(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="live")
    run.log_metrics({"loss": 1.0})

    report = sync_run_directory(api.client(), run.offline_directory)

    assert report.outcome == "recording" and not api.requests
    run.finish()


def test_a_run_without_an_end_is_synced_but_not_marked_completed(tmp_path):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, finish=False, artifact=None)

    report = sync_run_directory(api.client(), directory)

    assert report.outcome == "partial" and api.runs[run.id]["status"] == "running"
    assert not SyncState.load(directory).completed


def test_auto_mode_switches_to_the_spool_when_the_api_becomes_unreachable(tmp_path, monkeypatch, capsys):
    api = FakeSyncApi()
    online_runs: dict[str, dict] = {}
    original_handle = api.handle

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}/")
        if api.unreachable or path.startswith(("sync/", "artifact-uploads", "artifacts/")):
            return original_handle(request)
        body = json.loads(request.read() or b"{}")
        api.requests.append((request.method, path))
        if path == "runs":
            run_id = str(uuid4())
            online_runs[run_id] = {"id": run_id, "status": "queued", **body}
            # The fake sync API knows the Run too, as the real API would.
            api.runs[run_id] = {"id": run_id, "status": "queued", "params": {}, "tags": {}, **body}
            return httpx.Response(201, json=online_runs[run_id])
        run_id = path.split("/")[1]
        if path.endswith("/metrics"):
            api.metrics.extend(body["metrics"])
            return httpx.Response(200, json={})
        online_runs[run_id].update(body)
        api.runs[run_id].update(status=body.get("status", api.runs[run_id]["status"]))
        return httpx.Response(200, json=online_runs[run_id])

    client = Client(api_url="http://mmt.test", api_token=TOKEN, transport=httpx.MockTransport(handle))
    run = client.start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="auto", mode="auto")
    run.log_metrics({"loss": 1.0}, step=0)
    assert run.offline_directory is None

    api.unreachable = True
    run.log_metrics({"loss": 0.5}, step=1)
    run.log_metrics({"loss": 0.25}, step=2)
    run.finish()

    directory = run.offline_directory
    assert directory is not None and directory.name == run.id
    assert "mado-tracking sync" in capsys.readouterr().err
    assert SyncState.load(directory).run_created
    api.unreachable = False
    api.requests.clear()

    report = sync_run_directory(api.client(), directory)

    assert report.outcome == "completed"
    # The Run already exists, so sync does not PUT it, and step 0 sent online is not sent again.
    assert not [path for method, path in api.requests if method == "PUT"]
    assert sorted(point["step"] for point in api.metrics) == [0, 1, 2]
    assert api.runs[run.id]["status"] == "finished"


def test_auto_mode_records_offline_from_the_start_when_the_api_cannot_create_the_run(monkeypatch):
    api = FakeSyncApi()
    api.unreachable = True

    run = api.client().start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="auto", mode="auto")
    run.log_metrics({"loss": 1.0})
    run.finish()

    assert run.offline_directory is not None and (run.offline_directory / "status.json").exists()


def test_cli_dry_run_reports_pending_work_without_contacting_the_api(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("MMT_API_URL", raising=False)
    monkeypatch.delenv("MMT_API_TOKEN", raising=False)
    run, directory = record_offline_run(tmp_path, batches=2)

    exit_code = cli_main(["sync", "--dry-run", str(directory.parent)])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert f"{run.id}  pending  batches=2 artifacts=1" in output and "status=pending" in output


def test_cli_sync_filters_by_project_and_prunes_completed_runs(tmp_path, monkeypatch, capsys):
    api = FakeSyncApi()
    run, directory = record_offline_run(tmp_path, batches=1)
    monkeypatch.setattr("mado_tracking.cli.Client", api.client)

    other_project = cli_main(["sync", "--project-id", str(uuid4()), str(directory.parent)])
    assert other_project == 0 and not api.requests and "filtered" in capsys.readouterr().out

    exit_code = cli_main(["sync", "--prune"])

    assert exit_code == 0 and f"{run.id}  completed" in capsys.readouterr().out
    assert not directory.exists()


def test_cli_exits_non_zero_when_a_run_fails(tmp_path, monkeypatch, capsys):
    api = FakeSyncApi()
    api.unreachable = True
    record_offline_run(tmp_path, batches=1)

    reports = sync_offline_directories([tmp_path / "offline"], client_factory=api.client)
    monkeypatch.setattr("mado_tracking.cli.Client", api.client)
    exit_code = cli_main(["sync"])

    assert [report.outcome for report in reports] == ["failed"]
    assert exit_code == 1 and TOKEN not in capsys.readouterr().out
