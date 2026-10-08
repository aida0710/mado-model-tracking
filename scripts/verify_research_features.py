"""End-to-end check of the research features on an isolated API, the Python SDK and a local worker.

system metrics -> media at three steps -> resume='must' -> offline recording and an interrupted
`mado-tracking sync` -> Sweep (grid 2x2, parallelism 2, hyperband) with analysis -> Run note and
MLflow's mlflow.note.content, comments -> saved view -> report live/snapshot. With
MMT_PLAYWRIGHT_MODULE set, the Web (Vite on its own port) is checked on the same data by
apps/web/tests/browser-research.mjs. Each stage's result and duration go to
artifacts/verification/<JST date>/research/research-integration.json.

The API is a fresh test schema in MMT_TEST_DATABASE_URL (scripts/serve_mlflow_verification.ts),
never the running development API/DB. The schema is dropped when the script stops the API;
`--hold` keeps the API (and the Web) running until Ctrl+C to look at the data.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from verify_pipeline_smoke import ProjectApi, StageFailure, StageRecorder, api_request, expect

from mado_tracking import Client, SweepsClient
from mado_tracking.code_version import build_code_version_payload
from mado_tracking.offline.spool import list_batches, read_artifacts, read_batch_body, read_media
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.service import Worker

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "python/examples"
JST = ZoneInfo("Asia/Tokyo")
# This package's servers use 47010-47019 only; the running API/Web are 4182/5182.
API_PORT = int(os.environ.get("MMT_VERIFY_RESEARCH_API_PORT", "47010"))
WEB_PORT = int(os.environ.get("MMT_VERIFY_RESEARCH_WEB_PORT", "47011"))
RELAY_PORT = int(os.environ.get("MMT_VERIFY_RESEARCH_RELAY_PORT", "47012"))
API_URL = f"http://127.0.0.1:{API_PORT}"
WEB_URL = f"http://127.0.0.1:{WEB_PORT}"
# The harness API accepts cookie requests from this Origin only; it is a header, nothing connects.
API_WEB_ORIGIN = "http://127.0.0.1:5182"
API_START_SECONDS = 90
WEB_START_SECONDS = 60
TODAY = datetime.now(JST).strftime("%Y-%m-%d")
OUTPUT_DIRECTORY = ROOT / "artifacts/verification" / TODAY / "research"
WORK_DIRECTORY = ROOT / "var/verification-research" / datetime.now(JST).strftime("%Y%m%d-%H%M%S")
TERMINAL_STATUSES = {"finished", "failed", "canceled"}
SWEEP_TERMINAL_STATUSES = {"finished", "failed", "canceled"}

# "Tens of seconds" of training with a sample every second gives each system.* key ~30 points.
TRAINING_STEPS = 30
STEP_SECONDS = 1.0
SYSTEM_METRICS_INTERVAL_SECONDS = 1.0
MINIMUM_SYSTEM_POINTS = 10
RESUMED_STEPS = 10
# research_features.py logs media every 10 steps: steps 9, 19, 29 for a 30-step Run.
MEDIA_STEPS = [9, 19, 29]
MEDIA_KEYS = {"inference/tone": "audio", "inference/spectrogram": "image", "evaluation/samples": "table"}
# Just over the SDK's 64 MiB session threshold, so the offline checkpoint uses an upload session.
CHECKPOINT_MIB = 65
# The relay drops every connection when the 65 MiB checkpoint's last part starts: some of its
# 16 MiB parts have arrived, the session is not complete, and the Run has no end yet.
RELAY_CUT_ON_REQUEST = b"/parts/5 HTTP/1.1"
SYNC_TIMEOUT_SECONDS = 300
# Sweep trials log val_loss each epoch and sleep between epochs, so the API's 15 s hyperband
# tick sees two trials between rungs.
SWEEP_EPOCHS = 8
SWEEP_EPOCH_SECONDS = 3
SWEEP_DEADLINE_SECONDS = 600
WORKER_HEARTBEAT_SECONDS = 0.5
# The point the report check logs after saving: the step after the resumed training.
REPORT_EXTRA_STEP = TRAINING_STEPS + RESUMED_STEPS
OUT_OF_SCOPE = ["実GPU", "実SSO（Authentik）", "実S3", "外部の実計算機", "実SSH target", "コンテナruntime"]

SLOW_TRIAL_ENTRY = f'''"""Sweep trial: sweep_training.py, pausing after each epoch for hyperband."""
import time

import sweep_training
from mado_tracking import start_run
from mado_tracking.sweeps import trial_parameters


class PacedRun:
    def __init__(self, run):
        self.run = run

    def log_metrics(self, metrics, *, step):
        self.run.log_metrics(metrics, step=step)
        time.sleep({SWEEP_EPOCH_SECONDS})


parameters = trial_parameters(sweep_training.DEFAULT_PARAMETERS)
with start_run() as run:
    sweep_training.train(
        lr=float(parameters["lr"]),
        batch_size=int(parameters["batch_size"]),
        epochs=int(parameters["epochs"]),
        run=PacedRun(run),
    )
'''


@dataclass
class Research:
    """What the stages share: the admin session, the SDK token and the Runs made so far."""

    session: httpx.Client
    api: ProjectApi
    project_id: str
    experiment_id: str
    target_id: str
    token: str
    ids: dict[str, Any] = field(default_factory=dict)

    def sdk_environment(self, **overrides: str) -> dict[str, str]:
        environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
        environment.update(
            MMT_API_URL=API_URL,
            MMT_API_TOKEN=self.token,
            MMT_PROJECT_ID=self.project_id,
            MMT_EXPERIMENT_ID=self.experiment_id,
            PYTHONPATH=str(ROOT / "python/src"),
        )
        environment.update(overrides)
        return environment

    def metric_points(self, run_id: str) -> list[dict[str, Any]]:
        return self.api.get(f"runs/{run_id}/metrics")["items"]


def run_example(environment: dict[str, str], *arguments: str) -> dict[str, Any]:
    """Run python/examples/research_features.py and return its final JSON line."""
    completed = subprocess.run(
        [sys.executable, str(EXAMPLES / "research_features.py"), *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=SYNC_TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        raise StageFailure(f"research_features.py exited {completed.returncode}: {completed.stderr[-2000:]}")
    return json.loads(completed.stdout.strip().splitlines()[-1])


# --- (1) system metrics, (4) media, (2) resume --------------------------------------------------
def verify_system_metrics(research: Research, details: dict[str, Any]) -> None:
    result = run_example(
        research.sdk_environment(),
        "--name",
        "research-online",
        "--steps",
        str(TRAINING_STEPS),
        "--step-seconds",
        str(STEP_SECONDS),
        "--system-metrics-interval",
        str(SYSTEM_METRICS_INTERVAL_SECONDS),
    )
    run_id = research.ids["onlineRunId"] = result["runId"]
    points = research.metric_points(run_id)
    system_points: dict[str, int] = {}
    for point in points:
        if point["name"].startswith("system."):
            system_points[point["name"]] = system_points.get(point["name"], 0) + 1
    details.update(runId=run_id, systemMetricPoints=system_points, status=research.api.run(run_id)["status"])
    expect(details["status"] == "finished", f"the online Run ended {details['status']}")
    for required in ("system.cpu.percent", "system.memory.percent"):
        expect(
            system_points.get(required, 0) >= MINIMUM_SYSTEM_POINTS,
            f"{required} has {system_points.get(required, 0)} points (< {MINIMUM_SYSTEM_POINTS})",
        )
    losses = sorted(point["step"] for point in points if point["name"] == "loss")
    expect(
        losses == list(range(TRAINING_STEPS)), f"loss steps {losses[:3]}... are not 0..{TRAINING_STEPS - 1}"
    )


def media_summary(research: Research, run_id: str) -> dict[str, Any]:
    keys = research.api.get(f"runs/{run_id}/media/keys")["items"]
    return {item["key"]: {key: item[key] for key in ("kind", "count", "minStep", "maxStep")} for item in keys}


def verify_media(research: Research, details: dict[str, Any]) -> None:
    run_id = research.ids["onlineRunId"]
    keys = details["keys"] = media_summary(research, run_id)
    expect(
        {key: value["kind"] for key, value in keys.items()} == MEDIA_KEYS, f"media keys are {sorted(keys)}"
    )
    for key in MEDIA_KEYS:
        items = research.api.get(f"runs/{run_id}/media", params={"key": key})["items"]
        steps = [item["step"] for item in items]
        details.setdefault("steps", {})[key] = steps
        expect(steps == MEDIA_STEPS, f"{key} steps {steps} != {MEDIA_STEPS}")
    audio = research.api.get(f"runs/{run_id}/media", params={"key": "inference/tone"})["items"]
    details["audioMetadata"] = audio[0]["metadata"]
    expect(audio[0]["mimeType"] == "audio/wav", f"audio MIME type {audio[0]['mimeType']}")
    (table,) = research.api.get(
        f"runs/{run_id}/media", params={"key": "evaluation/samples", "stepFrom": 29, "stepTo": 29}
    )["items"]
    page = research.api.get(f"runs/{run_id}/media/{table['id']}/table")
    columns = {column["name"]: column["type"] for column in page["columns"]}
    details.update(tableColumns=columns, tableRows=page["totalRows"], tableFirstRow=page["rows"][0])
    expect(columns == {"audio": "audio", "transcript": "text", "score": "number"}, f"columns {columns}")
    audio_cell = page["rows"][0][0]
    expect(audio_cell["artifactId"] and audio_cell["error"] is None, f"audio cell not resolved: {audio_cell}")
    expect(page["rows"][0][1] == "こんにちは", f"transcript cell {page['rows'][0][1]!r}")
    research.ids["mediaTableId"] = table["id"]


def verify_resume(research: Research, details: dict[str, Any]) -> None:
    run_id = research.ids["onlineRunId"]
    result = run_example(
        research.sdk_environment(), "--resume", run_id, "--steps", str(RESUMED_STEPS), "--step-seconds", "0.2"
    )
    expect(result["runId"] == run_id, "the resumed example wrote to another Run")
    events = research.api.get(f"runs/{run_id}/resume-events")
    details.update(
        events=[
            {key: event[key] for key in ("source", "previousStatus", "maxStepAtResume")}
            for event in events["items"]
        ],
        segments=events["segments"],
    )
    expect(
        len(events["items"]) == 1 and events["items"][0]["source"] == "native", "expected one native event"
    )
    expect(len(events["segments"]) == 2, f"{len(events['segments'])} segments")
    expect(events["segments"][1]["firstStep"] == TRAINING_STEPS, f"second segment {events['segments'][1]}")
    losses = sorted(point["step"] for point in research.metric_points(run_id) if point["name"] == "loss")
    expected = list(range(TRAINING_STEPS + RESUMED_STEPS))
    details["lossSteps"] = [losses[0], losses[-1], len(losses)]
    expect(losses == expected, "loss steps after the resume are not one continuous 0..N range")
    expect(research.api.run(run_id)["status"] == "finished", "the resumed Run did not finish again")


# --- (3) offline recording and an interrupted sync ----------------------------------------------
class CuttableRelay:
    """A loopback TCP relay to the API that can drop every connection, like the API going away."""

    def __init__(self, *, listen_port: int, target_port: int):
        self.target_port = target_port
        self.listener = socket.create_server(("127.0.0.1", listen_port))
        self.lock = threading.Lock()
        self.connections: set[socket.socket] = set()
        self.request_bytes = 0
        self.cut_on_request: bytes | None = None
        self.is_down = False
        self.cuts = 0
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                client, _address = self.listener.accept()
            except OSError:
                return
            if self.is_down:
                client.close()
                continue
            upstream = socket.create_connection(("127.0.0.1", self.target_port))
            with self.lock:
                self.connections.update({client, upstream})
            threading.Thread(target=self._pipe, args=(client, upstream, True), daemon=True).start()
            threading.Thread(target=self._pipe, args=(upstream, client, False), daemon=True).start()

    def _pipe(self, source: socket.socket, destination: socket.socket, is_request: bool) -> None:
        try:
            while chunk := source.recv(256 * 1024):
                if is_request and self._should_cut(chunk):
                    self.go_down()
                    return
                destination.sendall(chunk)
        except OSError:
            pass
        finally:
            for end in (source, destination):
                self._close(end)

    def _should_cut(self, chunk: bytes) -> bool:
        with self.lock:
            self.request_bytes += len(chunk)
            return self.cut_on_request is not None and self.cut_on_request in chunk

    def _close(self, connection: socket.socket) -> None:
        with self.lock:
            self.connections.discard(connection)
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        connection.close()

    def go_down(self) -> None:
        with self.lock:
            if self.is_down:
                return
            self.is_down = True
            self.cut_on_request = None
            self.cuts += 1
            connections = list(self.connections)
        for connection in connections:
            self._close(connection)

    def restore(self) -> None:
        with self.lock:
            self.is_down = False
            self.request_bytes = 0

    def close(self) -> None:
        # shutdown wakes the accept thread; close alone leaves the port listening until exit.
        try:
            self.listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.listener.close()
        self.go_down()


def run_sync(environment: dict[str, str], directory: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "mado_tracking.cli", "sync", str(directory)],
        env=environment,
        capture_output=True,
        text=True,
        timeout=SYNC_TIMEOUT_SECONDS,
        check=False,
    )


def spooled_counts(directory: Path) -> dict[str, int]:
    metrics = sum(len(read_batch_body(batch).get("metrics", [])) for batch in list_batches(directory))
    return {
        "metrics": metrics,
        "artifacts": len({artifact.path for artifact in read_artifacts(directory)}),
        "media": len(read_media(directory)),
    }


def api_counts(research: Research, run_id: str) -> dict[str, int]:
    listing = research.api.get(f"runs/{run_id}/artifacts", params={"versions": "all", "limit": "500"})
    media = research.api.get(f"runs/{run_id}/media", params={"limit": "500"})["items"]
    return {
        "metrics": len(research.metric_points(run_id)),
        "artifacts": len(listing["items"]),
        "media": len(media),
    }


def verify_offline_sync(research: Research, details: dict[str, Any]) -> None:
    offline_root = WORK_DIRECTORY / "offline"
    recorded = run_example(
        research.sdk_environment(MMT_MODE="offline", MMT_OFFLINE_DIR=str(offline_root)),
        "--name",
        "research-offline",
        "--steps",
        str(TRAINING_STEPS),
        "--step-seconds",
        "0.1",
        "--checkpoint-mib",
        str(CHECKPOINT_MIB),
    )
    run_id = research.ids["offlineRunId"] = recorded["runId"]
    directory = Path(recorded["offlineDirectory"])
    expect(recorded["mode"] == "offline", "the example did not record offline")
    expected = details["spooled"] = spooled_counts(directory)
    (checkpoint,) = [
        artifact for artifact in read_artifacts(directory) if artifact.path == "checkpoints/model.bin"
    ]
    expect(checkpoint.size >= 64 * 1024 * 1024, "the checkpoint is below the session threshold")
    relay = CuttableRelay(listen_port=RELAY_PORT, target_port=API_PORT)
    try:
        environment = research.sdk_environment(MMT_API_URL=f"http://127.0.0.1:{RELAY_PORT}")
        relay.cut_on_request = RELAY_CUT_ON_REQUEST
        interrupted = run_sync(environment, directory)
        details["interrupted"] = {
            "exitCode": interrupted.returncode,
            "relayCuts": relay.cuts,
            "requestBytesBeforeCut": relay.request_bytes,
            "stdout": interrupted.stdout.strip()[-500:],
        }
        expect(relay.cuts == 1 and interrupted.returncode == 1, "the first sync was not interrupted")
        partial_run = research.session.get(f"projects/{research.project_id}/runs/{run_id}")
        details["interrupted"]["runStatusAfterCut"] = (
            partial_run.json()["status"] if partial_run.is_success else partial_run.status_code
        )
        relay.restore()
        resumed = run_sync(environment, directory)
        details["resumed"] = {
            "exitCode": resumed.returncode,
            "requestBytes": relay.request_bytes,
            "stdout": resumed.stdout.strip()[-500:],
        }
        expect(resumed.returncode == 0 and " completed " in resumed.stdout, f"resumed sync: {resumed.stdout}")
        # Resuming the session sends only the parts that did not arrive before the cut.
        expect(relay.request_bytes < checkpoint.size, "the resumed sync re-sent the whole checkpoint")
    finally:
        relay.close()
    after_sync = details["afterSync"] = api_counts(research, run_id)
    expect(after_sync == expected, f"API has {after_sync}, the spool {expected}")
    run = research.api.run(run_id)
    details.update(status=run["status"], syncOrigin=run.get("syncOrigin"))
    expect(run["status"] == "finished", f"the synced Run is {run['status']}")
    (stored,) = [
        artifact
        for artifact in research.api.get(f"runs/{run_id}/artifacts", params={"versions": "all"})["items"]
        if artifact["path"] == "checkpoints/model.bin"
    ]
    expect(stored["sha256"] == checkpoint.sha256, "the stored checkpoint differs from the spooled file")
    details["mediaKeys"] = media_summary(research, run_id)
    second = run_sync(research.sdk_environment(), directory)
    details["secondSync"] = {"stdout": second.stdout.strip(), "counts": api_counts(research, run_id)}
    expect(
        second.returncode == 0 and details["secondSync"]["counts"] == expected, "the second sync added data"
    )
    # Without sync-state.json everything is sent again; the API's idempotency keeps the counts.
    (directory / "sync-state.json").unlink()
    third = run_sync(research.sdk_environment(), directory)
    details["resendWithoutSyncState"] = {
        "stdout": third.stdout.strip(),
        "counts": api_counts(research, run_id),
    }
    expect(
        third.returncode == 0 and details["resendWithoutSyncState"]["counts"] == expected,
        "resending without sync-state added data",
    )


# --- (5) Sweep on the local worker ---------------------------------------------------------------
def register_sweep_task(research: Research) -> str:
    code = research.api.post("codes", {"name": "Research sweep trial", "description": "research features"})
    version = research.api.post(
        f"codes/{code['id']}/versions",
        build_code_version_payload(
            version="v1",
            source={
                "kind": "inline",
                "files": {
                    "sweep_training.py": (EXAMPLES / "sweep_training.py").read_text(),
                    "slow_trial.py": SLOW_TRIAL_ENTRY,
                },
            },
            entrypoint=["python", "slow_trial.py"],
            test_entrypoint=[],
            runtime=None,
            requirements=[],
            environment=None,
            supported_model_families=["linear"],
            task_types=["training"],
        ),
    )
    task = research.api.post(
        "tasks",
        {
            "experimentId": research.experiment_id,
            "name": "Research sweep trial",
            "kind": "training",
            "codeVersionId": version["id"],
            "parameters": {"epochs": SWEEP_EPOCHS},
            "targetId": research.target_id,
        },
    )
    return task["id"]


def worker_settings(research: Research) -> WorkerSettings:
    return WorkerSettings(
        api=ApiSettings.from_environment(url=API_URL, token=research.token),
        worker_id=f"research-{research.project_id[:8]}",
        target_ids=(research.target_id,),
        state_directory=WORK_DIRECTORY / "worker-state",
        allow_local_executor=True,
        heartbeat_seconds=WORKER_HEARTBEAT_SECONDS,
        poll_seconds=0.2,
        telemetry_seconds=2,
        cancel_grace_seconds=1,
        parallel_jobs=2,
    )


async def run_worker_until_sweep_ends(
    research: Research, sweeps: SweepsClient, sweep_id: str
) -> dict[str, Any]:
    worker = Worker(worker_settings(research))
    worker_task = asyncio.create_task(worker.run_forever())
    deadline = time.monotonic() + SWEEP_DEADLINE_SECONDS
    try:
        while time.monotonic() < deadline:
            sweep = await asyncio.to_thread(sweeps.get_sweep, research.project_id, sweep_id)
            if sweep["status"] in SWEEP_TERMINAL_STATUSES:
                return sweep
            if worker_task.done():
                worker_task.result()
                raise StageFailure("the worker stopped before the Sweep ended")
            await asyncio.sleep(1)
        raise StageFailure(f"the Sweep did not end within {SWEEP_DEADLINE_SECONDS}s")
    finally:
        worker.stopping.set()
        await asyncio.wait_for(worker_task, timeout=60)


def verify_sweep(research: Research, details: dict[str, Any]) -> None:
    task_id = register_sweep_task(research)
    with Client(api_url=API_URL, api_token=research.token) as client:
        sweeps = SweepsClient(client)
        created = sweeps.create_sweep(
            research.project_id,
            task_id=task_id,
            name="research-grid",
            config={
                "method": "grid",
                "metric": {"name": "val_loss", "goal": "minimize"},
                "parameters": {"lr": {"values": [0.01, 0.2]}, "batch_size": {"values": [4, 32]}},
                "run_cap": 4,
                "parallelism": 2,
                "early_terminate": {"type": "hyperband", "min_iter": 2, "eta": 2},
            },
        )
        sweep_id = research.ids["sweepId"] = created["id"]
        started = time.monotonic()
        sweep = asyncio.run(run_worker_until_sweep_ends(research, sweeps, sweep_id))
        trials = list(sweeps.iter_trials(research.project_id, sweep_id))
    details.update(
        sweepId=sweep_id,
        status=sweep["status"],
        statusReason=sweep.get("statusReason"),
        workerSeconds=round(time.monotonic() - started, 1),
        trialCounts=sweep["trialCounts"],
        bestTrial={key: sweep["bestTrial"][key] for key in ("trialIndex", "parameters", "objectiveValue")}
        if sweep["bestTrial"]
        else None,
        trials=[
            {
                key: trial.get(key)
                for key in ("trialIndex", "parameters", "state", "objectiveValue", "stopReason")
            }
            for trial in trials
        ],
    )
    expect(sweep["status"] == "finished", f"the Sweep ended {sweep['status']} ({sweep.get('statusReason')})")
    expect(len(trials) == 4, f"{len(trials)} trials for a 2x2 grid")
    combinations = {(trial["parameters"]["lr"], trial["parameters"]["batch_size"]) for trial in trials}
    expect(len(combinations) == 4, "the grid repeated a combination")
    expect(details["bestTrial"] is not None, "no best trial")
    finished_objectives = [
        trial["objectiveValue"]
        for trial in trials
        if trial["state"] == "finished" and trial["objectiveValue"] is not None
    ]
    expect(
        details["bestTrial"]["objectiveValue"] <= min(finished_objectives),
        "the best trial is not the lowest val_loss",
    )
    details["earlyStoppedTrials"] = sum(trial["state"] == "early_stopped" for trial in trials)
    table = research.api.post(
        "runs/analysis/table",
        {"runSet": {"sweepId": sweep_id}, "params": ["lr", "batch_size"], "metrics": ["val_loss"]},
    )
    details["analysisTable"] = {
        "runs": len(table["runs"]),
        "params": [{key: param[key] for key in ("key", "kind", "coverage")} for param in table["params"]],
        "objective": table.get("objective"),
    }
    expect(
        len(table["runs"]) == 4 and table.get("objective"), "the analysis table lacks trials or the objective"
    )
    importance = research.api.post(
        "runs/analysis/parameter-importance",
        {"runSet": {"sweepId": sweep_id}, "params": ["lr", "batch_size"]},
    )
    details["parameterImportance"] = {
        key: importance[key]
        for key in ("targetMetric", "targetSource", "runCount", "importanceUnavailableReason")
    } | {
        "entries": [
            {key: entry[key] for key in ("param", "correlation", "importance")}
            for entry in importance["entries"]
        ]
    }
    expect(importance["targetSource"] == "sweep_objective", "importance did not use the Sweep objective")
    expect({entry["param"] for entry in importance["entries"]} == {"lr", "batch_size"}, "importance entries")


# --- (6) note and comments, (7) saved view, (8) report -------------------------------------------
def mlflow_request(research: Research, method: str, endpoint: str, **options: Any) -> Any:
    response = research.session.request(
        method,
        f"mlflow/projects/{research.project_id}/api/2.0/mlflow/{endpoint}",
        headers={"Authorization": f"Bearer {research.token}"},
        **options,
    )
    if not response.is_success:
        raise StageFailure(f"MLflow {endpoint}: HTTP {response.status_code} {response.text}")
    return response.json()


def verify_note_and_comments(research: Research, details: dict[str, Any]) -> None:
    run_id = research.ids["onlineRunId"]
    native_note = "## 学習の説明\n\n440 Hz の正弦波を学習する例。**再開**して 40 step まで回した。"
    research.api.request("PUT", f"runs/{run_id}/note", json={"content": native_note})
    mlflow_tags = {
        tag["key"]: tag["value"]
        for tag in mlflow_request(research, "GET", "runs/get", params={"run_id": run_id})["run"]["data"][
            "tags"
        ]
    }
    expect(
        mlflow_tags.get("mlflow.note.content") == native_note, "MLflow get-run does not show the native note"
    )
    mlflow_note = native_note + "\n\n- MLflow の set-tag から追記"
    mlflow_request(
        research,
        "POST",
        "runs/set-tag",
        json={"run_id": run_id, "key": "mlflow.note.content", "value": mlflow_note},
    )
    native_tags = research.api.run(run_id)["tags"]
    expect(
        native_tags.get("mlflow.note.content") == mlflow_note, "the native Run does not show MLflow's note"
    )
    details["noteRoundTrip"] = {"nativeToMlflow": True, "mlflowToNative": True, "length": len(mlflow_note)}
    thread = research.api.post(
        "comments",
        {"targetType": "run", "targetId": run_id, "body": "再開後の loss が滑らかにつながっている"},
    )
    reply = research.api.post(
        "comments",
        {
            "targetType": "run",
            "targetId": run_id,
            "parentCommentId": thread["id"],
            "body": "system metrics も確認済み",
        },
    )
    comments = research.api.get("comments", params={"targetType": "run", "targetId": run_id})["items"]
    details["comments"] = [
        {"id": item["id"], "parentCommentId": item["parentCommentId"]} for item in comments
    ]
    expect(
        [item["id"] for item in comments] == [thread["id"], reply["id"]], "comments are not in thread order"
    )
    expect(comments[1]["parentCommentId"] == thread["id"], "the reply is not attached to the thread")
    research.ids.update(noteContent=mlflow_note, commentBodies=[thread["body"], reply["body"]])


def chart_panel(
    panel_id: str, *, title: str, metric_key: str = "loss", group_by: dict[str, str] | None = None
) -> dict[str, Any]:
    panel: dict[str, Any] = {
        "id": panel_id,
        "title": title,
        "metricKeys": [metric_key],
        "xAxis": {"kind": "step"},
        "yScale": "linear",
        "smoothing": {"kind": "ema", "weight": 0.6},
        "showRange": True,
        "layout": {"x": 0, "y": 0, "w": 12, "h": 4},
    }
    if group_by:
        panel["groupBy"] = group_by
    return panel


def verify_saved_view(research: Research, details: dict[str, Any]) -> None:
    state = {
        "version": 1,
        "experimentIds": [research.experiment_id],
        "filter": "",
        "orderBy": [],
        "statuses": ["finished"],
        "kinds": [],
        "columns": [{"key": "name"}, {"key": "status"}, {"key": "metrics.loss", "width": 140}],
        "groupBy": {"kind": "param", "key": "batch_size"},
        "chartPanels": {
            "version": 1,
            "columns": 12,
            "panels": [chart_panel("research-val-loss", title="研究: val_loss", metric_key="val_loss")],
        },
    }
    created = research.api.post(
        "saved-views",
        {"visibility": "project", "page": "runs", "name": "研究: batch_size でグループ化", "state": state},
    )
    fetched = research.api.get(f"saved-views/{created['id']}")
    listed = research.api.get("saved-views", params={"page": "runs"})["items"]
    details.update(savedViewId=created["id"], name=fetched["name"], visibility=fetched["visibility"])
    expect(fetched["state"] == state, "the saved state differs from the one sent")
    expect(created["id"] in [view["id"] for view in listed], "the view is missing from the list")
    research.ids.update(savedViewId=created["id"], savedViewName=fetched["name"])


def verify_report(research: Research, details: dict[str, Any]) -> None:
    run_ids = [research.ids["onlineRunId"], research.ids["offlineRunId"]]
    blocks = [
        {
            "id": "intro",
            "type": "markdown",
            "text": "# 研究機能の通し確認\n\nオンラインとオフラインの Run を比べる。",
        },
        {
            "id": "loss-live",
            "type": "chart",
            "panel": chart_panel("loss-live", title="loss（live）"),
            "runSet": {"runIds": run_ids},
            "mode": "live",
        },
        {
            "id": "loss-snapshot",
            "type": "chart",
            "panel": chart_panel("loss-snapshot", title="loss（固定）"),
            "runSet": {"runIds": run_ids},
            "mode": "snapshot",
        },
        {
            "id": "importance",
            "type": "parameter_importance",
            "runSet": {"sweepId": research.ids["sweepId"]},
            "mode": "snapshot",
        },
        {
            "id": "tones",
            "type": "media",
            "runIds": run_ids,
            "key": "inference/tone",
            "steps": MEDIA_STEPS,
            "mode": "snapshot",
        },
        {
            "id": "view-runs",
            "type": "run_table",
            "runSet": {"savedViewId": research.ids["savedViewId"]},
            "columns": ["name", "status", "metrics.loss"],
            "limit": 20,
            "mode": "live",
        },
    ]
    created = research.api.post("reports", {"title": "研究機能の通し確認", "blocks": blocks})
    report_id = created["report"]["id"]
    before = research.api.get(f"reports/{report_id}/snapshots")
    snapshot_before = {item["blockId"]: item["data"] for item in before["items"]}
    expect(
        set(snapshot_before) == {"loss-snapshot", "importance", "tones"},
        f"snapshots {sorted(snapshot_before)}",
    )
    series_request = {"runIds": run_ids, "keys": ["loss"], "xAxis": {"kind": "step"}}
    live_before = research.api.post("metrics/series", series_request)
    research.api.post(
        f"runs/{run_ids[0]}/metrics",
        {
            "metrics": [
                {
                    "name": "loss",
                    "value": 0.05,
                    "step": REPORT_EXTRA_STEP,
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            ]
        },
    )
    live_after = research.api.post("metrics/series", series_request)
    after = research.api.get(f"reports/{report_id}/snapshots")
    snapshot_after = {item["blockId"]: item["data"] for item in after["items"]}
    live_points = (
        [len(series["points"]) for series in live_before["series"]],
        [len(series["points"]) for series in live_after["series"]],
    )
    details.update(
        reportId=report_id,
        revision=created["report"]["currentRevision"],
        snapshotBlocks=sorted(snapshot_before),
        livePointsBeforeAfter=live_points,
        snapshotUnchanged=snapshot_after == snapshot_before,
    )
    expect(live_points[1][0] == live_points[0][0] + 1, "the live series did not gain the new point")
    expect(snapshot_after == snapshot_before, "the snapshot changed after metrics were added")
    comment = research.api.post(
        "comments", {"targetType": "report", "targetId": report_id, "body": "固定の図は変わらない"}
    )
    details["commentId"] = comment["id"]
    research.ids.update(reportId=report_id, reportTitle=created["report"]["title"])


# --- Web -----------------------------------------------------------------------------------------
@contextmanager
def web_server(log_path: Path) -> Iterator[None]:
    environment = {**os.environ, "MMT_WEB_API_PROXY_TARGET": API_URL}
    with log_path.open("wb") as log:
        server = subprocess.Popen(
            [
                str(ROOT / "node_modules/.bin/vite"),
                "--host",
                "127.0.0.1",
                "--port",
                str(WEB_PORT),
                "--strictPort",
            ],
            cwd=ROOT / "apps/web",
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            wait_for_http(f"{WEB_URL}/", server, log_path, WEB_START_SECONDS)
            yield
        finally:
            stop_process(server)


def verify_browser(research: Research, details: dict[str, Any]) -> None:
    fixture_path = OUTPUT_DIRECTORY / "browser-fixture.json"
    fixture_path.write_text(json.dumps(browser_fixture(research), ensure_ascii=False, indent=2) + "\n")
    with web_server(OUTPUT_DIRECTORY / "web.log"):
        completed = subprocess.run(
            ["node", "apps/web/tests/browser-research.mjs"],
            cwd=ROOT,
            env={
                **os.environ,
                "MMT_WEB_URL": WEB_URL,
                "MMT_RESEARCH_FIXTURE": str(fixture_path),
                "MMT_API_ORIGIN": API_WEB_ORIGIN,
                "MMT_SCREENSHOT_DIR": str(OUTPUT_DIRECTORY / "screenshots"),
            },
            capture_output=True,
            text=True,
            timeout=900,
            check=False,
        )
    (OUTPUT_DIRECTORY / "browser.log").write_text(completed.stdout + completed.stderr)
    details.update(exitCode=completed.returncode, steps=completed.stdout.strip().splitlines()[-40:])
    expect(completed.returncode == 0, f"browser-research.mjs failed: {completed.stderr[-1500:]}")


def browser_fixture(research: Research) -> dict[str, Any]:
    return {"projectId": research.project_id, "experimentId": research.experiment_id, **research.ids}


# --- Processes and setup -------------------------------------------------------------------------
def wait_for_http(url: str, process: subprocess.Popen[bytes], log_path: Path, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while True:
        if process.poll() is not None:
            raise SystemExit(f"{url} exited early; see {log_path}")
        try:
            if httpx.get(url, timeout=2).is_success:
                return
        except httpx.TransportError:
            pass
        if time.monotonic() > deadline:
            raise SystemExit(f"{url} did not start within {seconds}s")
        time.sleep(0.5)


def stop_process(process: subprocess.Popen[bytes]) -> None:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


@contextmanager
def isolated_api(log_path: Path) -> Iterator[None]:
    """Like verify_pipeline_smoke's, on this package's port and with the Sweep scheduler running."""
    if not os.environ.get("MMT_TEST_DATABASE_URL"):
        raise SystemExit("MMT_TEST_DATABASE_URL (the dedicated loopback mmt_test DB) is required")
    for port in (API_PORT, WEB_PORT, RELAY_PORT):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(f"Port {port} is already in use")
    environment = {**os.environ, "MMT_VERIFY_API_PORT": str(API_PORT), "MMT_VERIFY_SWEEP_SCHEDULER": "true"}
    with log_path.open("wb") as log:
        server = subprocess.Popen(
            [str(ROOT / "node_modules/.bin/tsx"), "scripts/serve_mlflow_verification.ts"],
            cwd=ROOT,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            wait_for_http(f"{API_URL}/api/health", server, log_path, API_START_SECONDS)
            yield
        finally:
            # SIGTERM lets the harness drop its test schema.
            stop_process(server)


def set_up(session: httpx.Client) -> Research:
    api_request(session, "POST", "auth/dev-login", json={})
    project = api_request(
        session,
        "POST",
        "projects",
        json={
            "name": "Research features " + datetime.now(JST).strftime("%H:%M:%S"),
            "description": "研究者向け機能の通し確認",
            "artifactBackend": "filesystem",
        },
    )
    target = api_request(
        session,
        "POST",
        "targets",
        json={
            "name": "Research CPU " + project["id"][:8],
            "host": "127.0.0.1",
            "port": 22,
            "username": "local",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": str(WORK_DIRECTORY / "jobs"),
            "pythonExecutable": os.environ.get("MMT_VERIFY_PYTHON", sys.executable),
            "gpuIds": [],
            "maxConcurrentJobs": 2,
            "enabled": True,
            "executor": "local",
        },
    )
    experiment = api_request(
        session, "POST", f"projects/{project['id']}/experiments", json={"name": "研究機能", "description": ""}
    )
    issued = api_request(
        session,
        "POST",
        "tokens",
        json={
            "name": "Research features verification",
            "kind": "service",
            "projectId": project["id"],
            "scopes": [
                "read",
                "runs:write",
                "registry:write",
                "artifacts:write",
                "jobs:write",
                "worker:execute",
            ],
            "expiresAt": (datetime.now(UTC) + timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
        },
    )
    return Research(
        session=session,
        api=ProjectApi(session, project["id"]),
        project_id=project["id"],
        experiment_id=experiment["id"],
        target_id=target["id"],
        token=issued["token"],
    )


STAGES = [
    ("system_metrics", "SDKのsystem_metrics=Trueで30秒回し、system.*が記録される", verify_system_metrics),
    ("media", "log_audio/log_image/log_tableを3 step。media APIのkeys・step・表のセル", verify_media),
    ("resume", "同じRunをresume='must'で再開し続きのstepで記録。resume-eventsに区間2つ", verify_resume),
    (
        "offline_sync",
        "MMT_MODE=offlineでRun・metrics・65MiBのArtifact・mediaを記録し、途中で切れたsyncを再実行",
        verify_offline_sync,
    ),
    (
        "sweep",
        "Sweep（grid 2×2、parallelism 2、hyperband）をlocal workerで完走し、分析表と重要度",
        verify_sweep,
    ),
    (
        "note_comments",
        "Runの説明文とMLflowのmlflow.note.contentの往復、コメントと返信",
        verify_note_and_comments,
    ),
    ("saved_view", "保存ビュー（Project公開、グループ化と図の配置）の作成と取得", verify_saved_view),
    ("report", "レポートのliveとsnapshot。metricsを足してもsnapshotは変わらない", verify_report),
]
# Stages that read data earlier stages made; the others still run after a failure.
DEPENDS_ON = {
    "media": ("system_metrics",),
    "resume": ("system_metrics",),
    "note_comments": ("system_metrics",),
    "report": ("system_metrics", "offline_sync", "sweep", "saved_view"),
}


def run_stages(research: Research, recorder: StageRecorder, *, with_browser: bool) -> None:
    failed: set[str] = set()
    for name, description, verify in STAGES:
        failed_dependencies = [stage for stage in DEPENDS_ON.get(name, ()) if stage in failed]
        if failed_dependencies:
            recorder.skip(name, description, f"{failed_dependencies[0]} failed")
            failed.add(name)
            continue
        try:
            with recorder.stage(name, description) as details:
                verify(research, details)
        except Exception:
            failed.add(name)
    description = (
        "Webで同じデータを一巡（図・systemMetrics・media・Compare・保存ビュー・Sweep・説明文・レポート）"
    )
    if not with_browser:
        recorder.skip("browser", description, "MMT_PLAYWRIGHT_MODULE is not set")
    elif failed:
        recorder.skip("browser", description, f"{sorted(failed)[0]} failed")
    else:
        try:
            with recorder.stage("browser", description) as details:
                verify_browser(research, details)
        except Exception:
            pass


def hold(research: Research) -> None:
    fixture_path = OUTPUT_DIRECTORY / "browser-fixture.json"
    fixture_path.write_text(json.dumps(browser_fixture(research), ensure_ascii=False, indent=2) + "\n")
    with web_server(OUTPUT_DIRECTORY / "web.log"):
        print(f"Holding API {API_URL} and Web {WEB_URL}; fixture {fixture_path}. Ctrl+C to stop.", flush=True)
        # The Sweep's worker ran an asyncio loop that took over SIGINT, so install handlers anew;
        # returning normally lets the API drop its schema.
        stop = threading.Event()
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signal_number, lambda *_arguments: stop.set())
        stop.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hold", action="store_true", help="keep the API and Web running after the checks")
    arguments = parser.parse_args()
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    WORK_DIRECTORY.mkdir(parents=True, exist_ok=True)
    recorder = StageRecorder()
    summary: dict[str, Any] = {
        "startedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "api": f"isolated test schema on 127.0.0.1:{API_PORT}",
        "outOfScope": OUT_OF_SCOPE,
        "stages": recorder.stages,
    }
    with (
        isolated_api(OUTPUT_DIRECTORY / "api.log"),
        httpx.Client(base_url=f"{API_URL}/api/", headers={"Origin": API_WEB_ORIGIN}, timeout=60) as session,
    ):
        research = set_up(session)
        summary["projectId"] = research.project_id
        run_stages(research, recorder, with_browser=bool(os.environ.get("MMT_PLAYWRIGHT_MODULE")))
        summary["ids"] = research.ids
        summary.update(
            finishedAt=datetime.now(JST).isoformat(timespec="seconds"),
            result="passed" if recorder.passed else "failed",
        )
        output = OUTPUT_DIRECTORY / "research-integration.json"
        output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        for stage in recorder.stages:
            print(f"{stage['status']:>8}  {stage.get('seconds', '-'):>8}  {stage['name']}")
        print(f"{summary['result']}: {output.relative_to(ROOT)}", flush=True)
        if arguments.hold:
            hold(research)
    return 0 if recorder.passed else 1


if __name__ == "__main__":
    sys.exit(main())
