"""Exercise the real local API, SDK and durable worker without using a GPU host."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from mado_tracking import Client
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.service import Worker

ROOT = Path(__file__).resolve().parents[1]
API_URL = os.environ.get("MMT_VERIFY_API_URL", "http://127.0.0.1:4182")
WEB_ORIGIN = os.environ.get("MMT_VERIFY_WEB_ORIGIN", "http://127.0.0.1:5182")
# Job setup installs httpx into a real venv; bound integration time without retrying forever.
JOB_DEADLINE_SECONDS = 120
# Match the fixture target's two slots and inspect state often enough to finish promptly.
PARALLEL_JOBS = 2
STATE_POLL_SECONDS = 0.1
# Both sides compute the same JSON float loss; tolerate only floating point rounding.
LOSS_TOLERANCE = 1e-12
ARTIFACT_DIRECTORY = (
    ROOT
    / "artifacts/verification"
    / datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")
)
WORK_DIRECTORY = ROOT / "var/verification-worker"


def session_request(session: httpx.Client, method: str, path: str, **options):
    response = session.request(method, path, **options)
    if not response.is_success:
        raise AssertionError(
            f"{method} {path} failed with HTTP {response.status_code}: {response.text}"
        )
    return response.json() if response.content else None


async def run_next_job(settings: WorkerSettings) -> None:
    worker = Worker(settings)
    worker.journal.acquire_worker_lock()
    try:
        jobs = await worker.recover()
        if not jobs:
            claimed = await worker.api.claim(settings.worker_id, settings.target_ids)
            jobs = [claimed] if claimed else []
        assert len(jobs) == 1, "Expected exactly one eligible job"
        await asyncio.wait_for(worker.run_job(jobs[0]), timeout=JOB_DEADLINE_SECONDS)
    finally:
        worker.journal.close()
        await worker.api.close()


async def wait_for_log(
    client: Client,
    *,
    project_id: str,
    run_id: str,
    message: str,
    monitoring: asyncio.Task[None] | None = None,
) -> None:
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        entries = client.request(
            "GET", client.project_path(project_id, f"runs/{run_id}/logs")
        )["items"]
        if any(message in entry["message"] for entry in entries):
            return
        if monitoring is not None and monitoring.done():
            await monitoring
            raise AssertionError(f"Worker stopped before emitting {message}")
        await asyncio.sleep(STATE_POLL_SECONDS)
    raise AssertionError(f"Run never emitted {message}")


async def wait_for_run_statuses(
    client: Client, *, project_id: str, run_ids: list[str], status: str
) -> None:
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        if all(
            client.get_run(project_id, run_id).entity["status"] == status
            for run_id in run_ids
        ):
            return
        await asyncio.sleep(STATE_POLL_SECONDS)
    raise AssertionError(f"Runs did not reach {status}")


async def verify_jobs(
    *, session: httpx.Client, project: dict, target: dict, token: str
) -> dict:
    project_id = project["id"]
    settings = WorkerSettings(
        api=ApiSettings.from_environment(url=API_URL, token=token),
        worker_id=f"verify-{project_id}",
        target_ids=(target["id"],),
        state_directory=WORK_DIRECTORY / "state" / project_id,
        allow_local_executor=True,
        heartbeat_seconds=0.2,
        poll_seconds=0.1,
        telemetry_seconds=1,
        cancel_grace_seconds=0.5,
        parallel_jobs=PARALLEL_JOBS,
    )
    summary = {"projectId": project_id, "targetId": target["id"], "checks": []}
    with Client(api_url=API_URL, api_token=token) as client:
        experiment = client.create_experiment(
            project_id, name="SDK and worker integration"
        )
        training = client.register_code(
            project_id,
            name="Real CPU training",
            version="v1",
            source={
                "kind": "inline",
                "files": {
                    "training.py": (ROOT / "python/examples/training.py").read_text()
                },
            },
            entrypoint=["python", "training.py"],
            supported_model_families=["linear"],
            task_types=["training", "finetuning"],
        )
        inference = client.register_code(
            project_id,
            name="Real CPU inference",
            version="v1",
            source={
                "kind": "inline",
                "files": {
                    "inference.py": (ROOT / "python/examples/inference.py").read_text()
                },
            },
            entrypoint=["python", "inference.py"],
            supported_model_families=["linear"],
            task_types=["inference"],
        )
        input_dataset = client.register_dataset(
            project_id,
            name="Linear training samples",
            namespace="verification",
            version="v1",
            uri="urn:mmt:verification:linear-samples",
            digest="fixture:linear-y2x1-v1",
            schema={"x": "number", "y": "number"},
            metadata={"fixture": True},
        )
        training_run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="Real CPU training",
            kind="training",
            code_version_id=training["id"],
            input_dataset_version_ids=[input_dataset["id"]],
            parameters={"steps": 40, "learning_rate": 0.1},
            tags={"verification": "true"},
        )
        client.create_job(
            project_id, run_id=training_run.id, target_id=target["id"], max_attempts=3
        )
        await run_next_job(settings)
        completed_training = client.get_run(project_id, training_run.id).entity
        assert completed_training["status"] == "finished", completed_training
        metrics = client.request("GET", training_run.api_path + "/metrics")["items"]
        loss = [point for point in metrics if point["name"] == "train.loss"]
        assert len(loss) == 40 and loss[-1]["value"] < loss[0]["value"]
        artifact = client.request("GET", training_run.api_path + "/artifacts")["items"][
            0
        ]
        weights = json.loads(
            b"".join(client.download_artifact(project_id, artifact["id"]))
        )
        assert abs(weights["weight"] - 2) < 0.1 and abs(weights["bias"] - 1) < 0.1
        model_version_id = completed_training["tags"]["outputModelVersionId"]
        summary.update(trainingRunId=training_run.id, modelVersionId=model_version_id)
        summary["checks"].append(
            "training: real loss, weights Artifact and output ModelVersion"
        )

        inference_run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="Real CPU inference",
            kind="inference",
            model_version_id=model_version_id,
            code_version_id=inference["id"],
            input_dataset_version_ids=[input_dataset["id"]],
        )
        client.create_job(project_id, run_id=inference_run.id, target_id=target["id"])
        await run_next_job(settings)
        assert (
            client.get_run(project_id, inference_run.id).entity["status"] == "finished"
        )
        prediction_artifact = client.request(
            "GET", inference_run.api_path + "/artifacts"
        )["items"][0]
        predictions = json.loads(
            b"".join(client.download_artifact(project_id, prediction_artifact["id"]))
        )
        assert len(predictions) == 3 and abs(predictions[1]["prediction"] - 3) < 0.1
        summary["inferenceRunId"] = inference_run.id
        summary["checks"].append(
            "inference: pinned model download, predictions Artifact and output DatasetVersion"
        )

        finetuning_run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="CPU fine-tuning",
            kind="finetuning",
            model_version_id=model_version_id,
            code_version_id=training["id"],
            input_dataset_version_ids=[input_dataset["id"]],
            parameters={"steps": 10, "learning_rate": 0.1},
        )
        client.create_job(project_id, run_id=finetuning_run.id, target_id=target["id"])
        await run_next_job(settings)
        fine_tuned = client.get_run(project_id, finetuning_run.id).entity
        assert fine_tuned["status"] == "finished", fine_tuned
        fine_loss = [
            point
            for point in client.request("GET", finetuning_run.api_path + "/metrics")[
                "items"
            ]
            if point["name"] == "train.loss"
        ]
        training_samples = [(-1.0, -1.0), (0.0, 1.0), (1.0, 3.0), (2.0, 5.0)]
        parent_loss = sum(
            (weights["weight"] * x + weights["bias"] - y) ** 2
            for x, y in training_samples
        ) / len(training_samples)
        assert abs(fine_loss[0]["value"] - parent_loss) < LOSS_TOLERANCE
        assert fine_loss[-1]["value"] < fine_loss[0]["value"]
        summary["finetuningRunId"] = finetuning_run.id
        summary["checks"].append(
            "finetuning: initialize pinned parent weights and continue reducing loss"
        )

        parallel_code = client.register_code(
            project_id,
            name="Parallel claim verification",
            version="v1",
            source={
                "kind": "inline",
                "files": {
                    "main.py": (
                        "import threading\n"
                        'print("parallel-ready", flush=True)\n'
                        "threading.Event().wait()\n"
                    )
                },
            },
            entrypoint=["python", "main.py"],
            supported_model_families=["linear"],
            task_types=["processing"],
        )
        parallel_runs = [
            client.create_run(
                project_id,
                experiment_id=experiment["id"],
                name=f"Parallel slot {slot + 1}",
                kind="processing",
                code_version_id=parallel_code["id"],
            )
            for slot in range(PARALLEL_JOBS)
        ]
        parallel_jobs = [
            client.create_job(project_id, run_id=run.id, target_id=target["id"])
            for run in parallel_runs
        ]
        parallel_worker = Worker(settings)
        monitoring_parallel = asyncio.create_task(parallel_worker.run_forever())
        try:
            for run in parallel_runs:
                await wait_for_log(
                    client,
                    project_id=project_id,
                    run_id=run.id,
                    message="parallel-ready",
                    monitoring=monitoring_parallel,
                )
            assert all(
                client.get_run(project_id, run.id).entity["status"] == "running"
                for run in parallel_runs
            ), "Both slots must be active at the same time"
            for job in parallel_jobs:
                session_request(
                    session,
                    "POST",
                    f"projects/{project_id}/jobs/{job['id']}/cancel",
                )
            await wait_for_run_statuses(
                client,
                project_id=project_id,
                run_ids=[run.id for run in parallel_runs],
                status="canceled",
            )
            # A terminal API status precedes the worker's durable acknowledgement cleanup.
            await asyncio.gather(*parallel_worker.tasks.values())
        finally:
            parallel_worker.stopping.set()
            await monitoring_parallel
        summary["checks"].append(
            "parallel worker: claim and monitor two real jobs concurrently"
        )

        long_code = client.register_code(
            project_id,
            name="Cancellation and restart",
            version="v1",
            source={
                "kind": "inline",
                "files": {
                    "main.py": (
                        "import pathlib,time\n"
                        'with pathlib.Path("../starts.txt").open("a") as output: output.write("started\\n")\n'
                        'print("execution-started",flush=True)\ntime.sleep(10)\nprint("execution-finished",flush=True)\n'
                    )
                },
            },
            entrypoint=["python", "main.py"],
            supported_model_families=["linear"],
            task_types=["processing"],
        )
        canceled_run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="Cancel then retry",
            kind="processing",
            code_version_id=long_code["id"],
        )
        canceled_job = client.create_job(
            project_id, run_id=canceled_run.id, target_id=target["id"], max_attempts=3
        )
        task = asyncio.create_task(run_next_job(settings))
        await wait_for_log(
            client,
            project_id=project_id,
            run_id=canceled_run.id,
            message="execution-started",
            monitoring=task,
        )
        session_request(
            session, "POST", f"projects/{project_id}/jobs/{canceled_job['id']}/cancel"
        )
        await task
        assert (
            client.get_run(project_id, canceled_run.id).entity["status"] == "canceled"
        )
        retried = session_request(
            session, "POST", f"projects/{project_id}/jobs/{canceled_job['id']}/retry"
        )
        repeated_retry = session_request(
            session, "POST", f"projects/{project_id}/jobs/{canceled_job['id']}/retry"
        )
        assert repeated_retry["job"]["id"] == retried["job"]["id"]
        await run_next_job(settings)
        assert (
            client.get_run(project_id, retried["run"]["id"]).entity["status"]
            == "finished"
        )
        assert retried["run"]["parentRunId"] == canceled_run.id
        summary["checks"].append(
            "cancellation: process termination; retry: new Run and idempotent request"
        )

        restart_run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="Recover after worker restart",
            kind="processing",
            code_version_id=long_code["id"],
        )
        restart_job = client.create_job(
            project_id, run_id=restart_run.id, target_id=target["id"]
        )
        monitoring = asyncio.create_task(run_next_job(settings))
        await wait_for_log(
            client,
            project_id=project_id,
            run_id=restart_run.id,
            message="execution-started",
            monitoring=monitoring,
        )
        monitoring.cancel()
        await asyncio.gather(monitoring, return_exceptions=True)
        await run_next_job(settings)
        assert client.get_run(project_id, restart_run.id).entity["status"] == "finished"
        starts = WORK_DIRECTORY / "jobs" / restart_job["id"] / "starts.txt"
        assert starts.read_text().splitlines() == ["started"]
        summary["checks"].append(
            "restart: reattach the existing process without a duplicate launch"
        )

        lineage = client.request("GET", client.project_path(project_id, "lineage"))
        serialized = json.dumps(lineage)
        for identifier in [
            training_run.id,
            inference_run.id,
            model_version_id,
            input_dataset["id"],
        ]:
            assert identifier in serialized
        summary["checks"].append(
            "lineage: input DatasetVersion, generating Run, models and prediction data"
        )
    return summary


def main() -> None:
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    python_executable = os.environ.get("MMT_VERIFY_PYTHON", sys.executable)
    with httpx.Client(
        base_url=API_URL + "/api/", headers={"Origin": WEB_ORIGIN}, timeout=30
    ) as session:
        session_request(session, "POST", "auth/dev-login", json={})
        project = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": "Worker integration "
                + datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%H:%M:%S"),
                "description": "実API/SDK/workerでCPU実行した検証記録",
                "artifactBackend": "filesystem",
            },
        )
        target = session_request(
            session,
            "POST",
            "targets",
            json={
                "name": "Verification CPU " + project["id"][:8],
                "host": "127.0.0.1",
                "port": 22,
                "username": "local",
                "sshKeyPath": "",
                "knownHostsPath": "",
                "workDirectory": str(WORK_DIRECTORY / "jobs"),
                "pythonExecutable": python_executable,
                "gpuIds": [],
                "maxConcurrentJobs": PARALLEL_JOBS,
                "enabled": True,
                "executor": "local",
            },
        )
        issued = session_request(
            session,
            "POST",
            "tokens",
            json={
                "name": "Temporary integration worker",
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
                "expiresAt": (datetime.now(UTC) + timedelta(hours=1))
                .isoformat()
                .replace("+00:00", "Z"),
            },
        )
        try:
            summary = asyncio.run(
                verify_jobs(
                    session=session,
                    project=project,
                    target=target,
                    token=issued["token"],
                )
            )
            (ARTIFACT_DIRECTORY / "worker-integration.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2)
            )
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        finally:
            session_request(session, "DELETE", "tokens/" + issued["item"]["id"])


if __name__ == "__main__":
    main()
