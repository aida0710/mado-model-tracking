"""End-to-end check of the automated pipeline on an isolated API and a local CPU worker.

training Task -> Task output registration -> inference rule (model_registered) -> evaluation rule
(upstream_run_finished) -> promotion policy decision -> automatic alias switch, then a second
training compared against the promoted baseline, a new evaluation rule applied by hand to the
baseline version, the SDK-free path (result.json declarations and a staged reference set), a
failed training whose downstream is skipped and, when Docker is available, a container inference
whose 1000 outputs travel in one archive. Rules and the policy belong to a Service Account after
their creator leaves the Project, and the worker runs with a Service Account token.

The API is a fresh test schema in MMT_TEST_DATABASE_URL (scripts/serve_mlflow_verification.ts),
never the running development API/DB. The schema is dropped when the script stops the API. Each
stage's result and duration go to artifacts/verification/<JST date>/pipeline/pipeline-integration.json.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
from collections import Counter
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from mado_tracking import Client, ExecutionRuntime
from mado_tracking.code_version import build_code_version_payload
from mado_tracking.settings import ApiSettings
from mado_tracking.worker import cli as worker_cli
from mado_tracking.worker.config import WorkerSettings
from mado_tracking.worker.output_archive import OUTPUT_ARCHIVE_COMMAND
from mado_tracking.worker.runtime import JobExecutor

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "python/examples"
JST = ZoneInfo("Asia/Tokyo")
# Verification servers started by agents use 47000-47009; the running API is 4182.
DEFAULT_API_PORT = 47001
# The API checks Origin on cookie requests; this is only a header, nothing connects to the Web.
WEB_ORIGIN = "http://127.0.0.1:5182"
# Migrations on a fresh schema take a few seconds; tsx compiles the API on first start.
API_START_SECONDS = 90
# Each Job creates a venv and installs httpx before running the example.
JOB_DEADLINE_SECONDS = 180
# 1000 container outputs are verified and uploaded one Artifact at a time after the archive.
CONTAINER_JOB_DEADLINE_SECONDS = 600
WORKER_IDLE_SECONDS = 0.2
TERMINAL_STATUSES = {"finished", "failed", "canceled"}
ADMIN_EMAIL = "admin@localhost"
OWNER_EMAIL = "pipeline-owner@example.test"

SDK_FAMILY = "linear"
# A second family keeps the result.json pipeline's rules away from the SDK pipeline's versions.
DECLARED_FAMILY = "linear-declared"
PROMOTION_ALIAS = "production"
# inference.py's default inputs and the true line y = 2x + 1 the training data follows.
INFERENCE_VALUES = (0.0, 1.0, 2.0)
SECONDS_PER_PREDICTION_UNIT = 0.1
TRAINING_STEPS = 40
# The second evaluation code version only tightens the length tolerance; it is a different version.
STRICT_TOLERANCE_SECONDS = "0.001"
CONTAINER_OUTPUT_FILES = 1000
# Digest-pinned so the check never pulls; override with an image already in the local Docker cache.
DEFAULT_CONTAINER_IMAGE = "alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"

# Runs the example given as the first argument after recording what the Job's token can do: its kind
# (GET /auth/token) and, when the parameters name a foreign Run, whether it may write a metric there.
JOB_ENTRY = '''"""Pipeline check entry: report the token's reach, then run the example unchanged."""
import json
import os
import runpy
import sys
from pathlib import Path

from mado_tracking import ApiError, Client
from mado_tracking.timestamps import utc_timestamp

with Client() as client:
    print(f"job-token job={client.request('GET', 'auth/token')['job']}", flush=True)
    parameters = json.loads(Path(os.environ["MMT_PARAMETERS_FILE"]).read_text())
    foreign_run_id = parameters.get("jobTokenProbeRunId")
    if foreign_run_id:
        path = client.project_path(os.environ["MMT_PROJECT_ID"], f"runs/{foreign_run_id}/metrics")
        point = {"name": "pipeline.probe", "value": 1.0, "step": 0, "timestamp": utc_timestamp()}
        try:
            client.request("POST", path, json={"metrics": [point]})
            outcome = "status=accepted"
        except ApiError as error:
            outcome = f"status={error.status_code} code={error.code}"
        print(f"job-token-probe {outcome}", flush=True)
example, *arguments = sys.argv[1:]
sys.argv = [example, *arguments]
runpy.run_path(example, run_name="__main__")
'''
FAILING_TRAINING_ENTRY = '''"""Pipeline check entry: train and register like training.py, then fail."""
import runpy
import sys

