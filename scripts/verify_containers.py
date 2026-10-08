"""Verify model automation and a real CPU Docker job against the local API."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from mado_tracking import Client
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.service import Worker
from verify_worker import (
    API_URL,
    WEB_ORIGIN,
    run_next_job,
    session_request,
    wait_for_log,
)

ROOT = Path(__file__).resolve().parents[1]
WORK_DIRECTORY = ROOT / "var/verification-containers"
ARTIFACT_DIRECTORY = (
    ROOT
    / "artifacts/verification"
    / datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")
    / "containers"
)
# This already available image has Node and needs no package installation for the fixture.
DEFAULT_IMAGE = (
    "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"
)
# Keep the recovery job alive long enough to interrupt the monitor after its first log.
RECOVERY_DELAY_SECONDS = 5
EXPECTED_SAMPLES = 4
# Allow the Docker stop/kill confirmation and final API acknowledgement to complete.
CANCEL_TIMEOUT_SECONDS = 60
# Frequent local polling keeps the reconnect/cancel scenarios short without changing worker defaults.
HEARTBEAT_SECONDS = 0.2
POLL_SECONDS = 0.1
TELEMETRY_SECONDS = 1
CANCEL_GRACE_SECONDS = 0.5
# Local API calls can include streamed artifacts; tokens remain bounded even if cleanup is interrupted.
REQUEST_TIMEOUT_SECONDS = 30
TOKEN_LIFETIME = timedelta(hours=1)


def create_verification_settings(
    *, project_id: str, target_id: str, token: str
) -> WorkerSettings:
    return WorkerSettings(
        api=ApiSettings.from_environment(url=API_URL, token=token),
        worker_id=f"containers-{project_id}",
        target_ids=(target_id,),
        state_directory=WORK_DIRECTORY / "state" / project_id,
        allow_local_executor=True,
        heartbeat_seconds=HEARTBEAT_SECONDS,
        poll_seconds=POLL_SECONDS,
        telemetry_seconds=TELEMETRY_SECONDS,
        cancel_grace_seconds=CANCEL_GRACE_SECONDS,
    )


async def cancel_remaining_jobs(
    *, session: httpx.Client, project_id: str, settings: WorkerSettings
) -> None:
    jobs = session_request(session, "GET", f"projects/{project_id}/jobs")["items"]
    active = [
        job for job in jobs if job["status"] not in {"finished", "failed", "canceled"}
    ]
    if not active:
        return
    for job in active:
        session_request(
            session, "POST", f"projects/{project_id}/jobs/{job['id']}/cancel", json={}
        )
    worker = Worker(settings)
    worker.journal.acquire_worker_lock()
    try:
        recovered = await worker.recover()
        for job in recovered:
            await asyncio.wait_for(worker.run_job(job), timeout=CANCEL_TIMEOUT_SECONDS)
    finally:
        worker.journal.close()
        await worker.api.close()


def automation_executions(session: httpx.Client, project_id: str) -> list[dict]:
    return session_request(
        session, "GET", f"projects/{project_id}/automation-executions"
    )["items"]


def executions_for_model(
    session: httpx.Client, *, project_id: str, model_version_id: str
) -> list[dict]:
    return [
        execution
        for execution in automation_executions(session, project_id)
        if execution["modelVersionId"] == model_version_id
    ]


async def disconnect_after_container_start(
    settings: WorkerSettings, *, client: Client, project_id: str
) -> dict:
    worker = Worker(settings)
    worker.journal.acquire_worker_lock()
    monitoring = None
    try:
        claimed = await worker.api.claim(settings.worker_id, settings.target_ids)
        assert claimed is not None, "Expected a queued recovery job"
        monitoring = asyncio.create_task(worker.run_job(claimed))
        await wait_for_log(
            client,
            project_id=project_id,
            run_id=claimed.run["id"],
            message="container started",
            monitoring=monitoring,
        )
        monitoring.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await monitoring
        return {"jobId": claimed.id, "runId": claimed.run["id"]}
    finally:
        if monitoring is not None and not monitoring.done():
            monitoring.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitoring
        worker.journal.close()
        await worker.api.close()


async def cancel_running_container(
    settings: WorkerSettings, *, client: Client, project_id: str
) -> dict:
    worker = Worker(settings)
    worker.journal.acquire_worker_lock()
    monitoring = None
    try:
        claimed = await worker.api.claim(settings.worker_id, settings.target_ids)
        assert claimed is not None, "Expected a queued cancellation job"
        monitoring = asyncio.create_task(worker.run_job(claimed))
        await wait_for_log(
            client,
            project_id=project_id,
            run_id=claimed.run["id"],
            message="container started",
            monitoring=monitoring,
        )
        client.request(
            "POST",
            client.project_path(project_id, f"jobs/{claimed.id}/cancel"),
            json={},
        )
        await asyncio.wait_for(monitoring, timeout=CANCEL_TIMEOUT_SECONDS)
        assert (
            client.get_run(project_id, claimed.run["id"]).entity["status"] == "canceled"
        )
        return {"jobId": claimed.id, "runId": claimed.run["id"]}
    finally:
        if monitoring is not None and not monitoring.done():
            monitoring.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitoring
        worker.journal.close()
        await worker.api.close()


async def verify_automation(
    *, session: httpx.Client, project: dict, target: dict, token: str, image: str
) -> dict:
    project_id = project["id"]
    settings = create_verification_settings(
        project_id=project_id, target_id=target["id"], token=token
    )
    summary = {
        "projectId": project_id,
        "targetId": target["id"],
        "image": image,
        "checks": [],
        "runs": [],
    }
    with Client(api_url=API_URL, api_token=token) as client:
        experiment = client.create_experiment(project_id, name="Container automation")
        inference_program = (
            ROOT / "scripts/fixtures/containerInference.mjs"
        ).read_text()
        source_code = client.register_code(
            project_id,
            name="Docker linear inference",
            version="v1",
            source={"kind": "inline", "files": {"infer.mjs": inference_program}},
            runtime={"kind": "docker", "image": image},
            entrypoint=["node", "/mmt/source/infer.mjs"],
            supported_model_families=["linear"],
            task_types=["inference", "evaluation"],
        )
        embedded_code = client.register_code(
            project_id,
            name="Docker embedded command",
            version="v1",
            source=None,
            runtime={"kind": "docker", "image": image},
            entrypoint=["node", "--input-type=module", "-e", inference_program],
            supported_model_families=["linear"],
            task_types=["evaluation"],
        )
        dataset = client.register_dataset(
            project_id,
            name="Linear evaluation samples",
            namespace="verification",
            version="v1",
            uri="urn:mmt:verification:linear-evaluation",
            digest="fixture:linear-y2x1-v1",
            metadata={"samples": [0, 1, 2, 3], "expected": [1, 3, 5, 7]},
        )
        weights = session_request(
            session,
            "PUT",
            f"projects/{project_id}/artifacts",
            params={"path": "models/linear-weights.json"},
            headers={"Content-Type": "application/json"},
            content=json.dumps({"weight": 2, "bias": 1}).encode(),
        )
        model_before_rules = client.register_model(
            project_id,
            name="Automated linear model",
            family="linear",
            version="v0",
            artifact_id=weights["id"],
        )
        rule_ids = []

        def create_rule(*, name: str, code: dict, kind: str, parameters: dict) -> dict:
            rule = session_request(
                session,
                "POST",
                f"projects/{project_id}/automation-rules",
                json={
                    "name": name,
                    "enabled": True,
                    "modelFamilies": ["linear"],
                    "kind": kind,
                    "experimentId": experiment["id"],
                    "codeVersionId": code["id"],
                    "targetId": target["id"],
                    "gpuIds": [],
                    "inputDatasetVersionIds": [dataset["id"]],
                    "parameters": parameters,
                    "tags": {"verification": "true"},
                    "maxAttempts": 3,
                },
            )
            rule_ids.append(rule["id"])
            return rule

        def register_version(version: str) -> dict:
            return client.register_model(
                project_id,
                name="Automated linear model",
                family="linear",
                model_id=model_before_rules["modelId"],
                version=version,
                artifact_id=weights["id"],
            )

        try:
            inference_rule = create_rule(
                name="Auto inference", code=source_code, kind="inference", parameters={}
            )
            evaluation_rule = create_rule(
                name="Auto evaluation",
                code=embedded_code,
                kind="evaluation",
                parameters={},
            )
            assert automation_executions(session, project_id) == []
            summary["checks"].append("rules do not execute historical ModelVersions")
            session_request(
                session,
                "PUT",
                f"projects/{project_id}/artifacts",
                params={"path": "models/unregistered-weights.json"},
                headers={"Content-Type": "application/json"},
                content=json.dumps({"weight": 2, "bias": 1}).encode(),
            )
            assert automation_executions(session, project_id) == []
            summary["checks"].append("upload alone does not execute a model")

            model = register_version("v1")
            executions = executions_for_model(
                session, project_id=project_id, model_version_id=model["id"]
            )
            assert len(executions) == 2 and all(
                execution["status"] == "queued" for execution in executions
            ), executions
            await run_next_job(settings)
            await run_next_job(settings)
            for execution in executions:
                run = client.get_run(project_id, execution["runId"]).entity
                assert run["status"] == "finished", run
                assert run["modelVersionId"] == model["id"]
                assert run["inputDatasetVersionIds"] == [dataset["id"]]
                assert run["latestMetrics"]["inference.samples"] == EXPECTED_SAMPLES, (
                    run
                )
                assert run["latestMetrics"]["evaluation.mse"] == 0, run
                artifacts = client.request(
                    "GET",
                    client.project_path(project_id, f"runs/{run['id']}/artifacts"),
                )["items"]
                predictions = next(
                    artifact
                    for artifact in artifacts
                    if artifact["path"].endswith("predictions.json")
                )
                content = json.loads(
                    b"".join(client.download_artifact(project_id, predictions["id"]))
                )
                assert content["predictions"] == [1, 3, 5, 7], content
                assert content["modelVersionId"] == model["id"]
                summary["runs"].append(
                    {"runId": run["id"], "jobId": execution["jobId"]}
                )
            duplicate = session.post(
                f"projects/{project_id}/models/{model['modelId']}/versions",
                json={"version": "v1", "artifactId": weights["id"]},
            )
            assert duplicate.status_code == 409
            assert (
                len(
                    executions_for_model(
                        session, project_id=project_id, model_version_id=model["id"]
                    )
                )
                == 2
            )
            summary["checks"].append(
                "model registration automatically creates inference/evaluation jobs once"
            )
            summary["checks"].append(
                "Docker reads model/input metadata and returns metrics and prediction Artifacts"
            )

            for rule in (inference_rule, evaluation_rule):
                session_request(
                    session,
                    "PATCH",
                    f"projects/{project_id}/automation-rules/{rule['id']}",
                    json={"enabled": False},
                )
            disabled_model = register_version("v2")
            assert (
                executions_for_model(
                    session,
                    project_id=project_id,
                    model_version_id=disabled_model["id"],
                )
                == []
            )
            summary["checks"].append("disabled rules do not enqueue jobs")

            recovery_rule = create_rule(
                name="Recover running Docker",
                code=source_code,
                kind="inference",
                parameters={"delaySeconds": RECOVERY_DELAY_SECONDS},
            )
            register_version("v3")
            recovered = await disconnect_after_container_start(
                settings, client=client, project_id=project_id
            )
            await run_next_job(settings)
            assert (
                client.get_run(project_id, recovered["runId"]).entity["status"]
                == "finished"
            )
            logs = client.request(
                "GET",
                client.project_path(project_id, f"runs/{recovered['runId']}/logs"),
            )["items"]
            assert sum("container started" in entry["message"] for entry in logs) == 1
            summary["runs"].append(recovered)
            summary["checks"].append(
                "worker reconnects to Docker without duplicate start"
            )
            session_request(
                session,
                "PATCH",
                f"projects/{project_id}/automation-rules/{recovery_rule['id']}",
                json={"enabled": False},
            )

            create_rule(
                name="Cancel running Docker",
                code=source_code,
                kind="inference",
                parameters={"hold": True},
            )
            register_version("v4")
            canceled = await cancel_running_container(
                settings, client=client, project_id=project_id
            )
            summary["runs"].append(canceled)
            summary["checks"].append(
                "cancel stops an actual SIGTERM-ignoring Docker process"
            )

            container_listing = await asyncio.to_thread(
                subprocess.run,
                ["docker", "ps", "-a", "--format", "{{.Names}}"],
                check=True,
                capture_output=True,
                text=True,
            )
            container_names = container_listing.stdout.splitlines()
            assert not any(
                run["jobId"] in name
                for run in summary["runs"]
                for name in container_names
            ), container_names
            graph = session_request(session, "GET", f"projects/{project_id}/lineage")
            assert any(node["id"] == model["id"] for node in graph["nodes"])
            assert all(
                any(node["id"] == run["runId"] for node in graph["nodes"])
                for run in summary["runs"]
            )
            summary.update(
                modelVersionId=model["id"],
                modelId=model["modelId"],
                sourceCodeVersionId=source_code["id"],
                embeddedCodeVersionId=embedded_code["id"],
                inputDatasetVersionId=dataset["id"],
                experimentId=experiment["id"],
                ruleIds=rule_ids,
            )
            summary["checks"].append(
                "completed containers are removed and Runs retain lineage"
            )
            return summary
        finally:
            for rule_id in rule_ids:
                session_request(
                    session,
                    "PATCH",
                    f"projects/{project_id}/automation-rules/{rule_id}",
                    json={"enabled": False},
                )


def main() -> None:
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    image = os.environ.get("MMT_VERIFY_CONTAINER_IMAGE", DEFAULT_IMAGE)
    subprocess.run(
        ["docker", "image", "inspect", image], check=True, stdout=subprocess.DEVNULL
    )
    with httpx.Client(
        base_url=API_URL + "/api/",
        headers={"Origin": WEB_ORIGIN},
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as session:
        session_request(session, "POST", "auth/dev-login", json={})
        project = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": "Container automation "
                + datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%H:%M:%S"),
                "description": "実Dockerでモデル登録後の自動推論・評価と停止・再接続を確認",
                "artifactBackend": "filesystem",
            },
        )
        target = session_request(
            session,
            "POST",
            "targets",
            json={
                "name": "Docker CPU " + project["id"][:8],
                "host": "127.0.0.1",
                "port": 22,
                "username": "local",
                "sshKeyPath": "",
                "knownHostsPath": "",
                "workDirectory": str(WORK_DIRECTORY / "jobs"),
                "pythonExecutable": os.environ.get("MMT_VERIFY_PYTHON", sys.executable),
                "runtimeKinds": ["python", "docker"],
                "gpuIds": [],
                "maxConcurrentJobs": 2,
                "enabled": True,
                "executor": "local",
            },
        )
        issued = session_request(
            session,
            "POST",
            "tokens",
            json={
                "name": "Temporary container verification worker",
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
                "expiresAt": (datetime.now(UTC) + TOKEN_LIFETIME)
                .isoformat()
                .replace("+00:00", "Z"),
            },
        )
        try:
            summary = asyncio.run(
                verify_automation(
                    session=session,
                    project=project,
                    target=target,
                    token=issued["token"],
                    image=image,
                )
            )
            (ARTIFACT_DIRECTORY / "container-integration.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2)
            )
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        finally:
            try:
                asyncio.run(
                    cancel_remaining_jobs(
                        session=session,
                        project_id=project["id"],
                        settings=create_verification_settings(
                            project_id=project["id"],
                            target_id=target["id"],
                            token=issued["token"],
                        ),
                    )
                )
            finally:
                session_request(session, "DELETE", "tokens/" + issued["item"]["id"])


if __name__ == "__main__":
    main()
