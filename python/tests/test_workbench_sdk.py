from __future__ import annotations

import json

import httpx
import pytest
from test_container_sdk import recording_sdk

from mado_tracking import ApiError, Client, ConfigurationError


def test_code_version_sdk_keeps_the_pinned_commit_overlay_deletions_and_test_command():
    client, calls = recording_sdk()
    source = {
        "kind": "git",
        "url": "https://example.invalid/code.git",
        "commit": "a" * 40,
        "files": {"main.py": "print('edited')", "new.py": "print('added')"},
        "deletedFiles": ["old.py"],
    }
    with client:
        client.create_code_version(
            "project",
            code_id="code",
            version="v2",
            source=source,
            entrypoint=["python", "main.py"],
            test_entrypoint=["python", "-m", "unittest"],
        )
    assert calls == [
        (
            "POST",
            "/api/projects/project/codes/code/versions",
            {
                "version": "v2",
                "source": source,
                "entrypoint": ["python", "main.py"],
                "testEntrypoint": ["python", "-m", "unittest"],
                "requirements": [],
                "environment": {},
                "supportedModelFamilies": [],
                "taskTypes": [],
            },
        )
    ]


@pytest.mark.parametrize("test_entrypoint", ["", "python test.py", [""], ["python", "argument\x00"], None])
def test_invalid_test_command_is_rejected_before_the_sdk_creates_code(test_entrypoint):
    client, calls = recording_sdk()
    with client, pytest.raises(ConfigurationError, match="argv"):
        client.register_code(
            "project",
            name="test",
            version="v1",
            source={"kind": "inline", "files": {"main.py": "ok"}},
            entrypoint=["python", "main.py"],
            test_entrypoint=test_entrypoint,
        )
    assert not calls


@pytest.mark.parametrize(
    "edits",
    [
        {"files": {".git/config": "bad"}},
        {"deletedFiles": ["../private"]},
        {"files": {"main.py": "new"}, "deletedFiles": ["main.py"]},
        {"deletedFiles": ["main.py", "main.py"]},
    ],
)
def test_unsafe_git_edits_fail_before_any_registry_request(edits):
    client, calls = recording_sdk()
    source = {"kind": "git", "url": "https://example.invalid/code.git", "commit": "a" * 40, **edits}
    with client, pytest.raises(ConfigurationError):
        client.register_code(
            "project", name="edited", version="v1", source=source, entrypoint=["python", "main.py"]
        )
    assert not calls


def task_sdk():
    calls = []

    def serve(request):
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, dict(request.url.params), body))
        if request.method == "GET" and (
            request.url.path.endswith("/tasks") or request.url.path.endswith("/runs")
        ):
            return httpx.Response(200, json={"items": [{"id": "listed"}]})
        return httpx.Response(200, json={"id": "task", "revision": 2, **(body or {})})

    return Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    ), calls


def test_task_sdk_creates_gets_lists_updates_and_reads_history_with_fixed_revision():
    client, calls = task_sdk()
    with client:
        client.create_task(
            "p",
            experiment_id="e",
            name="training",
            kind="training",
            code_version_id="code-v1",
            model_version_id="model-v1",
            input_dataset_version_ids=["dataset-v1"],
            target_id="cpu",
            gpu_ids=[],
            parameters={"steps": 3},
            tags={"owner": "test"},
        )
        client.get_task("p", "task")
        assert client.list_tasks("p", experiment_id="e") == [{"id": "listed"}]
        client.update_task(
            "p", "task", expected_revision=1, changes={"name": "changed", "codeVersionId": "code-v2"}
        )
        assert client.list_task_runs("p", "task") == [{"id": "listed"}]
    assert calls[0][3] == {
        "experimentId": "e",
        "name": "training",
        "description": "",
        "kind": "training",
        "codeVersionId": "code-v1",
        "modelVersionId": "model-v1",
        "inputDatasetVersionIds": ["dataset-v1"],
        "parameters": {"steps": 3},
        "tags": {"owner": "test"},
        "targetId": "cpu",
        "gpuIds": [],
    }
    assert calls[2][2] == {"experimentId": "e"}
    assert calls[3][3] == {"expectedRevision": 1, "name": "changed", "codeVersionId": "code-v2"}
    assert calls[4][1] == "/api/projects/p/tasks/task/runs"


