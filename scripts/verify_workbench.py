"""Verify task revisions, fixed Git edits, test Jobs and saved execution sources."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from mado_tracking import Client
from mado_tracking.settings import ApiSettings
from mado_tracking.worker.config import WorkerSettings
from verify_worker import run_next_job, session_request

ROOT = Path(__file__).resolve().parents[1]
API_URL = os.environ.get("MMT_VERIFY_API_URL", "http://127.0.0.1:4182")
WEB_ORIGIN = os.environ.get("MMT_VERIFY_WEB_ORIGIN", "http://127.0.0.1:5182")
# Git preview has a 30-second deadline; the HTTP caller leaves time for cleanup.
REQUEST_DEADLINE_SECONDS = 45
# A CPU fixture reports progress promptly while leaving dependency setup time to the Job deadline.
HEARTBEAT_SECONDS = 0.2
POLL_SECONDS = 0.1
TELEMETRY_SECONDS = 1
CANCEL_GRACE_SECONDS = 0.5
TOKEN_LIFETIME = timedelta(hours=1)
# Five completed Jobs span several pages, so the real API's cursor ordering is exercised.
HISTORY_PAGE_SIZE = 2
# A small public fixture checks real Git fetching without private credentials.
REPOSITORY_URL = "https://github.com/octocat/Hello-World.git"
REPOSITORY_COMMIT = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"
FIXTURE_DIRECTORY = ROOT / "scripts/fixtures/workbench"
WORK_DIRECTORY = ROOT / "var/verification-workbench"
ARTIFACT_DIRECTORY = (
    ROOT
    / "artifacts/verification"
    / datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")
    / "workbench"
)


@dataclass
class TaskScenario:
    session: httpx.Client
    client: Client
    project: dict[str, Any]
    target: dict[str, Any]
    settings: WorkerSettings

    def request(self, method: str, resource: str, **options: Any) -> dict[str, Any]:
        return session_request(
            self.session, method, f"projects/{self.project['id']}/{resource}", **options
        )

    def publish_code(self, code_id: str, *, version: int) -> dict[str, Any]:
        main_source = (
            (FIXTURE_DIRECTORY / "main.py")
            .read_text()
            .replace("VERSION = 1", f"VERSION = {version}")
        )
        return self.request(
            "POST",
            f"codes/{code_id}/versions",
            json={
                "version": f"v{version}",
                "source": {
                    "kind": "git",
                    "url": REPOSITORY_URL,
                    "commit": REPOSITORY_COMMIT,
                    "files": {
                        "main.py": main_source,
                        "test_main.py": (
                            FIXTURE_DIRECTORY / "test_main.py"
                        ).read_text(),
                        "README.md": "# Workbench Git overlay fixture\n",
                    },
                    "deletedFiles": ["README"],
                },
                "entrypoint": ["python", "main.py"],
                "testEntrypoint": ["python", "-m", "unittest", "test_main"],
                "supportedModelFamilies": ["linear"],
                "taskTypes": ["processing"],
            },
        )

    def launch(
        self, task: dict[str, Any], *, mode: str, **overrides: Any
    ) -> dict[str, Any]:
        return self.request(
            "POST",
            f"tasks/{task['id']}/launch",
            json={
                "expectedRevision": task["revision"],
                "executionMode": mode,
                **overrides,
            },
        )

    def verify_completed_source(
        self, execution: dict[str, Any], *, version: int, status: str
    ) -> dict[str, Any]:
        run = self.request("GET", f"runs/{execution['run']['id']}")
        assert run["status"] == status, run
        snapshot = run["executionSnapshot"]
        assert snapshot["mode"] == run["executionMode"]
        assert snapshot["codeVersionId"] == run["codeVersionId"]
        assert snapshot["source"]["commit"] == REPOSITORY_COMMIT
        artifacts = self.request("GET", f"runs/{run['id']}/artifacts")["items"]
        source_artifact = next(
            item for item in artifacts if item["path"].endswith("source.zip")
        )
        archive = b"".join(
            self.client.download_artifact(self.project["id"], source_artifact["id"])
        )
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            files = {
                name.removeprefix("source/"): source.read(name)
                for name in source.namelist()
            }
        assert files["main.py"].decode() == snapshot["source"]["files"]["main.py"]
        assert f"VERSION = {version}" in files["main.py"].decode()
        assert "README" not in files and files["README.md"].startswith(b"# Workbench")
        assert not any(".git" in Path(name).parts for name in files)
        manifest_artifact = next(
            item
            for item in artifacts
            if "manifest" in item["path"] and item["path"].endswith(".json")
        )
        manifest = json.loads(
            b"".join(
                self.client.download_artifact(
                    self.project["id"], manifest_artifact["id"]
                )
            )
        )
        assert manifest["runId"] == run["id"]
        assert manifest["jobId"] == execution["job"]["id"]
        assert manifest["codeVersionId"] == run["codeVersionId"]
        logs = self.request("GET", f"runs/{run['id']}/logs")["items"]
        message = (
            "tested_code_version"
            if run["executionMode"] == "test"
            else "executed_code_version"
        )
        assert any(f"{message}={version}" in entry["message"] for entry in logs)
        return run


async def verify_task_history(scenario: TaskScenario) -> dict[str, Any]:
    repository = scenario.request(
        "POST",
        "repository-files",
        json={
            "url": REPOSITORY_URL,
            "commit": REPOSITORY_COMMIT,
        },
    )
    assert repository["commit"] == REPOSITORY_COMMIT and "README" in repository["files"]
    experiment = scenario.request(
        "POST", "experiments", json={"name": "コードとテストの追跡"}
    )
    code = scenario.request("POST", "codes", json={"name": "Git版の実行サンプル"})
    first_code = scenario.publish_code(code["id"], version=1)
    second_code = scenario.publish_code(code["id"], version=2)
    first_task = scenario.request(
        "POST",
        "tasks",
        json={
            "experimentId": experiment["id"],
            "name": "コード保存の確認",
            "kind": "processing",
            "codeVersionId": first_code["id"],
            "parameters": {"expected_version": 1},
            "targetId": scenario.target["id"],
        },
    )
    first_test = scenario.launch(first_task, mode="test", name="v1のテスト")
    first_run = scenario.launch(first_task, mode="run", name="v1の通常実行")
    second_task = scenario.request(
        "PATCH",
        f"tasks/{first_task['id']}",
        json={
            "expectedRevision": first_task["revision"],
            "codeVersionId": second_code["id"],
            "parameters": {"expected_version": 2},
        },
    )
    stale = scenario.session.post(
        f"projects/{scenario.project['id']}/tasks/{first_task['id']}/launch",
        json={"expectedRevision": first_task["revision"], "executionMode": "run"},
    )
    assert stale.status_code == 409, stale.text
    for execution in [first_test, first_run]:
        await run_next_job(scenario.settings)
        completed = scenario.verify_completed_source(
            execution, version=1, status="finished"
        )
        assert completed["taskRevision"] == first_task["revision"]
        assert completed["codeVersionId"] == first_code["id"]
    second_run = scenario.launch(second_task, mode="run", name="v2の通常実行")
    await run_next_job(scenario.settings)
    scenario.verify_completed_source(second_run, version=2, status="finished")
    failed_test = scenario.launch(
        second_task,
        mode="test",
        name="失敗するテストの確認",
        parameters={"fail_test": True},
    )
    await run_next_job(scenario.settings)
    failed = scenario.verify_completed_source(failed_test, version=2, status="failed")
    assert failed["parameters"] == {"expected_version": 2, "fail_test": True}
    # Moving a task back must not change the fixed retry of its earlier failed test.
    scenario.request(
        "PATCH",
        f"tasks/{first_task['id']}",
        json={
            "expectedRevision": second_task["revision"],
            "codeVersionId": first_code["id"],
            "parameters": {"expected_version": 1},
        },
    )
    retried = scenario.request("POST", f"jobs/{failed_test['job']['id']}/retry")
    await run_next_job(scenario.settings)
    retry_run = scenario.verify_completed_source(retried, version=2, status="failed")
    assert retry_run["parentRunId"] == failed["id"]
    assert retry_run["taskRevision"] == second_task["revision"]
    assert retry_run["executionMode"] == "test"
    history = scenario.request("GET", f"tasks/{first_task['id']}/runs")["items"]
    assert len(history) == 5 and {item["taskRevision"] for item in history} == {1, 2}
    paged_run_ids = []
    cursor = None
    while True:
        page = scenario.request(
            "GET",
            f"tasks/{first_task['id']}/runs",
            params={
                "limit": HISTORY_PAGE_SIZE,
                **({"cursor": cursor} if cursor else {}),
            },
        )
        assert len(page["items"]) <= HISTORY_PAGE_SIZE
        assert all("executionSnapshot" not in item for item in page["items"])
        paged_run_ids.extend(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
        assert len(paged_run_ids) < len(history)
    assert paged_run_ids == [item["id"] for item in history]
    return {
        "projectId": scenario.project["id"],
        "targetId": scenario.target["id"],
        "taskId": first_task["id"],
        "experimentId": experiment["id"],
        "codeId": code["id"],
        "codeVersionIds": [first_code["id"], second_code["id"]],
        "runIds": [item["id"] for item in history],
        "testRunId": first_test["run"]["id"],
        "normalRunId": second_run["run"]["id"],
        "failedTestRunId": failed["id"],
        "checks": [
            "exact Git commit read, edits and deleted files materialized",
            "queued Jobs retain code and task revision after a task edit",
            "stale task revision rejected before creating a Run or Job",
            "test command and regular command execute separately",
            "source ZIP captures code before the workload changes its files",
            "failed tests retain logs, manifest and source ZIP",
            "retry retains failed test code, mode, parameters and task revision",
            "task history includes all original executions and retry",
            "bounded history pages preserve order without code snapshots",
        ],
    }


def main() -> None:
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    with httpx.Client(
        base_url=API_URL + "/api/",
        headers={"Origin": WEB_ORIGIN},
        timeout=REQUEST_DEADLINE_SECONDS,
    ) as session:
        session_request(session, "POST", "auth/dev-login", json={})
        project = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": "Workbench検証 "
                + datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%H:%M:%S"),
                "description": "固定コード・タスクrevision・テスト失敗を実CPUで確認",
                "artifactBackend": "filesystem",
            },
        )
        target = session_request(
            session,
            "POST",
            "targets",
            json={
                "name": "Workbench検証CPU " + project["id"][:8],
                "host": "127.0.0.1",
                "port": 22,
                "username": "local",
                "sshKeyPath": "",
                "knownHostsPath": "",
                "workDirectory": str(WORK_DIRECTORY / "jobs"),
                "pythonExecutable": sys.executable,
                "runtimeKinds": ["python"],
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
                "name": "Temporary workbench verification",
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
            with Client(api_url=API_URL, api_token=issued["token"]) as client:
                settings = WorkerSettings(
                    api=ApiSettings.from_environment(
                        url=API_URL, token=issued["token"]
                    ),
                    worker_id=f"verify-workbench-{project['id']}",
                    target_ids=(target["id"],),
                    state_directory=WORK_DIRECTORY / "state" / project["id"],
                    allow_local_executor=True,
                    heartbeat_seconds=HEARTBEAT_SECONDS,
                    poll_seconds=POLL_SECONDS,
                    telemetry_seconds=TELEMETRY_SECONDS,
                    cancel_grace_seconds=CANCEL_GRACE_SECONDS,
                )
                scenario = TaskScenario(
                    session=session,
                    client=client,
                    project=project,
                    target=target,
                    settings=settings,
                )
                summary = asyncio.run(verify_task_history(scenario))
                (ARTIFACT_DIRECTORY / "task-integration.json").write_text(
                    json.dumps(summary, ensure_ascii=False, indent=2)
                )
                print(json.dumps(summary, ensure_ascii=False, indent=2))
        finally:
            session_request(session, "DELETE", "tokens/" + issued["item"]["id"])
            session_request(
                session, "PATCH", "targets/" + target["id"], json={"enabled": False}
            )


if __name__ == "__main__":
    main()
