"""Authenticated SDK operations using the public /api contract."""

from __future__ import annotations

import os
from collections.abc import Iterator, Mapping, Sequence
from typing import Any
from urllib.parse import quote

import httpx

from .errors import ConfigurationError
from .http import REQUEST_TIMEOUT_SECONDS, request_sync
from .security import SecretMasker, secret_values
from .settings import ApiSettings


def path_id(identifier: str) -> str:
    if not identifier:
        raise ConfigurationError("An entity ID is required")
    return quote(identifier, safe="")


class Client:
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
    ) -> Run:
        from .run import Run

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
            },
        )
        return Run(self, project_id, run)

    def get_run(self, project_id: str, run_id: str, *, managed_by_worker: bool = False) -> Run:
        from .run import Run

        run = self.request("GET", self.project_path(project_id, f"runs/{path_id(run_id)}"), retryable=True)
        return Run(self, project_id, run, managed_by_worker=managed_by_worker)

    def start_run(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        name: str | None = None,
        kind: str = "training",
        **attributes: Any,
    ) -> Run:
        project_id = project_id or os.environ.get("MMT_PROJECT_ID")
        if not project_id:
            raise ConfigurationError("project_id or MMT_PROJECT_ID is required")
        existing_run_id = os.environ.get("MMT_RUN_ID")
        if existing_run_id and name is None:
            return self.get_run(project_id, existing_run_id, managed_by_worker=True)
        experiment_id = experiment_id or os.environ.get("MMT_EXPERIMENT_ID")
        if not experiment_id or not name:
            raise ConfigurationError("experiment_id and name are required to create a Run")
        run = self.create_run(project_id, experiment_id=experiment_id, name=name, kind=kind, **attributes)
        run.start()
        return run

    def register_model(
        self,
        project_id: str,
        *,
        version: str,
        model_id: str | None = None,
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
        if model_id is None:
            if not name or not family:
                raise ConfigurationError("name and family are required to create a Model")
            model = self.request(
                "POST",
                self.project_path(project_id, "models"),
                json={"name": name, "family": family, "description": description},
            )
            model_id = model["id"]
        return self.request(
            "POST",
            self.project_path(project_id, f"models/{path_id(model_id)}/versions"),
            json={
                "version": version,
                "parentModelVersionIds": list(parent_model_version_ids),
                "sourceRunId": source_run_id,
                "weightsUri": weights_uri,
                "artifactId": artifact_id,
                "defaultCodeVersionId": default_code_version_id,
                "metadata": dict(metadata or {}),
            },
        )

    def register_dataset(
        self,
        project_id: str,
        *,
        version: str,
        uri: str,
        digest: str,
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
        if dataset_id is None:
            if not name:
                raise ConfigurationError("name is required to create a Dataset")
            dataset = self.request(
                "POST",
                self.project_path(project_id, "datasets"),
                json={"name": name, "namespace": namespace, "description": description},
            )
            dataset_id = dataset["id"]
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

    def register_code(
        self,
        project_id: str,
        *,
        name: str,
        version: str,
        source: Mapping[str, Any],
        entrypoint: Sequence[str],
        requirements: Sequence[str] = (),
        environment: Mapping[str, str] | None = None,
        supported_model_families: Sequence[str] = (),
        task_types: Sequence[str] = (),
        description: str = "",
        code_id: str | None = None,
    ) -> dict[str, Any]:
        if code_id is None:
            code = self.request(
                "POST",
                self.project_path(project_id, "codes"),
                json={"name": name, "description": description},
            )
            code_id = code["id"]
        return self.request(
            "POST",
            self.project_path(project_id, f"codes/{path_id(code_id)}/versions"),
            json={
                "version": version,
                "source": dict(source),
                "entrypoint": list(entrypoint),
                "requirements": list(requirements),
                "environment": dict(environment or {}),
                "supportedModelFamilies": list(supported_model_families),
                "taskTypes": list(task_types),
            },
        )

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

    def download_artifact(self, project_id: str, artifact_id: str) -> Iterator[bytes]:
        path = self.project_path(project_id, f"artifacts/{path_id(artifact_id)}/content")
        with self.http.stream("GET", path) as response:
            from .http import check_response

            if not response.is_success:
                response.read()
                check_response(response, self.masker)
            yield from response.iter_bytes()


from .run import Run  # noqa: E402
