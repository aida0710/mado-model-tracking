from __future__ import annotations

import json

import httpx
import pytest

from mado_tracking import Client, ConfigurationError
from mado_tracking.worker.contracts import WorkerJob


def recording_sdk():
    requests = []

    def serve(request):
        payload = json.loads(request.content) if request.content else {}
        requests.append((request.method, request.url.path, payload))
        return httpx.Response(200, json={"id": "registered", **payload})

    return Client(
        api_url="http://localhost", api_token="sdk-fixture-token", transport=httpx.MockTransport(serve)
    ), requests


def test_python_code_registration_preserves_the_existing_payload_default():
    client, requests = recording_sdk()
    source = {"kind": "inline", "files": {"main.py": "print('python')"}}
    with client:
        client.register_code(
            "project",
            name="python",
            code_id="code",
            version="v1",
            source=source,
            entrypoint=["python", "main.py"],
            requirements=["numpy"],
        )
    assert requests[0][2]["source"] == source and "runtime" not in requests[0][2]


@pytest.mark.parametrize(
    "runtime",
    [
        {"kind": "docker", "image": "example/model@sha256:" + "a" * 64, "workingDirectory": "/app"},
        {"kind": "singularity", "artifactId": "saved", "sha256": "b" * 64},
        {"kind": "apptainer", "artifactId": "saved", "sha256": "b" * 64},
    ],
)
def test_container_registration_accepts_an_image_with_no_source(runtime):
    client, requests = recording_sdk()
    with client:
        client.register_code(
            "project",
            name="container",
            code_id="code",
            version="v1",
            source=None,
            runtime=runtime,
            entrypoint=["/app/predict"],
        )
    assert requests[0][2]["source"] is None and requests[0][2]["runtime"] == runtime
    assert requests[0][2]["requirements"] == []


@pytest.mark.parametrize(
    "runtime,source,requirements",
    [
        (None, None, []),
        ({"kind": "docker", "image": "model:latest"}, None, []),
        ({"kind": "docker", "image": "model@sha256:" + "a" * 64}, None, ["numpy"]),
        ({"kind": "apptainer", "artifactId": "saved", "sha256": "not-a-hash"}, None, []),
    ],
)
def test_invalid_runtime_registration_fails_before_creating_a_registry_entity(runtime, source, requirements):
    client, requests = recording_sdk()
    with client, pytest.raises(ConfigurationError):
        client.register_code(
            "project",
            name="bad",
            version="v1",
            source=source,
            runtime=runtime,
            requirements=requirements,
            entrypoint=["predict"],
        )
    assert not requests


def test_compute_target_capability_must_match_the_registered_runtime(job_payload):
    job_payload["codeVersion"].update(
        source=None, runtime={"kind": "docker", "image": "model@sha256:" + "a" * 64}
    )
    with pytest.raises(ConfigurationError, match="support"):
        WorkerJob.parse(job_payload)
    job_payload["target"]["runtimeKinds"] = ["python", "docker"]
    assert WorkerJob.parse(job_payload).runtime["kind"] == "docker"


@pytest.mark.parametrize("entrypoint", [[], [""], "python main.py", ["python", "argument\x00"]])
def test_invalid_entrypoint_is_rejected_before_the_code_is_registered(entrypoint):
    client, requests = recording_sdk()
    with client, pytest.raises(ConfigurationError, match="argv"):
        client.register_code(
            "project",
            name="bad",
            version="v1",
            source={"kind": "inline", "files": {}},
            entrypoint=entrypoint,
        )
    assert not requests


def test_automation_convenience_methods_use_fixed_versions_and_toggle_only_enabled():
    client, requests = recording_sdk()
    with client:
        rule = client.create_automation_rule(
            "project",
            name="evaluate",
            model_families=["linear"],
            kind="evaluation",
            experiment_id="experiment",
            code_version_id="code-version",
            target_id="target",
            gpu_ids=["0"],
            input_dataset_version_ids=["dataset-version"],
            parameters={"batch": 2},
        )
        client.set_automation_rule_enabled("project", rule["id"], enabled=False)
    assert requests[0][2]["codeVersionId"] == "code-version"
    assert requests[0][2]["inputDatasetVersionIds"] == ["dataset-version"]
    assert requests[1] == ("PATCH", "/api/projects/project/automation-rules/registered", {"enabled": False})
