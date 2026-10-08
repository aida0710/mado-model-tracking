"""Thin end-to-end smoke of the automated pipeline on an isolated API and a local CPU worker.

training Task -> Task output registration -> inference rule (model_registered) -> evaluation rule
(upstream_run_finished) reading the inference WAVs -> promotion policy decision; plus a failed
training whose pending downstream must be skipped. Each stage's result and duration go to
artifacts/verification/<JST date>/pipeline-smoke/pipeline-smoke.json.

The API is a fresh test schema in MMT_TEST_DATABASE_URL (scripts/serve_mlflow_verification.ts),
never the running development API/DB. The schema is dropped when the script stops the API.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from mado_tracking.code_version import build_code_version_payload
from mado_tracking.settings import ApiSettings
from mado_tracking.worker import cli as worker_cli
from mado_tracking.worker.config import WorkerSettings

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "python/examples"
JST = ZoneInfo("Asia/Tokyo")
# Verification servers of this package use 47150-47159 only; the running API is 4182.
DEFAULT_API_PORT = 47150
API_PORT = int(os.environ.get("MMT_VERIFY_SMOKE_API_PORT", DEFAULT_API_PORT))
API_URL = f"http://127.0.0.1:{API_PORT}"
# The API checks Origin on cookie requests; this is only a header, nothing connects to the Web.
WEB_ORIGIN = "http://127.0.0.1:5182"
# Migrations on a fresh schema take a few seconds; tsx compiles the API on first start.
API_START_SECONDS = 90
# Each Job creates a venv and installs httpx before running the example.
JOB_DEADLINE_SECONDS = 180
WORKER_IDLE_SECONDS = 0.2
OUTPUT_DIRECTORY = ROOT / "artifacts/verification" / datetime.now(JST).strftime("%Y-%m-%d") / "pipeline-smoke"
WORK_DIRECTORY = ROOT / "var/verification-pipeline-smoke" / datetime.now(JST).strftime("%Y%m%d-%H%M%S")
MODEL_FAMILY = "linear"
# inference.py's default inputs and the true line y = 2x + 1 the training data follows.
INFERENCE_VALUES = (0.0, 1.0, 2.0)
SECONDS_PER_PREDICTION_UNIT = 0.1
TERMINAL_STATUSES = {"finished", "failed", "canceled"}

# Smoke-only entry points. Registration is left to the Task so the Task-side registration is what
# starts the pipeline; the probe proves the Job token cannot write to another Run.
TASK_TRAINING_ENTRY = '''"""Smoke entry: training.py's loop; the Task's outputModel registers the version."""
import json
import os
from pathlib import Path

import training
from mado_tracking import ApiError, start_run
from mado_tracking.timestamps import utc_timestamp


class TaskRegisteredRun:
    """Log through the Job's Run, but leave the output model to the Task."""

    def __init__(self, run):
        self.run = run

    def log_metrics(self, metrics, *, step=0):
        self.run.log_metrics(metrics, step=step)

    def log_artifact(self, source, *, path=None, mime_type=None):
        return self.run.log_artifact(source, path=path, mime_type=mime_type)

    def register_output_model(self, **_attributes):
        return {}


def probe_foreign_run(run, foreign_run_id):
    path = run.client.project_path(run.project_id, f"runs/{foreign_run_id}/metrics")
    point = {"name": "smoke.probe", "value": 1.0, "step": 0, "timestamp": utc_timestamp()}
    try:
        run.client.request("POST", path, json={"metrics": [point]})
        outcome = "status=accepted"
    except ApiError as error:
        outcome = f"status={error.status_code} code={error.code}"
    print(f"job-token-probe {outcome}", flush=True)


parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
with start_run(kind="training") as run:
    probe_foreign_run(run, parameters["jobTokenProbeRunId"])
    training.train(
        steps=int(parameters["steps"]),
        learning_rate=float(parameters["learning_rate"]),
        output=Path("outputs/weights.json"),
        initial_weight=0.0,
        initial_bias=0.0,
        run=TaskRegisteredRun(run),
    )
'''
FAILING_TRAINING_ENTRY = '''"""Smoke entry: train and register like training.py, then fail."""
import runpy
import sys