runpy.run_path("training.py", run_name="__main__")
print("pipeline-training-fails-after-registration", flush=True)
sys.exit(3)
'''
# Audio inference writes one file per utterance: the files are listed in a JSON Lines manifest and
# the index file is declared as the output DatasetVersion (result.json version 2). BusyBox only.
CONTAINER_INFERENCE_SCRIPT = r"""
set -eu
dataset_id="$1"
count="$2"
mkdir -p "$MMT_OUTPUTS_DIR/audio"
: > "$MMT_OUTPUTS_DIR/artifacts.partial"
: > "$MMT_OUTPUTS_DIR/index.partial"
i=0
while [ "$i" -lt "$count" ]; do
  path="audio/$i.wav"
  printf 'utterance-%s' "$i" > "$MMT_OUTPUTS_DIR/$path"
  checksum=$(sha256sum "$MMT_OUTPUTS_DIR/$path" | cut -d ' ' -f 1)
  size=$(wc -c < "$MMT_OUTPUTS_DIR/$path" | tr -d ' ')
  printf '{"path":"%s","sha256":"%s","size":%s,"mimeType":"audio/wav"}\n' \
    "$path" "$checksum" "$size" >> "$MMT_OUTPUTS_DIR/artifacts.partial"
  printf '{"audio":"%s"}\n' "$path" >> "$MMT_OUTPUTS_DIR/index.partial"
  i=$((i + 1))
done
mv "$MMT_OUTPUTS_DIR/artifacts.partial" "$MMT_OUTPUTS_DIR/artifacts.jsonl"
mv "$MMT_OUTPUTS_DIR/index.partial" "$MMT_OUTPUTS_DIR/index.jsonl"
checksum=$(sha256sum "$MMT_OUTPUTS_DIR/index.jsonl" | cut -d ' ' -f 1)
size=$(wc -c < "$MMT_OUTPUTS_DIR/index.jsonl" | tr -d ' ')
printf '{"version":2,"complete":true,"artifactsManifest":"artifacts.jsonl",'\
'"artifacts":[{"path":"index.jsonl","sha256":"%s","size":%s,"mimeType":"application/x-ndjson"}],'\
'"metrics":[{"name":"inference.outputs","value":%s,"step":0}],'\
'"datasets":[{"datasetId":"%s","path":"index.jsonl","digest":"sha256:%s"}]}' \
  "$checksum" "$size" "$count" "$dataset_id" "$checksum" > "$MMT_OUTPUTS_DIR/manifest.partial"
mv "$MMT_OUTPUTS_DIR/manifest.partial" "$MMT_RESULT_FILE"
"""


class StageFailure(AssertionError):
    pass


class StageNotRun(Exception):
    """The stage's precondition (for example Docker) is missing; recorded as not_run."""


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
        except StageNotRun as reason:
            record.update(status="not_run", reason=str(reason))
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
        # An optional stage without its environment (Docker) does not fail the check.
        return all(
            stage["status"] == "passed" or (stage["status"] == "not_run" and stage.get("optional"))
            for stage in self.stages
        )


class ProjectApi:
    """Cookie session of one development login, scoped to one Project."""

    def __init__(self, session: httpx.Client, project_id: str):
        self.session = session
        self.project_id = project_id

    def request(self, method: str, resource: str, **options: Any) -> Any:
        return api_request(self.session, method, f"projects/{self.project_id}/{resource}", **options)

    # Every resource this check reads or creates answers with a JSON object.
    def json_object(self, method: str, resource: str, **options: Any) -> dict[str, Any]:
        entity: dict[str, Any] = self.request(method, resource, **options)
        return entity

    def status_of(self, method: str, resource: str, **options: Any) -> int:
        """HTTP status of a request that is expected to be refused."""
        return self.session.request(method, f"projects/{self.project_id}/{resource}", **options).status_code

    def get(self, resource: str, **options: Any) -> dict[str, Any]:
        return self.json_object("GET", resource, **options)

    def post(self, resource: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.json_object("POST", resource, json=body)

    def put(self, resource: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.json_object("PUT", resource, json=body)

    def run(self, run_id: str) -> dict[str, Any]:
        return self.get(f"runs/{run_id}")

    def executions(self, rule_id: str) -> list[dict[str, Any]]:
        listing = self.get("automation-executions", params={"ruleId": rule_id, "limit": "200"})
        items: list[dict[str, Any]] = listing["items"]
        return items

    def latest_metrics(self, run_id: str) -> dict[str, float]:
        latest: dict[str, float] = {}
        for point in sorted(self.get(f"runs/{run_id}/metrics")["items"], key=lambda point: point["step"]):
            latest[point["name"]] = point["value"]
        return latest

    def artifact_paths(self, run_id: str, prefix: str = "") -> list[str]:
        paths: list[str] = []
        cursor: str | None = None
        while True:
            parameters = {"versions": "latest", "limit": "500", "prefix": prefix}
            if cursor:
                parameters["cursor"] = cursor
            listing = self.get(f"runs/{run_id}/artifacts", params=parameters)
            paths.extend(artifact["path"] for artifact in listing["items"])
            cursor = listing.get("nextCursor")
            if not cursor:
                return sorted(paths)

    def log_messages(self, run_id: str) -> list[str]:
        return [entry["message"] for entry in self.get(f"runs/{run_id}/logs")["items"]]


def api_request(session: httpx.Client, method: str, path: str, **options: Any) -> Any:
    response = session.request(method, path, **options)
    if not response.is_success:
        raise StageFailure(f"{method} {path} failed with HTTP {response.status_code}: {response.text}")
    return response.json() if response.content else None


@dataclass
class Pipeline:
    admin: ProjectApi
    owner: ProjectApi
    worker: WorkerSettings
    experiment_id: str
    target_id: str
    setup_token: str
    ids: dict[str, str] = field(default_factory=dict)


async def run_worker_until(
    settings: WorkerSettings,
    finished: Callable[[], bool],
    waiting_for: str,
    *,
    deadline_seconds: float = JOB_DEADLINE_SECONDS,
) -> None:
    """Run the worker with --once semantics (recover or claim one Job) until finished() holds."""
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        await worker_cli.run(settings, once=True)
        if finished():
            return
        await asyncio.sleep(WORKER_IDLE_SECONDS)
    raise StageFailure(f"Timed out after {deadline_seconds}s waiting for {waiting_for}")


async def run_jobs_of(pipeline: Pipeline, run_ids: list[str], **options: Any) -> list[dict[str, Any]]:
    await run_worker_until(
        pipeline.worker,
        lambda: all(pipeline.admin.run(run_id)["status"] in TERMINAL_STATUSES for run_id in run_ids),
        f"Runs {', '.join(run_ids)} to end",
        **options,
    )
    return [pipeline.admin.run(run_id) for run_id in run_ids]


async def run_job_of(pipeline: Pipeline, run_id: str, **options: Any) -> dict[str, Any]:
    (run,) = await run_jobs_of(pipeline, [run_id], **options)
    return run


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
    api: ProjectApi,
    *,
    name: str,
    files: dict[str, str] | None,
    entrypoint: list[str],
    task_type: str,
    families: list[str],
    version: str = "v1",
    runtime: ExecutionRuntime | None = None,
) -> dict[str, Any]:
    code = api.post("codes", {"name": name, "description": "pipeline verification"})
    return create_code_version(
        api,
        code_id=code["id"],
        version=version,
        files=files,
        entrypoint=entrypoint,
        task_type=task_type,
        families=families,
        runtime=runtime,
    )


def create_code_version(
    api: ProjectApi,
    *,
    code_id: str,
    version: str,
    files: dict[str, str] | None,
    entrypoint: list[str],
    task_type: str,
    families: list[str],
    runtime: ExecutionRuntime | None = None,
) -> dict[str, Any]:
    return api.post(
        f"codes/{code_id}/versions",
        build_code_version_payload(
            version=version,
            source={"kind": "inline", "files": files} if files is not None else None,
            entrypoint=entrypoint,
            test_entrypoint=[],
            runtime=runtime,
            requirements=[],
            environment=None,
            supported_model_families=families,
            task_types=[task_type],
        ),
    )


def job_entrypoint(example: str, *arguments: str) -> list[str]:
    return ["python", "pipeline_entry.py", example, *arguments]


def register_codes(pipeline: Pipeline) -> None:
    api, ids = pipeline.admin, pipeline.ids
    families = [SDK_FAMILY, DECLARED_FAMILY]
    training_source = (EXAMPLES / "training.py").read_text()
    ids["trainingCodeVersionId"] = register_code(
        api,
        name="Pipeline training",
        files={"training.py": training_source, "pipeline_entry.py": JOB_ENTRY},
        entrypoint=job_entrypoint("training.py"),
        task_type="training",
        families=families,
    )["id"]
    ids["failingTrainingCodeVersionId"] = register_code(
        api,
        name="Pipeline failing training",
        files={"training.py": training_source, "failing_training.py": FAILING_TRAINING_ENTRY},
        entrypoint=["python", "failing_training.py"],
        task_type="training",
        families=[SDK_FAMILY],
    )["id"]
    ids["inferenceCodeVersionId"] = register_code(
        api,
        name="Pipeline inference",
        files={"inference.py": (EXAMPLES / "inference.py").read_text(), "pipeline_entry.py": JOB_ENTRY},
        entrypoint=job_entrypoint("inference.py"),
        task_type="inference",
        families=families,
    )["id"]
    evaluation_files = {
        "evaluation.py": (EXAMPLES / "evaluation.py").read_text(),
        "pipeline_entry.py": JOB_ENTRY,
    }
    evaluation = register_code(
        api,
        name="Pipeline evaluation",
        files=evaluation_files,
        entrypoint=job_entrypoint("evaluation.py"),
        task_type="evaluation",
        families=families,
    )
    ids["evaluationCodeId"] = evaluation["codeId"]
    ids["evaluationCodeVersionId"] = evaluation["id"]
    ids["strictEvaluationCodeVersionId"] = create_code_version(
        api,
        code_id=evaluation["codeId"],
        version="v2-strict",
        files=evaluation_files,
        entrypoint=job_entrypoint("evaluation.py", "--tolerance-seconds", STRICT_TOLERANCE_SECONDS),
        task_type="evaluation",
        families=families,
    )["id"]


def register_reference_sets(pipeline: Pipeline, work_directory: Path) -> None:
    """A descriptor-only reference (samples in metadata) and the same samples uploaded as a file."""
    api, ids = pipeline.admin, pipeline.ids
    samples = reference_samples()
    dataset = api.post("datasets", {"name": "Pipeline reference lengths", "namespace": "verification"})
    ids["referenceDatasetVersionId"] = api.post(
        f"datasets/{dataset['id']}/versions",
        {
            "version": "metadata",
            "uri": "urn:mmt:verification:pipeline-reference",
            "digest": "sha256:" + hashlib.sha256(json.dumps(samples).encode()).hexdigest(),
            "schema": {"audio": "string", "durationSeconds": "number"},
            "metadata": {"samples": samples},
        },
    )["id"]
    # The file version has no samples in its metadata: only the staged reference.json can score.
    directory = work_directory / "reference-files"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "reference.json").write_text(json.dumps({"samples": samples}))
    with Client(api_url=pipeline.worker.api.url, api_token=pipeline.setup_token) as client:
        uploaded = client.register_dataset(
            api.project_id, files=directory, dataset_id=dataset["id"], version="files"
        )
    expect(uploaded.get("contentKind") == "artifacts", "the uploaded reference is not an artifacts version")
    ids["stagedReferenceDatasetVersionId"] = uploaded["id"]


def create_rule_chain(
    pipeline: Pipeline, *, family: str, reference_version_id: str, parameters: dict[str, Any]
) -> dict[str, str]:
    """An inference rule on registration and an evaluation rule chained to it, for one family."""
    owner = pipeline.owner
    common = {"experimentId": pipeline.experiment_id, "targetId": pipeline.target_id, "maxAttempts": 1}
    output_dataset_id = owner.post(
        "datasets", {"name": f"Pipeline inference outputs {family}", "namespace": "verification"}
    )["id"]
    inference_rule = owner.post(
        "automation-rules",
        {
            **common,
            "name": f"Inference on registration ({family})",
            "modelFamilies": [family],
            "kind": "inference",
            "codeVersionId": pipeline.ids["inferenceCodeVersionId"],
            "trigger": "model_registered",
            # The Job token may add versions to a Dataset but not create one.
            "parameters": {**parameters, "outputDatasetId": output_dataset_id},
        },
    )
    evaluation_rule = owner.post(
        "automation-rules",
        {
            **common,
            "name": f"Evaluation after inference ({family})",
            "modelFamilies": [family],
            "kind": "evaluation",
            "codeVersionId": pipeline.ids["evaluationCodeVersionId"],
            "trigger": "upstream_run_finished",
            "upstreamRuleId": inference_rule["id"],
            "inputDatasetVersionIds": [reference_version_id],
            "parameters": parameters,
            "summaryMetrics": ["evaluation.duration_match_rate"],
        },
    )
    return {
        "inferenceOutputDatasetId": output_dataset_id,
        "inferenceRuleId": inference_rule["id"],
        "evaluationRuleId": evaluation_rule["id"],
    }


def create_rules_and_policy(pipeline: Pipeline) -> None:
    """The owner (a Project admin, not a global admin) creates what the Service Account takes over."""
    ids = pipeline.ids
    ids.update(
        create_rule_chain(
            pipeline, family=SDK_FAMILY, reference_version_id=ids["referenceDatasetVersionId"], parameters={}
        )
    )
    declared = create_rule_chain(
        pipeline,
        family=DECLARED_FAMILY,
        reference_version_id=ids["stagedReferenceDatasetVersionId"],
        parameters={"outputMode": "result-json"},
    )
    ids.update(
        declaredInferenceOutputDatasetId=declared["inferenceOutputDatasetId"],
        declaredInferenceRuleId=declared["inferenceRuleId"],
        declaredEvaluationRuleId=declared["evaluationRuleId"],
    )
    ids["promotionPolicyId"] = pipeline.owner.post(
        "promotion-policies",
        {
            "name": "Pipeline promotion gate",
            "modelId": ids["modelId"],
            "targetAlias": PROMOTION_ALIAS,
            "baselineAlias": PROMOTION_ALIAS,
            "evaluationRuleId": ids["evaluationRuleId"],
            "autoPromote": True,
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


def create_task(pipeline: Pipeline, *, name: str, code_version_id: str, model_id: str | None) -> str:
    parameters = {
        "steps": TRAINING_STEPS,
        "learning_rate": 0.1,
        "jobTokenProbeRunId": pipeline.ids["foreignRunId"],
    }
    body: dict[str, Any] = {
        "experimentId": pipeline.experiment_id,
        "name": name,
        "kind": "training",
        "codeVersionId": code_version_id,
        "parameters": parameters,
        "targetId": pipeline.target_id,
    }
    if model_id is not None:
        body["outputModel"] = {
            "modelId": model_id,
            "createModel": None,
            "artifactPath": "model/weights.json",
            "metadata": {},
        }
    task_id: str = pipeline.admin.post("tasks", body)["id"]
    return task_id


def set_up(pipeline: Pipeline, details: dict[str, Any], work_directory: Path) -> None:
    api, ids = pipeline.admin, pipeline.ids
    register_codes(pipeline)
    register_reference_sets(pipeline, work_directory)
    ids["modelId"] = api.post("models", {"name": "pipeline-linear", "family": SDK_FAMILY, "description": ""})[
        "id"
    ]
    ids["declaredModelId"] = api.post(
        "models", {"name": "pipeline-linear-declared", "family": DECLARED_FAMILY, "description": ""}
    )["id"]
    create_rules_and_policy(pipeline)
    # A Run the training Job's token must not be able to write to.
    ids["foreignRunId"] = api.post(
        "runs",
        {"experimentId": pipeline.experiment_id, "name": "Job token probe target", "kind": "processing"},
    )["id"]
    ids["taskId"] = create_task(
        pipeline,
        name="Pipeline training",
        code_version_id=ids["trainingCodeVersionId"],
        model_id=ids["modelId"],
    )
    ids["declaredTaskId"] = create_task(
        pipeline,
        name="Pipeline training (result.json path)",
        code_version_id=ids["trainingCodeVersionId"],
        model_id=ids["declaredModelId"],
    )
    # Without an output model the failing training registers its version itself while running.
    ids["failingTaskId"] = create_task(
        pipeline,
        name="Pipeline failing training",
        code_version_id=ids["failingTrainingCodeVersionId"],
        model_id=None,
    )
    details.update(ids)


def launch_task(api: ProjectApi, task_id: str) -> str:
    task = api.get(f"tasks/{task_id}")
    launched = api.post(
        f"tasks/{task_id}/launch", {"expectedRevision": task["revision"], "executionMode": "run"}
    )
    run_id: str = launched["run"]["id"]
    return run_id


def log_lines(pipeline: Pipeline, run_id: str, marker: str) -> list[str]:
    """Log lines of a Run containing marker; the worker forwards output in multi-line chunks."""
    return [
        line
        for message in pipeline.admin.log_messages(run_id)
        for line in message.splitlines()
        if marker in line
    ]


def job_token_lines(pipeline: Pipeline, run_id: str) -> list[str]:
    return log_lines(pipeline, run_id, "job-token")


def expect_job_token(pipeline: Pipeline, run_id: str, details: dict[str, Any]) -> None:
    lines = job_token_lines(pipeline, run_id)
    details["jobTokenLog"] = lines
    expect(
        any("job-token job=True" in line for line in lines), f"Run {run_id}'s code did not get a Job token"
    )


def single_execution(
    pipeline: Pipeline, rule_id: str, details: dict[str, Any], *, matches: Callable[[dict[str, Any]], bool]
) -> dict[str, Any]:
    executions = [execution for execution in pipeline.admin.executions(rule_id) if matches(execution)]
    details["executions"] = [
        {key: execution.get(key) for key in ("id", "status", "runId", "error", "source", "attempt")}
        for execution in executions
    ]
    expect(len(executions) == 1, f"expected one execution of rule {rule_id}, found {len(executions)}")
    return executions[0]


# --- stages ---------------------------------------------------------------------------------------


def verify_owner_transfer(pipeline: Pipeline, details: dict[str, Any]) -> None:
    admin, ids = pipeline.admin, pipeline.ids
    service_account = ids["automationServiceAccountId"]
    rule_keys = ("inferenceRuleId", "evaluationRuleId", "declaredInferenceRuleId", "declaredEvaluationRuleId")
    for key in rule_keys:
        rule = admin.put(f"automation-rules/{ids[key]}/owner", {"serviceAccountId": service_account})
        expect(rule["runAsUserId"] == service_account, f"rule {key} still runs as {rule['runAsUserId']}")
        expect(rule["createdBy"] == ids["ownerUserId"], "the rule lost its creator record")
    policy = admin.put(
        f"promotion-policies/{ids['promotionPolicyId']}/owner", {"serviceAccountId": service_account}
    )
    expect(policy["runAsUserId"] == service_account, "the policy still runs as its creator")
    admin.request("DELETE", f"members/{ids['ownerUserId']}")
    owner_status = pipeline.owner.status_of("GET", "automation-rules")
    rules = {rule["id"]: rule for rule in admin.get("automation-rules")["items"]}
    details.update(
        ownerStatusAfterRemoval=owner_status,
        ruleRunAs={key: rules[ids[key]].get("runAsKind") for key in rule_keys},
        policyRunAs=policy["runAsUserId"],
    )
    expect(owner_status == 403, f"the removed creator still reaches the Project (HTTP {owner_status})")
    expect(
        all(rules[ids[key]].get("runAsKind") == "service" for key in rule_keys),
        "a rule does not run as service",
    )


async def verify_training(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = pipeline.ids["trainingRunId"] = launch_task(pipeline.admin, pipeline.ids["taskId"])
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"])
    expect(run["status"] == "finished", f"training Run ended {run['status']}")
    losses = [
        point["value"]
        for point in pipeline.admin.get(f"runs/{run_id}/metrics")["items"]
        if point["name"] == "train.loss"
    ]
    details["trainLoss"] = {
        "first": losses[0] if losses else None,
        "last": losses[-1] if losses else None,
        "points": len(losses),
    }
    expect(
        len(losses) == TRAINING_STEPS and losses[-1] < losses[0],
        "train.loss was not recorded or did not decrease",
    )
    expect("model/weights.json" in pipeline.admin.artifact_paths(run_id), "model/weights.json was not saved")
    handed_over = log_lines(pipeline, run_id, "the Task registers")
    details["taskRegistrationLog"] = handed_over
    expect(handed_over, "training.py did not leave the registration to the Task's output model")


def verify_job_token_scope(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id, foreign_run_id = pipeline.ids["trainingRunId"], pipeline.ids["foreignRunId"]
    expect_job_token(pipeline, run_id, details)
    probes = [line for line in details["jobTokenLog"] if "job-token-probe" in line]
    expect(
        probes and "status=403 code=job_token_forbidden" in probes[0],
        "Job token wrote to or reached another Run",
    )
    foreign_metrics = pipeline.admin.get(f"runs/{foreign_run_id}/metrics")["items"]
    details["foreignRunMetricCount"] = len(foreign_metrics)
    expect(not foreign_metrics, "the foreign Run received a metric")


def verify_output_registration(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = pipeline.ids["trainingRunId"]
    registration = pipeline.admin.get(f"runs/{run_id}/output-registration")
    details["registration"] = registration
    expect(registration["status"] == "registered", f"Task output registration is {registration['status']}")
    version_id = pipeline.ids["firstVersionId"] = registration["modelVersionId"]
    version = pipeline.admin.get(f"models/{pipeline.ids['modelId']}/versions/{version_id}")
    details.update(
        version=version["version"], sourceRunId=version["sourceRunId"], artifactId=version["artifactId"]
    )
    expect(version["sourceRunId"] == run_id, "the version does not point to the training Run")
    expect(version["artifactId"], "the version has no weights Artifact")
    expect(
        pipeline.admin.run(run_id)["outputModelVersionIds"] == [version_id], "the Run lists other versions"
    )


async def verify_inference(
    pipeline: Pipeline, details: dict[str, Any], *, version_key: str, run_key: str
) -> None:
    version_id = pipeline.ids[version_key]
    execution = single_execution(
        pipeline,
        pipeline.ids["inferenceRuleId"],
        details,
        matches=lambda item: item["modelVersionId"] == version_id,
    )
    expect(execution["status"] == "queued", "the inference rule did not start")
    run_id = pipeline.ids[run_key] = execution["runId"]
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"], outputDatasetVersionIds=run["outputDatasetVersionIds"])
    expect(run["status"] == "finished", f"inference Run ended {run['status']}")
    expect(run["modelVersionId"] == version_id, "inference ran on another version")
    expect(
        run["createdBy"] == pipeline.ids["automationServiceAccountId"],
        "the inference Run is not the rule owner's",
    )
    expect(len(run["outputDatasetVersionIds"]) == 1, "inference did not register one output DatasetVersion")
    audio = pipeline.admin.artifact_paths(run_id, "inference/audio/")
    details["audioArtifacts"] = audio
    expect(len(audio) == len(INFERENCE_VALUES), "inference did not save one WAV per input")
    expect_job_token(pipeline, run_id, details)


async def verify_evaluation(
    pipeline: Pipeline, details: dict[str, Any], *, rule_key: str, inference_run_key: str, run_key: str
) -> dict[str, float]:
    inference_run = pipeline.admin.run(pipeline.ids[inference_run_key])
    execution = single_execution(
        pipeline,
        pipeline.ids[rule_key],
        details,
        matches=lambda item: item["triggerRunId"] == inference_run["id"],
    )
    expect(execution["status"] == "queued", "the chained evaluation did not start")
    run_id = pipeline.ids[run_key] = execution["runId"]
    queued = pipeline.admin.run(run_id)
    details.update(
        parentRunId=queued["parentRunId"], upstreamDatasetVersionIds=queued["upstreamDatasetVersionIds"]
    )
    expect(
        queued["parentRunId"] == inference_run["id"], "the evaluation Run's parent is not the inference Run"
    )
    expect(
        queued["upstreamDatasetVersionIds"] == inference_run["outputDatasetVersionIds"],
        "upstreamDatasetVersionIds is not the inference output",
    )
    run = await run_job_of(pipeline, run_id)
    details["status"] = run["status"]
    expect(run["status"] == "finished", f"evaluation Run ended {run['status']}")
    metrics = pipeline.admin.latest_metrics(run_id)
    details["metrics"] = {name: value for name, value in metrics.items() if name.startswith("evaluation.")}
    expect(
        metrics.get("evaluation.samples") == len(INFERENCE_VALUES), "evaluation did not score every sample"
    )
    expect("evaluation.duration_match_rate" in metrics, "evaluation.duration_match_rate was not recorded")
    expect_job_token(pipeline, run_id, details)
    summaries = log_lines(pipeline, run_id, "upstreamRunId")
    details["evaluationLog"] = summaries
    expect(
        any(inference_run["id"] in message for message in summaries),
        "the code did not read MMT_UPSTREAM_RUN_ID",
    )
    return metrics


def promotion_decisions(pipeline: Pipeline, version_id: str) -> list[dict[str, Any]]:
    evaluations: list[dict[str, Any]] = pipeline.admin.get(
        "promotion-evaluations",
        params={"policyId": pipeline.ids["promotionPolicyId"], "candidateVersionId": version_id},
    )["items"]
    return evaluations


def summarize_decision(decision: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "decision", "reason", "candidateRunId", "baselineVersionId", "promoted", "aliasEventId")
    return {key: decision[key] for key in keys} | {
        "criteria": [
            {key: result[key] for key in ("metric", "mode", "candidate", "baseline", "observed", "outcome")}
            for result in decision["criteriaResults"]
        ]
    }


def verify_auto_promotion(
    pipeline: Pipeline,
    details: dict[str, Any],
    *,
    version_key: str,
    evaluation_run_key: str,
    expected_reason: str | None,
    expected_baseline_key: str | None,
) -> None:
    ids = pipeline.ids
    version_id = ids[version_key]
    decisions = promotion_decisions(pipeline, version_id)
    details["decisions"] = [summarize_decision(decision) for decision in decisions]
    expect(len(decisions) == 1, f"expected one promotion decision, found {len(decisions)}")
    (decision,) = decisions
    expect(decision["candidateRunId"] == ids[evaluation_run_key], "the decision is for another Run")
    expect(decision["decision"] == "passed", f"decision is {decision['decision']} ({decision['reason']})")
    if expected_reason is not None:
        expect(decision["reason"] == expected_reason, f"reason is {decision['reason']}")
    if expected_baseline_key is not None:
        expect(
            decision["baselineVersionId"] == ids[expected_baseline_key],
            "the baseline is not the promoted version",
        )
    expect(decision["promoted"] and decision["aliasEventId"], "the passed decision did not switch the alias")
    detail = pipeline.admin.get(f"model-versions/{version_id}")
    details["aliases"] = detail["aliases"]
    expect(PROMOTION_ALIAS in detail["aliases"], f"{PROMOTION_ALIAS} does not point to the version")
    events = pipeline.admin.get(f"models/{ids['modelId']}/alias-events", params={"alias": PROMOTION_ALIAS})[
        "items"
    ]
    details["aliasHistory"] = [
        {
            key: event[key]
            for key in ("id", "version", "previousVersion", "source", "promotionEvaluationId", "reason")
        }
        | {"actorUserId": (event["actor"] or {}).get("userId")}
        for event in events
    ]
    newest = events[0]
    expect(newest["id"] == decision["aliasEventId"], "the newest alias event is not the decision's")
    expect(newest["source"] == "promotion_policy", f"alias event source is {newest['source']}")
    expect(newest["promotionEvaluationId"] == decision["id"], "the alias event does not cite the decision")
    expect(
        (newest["actor"] or {}).get("userId") == ids["automationServiceAccountId"],
        "the alias was switched by someone other than the policy's Service Account",
    )
    automated = pipeline.admin.get(f"model-versions/{version_id}/evaluations")["items"]
    details["versionEvaluations"] = [
        {key: run[key] for key in ("id", "kind", "status", "automatic", "ruleId")} for run in automated
    ]
    expect(
        {(run["kind"], run["status"]) for run in automated}
        >= {("inference", "finished"), ("evaluation", "finished")},
        "model-versions/:id/evaluations does not list the finished inference and evaluation",
    )


async def verify_second_round(pipeline: Pipeline, details: dict[str, Any]) -> None:
    """A second version is compared with the promoted one; a new evaluation rule also runs on it."""
    ids = pipeline.ids
    # Created now, so it chains from the second inference but not from the first one.
    ids["strictEvaluationRuleId"] = pipeline.admin.post(
        "automation-rules",
        {
            "name": "Strict evaluation after inference",
            "modelFamilies": [SDK_FAMILY],
            "kind": "evaluation",
            "experimentId": pipeline.experiment_id,
            "targetId": pipeline.target_id,
            "codeVersionId": ids["strictEvaluationCodeVersionId"],
            "trigger": "upstream_run_finished",
            "upstreamRuleId": ids["inferenceRuleId"],
            "inputDatasetVersionIds": [ids["referenceDatasetVersionId"]],
            "maxAttempts": 1,
        },
    )["id"]
    training_run_id = ids["secondTrainingRunId"] = launch_task(pipeline.admin, ids["taskId"])
    training = await run_job_of(pipeline, training_run_id)
    expect(training["status"] == "finished", f"second training ended {training['status']}")
    registration = pipeline.admin.get(f"runs/{training_run_id}/output-registration")
    expect(registration["status"] == "registered", f"second registration is {registration['status']}")
    ids["secondVersionId"] = registration["modelVersionId"]
    details["secondVersion"] = pipeline.admin.get(f"model-versions/{ids['secondVersionId']}")["version"][
        "version"
    ]
    inference: dict[str, Any] = {}
    await verify_inference(pipeline, inference, version_key="secondVersionId", run_key="secondInferenceRunId")
    evaluations = {
        rule_key: single_execution(
            pipeline,
            ids[rule_key],
            {},
            matches=lambda item: item["triggerRunId"] == ids["secondInferenceRunId"],
        )["runId"]
        for rule_key in ("evaluationRuleId", "strictEvaluationRuleId")
    }
    ids["secondEvaluationRunId"] = evaluations["evaluationRuleId"]
    ids["secondStrictEvaluationRunId"] = evaluations["strictEvaluationRuleId"]
    runs = await run_jobs_of(pipeline, list(evaluations.values()))
    details.update(
        trainingRunId=training_run_id, inferenceRunId=ids["secondInferenceRunId"], evaluationRuns=evaluations
    )
    expect(
        all(run["status"] == "finished" for run in runs), "an evaluation of the second version did not finish"
    )
    promotion: dict[str, Any] = {}
    verify_auto_promotion(
        pipeline,
        promotion,
        version_key="secondVersionId",
        evaluation_run_key="secondEvaluationRunId",
        expected_reason=None,
        expected_baseline_key="firstVersionId",
    )
    details["promotion"] = promotion
    expect(len(promotion["aliasHistory"]) == 2, "the alias history does not hold both promotions")


async def verify_manual_apply_comparison(pipeline: Pipeline, details: dict[str, Any]) -> None:
    """The strict rule did not exist for the baseline: apply it by hand, then compare the versions."""
    ids = pipeline.ids
    execution = pipeline.admin.post(
        f"automation-rules/{ids['strictEvaluationRuleId']}/executions",
        {"triggerRunId": ids["inferenceRunId"]},
    )
    details["execution"] = {
        key: execution.get(key) for key in ("id", "status", "source", "requestedBy", "runId", "attempt")
    }
    expect(
        execution["status"] == "queued" and execution["source"] == "manual", "the manual apply did not start"
    )
    run = await run_job_of(pipeline, execution["runId"])
    expect(run["status"] == "finished", f"the manually applied evaluation ended {run['status']}")
    expect(run["modelVersionId"] == ids["firstVersionId"], "the manual apply evaluated another version")
    comparison = pipeline.admin.get(
        f"models/{ids['modelId']}/versions/{ids['secondVersionId']}/evaluation-comparison",
        params={
            "baselineVersionId": ids["firstVersionId"],
            "evaluationRuleId": ids["strictEvaluationRuleId"],
            "codeVersionId": ids["strictEvaluationCodeVersionId"],
        },
    )
    details["comparison"] = {
        key: comparison[key] for key in ("status", "candidateRunId", "baselineRunId", "codeVersionId")
    } | {
        "metrics": [
            {key: metric[key] for key in ("key", "candidate", "baseline", "delta")}
            for metric in comparison["metrics"]
        ]
    }
    expect(comparison["status"] == "ok", f"the comparison is {comparison['status']}")
    expect(comparison["baselineRunId"] == execution["runId"], "the baseline side is not the manual apply")
    expect(
        comparison["candidateRunId"] == ids["secondStrictEvaluationRunId"],
        "the candidate side is another Run",
    )
    expect(
        any(metric["key"] == "evaluation.duration_match_rate" for metric in comparison["metrics"]),
        "no metric to compare",
    )


async def verify_declared_outputs(pipeline: Pipeline, details: dict[str, Any]) -> None:
    """The SDK-free path: result.json declarations and a reference staged by the worker."""
    ids = pipeline.ids
    training_run_id = launch_task(pipeline.admin, ids["declaredTaskId"])
    training = await run_job_of(pipeline, training_run_id)
    expect(training["status"] == "finished", f"training ended {training['status']}")
    version_id = pipeline.admin.get(f"runs/{training_run_id}/output-registration")["modelVersionId"]
    inference_execution = single_execution(
        pipeline,
        ids["declaredInferenceRuleId"],
        details,
        matches=lambda item: item["modelVersionId"] == version_id,
    )
    inference = await run_job_of(pipeline, inference_execution["runId"])
    expect(inference["status"] == "finished", f"inference ended {inference['status']}")
    audio = pipeline.admin.artifact_paths(inference["id"], "container/inference/audio/")
    declarations = inference["outputDatasetVersionIds"]
    details.update(
        inferenceRunId=inference["id"], containerAudioArtifacts=audio, outputDatasetVersionIds=declarations
    )
    expect(len(audio) == len(INFERENCE_VALUES), "the result.json outputs were not saved under container/")
    expect(len(declarations) == 1, "result.json did not register the output DatasetVersion")
    output = pipeline.admin.get(f"datasets/{ids['declaredInferenceOutputDatasetId']}/versions")["items"]
    registered = next(item for item in output if item["id"] == declarations[0])
    details["outputVersion"] = {key: registered[key] for key in ("version", "uri", "sourceRunId")}
    expect(
        registered["sourceRunId"] == inference["id"],
        "the declared output does not point to the inference Run",
    )
    evaluation_execution = single_execution(
        pipeline,
        ids["declaredEvaluationRuleId"],
        {},
        matches=lambda item: item["triggerRunId"] == inference["id"],
    )
    evaluation = await run_job_of(pipeline, evaluation_execution["runId"])
    expect(evaluation["status"] == "finished", f"evaluation ended {evaluation['status']}")
    metrics = pipeline.admin.latest_metrics(evaluation["id"])
    logs = log_lines(pipeline, evaluation["id"], "referenceSources")
    details.update(evaluationRunId=evaluation["id"], metrics=metrics, evaluationLog=logs)
    expect(
        metrics.get("evaluation.duration_match_rate") == 1.0, "the result.json metrics did not reach the Run"
    )
    expect(
        any(f"{ids['stagedReferenceDatasetVersionId']}:staged" in line for line in logs),
        "the staged reference was not read",
    )
    expect(
        "container/eval/results.jsonl" in pipeline.admin.artifact_paths(evaluation["id"]),
        "results.jsonl was not saved",
    )


async def verify_failed_training(pipeline: Pipeline, details: dict[str, Any]) -> None:
    run_id = launch_task(pipeline.admin, pipeline.ids["failingTaskId"])
    run = await run_job_of(pipeline, run_id)
    details.update(runId=run_id, status=run["status"], outputModelVersionIds=run["outputModelVersionIds"])
    expect(run["status"] == "failed", f"failing training ended {run['status']}")
    expect(
        len(run["outputModelVersionIds"]) == 1, "the failing training did not register its version in the Run"
    )
    (version_id,) = run["outputModelVersionIds"]
    execution = single_execution(
        pipeline,
        pipeline.ids["inferenceRuleId"],
        details,
        matches=lambda item: item["modelVersionId"] == version_id,
    )
    expect(execution["status"] == "skipped" and execution["runId"] is None, "inference was not skipped")
    expect(
        (execution["error"] or "").startswith("source_run_unsuccessful"),
        "the skip reason is not source_run_unsuccessful",
    )


@contextmanager
def counting_target_commands() -> Iterator[Counter[str]]:
    """Count the runner commands the in-process worker sends to the target, by command name."""
    counts: Counter[str] = Counter()
    original_command, original_stream = JobExecutor.command, JobExecutor.stream_command

    async def command(self: JobExecutor, name: str, **options: Any) -> dict[str, Any]:
        counts[name] += 1
        return await original_command(self, name, **options)

    async def stream_command(self: JobExecutor, name: str, **options: Any) -> Any:
        counts[name] += 1
        return await original_stream(self, name, **options)

    JobExecutor.command = command  # type: ignore[method-assign]
    JobExecutor.stream_command = stream_command  # type: ignore[method-assign]
    try:
        yield counts
    finally:
        JobExecutor.command = original_command  # type: ignore[method-assign]
        JobExecutor.stream_command = original_stream  # type: ignore[method-assign]


def container_image() -> str:
    image = os.environ.get("MMT_VERIFY_CONTAINER_IMAGE", DEFAULT_CONTAINER_IMAGE)
    if shutil.which("docker") is None:
        raise StageNotRun("docker is not installed")
    inspected = subprocess.run(["docker", "image", "inspect", image], capture_output=True, check=False)
    if inspected.returncode != 0:
        raise StageNotRun(f"{image} is not in the local Docker cache (set MMT_VERIFY_CONTAINER_IMAGE)")
    return image


async def verify_container_bulk_outputs(pipeline: Pipeline, details: dict[str, Any]) -> None:
    ids = pipeline.ids
    if "firstVersionId" not in ids:
        raise StageNotRun("no registered version to apply the rule to (output_registration did not pass)")
    image = container_image()
    dataset_id = pipeline.admin.post(
        "datasets", {"name": "Pipeline container outputs", "namespace": "verification"}
    )["id"]
    code_version = register_code(
        pipeline.admin,
        name="Pipeline container inference",
        files=None,
        entrypoint=[
            "/bin/sh",
            "-c",
            CONTAINER_INFERENCE_SCRIPT,
            "mmt-inference",
            dataset_id,
            str(CONTAINER_OUTPUT_FILES),
        ],
        task_type="inference",
        families=[SDK_FAMILY],
        runtime={"kind": "docker", "image": image, "workingDirectory": "/tmp"},
    )
    # A model_registered rule created after every linear training: it starts only when applied.
    rule_id = pipeline.admin.post(
        "automation-rules",
        {
            "name": "Container inference",
            "modelFamilies": [SDK_FAMILY],
            "kind": "inference",
            "experimentId": pipeline.experiment_id,
            "targetId": pipeline.target_id,
            "codeVersionId": code_version["id"],
            "trigger": "model_registered",
            "maxAttempts": 1,
        },
    )["id"]
    execution = pipeline.admin.post(
        f"automation-rules/{rule_id}/executions", {"modelVersionId": ids["firstVersionId"]}
    )
    expect(
        execution["status"] == "queued",
        f"the container inference was {execution['status']}: {execution['error']}",
    )
    started = time.monotonic()
    with counting_target_commands() as commands:
        run = await run_job_of(pipeline, execution["runId"], deadline_seconds=CONTAINER_JOB_DEADLINE_SECONDS)
    details.update(
        image=image,
        runId=run["id"],
        status=run["status"],
        jobSeconds=round(time.monotonic() - started, 3),
        targetCommands=dict(commands),
    )
    expect(run["status"] == "finished", f"the container inference ended {run['status']}")
    audio = pipeline.admin.artifact_paths(run["id"], "container/audio/")
    details["audioArtifactCount"] = len(audio)
    expect(
        len(audio) == CONTAINER_OUTPUT_FILES, f"{len(audio)} of {CONTAINER_OUTPUT_FILES} outputs were saved"
    )
    expect(len(run["outputDatasetVersionIds"]) == 1, "the container's DatasetVersion was not registered")
    # One archive stream (one SSH connection on a real target) instead of one command per file.
    expect(
        commands[OUTPUT_ARCHIVE_COMMAND] == 1,
        f"outputs took {commands[OUTPUT_ARCHIVE_COMMAND]} archive streams",
    )
    expect(commands["output"] == 0, "outputs were also fetched file by file")


# --- orchestration --------------------------------------------------------------------------------

StageCheck = Callable[[Pipeline, dict[str, Any]], Awaitable[Any] | None]


@dataclass(frozen=True)
class Stage:
    name: str
    description: str
    check: StageCheck
    # Without its environment (Docker) the stage is not_run and does not fail the check.
    optional: bool = False


def success_path_stages() -> list[Stage]:
    return [
        Stage(
            "owner_transfer",
            "ruleとpolicyの所有者をService Accountへ移し、作成者をProjectから外す",
            verify_owner_transfer,
        ),
        Stage(
            "training",
            "学習TaskをlaunchしService Account tokenのworkerでRunがfinishedになる",
            verify_training,
        ),
        Stage(
            "job_token_scope",
            "実行コードのtokenはJob tokenで、別Runへの書き込みは403 job_token_forbidden",
            verify_job_token_scope,
        ),
        Stage(
            "output_registration",
            "Taskの出力モデル設定で版が自動登録される（training.pyは登録をTaskに任せる）",
            verify_output_registration,
        ),
        Stage(
            "inference",
            "推論rule（model_registered）がService Accountの権限で起動し、WAVと出力Datasetを残す",
            lambda pipeline, details: verify_inference(
                pipeline, details, version_key="firstVersionId", run_key="inferenceRunId"
            ),
        ),
        Stage(
            "evaluation",
            "評価rule（upstream_run_finished）が推論の出力で評価しmetricsを残す",
            lambda pipeline, details: verify_evaluation(
                pipeline,
                details,
                rule_key="evaluationRuleId",
                inference_run_key="inferenceRunId",
                run_key="evaluationRunId",
            ),
        ),
        Stage(
            "auto_promotion",
            "昇格policyが合格（基準なしの初回）と判定し、productionを自動で切り替え、alias履歴と版の評価一覧に残る",
            lambda pipeline, details: verify_auto_promotion(
                pipeline,
                details,
                version_key="firstVersionId",
                evaluation_run_key="evaluationRunId",
                expected_reason="baseline_missing_first_promotion",
                expected_baseline_key=None,
            ),
        ),
        Stage(
            "second_round_against_baseline",
            "2回目の学習の版を昇格済みの基準版と比べて判定し、再び自動昇格する",
            verify_second_round,
        ),
        Stage(
            "manual_apply_and_comparison",
            "評価コード版を変えたruleを基準版へ手動適用し、2つの版を同じ条件で比較できる",
            verify_manual_apply_comparison,
        ),
    ]


def independent_stages() -> list[Stage]:
    return [
        Stage(
            "declared_outputs_and_staged_reference",
            "result.json v2の宣言（推論の出力Dataset・評価metrics）と、workerが取得した正解セットで通る",
            verify_declared_outputs,
        ),
        Stage(
            "failed_training_skips_downstream",
            "学習がfailedなら保留中の版の推論はskipped（source_run_unsuccessful）",
            verify_failed_training,
        ),
        Stage(
            "container_bulk_outputs",
            "コンテナの推論が1000ファイルを出力し、一括転送で全件Artifactになる（Dockerがあるときだけ）",
            verify_container_bulk_outputs,
            optional=True,
        ),
    ]


SMOKE_STAGE_NAMES = {
    "owner_transfer",
    "training",
    "job_token_scope",
    "output_registration",
    "inference",
    "evaluation",
    "auto_promotion",
    "failed_training_skips_downstream",
}


async def run_stage(stage: Stage, pipeline: Pipeline, recorder: StageRecorder) -> None:
    with recorder.stage(stage.name, stage.description) as details:
        if stage.optional:
            recorder.stages[-1]["optional"] = True
        outcome = stage.check(pipeline, details)
        if asyncio.iscoroutine(outcome):
            await outcome


async def verify_pipeline(
    pipeline: Pipeline, recorder: StageRecorder, *, stage_names: set[str] | None
) -> None:
    def selected(stages: list[Stage]) -> list[Stage]:
        return [stage for stage in stages if stage_names is None or stage.name in stage_names]

    success_path = selected(success_path_stages())
    for index, stage in enumerate(success_path):
        try:
            await run_stage(stage, pipeline, recorder)
        except Exception:
            for skipped in success_path[index + 1 :]:
                recorder.skip(skipped.name, skipped.description, f"{stage.name} failed")
            break
    for stage in selected(independent_stages()):
        try:
            await run_stage(stage, pipeline, recorder)
        except Exception:
            pass  # The recorder holds the failure; the JSON is the report.


@contextmanager
def isolated_api(log_path: Path, port: int) -> Iterator[str]:
    if not os.environ.get("MMT_TEST_DATABASE_URL"):
        raise SystemExit("MMT_TEST_DATABASE_URL (the dedicated loopback mmt_test DB) is required")
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(f"Port {port} is already in use")
    url = f"http://127.0.0.1:{port}"
    environment = {**os.environ, "MMT_VERIFY_API_PORT": str(port)}
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
                    if httpx.get(f"{url}/api/health", timeout=2).is_success:
                        break
                except httpx.TransportError:
                    pass
                if time.monotonic() > deadline:
                    raise SystemExit(f"The isolated API did not start within {API_START_SECONDS}s")
                time.sleep(0.5)
            yield url
        finally:
            # SIGTERM lets the harness drop its test schema.
            server.send_signal(signal.SIGTERM)
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()


def expires_in_one_day() -> str:
    return (datetime.now(UTC) + timedelta(days=1)).isoformat().replace("+00:00", "Z")


def create_service_account(api: ProjectApi, name: str) -> dict[str, Any]:
    return api.post(
        "service-accounts", {"name": name, "description": "pipeline verification", "role": "admin"}
    )


def prepare_project(
    admin_session: httpx.Client, owner_session: httpx.Client, work_directory: Path, api_url: str
) -> Pipeline:
    owner_user = api_request(owner_session, "POST", "auth/dev-login", json={"email": OWNER_EMAIL})["user"]
    api_request(admin_session, "POST", "auth/dev-login", json={})
    project = api_request(
        admin_session,
        "POST",
        "projects",
        json={
            "name": "Pipeline " + datetime.now(JST).strftime("%H:%M:%S"),
            "description": "学習→自動登録→推論→評価→判定・昇格の通し確認",
            "artifactBackend": "filesystem",
        },
    )
    admin = ProjectApi(admin_session, project["id"])
    owner = ProjectApi(owner_session, project["id"])
    admin.put(f"members/{owner_user['id']}", {"role": "admin"})
    target = api_request(
        admin_session,
        "POST",
        "targets",
        json={
            "name": "Pipeline CPU " + project["id"][:8],
            "host": "127.0.0.1",
            "port": 22,
            "username": "local",
            "sshKeyPath": "",
            "knownHostsPath": "",
            "workDirectory": str(work_directory / "jobs"),
            "pythonExecutable": os.environ.get("MMT_VERIFY_PYTHON", sys.executable),
            "runtimeKinds": ["python", "docker"],
            "gpuIds": [],
            "maxConcurrentJobs": 1,
            "enabled": True,
            "executor": "local",
        },
    )
    experiment = admin.post("experiments", {"name": "Pipeline", "description": ""})
    worker_account = create_service_account(admin, "pipeline-worker")
    automation_account = create_service_account(admin, "pipeline-automation")
    # docs/worker.md: a worker needs read, worker:execute, artifacts:write and, for result.json
    # declarations, registry:write. The Job's own code gets a Job token instead.
    worker_token = admin.post(
        f"service-accounts/{worker_account['id']}/tokens",
        {
            "name": "pipeline worker",
            "scopes": ["read", "worker:execute", "artifacts:write", "registry:write"],
            "expiresAt": expires_in_one_day(),
        },
    )
    # Uploading the reference files goes through the SDK, which authenticates with a token.
    setup_token = api_request(
        admin_session,
        "POST",
        "tokens",
        json={
            "name": "pipeline setup",
            "kind": "personal",
            "projectId": project["id"],
            "scopes": ["read", "registry:write", "artifacts:write"],
            "expiresAt": expires_in_one_day(),
        },
    )
    pipeline = Pipeline(
        admin=admin,
        owner=owner,
        worker=WorkerSettings(
            api=ApiSettings.from_environment(url=api_url, token=worker_token["token"]),
            worker_id=f"pipeline-{project['id'][:8]}",
            target_ids=(target["id"],),
            state_directory=work_directory / "state",
            allow_local_executor=True,
            heartbeat_seconds=0.2,
            poll_seconds=0.1,
            telemetry_seconds=1,
            cancel_grace_seconds=0.5,
            parallel_jobs=1,
        ),
        experiment_id=experiment["id"],
        target_id=target["id"],
        setup_token=setup_token["token"],
    )
    pipeline.ids.update(
        projectId=project["id"],
        ownerUserId=owner_user["id"],
        workerServiceAccountId=worker_account["id"],
        automationServiceAccountId=automation_account["id"],
    )
    return pipeline


@dataclass(frozen=True)
class Profile:
    """What one invocation checks and where it writes its report."""

    output_name: str
    report_name: str
    port_variable: str
    stage_names: set[str] | None


FULL_PROFILE = Profile("pipeline", "pipeline-integration.json", "MMT_VERIFY_PIPELINE_API_PORT", None)
SMOKE_PROFILE = Profile(
    "pipeline-smoke", "pipeline-smoke.json", "MMT_VERIFY_SMOKE_API_PORT", SMOKE_STAGE_NAMES
)


def main(profile: Profile = FULL_PROFILE) -> int:
    now = datetime.now(JST)
    output_directory = ROOT / "artifacts/verification" / now.strftime("%Y-%m-%d") / profile.output_name
    work_directory = ROOT / f"var/verification-{profile.output_name}" / now.strftime("%Y%m%d-%H%M%S")
    output_directory.mkdir(parents=True, exist_ok=True)
    work_directory.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get(profile.port_variable, DEFAULT_API_PORT))
    recorder = StageRecorder()
    summary: dict[str, Any] = {
        "startedAt": now.isoformat(timespec="seconds"),
        "api": f"isolated test schema on 127.0.0.1:{port}",
        "worker": "local executor, --once loop in this process, Service Account token",
        "outOfScope": ["実SSH", "GPU", "実SSO（Authentik）", "実S3", "本番Mado"],
        "stages": recorder.stages,
    }
    with (
        isolated_api(output_directory / "api.log", port) as api_url,
        httpx.Client(base_url=f"{api_url}/api/", headers={"Origin": WEB_ORIGIN}, timeout=30) as admin_session,
        httpx.Client(base_url=f"{api_url}/api/", headers={"Origin": WEB_ORIGIN}, timeout=30) as owner_session,
    ):
        try:
            with recorder.stage(
                "setup", "Project・target・Service Account・コード版・正解セット・rule・policy・Taskの登録"
            ) as details:
                pipeline = prepare_project(admin_session, owner_session, work_directory, api_url)
                set_up(pipeline, details, work_directory)
            asyncio.run(verify_pipeline(pipeline, recorder, stage_names=profile.stage_names))
        except Exception:
            pass  # A failed setup is recorded as its stage; no later stage can run without it.
    summary.update(
        finishedAt=datetime.now(JST).isoformat(timespec="seconds"),
        result="passed" if recorder.passed else "failed",
    )
    output = output_directory / profile.report_name
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    for stage in recorder.stages:
        print(f"{stage['status']:>8}  {stage.get('seconds', '-'):>8}  {stage['name']}")
    print(f"{summary['result']}: {output.relative_to(ROOT)}")
    return 0 if recorder.passed else 1


if __name__ == "__main__":
    sys.exit(main())
