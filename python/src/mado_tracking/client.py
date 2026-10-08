"""Authenticated SDK operations using the public /api contract."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator, Mapping, Sequence
from typing import Any, BinaryIO, Literal, cast

import httpx

from . import aliases, automation, evaluation, exports, service_accounts
from .api_paths import path_id
from .artifact_downloads import download_resumable_sync
from .code_version import build_code_version_payload
from .dataset_upload import upload_dataset_directory
from .errors import ApiError, ConfigurationError
from .execution_runtime import ExecutionRuntime
from .execution_snapshot import ExecutionMode, validate_execution_mode
from .experiment_tasks import ExperimentTasksClient
from .http import REQUEST_TIMEOUT_SECONDS, request_sync
from .pagination import iterate_cursor_pages
from .run_search_request import build_run_search_body
from .security import SecretMasker, secret_values
from .settings import ApiSettings
from .timestamps import utc_timestamp

__all__ = ["Client", "ResumeMode", "path_id", "start_run_offline"]

ResumeMode = Literal["never", "allow", "must"]
RESUME_MODES: tuple[ResumeMode, ...] = ("never", "allow", "must")
# Values of MMT_SYSTEM_METRICS that turn off system metrics requested in code.
SYSTEM_METRICS_DISABLED_VALUES = frozenset({"0", "false", "no", "off"})

# Mirrors POST /projects/:p/runs/search: limit defaults to 100 and is capped at 500.
RUN_SEARCH_DEFAULT_PAGE_SIZE = 100
RUN_SEARCH_MAX_PAGE_SIZE = 500


class Client(ExperimentTasksClient):
    """Native API client. Feature operations live in their own modules and are bound here as methods.

    Each bound function takes the Client as its first argument, so ``client.set_model_alias(...)``
    and ``aliases.set_model_alias(client, ...)`` are the same call with the same documentation.
    """

    set_model_alias = aliases.set_model_alias
    delete_model_alias = aliases.delete_model_alias
    list_alias_events = aliases.list_alias_events
    compare_to_baseline = evaluation.compare_to_baseline
    create_promotion_policy = evaluation.create_promotion_policy
    list_promotion_policies = evaluation.list_promotion_policies
    list_promotion_evaluations = evaluation.list_promotion_evaluations
    transfer_promotion_policy_owner = evaluation.transfer_promotion_policy_owner
    create_automation_rule = automation.create_automation_rule
    list_automation_executions = automation.list_automation_executions
    apply_automation_rule = automation.apply_automation_rule
    transfer_automation_rule_owner = automation.transfer_automation_rule_owner
    compare_runs = exports.compare_runs
    export_runs_csv = exports.export_runs_csv
    export_comparison_csv = exports.export_comparison_csv
    list_service_accounts = service_accounts.list_service_accounts
    create_service_account = service_accounts.create_service_account
    create_service_account_token = service_accounts.create_service_account_token
    list_project_tokens = service_accounts.list_project_tokens

    def __init__(
        self,
        *,
        api_url: str | None = None,
        api_token: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        self.settings = ApiSettings.from_environment(url=api_url, token=api_token)
        self.masker = SecretMasker([self.settings.token, *secret_values(os.environ)])
        self.http = httpx.Client(
            base_url=self.settings.url + "/",
            transport=transport,
            headers={"Authorization": f"Bearer {self.settings.token}"},
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
        )

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *_exception: object) -> None:
        self.close()

    def close(self) -> None:
        self.http.close()

    def request(self, method: str, path: str, *, retryable: bool = False, **options: Any) -> dict[str, Any]:
        response = request_sync(
            self.http, method, path.lstrip("/"), masker=self.masker, retryable=retryable, **options
        )
        if response.status_code == 204:
            return {}
        payload = response.json()
        if not isinstance(payload, dict):
            raise ConfigurationError("API returned a non-object response")
        return payload

    def project_path(self, project_id: str, resource: str = "") -> str:
        return f"projects/{path_id(project_id)}" + (f"/{resource}" if resource else "")

    def create_experiment(self, project_id: str, *, name: str, description: str = "") -> dict[str, Any]:
        return self.request(
            "POST",
            self.project_path(project_id, "experiments"),
            json={"name": name, "description": description},
        )

    def create_run(
        self,
        project_id: str,
        *,
        experiment_id: str,
        name: str,
        kind: str = "training",
        parameters: Mapping[str, Any] | None = None,
        tags: Mapping[str, str] | None = None,
        model_version_id: str | None = None,
        code_version_id: str | None = None,
        input_dataset_version_ids: Sequence[str] = (),
        parent_run_id: str | None = None,
        environment: Mapping[str, Any] | None = None,
        execution_mode: ExecutionMode = "run",
    ) -> Run:
        from .run import Run

        try:
            validate_execution_mode(execution_mode)
        except ValueError as error:
            raise ConfigurationError(str(error)) from None
        run = self.request(
            "POST",
            self.project_path(project_id, "runs"),
            json={
                "experimentId": experiment_id,
                "name": name,
                "kind": kind,
                "parameters": dict(parameters or {}),
                "tags": dict(tags or {}),
                "modelVersionId": model_version_id,
                "codeVersionId": code_version_id,
                "inputDatasetVersionIds": list(input_dataset_version_ids),
                "parentRunId": parent_run_id,
                "environment": dict(environment or {}),
                "executionMode": execution_mode,
            },
        )
        return Run(self, project_id, run)

    def get_run(self, project_id: str, run_id: str, *, managed_by_worker: bool = False) -> Run:
        from .run import Run

        run = self.request("GET", self.project_path(project_id, f"runs/{path_id(run_id)}"), retryable=True)
        return Run(self, project_id, run, managed_by_worker=managed_by_worker)

    def search_runs(
        self,
        project_id: str,
        *,
        page_size: int = RUN_SEARCH_DEFAULT_PAGE_SIZE,
        **search: Any,
    ) -> Iterator[dict[str, Any]]:
        """Yield every matching Run summary, following ``nextCursor`` page by page.

        ``search`` takes ``filter``, ``order_by``, ``experiment_ids``, ``kinds``, ``statuses``,
        ``model_version_ids``, ``input_dataset_version_ids``, ``parent_run_id`` and ``name``.
        ``filter`` and ``order_by`` use MLflow search syntax, for example
        ``metrics.loss < 0.1 AND params.lr = '0.01'`` and ``metrics.loss ASC``.
        Pages are requested lazily, so stopping the iteration stops the requests.
        """
        if not 1 <= page_size <= RUN_SEARCH_MAX_PAGE_SIZE:
            raise ConfigurationError(f"page_size must be between 1 and {RUN_SEARCH_MAX_PAGE_SIZE}")
        conditions = {**build_run_search_body(**search), "limit": page_size}
        path = self.project_path(project_id, "runs/search")

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            body = {**conditions, "cursor": cursor} if cursor else conditions
            # Search only reads, so a lost response can be retried without side effects.
            return self.request("POST", path, json=body, retryable=True)

        return iterate_cursor_pages(fetch_page, label="Run search")

    def start_run(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        name: str | None = None,
        kind: str = "training",
        run_id: str | None = None,
        resume: ResumeMode = "never",
        mode: RunMode | None = None,
        system_metrics: bool = False,
        system_metrics_interval: float | None = None,
        **attributes: Any,
    ) -> Run:
        """Create and start a Run, resume one by run_id, or use the worker's Run (MMT_RUN_ID).

        resume: 'never' creates a new Run, 'must' reopens run_id and fails when it does not exist,
        'allow' reopens run_id or creates a Run with that ID. mode (else MMT_MODE): 'online' writes
        to the API, 'offline' to the local spool, 'auto' to the API until it becomes unreachable.
        system_metrics=True records `system.*` metrics every system_metrics_interval seconds.
        """
        run_mode = resolve_mode(mode, os.environ)
        if run_mode == "offline":
            return start_run_offline(
                project_id=project_id,
                experiment_id=experiment_id,
                name=name,
                kind=kind,
                run_id=run_id,
                resume=resume,
                system_metrics=system_metrics,
                system_metrics_interval=system_metrics_interval,
                api_url=self.settings.url,
                masker=self.masker,
                **attributes,
            )
        project_id = require_project_id(project_id)
        validate_resume(resume, run_id)
        worker_run_id = os.environ.get("MMT_RUN_ID")
        if resume != "never":
            run = self._resume_run(
                project_id,
                run_id=cast(str, run_id),
                resume=resume,
                run_mode=run_mode,
                experiment_id=experiment_id,
                name=name,
                kind=kind,
                attributes=attributes,
            )
        elif worker_run_id and name is None:
            return self.get_run(project_id, worker_run_id, managed_by_worker=True)
        else:
            run = self._create_started_run(
                project_id,
                experiment_id=experiment_id,
                name=name,
                kind=kind,
                run_mode=run_mode,
                attributes=attributes,
            )
        if system_metrics and system_metrics_enabled(os.environ):
            run.start_system_metrics(interval_seconds=system_metrics_interval)
        return run

    def _create_started_run(
        self,
        project_id: str,
        *,
        experiment_id: str | None,
        name: str | None,
        kind: str,
        run_mode: RunMode,
        attributes: Mapping[str, Any],
    ) -> Run:
        experiment_id = experiment_id or os.environ.get("MMT_EXPERIMENT_ID")
        if not experiment_id or not name:
            raise ConfigurationError("experiment_id and name are required to create a Run")
        try:
            run = self.create_run(project_id, experiment_id=experiment_id, name=name, kind=kind, **attributes)
        except ApiError as error:
            if run_mode != "auto" or not is_api_unreachable(error):
                raise
            print(
                "mado-tracking: the API is unreachable; recording the Run offline instead.",
                file=sys.stderr,
            )
            return start_offline_run(
                project_id=project_id,
                experiment_id=experiment_id,
                name=name,
                kind=kind,
                attributes=attributes,
                api_url=self.settings.url,
                masker=self.masker,
            )
        run.transport = self._run_transport(project_id, run.entity, run_mode)
        run.start()
        return run

    def _resume_run(
        self,
        project_id: str,
        *,
        run_id: str,
        resume: ResumeMode,
        run_mode: RunMode,
        experiment_id: str | None,
        name: str | None,
        kind: str,
        attributes: Mapping[str, Any],
    ) -> Run:
        """POST /runs/:r/resume; with resume='allow' a missing Run is created under run_id."""
        if os.environ.get("MMT_RUN_ID") or os.environ.get("MMT_JOB_ID"):
            raise ConfigurationError(
                "A worker-managed Run cannot be resumed; retry its Job from a checkpoint "
                "and continue with run.resume_checkpoint()"
            )
        try:
            # Resuming a running Run changes nothing, so a lost response can be retried.
            result = self.request(
                "POST",
                self.project_path(project_id, f"runs/{path_id(run_id)}/resume"),
                json={},
                retryable=True,
            )
        except ApiError as error:
            if error.code == "run_finalized":
                raise ConfigurationError(
                    f"Run {run_id} belongs to a Job and cannot be resumed; retry the Job from a checkpoint"
                ) from None
            if error.status_code != 404:
                raise
            if resume == "must":
                raise ConfigurationError(
                    f"Run {run_id} does not exist; resume='must' needs an existing Run"
                ) from None
            entity = self._create_run_with_id(
                project_id, run_id, experiment_id=experiment_id, name=name, kind=kind, attributes=attributes
            )
            last_steps: dict[str, int] = {}
        else:
            entity = result["run"]
            last_steps = {str(key): int(step) for key, step in result.get("lastSteps", {}).items()}
        return Run(
            self,
            project_id,
            entity,
            transport=self._run_transport(project_id, entity, run_mode),
            last_steps=last_steps,
        )

    def _create_run_with_id(
        self,
        project_id: str,
        run_id: str,
        *,
        experiment_id: str | None,
        name: str | None,
        kind: str,
        attributes: Mapping[str, Any],
    ) -> dict[str, Any]:
        """PUT /sync/runs/:runId is the only way to create a Run under a client-chosen ID."""
        experiment_id = experiment_id or os.environ.get("MMT_EXPERIMENT_ID")
        if not experiment_id or not name:
            raise ConfigurationError(
                "experiment_id and name are required when resume='allow' creates the Run"
            )
        if unsupported := sorted(set(attributes) - OFFLINE_RUN_ATTRIBUTES):
            raise ConfigurationError(f"resume='allow' cannot create a Run with {', '.join(unsupported)}")
        return self.request(
            "PUT",
            self.project_path(project_id, f"sync/runs/{path_id(run_id)}"),
            json={
                "experimentId": experiment_id,
                "name": name,
                "kind": kind,
                "parameters": dict(attributes.get("parameters") or {}),
                "tags": dict(attributes.get("tags") or {}),
                "parentRunId": attributes.get("parent_run_id"),
                "startedAt": utc_timestamp(),
            },
            # The PUT returns the existing Run unchanged, so a lost response can be retried.
            retryable=True,
        )

    def _run_transport(self, project_id: str, entity: Mapping[str, Any], run_mode: RunMode) -> RunTransport:
        online = HttpRunTransport(self, project_id, str(entity["id"]))
        if run_mode != "auto":
            return online
        record = spool_record_from_entity(entity, project_id=project_id, api_url=self.settings.url)
        return AutoRunTransport(
            online, lambda: RunSpool.create(default_offline_directory(), record, run_created=True)
        )

    def register_model(
        self,
        project_id: str,
        *,
        version: str | None = None,
        model_id: str | None = None,
        model_name: str | None = None,
        name: str | None = None,
        family: str | None = None,
        description: str = "",
        parent_model_version_ids: Sequence[str] = (),
        source_run_id: str | None = None,
        weights_uri: str | None = None,
        artifact_id: str | None = None,
        default_code_version_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Register a ModelVersion; an omitted version is numbered by the API (1, 2, 3, ...).

        ``model_name`` (or the older ``name``) reuses the Model with that name and creates it
        only when it does not exist yet.
        """
        if name is not None and model_name is not None and name != model_name:
            raise ConfigurationError("Specify either model_name or name, not both")
        model_name = model_name if model_name is not None else name
        if model_id is None:
            if not model_name:
                raise ConfigurationError("model_id or model_name is required")
            model = self.ensure_model(project_id, name=model_name, family=family, description=description)
            model_id = model["id"]
        payload: dict[str, Any] = {
            "parentModelVersionIds": list(parent_model_version_ids),
            "sourceRunId": source_run_id,
            "weightsUri": weights_uri,
            "artifactId": artifact_id,
            "defaultCodeVersionId": default_code_version_id,
            "metadata": dict(metadata or {}),
        }
        if version is not None:
            payload["version"] = version
        return self.request(
            "POST",
            self.project_path(project_id, f"models/{path_id(model_id)}/versions"),
            json=payload,
        )

    def find_model(self, project_id: str, *, name: str) -> dict[str, Any] | None:
        models = self.list_project_items(project_id, "models", params={"name": name})
        return models[0] if models else None

    def ensure_model(
        self, project_id: str, *, name: str, family: str | None = None, description: str = ""
    ) -> dict[str, Any]:
        """Return the Model named ``name``, creating it when absent.

        A concurrent creator can win between the lookup and the POST; the 409 is then
        resolved by reading the Model it created.
        """
        model = self.find_model(project_id, name=name)
        if model is None:
            if not family:
                raise ConfigurationError("family is required to create a Model")
            try:
                return self.request(
                    "POST",
                    self.project_path(project_id, "models"),
                    json={"name": name, "family": family, "description": description},
                )
            except ApiError as error:
                if error.status_code != 409:
                    raise
            model = self.find_model(project_id, name=name)
            if model is None:
                raise ConfigurationError(f"Model {name!r} conflicted but could not be read")
        if family and model["family"] != family:
            raise ConfigurationError(f"Model {name!r} has family {model['family']!r}, not {family!r}")
        return model

    def register_dataset(
        self,
        project_id: str,
        *,
        version: str | None = None,
        uri: str | None = None,
        digest: str | None = None,
        files: str | os.PathLike[str] | None = None,
        dataset_id: str | None = None,
        name: str | None = None,
        namespace: str = "default",
        description: str = "",
        schema: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
        source_run_id: str | None = None,
        parent_dataset_version_ids: Sequence[str] = (),
        external_ref: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        """Register a DatasetVersion that refers to ``uri``, or upload the directory ``files``.

        With ``files`` the directory is uploaded as Artifacts and the API computes the uri and
        digest; unchanged files already in the Project are not sent again. Without ``files``,
        ``version``, ``uri`` and ``digest`` are required.
        """
        if files is not None:
            if uri is not None or digest is not None:
                raise ConfigurationError("files replaces uri and digest; do not give them together")
            if source_run_id is not None or parent_dataset_version_ids or external_ref:
                raise ConfigurationError(
                    "files does not support source_run_id, parent_dataset_version_ids or external_ref"
                )
        elif version is None or uri is None or digest is None:
            raise ConfigurationError("version, uri and digest are required without files")
        dataset_id = dataset_id or self._create_dataset(
            project_id, name=name, namespace=namespace, description=description
        )
        if files is not None:
            return upload_dataset_directory(
                self, project_id, dataset_id, files, version=version, metadata=metadata, schema=schema
            )
        return self.request(
            "POST",
            self.project_path(project_id, f"datasets/{path_id(dataset_id)}/versions"),
            json={
                "version": version,
                "uri": uri,
                "digest": digest,
                "schema": dict(schema or {}),
                "metadata": dict(metadata or {}),
                "sourceRunId": source_run_id,
                "parentDatasetVersionIds": list(parent_dataset_version_ids),
                "externalRef": dict(external_ref) if external_ref else None,
            },
        )

    def _create_dataset(self, project_id: str, *, name: str | None, namespace: str, description: str) -> str:
        if not name:
            raise ConfigurationError("name is required to create a Dataset")
        dataset = self.request(
            "POST",
            self.project_path(project_id, "datasets"),
            json={"name": name, "namespace": namespace, "description": description},
        )
        dataset_id: str = dataset["id"]
        return dataset_id

    def register_code(
        self,
        project_id: str,
        *,
        name: str,
        version: str,
        source: Mapping[str, Any] | None = None,
        entrypoint: Sequence[str],
        test_entrypoint: Sequence[str] = (),
        runtime: ExecutionRuntime | None = None,
        requirements: Sequence[str] = (),
        environment: Mapping[str, str] | None = None,
        supported_model_families: Sequence[str] = (),
        task_types: Sequence[str] = (),
        description: str = "",
        code_id: str | None = None,
    ) -> dict[str, Any]:
        try:
            payload = build_code_version_payload(
                version=version,
                source=source,
                entrypoint=entrypoint,
                test_entrypoint=test_entrypoint,
                runtime=runtime,
                requirements=requirements,
                environment=environment,
                supported_model_families=supported_model_families,
                task_types=task_types,
            )
        except ValueError as error:
            raise ConfigurationError(str(error)) from None
        if code_id is None:
            code = self.request(
                "POST",
                self.project_path(project_id, "codes"),
                json={"name": name, "description": description},
            )
            code_id = code["id"]
        return self._save_code_version(project_id, code_id, payload=payload)

    def create_code_version(
        self,
        project_id: str,
        *,
        code_id: str,
        version: str,
        source: Mapping[str, Any] | None = None,
        entrypoint: Sequence[str],
        test_entrypoint: Sequence[str] = (),
        runtime: ExecutionRuntime | None = None,
        requirements: Sequence[str] = (),
        environment: Mapping[str, str] | None = None,
        supported_model_families: Sequence[str] = (),
        task_types: Sequence[str] = (),
    ) -> dict[str, Any]:
        try:
            payload = build_code_version_payload(
                version=version,
                source=source,
                entrypoint=entrypoint,
                test_entrypoint=test_entrypoint,
                runtime=runtime,
                requirements=requirements,
                environment=environment,
                supported_model_families=supported_model_families,
                task_types=task_types,
            )
        except ValueError as error:
            raise ConfigurationError(str(error)) from None
        return self._save_code_version(project_id, code_id, payload=payload)

    def _save_code_version(self, project_id: str, code_id: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request(
            "POST",
            self.project_path(project_id, f"codes/{path_id(code_id)}/versions"),
            json=payload,
        )

    def list_automation_rules(self, project_id: str) -> list[dict[str, Any]]:
        return self.list_project_items(project_id, "automation-rules")

    def set_automation_rule_enabled(self, project_id: str, rule_id: str, *, enabled: bool) -> dict[str, Any]:
        return self.request(
            "PATCH",
            self.project_path(project_id, f"automation-rules/{path_id(rule_id)}"),
            json={"enabled": enabled},
            retryable=True,
        )

    def list_project_items(
        self, project_id: str, resource: str, *, params: Mapping[str, str] | None = None
    ) -> list[dict[str, Any]]:
        """Items of a Project list endpoint that answers in one page ``{items}``."""
        payload = self.request("GET", self.project_path(project_id, resource), retryable=True, params=params)
        items = payload.get("items")
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise ConfigurationError("API list response must contain items")
        return items

    def create_job(
        self,
        project_id: str,
        *,
        run_id: str,
        target_id: str,
        gpu_ids: Sequence[str] = (),
        max_attempts: int = 1,
    ) -> dict[str, Any]:
        return self.request(
            "POST",
            self.project_path(project_id, "jobs"),
            json={
                "runId": run_id,
                "targetId": target_id,
                "gpuIds": list(gpu_ids),
                "maxAttempts": max_attempts,
            },
        )

    def download_artifact_to(
        self, project_id: str, artifact_id: str, destination: BinaryIO
    ) -> dict[str, Any]:
        """Write an Artifact into a seekable stream, resuming with Range after an interruption.

        Returns the received {sha256, size}; the sha256 is already checked against the version's ETag.
        """
        return download_resumable_sync(
            self.http,
            self.project_path(project_id, f"artifacts/{path_id(artifact_id)}/content"),
            destination,
            masker=self.masker,
        )

    def download_artifact(self, project_id: str, artifact_id: str) -> Iterator[bytes]:
        path = self.project_path(project_id, f"artifacts/{path_id(artifact_id)}/content")
        with self.http.stream("GET", path) as response:
            from .http import check_response

            if not response.is_success:
                response.read()
                check_response(response, self.masker)
            yield from response.iter_bytes()


def require_project_id(project_id: str | None) -> str:
    project_id = project_id or os.environ.get("MMT_PROJECT_ID")
    if not project_id:
        raise ConfigurationError("project_id or MMT_PROJECT_ID is required")
    return project_id


def validate_resume(resume: str, run_id: str | None) -> None:
    if resume not in RESUME_MODES:
        raise ConfigurationError(f"resume must be one of {', '.join(RESUME_MODES)}, not {resume!r}")
    if resume != "never" and not run_id:
        raise ConfigurationError(f"resume={resume!r} needs run_id")
    if resume == "never" and run_id:
        raise ConfigurationError("run_id needs resume='allow' or resume='must'")


def system_metrics_enabled(environment: Mapping[str, str]) -> bool:
    """False inside a worker Job (the worker records the same metrics) or with MMT_SYSTEM_METRICS=false."""
    if environment.get("MMT_JOB_ID"):
        return False
    return environment.get("MMT_SYSTEM_METRICS", "").strip().lower() not in SYSTEM_METRICS_DISABLED_VALUES


def start_run_offline(
    *,
    project_id: str | None = None,
    experiment_id: str | None = None,
    name: str | None = None,
    kind: str = "training",
    run_id: str | None = None,
    resume: ResumeMode = "never",
    system_metrics: bool = False,
    system_metrics_interval: float | None = None,
    api_url: str | None = None,
    masker: SecretMasker | None = None,
    **attributes: Any,
) -> Run:
    """Client.start_run(mode='offline') without an API URL or token; nothing contacts the API."""
    if os.environ.get("MMT_JOB_ID"):
        # Job tokens cannot use /sync, and the worker records the Job's Run online.
        raise ConfigurationError("A worker Job records online; do not set MMT_MODE=offline for a Job")
    project_id = require_project_id(project_id)
    validate_resume(resume, run_id)
    if resume != "never":
        raise ConfigurationError("An offline Run cannot be resumed; resume it online, then log offline")
    experiment_id = experiment_id or os.environ.get("MMT_EXPERIMENT_ID")
    if not experiment_id or not name:
        raise ConfigurationError("experiment_id and name are required to create a Run")
    run = start_offline_run(
        project_id=project_id,
        experiment_id=experiment_id,
        name=name,
        kind=kind,
        attributes=attributes,
        api_url=api_url,
        masker=masker,
    )
    if system_metrics and system_metrics_enabled(os.environ):
        run.start_system_metrics(interval_seconds=system_metrics_interval)
    return run


from .offline import OFFLINE_RUN_ATTRIBUTES, start_offline_run  # noqa: E402
from .offline.spool import RunSpool, default_offline_directory  # noqa: E402
from .offline.transport import (  # noqa: E402
    AutoRunTransport,
    HttpRunTransport,
    RunMode,
    RunTransport,
    is_api_unreachable,
    resolve_mode,
    spool_record_from_entity,
)
from .run import Run  # noqa: E402