runpy.run_path("training.py", run_name="__main__")
print("smoke-training-fails-after-registration", flush=True)
sys.exit(3)
'''


class StageFailure(AssertionError):
    pass


def expect(condition: object, message: str) -> None:
    if not condition:
        raise StageFailure(message)


@dataclass
class StageRecorder:
    stages: list[dict[str, Any]] = field(default_factory=list)

    @contextmanager
    def stage(self, name: str, description: str) -> Iterator[dict[str, Any]]:
        details: dict[str, Any] = {}
        record: dict[str, Any] = {"name": name, "description": description, "details": details}
        self.stages.append(record)
        started = time.monotonic()
        try:
            yield details
        except BaseException as error:
            record.update(status="failed", error=f"{type(error).__name__}: {error}")
            record["traceback"] = traceback.format_exc(limit=6)
            raise
        else:
            record["status"] = "passed"
        finally:
            record["seconds"] = round(time.monotonic() - started, 3)

    def skip(self, name: str, description: str, reason: str) -> None:
        self.stages.append({"name": name, "description": description, "status": "not_run", "reason": reason})

    @property
    def passed(self) -> bool:
        return all(stage["status"] == "passed" for stage in self.stages)


class ProjectApi:
    """Cookie session of the development login (global admin) scoped to one Project."""

    def __init__(self, session: httpx.Client, project_id: str):
        self.session = session
        self.project_id = project_id

    def request(self, method: str, resource: str, **options: Any) -> Any:
        return api_request(self.session, method, f"projects/{self.project_id}/{resource}", **options)

    def get(self, resource: str, **options: Any) -> Any:
        return self.request("GET", resource, **options)

    def post(self, resource: str, body: dict[str, Any]) -> Any:
        return self.request("POST", resource, json=body)

    def run(self, run_id: str) -> dict[str, Any]:
        return self.get(f"runs/{run_id}")

    def executions(self, rule_id: str) -> list[dict[str, Any]]:
        return [item for item in self.get("automation-executions")["items"] if item["ruleId"] == rule_id]

    def latest_metrics(self, run_id: str) -> dict[str, float]:
        latest: dict[str, float] = {}
        for point in sorted(self.get(f"runs/{run_id}/metrics")["items"], key=lambda point: point["step"]):
            latest[point["name"]] = point["value"]
        return latest

    def artifact_paths(self, run_id: str) -> list[str]:
        listing = self.get(f"runs/{run_id}/artifacts", params={"versions": "latest", "limit": "500"})
        return sorted(artifact["path"] for artifact in listing["items"])

    def log_messages(self, run_id: str) -> list[str]:
        return [entry["message"] for entry in self.get(f"runs/{run_id}/logs")["items"]]


def api_request(session: httpx.Client, method: str, path: str, **options: Any) -> Any:
    response = session.request(method, path, **options)
    if not response.is_success:
        raise StageFailure(f"{method} {path} failed with HTTP {response.status_code}: {response.text}")
    return response.json() if response.content else None


@dataclass
class Pipeline:
    api: ProjectApi
    worker: WorkerSettings
    experiment_id: str
    target_id: str
    ids: dict[str, str] = field(default_factory=dict)


async def run_worker_until(settings: WorkerSettings, finished: Callable[[], bool], waiting_for: str) -> None:
    """Run the worker with --once semantics (recover or claim one Job) until finished() holds."""
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        await worker_cli.run(settings, once=True)
        if finished():
            return
        await asyncio.sleep(WORKER_IDLE_SECONDS)
    raise StageFailure(f"Timed out after {JOB_DEADLINE_SECONDS}s waiting for {waiting_for}")


async def run_job_of(pipeline: Pipeline, run_id: str) -> dict[str, Any]:
    await run_worker_until(
        pipeline.worker,
        lambda: pipeline.api.run(run_id)["status"] in TERMINAL_STATUSES,
        f"Run {run_id} to end",
    )
    return pipeline.api.run(run_id)


def reference_samples() -> list[dict[str, Any]]:
    """Expected WAV lengths for inference.py's inputs on the true line y = 2x + 1."""
    return [
        {
            "audio": f"sample-{index:03d}.wav",
            "durationSeconds": round((2 * x + 1) * SECONDS_PER_PREDICTION_UNIT, 6),
        }
        for index, x in enumerate(INFERENCE_VALUES)
    ]


def register_code(
    api: ProjectApi, *, name: str, files: dict[str, str], entrypoint: list[str], task_type: str
):
    code = api.post("codes", {"name": name, "description": "pipeline smoke"})
    return api.post(
        f"codes/{code['id']}/versions",
        build_code_version_payload(
            version="v1",
            source={"kind": "inline", "files": files},
            entrypoint=entrypoint,
            test_entrypoint=[],
            runtime=None,
            requirements=[],
            environment=None,
            supported_model_families=[MODEL_FAMILY],
            task_types=[task_type],
        ),
    )


def set_up(pipeline: Pipeline, details: dict[str, Any]) -> None:
    api, ids = pipeline.api, pipeline.ids
    training_source = (EXAMPLES / "training.py").read_text()
    ids["trainingCodeVersionId"] = register_code(
        api,
        name="Smoke training",
        files={"training.py": training_source, "smoke_training.py": TASK_TRAINING_ENTRY},
        entrypoint=["python", "smoke_training.py"],
        task_type="training",
    )["id"]
    ids["failingTrainingCodeVersionId"] = register_code(
        api,
        name="Smoke failing training",
        files={"training.py": training_source, "failing_training.py": FAILING_TRAINING_ENTRY},
        entrypoint=["python", "failing_training.py"],
        task_type="training",
    )["id"]
    ids["inferenceCodeVersionId"] = register_code(
        api,
        name="Smoke inference",
        files={"inference.py": (EXAMPLES / "inference.py").read_text()},
        entrypoint=["python", "inference.py"],
        task_type="inference",
    )["id"]
    ids["evaluationCodeVersionId"] = register_code(
        api,
        name="Smoke evaluation",
        files={"evaluation.py": (EXAMPLES / "evaluation.py").read_text()},
        entrypoint=["python", "evaluation.py"],
        task_type="evaluation",
    )["id"]
    samples = reference_samples()
    reference_dataset = api.post("datasets", {"name": "Smoke reference lengths", "namespace": "verification"})
    ids["referenceDatasetVersionId"] = api.post(
        f"datasets/{reference_dataset['id']}/versions",
        {
            "version": "v1",
            "uri": "urn:mmt:verification:pipeline-smoke-reference",
            "digest": "sha256:" + hashlib.sha256(json.dumps(samples).encode()).hexdigest(),
            "schema": {"audio": "string", "durationSeconds": "number"},
            "metadata": {"samples": samples},
        },
    )["id"]
    # The Job token may add versions to a Dataset but not create one, so the inference rule names it.
    ids["inferenceOutputDatasetId"] = api.post(
        "datasets", {"name": "Smoke inference outputs", "namespace": "verification"}
    )["id"]
    ids["modelId"] = api.post("models", {"name": "smoke-linear", "family": MODEL_FAMILY, "description": ""})[
        "id"
    ]
    common_rule = {
        "modelFamilies": [MODEL_FAMILY],
        "experimentId": pipeline.experiment_id,
        "targetId": pipeline.target_id,
    }
    ids["inferenceRuleId"] = api.post(
        "automation-rules",
        {
            **common_rule,
            "name": "Smoke inference on registration",
            "kind": "inference",
            "codeVersionId": ids["inferenceCodeVersionId"],
            "trigger": "model_registered",
            "parameters": {"outputDatasetId": ids["inferenceOutputDatasetId"]},
            "maxAttempts": 1,
        },
    )["id"]
    ids["evaluationRuleId"] = api.post(
        "automation-rules",
        {
            **common_rule,
            "name": "Smoke evaluation after inference",
            "kind": "evaluation",
            "codeVersionId": ids["evaluationCodeVersionId"],
            "trigger": "upstream_run_finished",
            "upstreamRuleId": ids["inferenceRuleId"],
            "inputDatasetVersionIds": [ids["referenceDatasetVersionId"]],
            "maxAttempts": 1,
        },
    )["id"]
    ids["promotionPolicyId"] = api.post(
        "promotion-policies",
        {
            "name": "Smoke promotion gate",
            "modelId": ids["modelId"],
            "targetAlias": "staging",
            "evaluationRuleId": ids["evaluationRuleId"],
            "criteria": [
                {
                    "metric": "evaluation.duration_match_rate",
                    "direction": "higher",
                    "mode": "absolute",
                    "threshold": 0.99,
                },
                {
                    "metric": "evaluation.duration_mean_abs_error_seconds",
                    "direction": "lower",
                    "mode": "delta",
                    "threshold": 0.0,
                },
            ],
        },
    )["id"]
    # A Run the training Job's token must not be able to write to.
    ids["foreignRunId"] = api.post(
        "runs",
        {"experimentId": pipeline.experiment_id, "name": "Job token probe target", "kind": "processing"},
    )["id"]
    task_output = {
        "modelId": ids["modelId"],
        "createModel": None,
        "artifactPath": "model/weights.json",
        "metadata": {},
    }
    for key, name, code_version in (
        ("taskId", "Smoke training", ids["trainingCodeVersionId"]),
        ("failingTaskId", "Smoke failing training", ids["failingTrainingCodeVersionId"]),
    ):
        ids[key] = api.post(
            "tasks",
            {
                "experimentId": pipeline.experiment_id,
                "name": name,
                "kind": "training",
                "codeVersionId": code_version,
                "parameters": {"steps": 40, "learning_rate": 0.1, "jobTokenProbeRunId": ids["foreignRunId"]},
                "targetId": pipeline.target_id,
                "outputModel": task_output,
            },
        )["id"]
    details.update(ids)


def launch_task(api: ProjectApi, task_id: str) -> str:
    task = api.get(f"tasks/{task_id}")
    launched = api.post(
        f"tasks/{task_id}/launch", {"expectedRevision": task["revision"], "executionMode": "run"}
    )
    return launched["run"]["id"]


async def verify_training(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = pipeline.ids["trainingRunId"] = launch_task(pipeline.api, pipeline.ids["taskId"])
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"])
    expect(run["status"] == "finished", f"training Run ended {run['status']}")
    losses = [
        point["value"]
        for point in pipeline.api.get(f"runs/{run_id}/metrics")["items"]
        if point["name"] == "train.loss"
    ]
    details["trainLoss"] = {
        "first": losses[0] if losses else None,
        "last": losses[-1] if losses else None,
        "points": len(losses),
    }
    expect(len(losses) == 40 and losses[-1] < losses[0], "train.loss was not recorded or did not decrease")
    expect("model/weights.json" in pipeline.api.artifact_paths(run_id), "model/weights.json was not saved")


def verify_job_token_scope(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id, foreign_run_id = pipeline.ids["trainingRunId"], pipeline.ids["foreignRunId"]
    probes = [message for message in pipeline.api.log_messages(run_id) if "job-token-probe" in message]
    details.update(probeLog=probes, foreignRunId=foreign_run_id)
    expect(
        probes and "status=403 code=job_token_forbidden" in probes[0],
        "Job token wrote to or reached another Run",
    )
    foreign_metrics = pipeline.api.get(f"runs/{foreign_run_id}/metrics")["items"]
    details["foreignRunMetricCount"] = len(foreign_metrics)
    expect(not foreign_metrics, "the foreign Run received a metric")


def verify_output_registration(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = pipeline.ids["trainingRunId"]
    registration = pipeline.api.get(f"runs/{run_id}/output-registration")
    details["registration"] = registration
    expect(registration["status"] == "registered", f"Task output registration is {registration['status']}")
    version_id = pipeline.ids["modelVersionId"] = registration["modelVersionId"]
    versions = pipeline.api.get(f"models/{pipeline.ids['modelId']}/versions")["items"]
    version = next((item for item in versions if item["id"] == version_id), None)
    expect(version is not None, "the registered version is not in the Task's Model")
    details.update(
        version=version["version"], sourceRunId=version["sourceRunId"], artifactId=version["artifactId"]
    )
    expect(version["sourceRunId"] == run_id, "the version does not point to the training Run")
    expect(version["artifactId"], "the version has no weights Artifact")
    expect(
        version_id in pipeline.api.run(run_id)["outputModelVersionIds"], "the Run does not list the version"
    )


async def verify_inference(pipeline: Pipeline, details: dict[str, Any]) -> None:
    executions = [
        execution
        for execution in pipeline.api.executions(pipeline.ids["inferenceRuleId"])
        if execution["modelVersionId"] == pipeline.ids["modelVersionId"]
    ]
    details["executions"] = [
        {key: execution[key] for key in ("id", "status", "runId", "error")} for execution in executions
    ]
    expect(
        len(executions) == 1 and executions[0]["status"] == "queued", "the inference rule did not start once"
    )
    run_id = pipeline.ids["inferenceRunId"] = executions[0]["runId"]
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"], outputDatasetVersionIds=run["outputDatasetVersionIds"])
    expect(run["status"] == "finished", f"inference Run ended {run['status']}")
    expect(run["modelVersionId"] == pipeline.ids["modelVersionId"], "inference ran on another version")
    expect(len(run["outputDatasetVersionIds"]) == 1, "inference did not register one output DatasetVersion")
    audio = [path for path in pipeline.api.artifact_paths(run_id) if path.startswith("inference/audio/")]
    details["audioArtifacts"] = audio
    expect(len(audio) == len(INFERENCE_VALUES), "inference did not save one WAV per input")


async def verify_evaluation(pipeline: Pipeline, details: dict[str, Any]) -> None:
    inference_run = pipeline.api.run(pipeline.ids["inferenceRunId"])
    executions = [
        execution
        for execution in pipeline.api.executions(pipeline.ids["evaluationRuleId"])
        if execution["triggerRunId"] == inference_run["id"]
    ]
    details["executions"] = [
        {key: execution[key] for key in ("id", "status", "runId", "error", "pipelineRootExecutionId")}
        for execution in executions
    ]
    expect(
        len(executions) == 1 and executions[0]["status"] == "queued",
        "the chained evaluation did not start once",
    )
    run_id = pipeline.ids["evaluationRunId"] = executions[0]["runId"]
    queued = pipeline.api.run(run_id)
    details.update(
        parentRunId=queued["parentRunId"],
        upstreamDatasetVersionIds=queued["upstreamDatasetVersionIds"],
        inputDatasetVersionIds=queued["inputDatasetVersionIds"],
    )
    expect(
        queued["parentRunId"] == inference_run["id"], "the evaluation Run's parent is not the inference Run"
    )
    expect(
        queued["upstreamDatasetVersionIds"] == inference_run["outputDatasetVersionIds"],
        "upstreamDatasetVersionIds is not the inference output",
    )
    expect(
        set(queued["inputDatasetVersionIds"])
        == {pipeline.ids["referenceDatasetVersionId"], *inference_run["outputDatasetVersionIds"]},
        "inputs are not the reference set plus the inference output",
    )
    run = await run_job_of(pipeline, run_id)
    details["status"] = run["status"]
    expect(run["status"] == "finished", f"evaluation Run ended {run['status']}")
    metrics = pipeline.api.latest_metrics(run_id)
    details["metrics"] = {name: value for name, value in metrics.items() if name.startswith("evaluation.")}
    expect(
        metrics.get("evaluation.samples") == len(INFERENCE_VALUES),
        "evaluation did not score every reference sample",
    )
    expect("evaluation.duration_match_rate" in metrics, "evaluation.duration_match_rate was not recorded")
    expect("eval/results.jsonl" in pipeline.api.artifact_paths(run_id), "eval/results.jsonl was not saved")
    upstream_logs = [message for message in pipeline.api.log_messages(run_id) if "upstreamRunId" in message]
    details["upstreamLog"] = upstream_logs
    expect(
        any(inference_run["id"] in message for message in upstream_logs),
        "the evaluation code did not read MMT_UPSTREAM_RUN_ID",
    )


def verify_promotion(pipeline: Pipeline, details: dict[str, Any]) -> None:
    evaluations = pipeline.api.get(
        "promotion-evaluations", params={"policyId": pipeline.ids["promotionPolicyId"]}
    )["items"]
    details["evaluations"] = [
        {
            key: item[key]
            for key in ("id", "decision", "reason", "candidateRunId", "candidateVersionId", "promoted")
        }
        | {
            "criteria": [
                {key: result[key] for key in ("metric", "mode", "observed", "outcome", "reason")}
                for result in item["criteriaResults"]
            ]
        }
        for item in evaluations
    ]
    expect(len(evaluations) == 1, f"expected one promotion decision, found {len(evaluations)}")
    (evaluation,) = evaluations
    expect(evaluation["candidateRunId"] == pipeline.ids["evaluationRunId"], "the decision is for another Run")
    expect(
        evaluation["candidateVersionId"] == pipeline.ids["modelVersionId"],
        "the decision is for another version",
    )
    expect(
        evaluation["decision"] == "passed", f"decision is {evaluation['decision']} ({evaluation['reason']})"
    )
    expect(evaluation["reason"] == "baseline_missing_first_promotion", f"reason is {evaluation['reason']}")


async def verify_failed_training(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = launch_task(pipeline.api, pipeline.ids["failingTaskId"])
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"], outputModelVersionIds=run["outputModelVersionIds"])
    expect(run["status"] == "failed", f"failing training ended {run['status']}")
    expect(
        len(run["outputModelVersionIds"]) == 1, "the failing training did not register its version in the Run"
    )
    (version_id,) = run["outputModelVersionIds"]
    registration = pipeline.api.session.get(
        f"projects/{pipeline.api.project_id}/runs/{run_id}/output-registration"
    )
    details["taskRegistrationHttpStatus"] = registration.status_code
    expect(registration.status_code == 404, "the Task registered an output for a failed Run")
    executions = [
        execution
        for execution in pipeline.api.executions(pipeline.ids["inferenceRuleId"])
        if execution["modelVersionId"] == version_id
    ]
    details["executions"] = [
        {key: execution[key] for key in ("id", "status", "runId", "error")} for execution in executions
    ]
    expect(len(executions) == 1, "the pending version produced no or several inference executions")
    expect(
        executions[0]["status"] == "skipped" and executions[0]["runId"] is None, "inference was not skipped"
    )
    expect(
        (executions[0]["error"] or "").startswith("source_run_unsuccessful"),
        "the skip reason is not source_run_unsuccessful",
    )


async def verify_pipeline(pipeline: Pipeline, recorder: StageRecorder) -> None:
    stages = [
        ("training", "学習TaskをlaunchしworkerでRunがfinishedになる", verify_training),
        (
            "job_token_scope",
            "学習JobのJob tokenで別のRunへmetricsを書くと403 job_token_forbidden",
            verify_job_token_scope,
        ),
        ("output_registration", "Taskの出力モデル設定で版が自動登録される", verify_output_registration),
        ("inference", "推論rule（model_registered）が起動し、WAVと出力Datasetを残す", verify_inference),
        ("evaluation", "評価rule（upstream_run_finished）が推論の出力と上流Runで評価する", verify_evaluation),
        ("promotion", "昇格policyの判定が1件（基準なしの初回合格）", verify_promotion),
    ]
    for index, (name, description, verify) in enumerate(stages):
        try:
            with recorder.stage(name, description) as details:
                outcome = verify(pipeline, details)
                if asyncio.iscoroutine(outcome):
                    await outcome
        except Exception:
            for skipped_name, skipped_description, _verify in stages[index + 1 :]:
                recorder.skip(skipped_name, skipped_description, f"{name} failed")
            break
    # Independent of the success path: it uses its own Task and version.
    try:
        with recorder.stage(
            "failed_training_skips_downstream",
            "学習がfailedなら保留中の版の推論はskipped（source_run_unsuccessful）",
        ) as details:
            await verify_failed_training(pipeline, details)
    except Exception:
        pass  # The recorder already holds the failure; the JSON is the report.


@contextmanager
def isolated_api(log_path: Path) -> Iterator[None]:
    if not os.environ.get("MMT_TEST_DATABASE_URL"):
        raise SystemExit("MMT_TEST_DATABASE_URL (the dedicated loopback mmt_test DB) is required")
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", API_PORT)) == 0:
            raise SystemExit(f"Port {API_PORT} is already in use")
    environment = {**os.environ, "MMT_VERIFY_API_PORT": str(API_PORT)}
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
            deadline = time.monotonic() + API_START_SECONDS
            while True:
                if server.poll() is not None:
                    raise SystemExit(f"The isolated API exited early; see {log_path}")
                try:
                    if httpx.get(f"{API_URL}/api/health", timeout=2).is_success:
                        break
                except httpx.TransportError:
                    pass
                if time.monotonic() > deadline:
                    raise SystemExit(f"The isolated API did not start within {API_START_SECONDS}s")
                time.sleep(0.5)
            yield
        finally:
            # SIGTERM lets the harness drop its test schema.
            server.send_signal(signal.SIGTERM)
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()


def create_project(session: httpx.Client) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    api_request(session, "POST", "auth/dev-login", json={})
    project = api_request(
        session,
        "POST",
        "projects",
        json={
            "name": "Pipeline smoke " + datetime.now(JST).strftime("%H:%M:%S"),
            "description": "学習→自動登録→推論→評価→昇格判定の薄い通し確認",
            "artifactBackend": "filesystem",
        },
    )
    target = api_request(
        session,
        "POST",
        "targets",
        json={
            "name": "Smoke CPU " + project["id"][:8],
            "host": "127.0.0.1",
            "port": 22,
            "username": "local",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": str(WORK_DIRECTORY / "jobs"),
            "pythonExecutable": os.environ.get("MMT_VERIFY_PYTHON", sys.executable),
            "gpuIds": [],
            "maxConcurrentJobs": 1,
            "enabled": True,
            "executor": "local",
        },
    )
    experiment = api_request(
        session,
        "POST",
        f"projects/{project['id']}/experiments",
        json={"name": "Pipeline smoke", "description": ""},
    )
    return project, target, experiment


def issue_worker_token(session: httpx.Client, project_id: str) -> dict[str, Any]:
    return api_request(
        session,
        "POST",
        "tokens",
        json={
            "name": "Pipeline smoke worker",
            "kind": "service",
            "projectId": project_id,
            # registry:write lets the worker declare outputs; the Job's code gets a Job token.
            "scopes": [
                "read",
                "runs:write",
                "registry:write",
                "artifacts:write",
                "jobs:write",
                "worker:execute",
            ],
            "expiresAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        },
    )


def main() -> int:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    WORK_DIRECTORY.mkdir(parents=True, exist_ok=True)
    recorder = StageRecorder()
    summary: dict[str, Any] = {
        "startedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "api": f"isolated test schema on 127.0.0.1:{API_PORT}",
        "outOfScope": ["実SSH", "GPU", "実SSO（Authentik）", "実S3", "コンテナruntime（Docker/SIF）"],
        "stages": recorder.stages,
    }
    with (
        isolated_api(OUTPUT_DIRECTORY / "api.log"),
        httpx.Client(base_url=f"{API_URL}/api/", headers={"Origin": WEB_ORIGIN}, timeout=30) as session,
    ):
        try:
            with recorder.stage(
                "setup", "Project・target・コード版・正解セット・rule・policy・Taskの登録"
            ) as details:
                project, target, experiment = create_project(session)
                issued = issue_worker_token(session, project["id"])
                pipeline = Pipeline(
                    api=ProjectApi(session, project["id"]),
                    worker=WorkerSettings(
                        api=ApiSettings.from_environment(url=API_URL, token=issued["token"]),
                        worker_id=f"pipeline-smoke-{project['id'][:8]}",
                        target_ids=(target["id"],),
                        state_directory=WORK_DIRECTORY / "state",
                        allow_local_executor=True,
                        heartbeat_seconds=0.2,
                        poll_seconds=0.1,
                        telemetry_seconds=1,
                        cancel_grace_seconds=0.5,
                        parallel_jobs=1,
                    ),
                    experiment_id=experiment["id"],
                    target_id=target["id"],
                )
                set_up(pipeline, details)
            asyncio.run(verify_pipeline(pipeline, recorder))
        except Exception:
            pass  # A failed setup is recorded as its stage; no later stage can run without it.
    summary.update(
        finishedAt=datetime.now(JST).isoformat(timespec="seconds"),
        result="passed" if recorder.passed else "failed",
    )
    output = OUTPUT_DIRECTORY / "pipeline-smoke.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    for stage in recorder.stages:
        print(f"{stage['status']:>8}  {stage.get('seconds', '-'):>8}  {stage['name']}")
    print(f"{summary['result']}: {output.relative_to(ROOT)}")
    return 0 if recorder.passed else 1


if __name__ == "__main__":
    sys.exit(main())
