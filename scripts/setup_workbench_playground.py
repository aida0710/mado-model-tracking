"""Create a development Playground project for the real browser/worker walkthrough."""

from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
from verify_workbench import ARTIFACT_DIRECTORY
from verify_worker import API_URL, WEB_ORIGIN, session_request


def main() -> None:
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    summary_path = ARTIFACT_DIRECTORY / "playground.json"
    with httpx.Client(
        base_url=API_URL + "/api/", headers={"Origin": WEB_ORIGIN}
    ) as session:
        session_request(session, "POST", "auth/dev-login", json={})
        if summary_path.exists():
            summary = json.loads(summary_path.read_text())
            projects = session_request(session, "GET", "projects")["items"]
            if not any(project["id"] == summary["projectId"] for project in projects):
                raise SystemExit("The saved Playground project is unavailable")
            print("Existing Playground project is ready")
            return
        project = session_request(
            session,
            "POST",
            "projects",
            json={
                "name": "Playground "
                + datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d"),
                "description": "コード編集・テスト・学習・推論をCPUで試す開発用サンプル",
                "artifactBackend": "filesystem",
            },
        )
        experiment = session_request(
            session,
            "POST",
            f"projects/{project['id']}/experiments",
            json={"name": "サンプル実験"},
        )
        summary = {"projectId": project["id"], "experimentId": experiment["id"]}
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        print("Playground project created: " + project["id"])


if __name__ == "__main__":
    main()