@pytest.mark.parametrize(
    "last_page", [{"items": [{"id": "third"}], "nextCursor": None}, {"items": [{"id": "third"}]}]
)
def test_task_history_sdk_follows_pages_and_preserves_the_list_return_value(last_page):
    pages = [
        {"items": [{"id": "first"}], "nextCursor": "first"},
        {"items": [{"id": "second"}], "nextCursor": "second"},
        last_page,
    ]
    cursors = []

    def serve(request):
        assert request.method == "GET" and request.url.path.endswith("/tasks/task/runs")
        cursors.append(dict(request.url.params))
        return httpx.Response(200, json=pages[len(cursors) - 1])

    with Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    ) as client:
        assert client.list_task_runs("p", "task") == [{"id": "first"}, {"id": "second"}, {"id": "third"}]
    assert cursors == [{}, {"cursor": "first"}, {"cursor": "second"}]


@pytest.mark.parametrize("cursors", [["first", "first"], ["first", "second", "first"], [""], [42], [False]])
def test_task_history_sdk_rejects_cyclic_or_malformed_cursors_without_repeating_the_request(cursors):
    calls = []

    def serve(request):
        calls.append(dict(request.url.params))
        return httpx.Response(200, json={"items": [], "nextCursor": cursors[len(calls) - 1]})

    with Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    ) as client:
        with pytest.raises(ConfigurationError, match="pagination cursor"):
            client.list_task_runs("p", "task")
    assert len(calls) == len(cursors)


def test_task_launch_distinguishes_inherited_defaults_from_explicit_null_and_empty_arrays():
    client, calls = task_sdk()
    with client:
        client.launch_task("p", "task", expected_revision=2)
        client.launch_task(
            "p",
            "task",
            expected_revision=2,
            execution_mode="test",
            model_version_id=None,
            input_dataset_version_ids=[],
            gpu_ids=[],
            target_id="cpu",
            parameters={"steps": 1},
        )
    assert calls[0][3] == {"expectedRevision": 2, "executionMode": "run"}
    assert calls[1][3] == {
        "expectedRevision": 2,
        "executionMode": "test",
        "modelVersionId": None,
        "inputDatasetVersionIds": [],
        "gpuIds": [],
        "targetId": "cpu",
        "parameters": {"steps": 1},
    }


@pytest.mark.parametrize("revision", [0, -1, True, 1.5, 2**31])
def test_invalid_task_revision_cannot_launch_or_patch_a_task(revision):
    client, calls = task_sdk()
    with client:
        with pytest.raises(ConfigurationError, match="revision"):
            client.launch_task("p", "task", expected_revision=revision)
        with pytest.raises(ConfigurationError, match="revision"):
            client.update_task("p", "task", expected_revision=revision, changes={"name": "changed"})
    assert not calls


def test_task_patch_cannot_replace_experiment_or_revision():
    client, calls = task_sdk()
    with client, pytest.raises(ConfigurationError, match="immutable"):
        client.update_task(
            "p", "task", expected_revision=1, changes={"experimentId": "other", "expectedRevision": 2}
        )
    assert not calls


@pytest.mark.parametrize("status", [409, "lost-response"])
def test_task_launch_conflict_or_response_loss_is_not_replayed(status):
    calls = 0

    def serve(request):
        nonlocal calls
        calls += 1
        if status == "lost-response":
            raise httpx.ReadError("response lost", request=request)
        return httpx.Response(status, json={"error": "revision changed"})

    with Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    ) as client:
        with pytest.raises(ApiError):
            client.launch_task("p", "task", expected_revision=1)
    assert calls == 1


def test_sdk_run_creation_sends_test_execution_mode():
    client, calls = recording_sdk()
    with client:
        client.create_run(
            "p", experiment_id="e", name="test run", code_version_id="code-v1", execution_mode="test"
        )
    assert calls[0][2]["executionMode"] == "test"
