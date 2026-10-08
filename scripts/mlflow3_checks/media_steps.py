"""Check that official MLflow 3 log_image(key=, step=) and log_table appear in the native media API.

Standalone: logs to Mado Model Tracking's MLflow API (dev login, temporary project token revoked at
the end), then reads the Run back through GET /runs/:r/media and the table API. Run it once with
MLflow 3.0.0 ('%' file names) and once with 3.17.0 ('+' file names).

    python scripts/mlflow3_checks/media_steps.py --mado-api-url http://127.0.0.1:47080
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ["MLFLOW_HTTP_REQUEST_MAX_RETRIES"] = "0"
os.environ["MLFLOW_DISABLE_AGENT_HINT"] = "1"
os.environ["MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING"] = "false"

# MLflow reads these variables at import time, so the imports follow the environment setup.
import httpx  # noqa: E402
import mlflow  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
# No "/": MLflow 3.0 turns it into "#" and sends that unescaped, so the server only sees "images/<prefix>".
IMAGE_KEY = "eval_mel"
LOGGED_STEPS = [0, 5, 10]
TABLE_FILE = "tables/eval.json"
TABLE_ROWS = 2
TOKEN_LIFETIME = timedelta(hours=1)
HTTP_TIMEOUT_SECONDS = 30
# Same default as the API's MMT_WEB_ORIGIN; only sent as a header, never connected to.
DEFAULT_WEB_ORIGIN = "http://127.0.0.1:5182"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--mado-api-url", required=True, help="Mado Model Tracking API origin")
    parser.add_argument(
        "--web-origin",
        default=DEFAULT_WEB_ORIGIN,
        help="Origin header for the session API's CSRF check (the API's MMT_WEB_ORIGIN)",
    )
    parser.add_argument("--output", type=Path, help="Result JSON path")
    return parser.parse_args()


def default_output_path() -> Path:
    date = datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")
    return ROOT / "artifacts/verification" / date / "media-steps" / f"mlflow-{mlflow.__version__}.json"


def expect_success(response: httpx.Response) -> dict:
    if not response.is_success:
        raise AssertionError(
            f"{response.request.method} {response.request.url.path}: HTTP {response.status_code}"
        )
    return response.json() if response.content else {}


def gradient_image(step: int) -> np.ndarray:
    row = ((np.arange(32) * 8 + step) % 256).astype(np.uint8)
    return np.stack([np.tile(row, (32, 1))] * 3, axis=-1)


def log_media_run(experiment_name: str) -> str:
    mlflow.set_experiment(experiment_name)
    with mlflow.start_run(run_name="media steps") as run:
        for step in LOGGED_STEPS:
            mlflow.log_image(gradient_image(step), key=IMAGE_KEY, step=step)
        table = pd.DataFrame(
            {
                "name": [f"sample-{index}" for index in range(TABLE_ROWS)],
                "image": [Image.fromarray(gradient_image(index)) for index in range(TABLE_ROWS)],
            }
        )
        mlflow.log_table(table, artifact_file=TABLE_FILE)
    return run.info.run_id


def read_media(session: httpx.Client, *, project_id: str, run_id: str) -> dict[str, object]:
    base = f"projects/{project_id}/runs/{run_id}/media"
    images = expect_success(session.get(base, params={"key": IMAGE_KEY}))["items"]
    tables = expect_success(session.get(base, params={"kind": "table"}))["items"]
    table_page = (
        expect_success(session.get(f"{base}/{tables[0]['id']}/table", params={"limit": TABLE_ROWS}))
        if tables
        else None
    )
    return {"images": images, "tables": tables, "tablePage": table_page}


def failures_of(media: dict[str, object]) -> list[str]:
    images, tables, table_page = media["images"], media["tables"], media["tablePage"]
    assert isinstance(images, list) and isinstance(tables, list)
    failures = []
    steps = [item["step"] for item in images]
    if steps != LOGGED_STEPS:
        failures.append(f"image steps {steps} != {LOGGED_STEPS}")
    if any(item["source"] != "mlflow" or item["thumbnailArtifactId"] is None for item in images):
        failures.append("an image has no MLflow source or no compressed thumbnail")
    if [item["key"] for item in tables] != [TABLE_FILE]:
        failures.append(f"tables {[item['key'] for item in tables]} != [{TABLE_FILE}]")
    if not isinstance(table_page, dict):
        failures.append("the table page was not read")
        return failures
    columns = {column["name"]: column["type"] for column in table_page["columns"]}
    if columns.get("image") != "image":
        failures.append(f"image column type is {columns.get('image')}")
    image_index = (
        [column["name"] for column in table_page["columns"]].index("image") if "image" in columns else -1
    )
    for row in table_page["rows"]:
        cell = row[image_index] if image_index >= 0 else None
        if (
            not isinstance(cell, dict)
            or cell.get("artifactId") is None
            or cell.get("thumbnailArtifactId") is None
        ):
            failures.append(f"image cell not resolved: {cell}")
    return failures


def main() -> int:
    arguments = parse_arguments()
    api_url = arguments.mado_api_url.rstrip("/")
    with httpx.Client(
        base_url=f"{api_url}/api/", headers={"Origin": arguments.web_origin}, timeout=HTTP_TIMEOUT_SECONDS
    ) as session:
        expect_success(session.post("auth/dev-login", json={}))
        project = expect_success(
            session.post(
                "projects",
                json={"name": f"Media steps check {time.time_ns()}", "artifactBackend": "filesystem"},
            )
        )
        expires_at = (datetime.now(UTC) + TOKEN_LIFETIME).isoformat().replace("+00:00", "Z")
        issued = expect_success(
            session.post(
                "tokens",
                json={
                    "name": "Temporary media steps check",
                    "kind": "service",
                    "projectId": project["id"],
                    "scopes": ["read", "runs:write", "artifacts:write"],
                    "expiresAt": expires_at,
                },
            )
        )
        try:
            os.environ["MLFLOW_TRACKING_TOKEN"] = issued["token"]
            mlflow.set_tracking_uri(f"{api_url}/api/mlflow/projects/{project['id']}")
            run_id = log_media_run(f"media-steps-{time.time_ns()}")
            media = read_media(session, project_id=project["id"], run_id=run_id)
        finally:
            os.environ.pop("MLFLOW_TRACKING_TOKEN", None)
            expect_success(session.delete(f"tokens/{issued['item']['id']}"))
    failures = failures_of(media)
    summary = {
        "mlflowVersion": mlflow.__version__,
        "checkedAt": datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(),
        "projectId": project["id"],
        "runId": run_id,
        "imagePaths": [item["path"] for item in media["images"]],  # type: ignore[union-attr]
        **media,
        "failures": failures,
        "passed": not failures,
    }
    output = arguments.output or default_output_path()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "passed": summary["passed"], "failures": failures}))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
