"""Registry features of the native API through the SDK: aliases, evaluation, promotion, automation,
Service Accounts and owner transfers, checked against a recording fake HTTP API."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from mado_tracking import ApiError, Client, ConfigurationError
from mado_tracking.evaluation import reference_dataset_version_ids
from mado_tracking.upstream import download_upstream_artifacts

PROJECT = "project-1"
PROJECT_PATH = f"/api/projects/{PROJECT}"

Recorded = list[tuple[str, str, dict[str, str], Any]]
Responder = Callable[[httpx.Request], httpx.Response]


def recording_client(respond: Responder | None = None) -> tuple[Client, Recorded]:
    """A Client whose requests are recorded as (method, encoded path, query, json body)."""
    requests: Recorded = []

    def serve(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        # The raw path keeps percent-encoding, so a quoted path segment stays visible.
        raw_path = request.url.raw_path.decode().split("?", 1)[0]
        requests.append((request.method, raw_path, dict(request.url.params), body))
        if respond is not None:
            return respond(request)
        return httpx.Response(200, json={"id": "created", **(body or {})})

    client = Client(
        api_url="http://localhost", api_token="sdk-test-secret", transport=httpx.MockTransport(serve)
    )
    return client, requests


def paged_responder(pages: list[dict[str, Any]]) -> Responder:
    served = iter(pages)
    return lambda _request: httpx.Response(200, json=next(served))


def test_setting_an_alias_sends_the_version_and_reason_and_retries_a_lost_response():
    attempts = []

    def respond(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        if len(attempts) == 1:
            return httpx.Response(503, headers={"retry-after": "0"}, json={"error": "busy"})
        return httpx.Response(200, json={"id": "model-1", "aliases": {"production": "version-2"}})

    client, requests = recording_client(respond)
    with client:
        model = client.set_model_alias(
            PROJECT, "model-1", "production", version_id="version-2", reason="良い評価"
        )
    assert model["aliases"] == {"production": "version-2"}
    assert [request[:2] for request in requests] == [
        ("PUT", f"{PROJECT_PATH}/models/model-1/aliases/production")
    ] * 2
    assert requests[-1][3] == {"versionId": "version-2", "reason": "良い評価"}


def test_alias_evaluation_id_is_sent_only_when_given():
    client, requests = recording_client()
    with client:
        client.set_model_alias(PROJECT, "model-1", "staging", version_id="v")
        client.set_model_alias(PROJECT, "model-1", "production", version_id="v", evaluation_id="evaluation-9")
    assert requests[0][3] == {"versionId": "v"}
    assert requests[1][3] == {"versionId": "v", "promotionEvaluationId": "evaluation-9"}


def test_alias_names_are_quoted_as_one_path_segment():
    client, requests = recording_client(lambda _request: httpx.Response(204))
    with client:
        client.delete_model_alias(PROJECT, "model-1", "a/b", reason="rollback")
    assert requests == [
        ("DELETE", f"{PROJECT_PATH}/models/model-1/aliases/a%2Fb", {}, {"reason": "rollback"})
    ]


def test_alias_removal_is_not_resent_after_a_server_error():
    client, requests = recording_client(lambda _request: httpx.Response(503, json={"error": "busy"}))
    with client, pytest.raises(ApiError):
        client.delete_model_alias(PROJECT, "model-1", "production")
    assert len(requests) == 1 and requests[0][3] is None


def test_alias_events_are_read_lazily_page_by_page_with_the_same_conditions():
    client, requests = recording_client(
        paged_responder(
            [
                {"items": [{"id": "event-3"}, {"id": "event-2"}], "nextCursor": "event-2"},
                {"items": [{"id": "event-1"}], "nextCursor": None},
            ]
        )
    )
    with client:
        events = client.list_alias_events(PROJECT, "model-1", alias="production", page_size=2)
        assert requests == []
        assert [event["id"] for event in events] == ["event-3", "event-2", "event-1"]
    path = f"{PROJECT_PATH}/models/model-1/alias-events"
    assert requests == [
        ("GET", path, {"alias": "production", "limit": "2"}, None),
        ("GET", path, {"alias": "production", "limit": "2", "cursor": "event-2"}, None),
    ]


def test_alias_event_page_size_beyond_the_api_limit_is_rejected_before_any_request():
    client, requests = recording_client()
    with client, pytest.raises(ConfigurationError, match="page_size"):
        client.list_alias_events(PROJECT, "model-1", page_size=201)
    assert requests == []


def test_baseline_comparison_sends_lists_as_comma_separated_values_and_keeps_an_explicit_empty_set():
    client, requests = recording_client(lambda _request: httpx.Response(200, json={"status": "ok"}))
    with client:
        result = client.compare_to_baseline(
            PROJECT,
            "model-1",
            "candidate-2",
            baseline_alias="production",
            reference_dataset_version_ids=["reference-a", "reference-b"],
            metrics=["wer", "cer"],
        )
        client.compare_to_baseline(PROJECT, "model-1", "candidate-2", reference_dataset_version_ids=[])
    assert result == {"status": "ok"}
    path = f"{PROJECT_PATH}/models/model-1/versions/candidate-2/evaluation-comparison"
    assert requests[0][:3] == (
        "GET",
        path,
        {
            "baselineAlias": "production",
            "referenceDatasetVersionIds": "reference-a,reference-b",
            "metrics": "wer,cer",
        },
    )
    assert requests[1][2] == {"referenceDatasetVersionIds": ""}


def test_baseline_comparison_accepts_only_one_kind_of_baseline():
    client, requests = recording_client()
    with client, pytest.raises(ConfigurationError, match="baseline"):
        client.compare_to_baseline(PROJECT, "m", "v", baseline_alias="production", baseline_version_id="v1")
    assert requests == []


def test_reference_set_is_the_inputs_without_the_upstream_outputs_in_input_order():
    run = {
        "inputDatasetVersionIds": ["reference-b", "inference-output", "reference-a"],
        "upstreamDatasetVersionIds": ["inference-output"],
    }
    assert reference_dataset_version_ids(run) == ["reference-b", "reference-a"]
    assert reference_dataset_version_ids({"inputDatasetVersionIds": ["only"]}) == ["only"]


def test_reference_set_reads_the_entity_of_a_fetched_run():
    run_entity = {
        "id": "run-1",
        "inputDatasetVersionIds": ["reference", "upstream"],
        "upstreamDatasetVersionIds": ["upstream"],
    }
    client, _requests = recording_client(lambda _request: httpx.Response(200, json=run_entity))
    with client:
        run = client.get_run(PROJECT, "run-1")
    assert reference_dataset_version_ids(run) == ["reference"]


def test_promotion_policy_sends_criteria_and_leaves_unset_options_to_the_api():
    client, requests = recording_client()
    criterion = {"metric": "wer", "direction": "lower", "mode": "delta", "threshold": 0.0}
    with client:
        client.create_promotion_policy(
            PROJECT,
            name="wer gate",
            model_id="model-1",
            target_alias="production",
            evaluation_rule_id="rule-evaluate",
            criteria=[criterion],
            missing_baseline="fail",
        )
    method, path, _query, body = requests[0]
    assert (method, path) == ("POST", f"{PROJECT_PATH}/promotion-policies")
    assert body == {
        "name": "wer gate",
        "modelId": "model-1",
        "targetAlias": "production",
        "evaluationRuleId": "rule-evaluate",
        "criteria": [criterion],
        "enabled": True,
        "missingBaseline": "fail",
    }


def test_promotion_policy_rejects_incomplete_criteria_before_any_request():
    client, requests = recording_client()
    with client, pytest.raises(ConfigurationError, match="criteria"):
        client.create_promotion_policy(
            PROJECT,
            name="gate",
            model_id="m",
            target_alias="production",
            evaluation_rule_id="r",
            criteria=[{"metric": "wer", "direction": "lower"}],
        )
    assert requests == []


def test_promotion_evaluations_follow_cursors_with_the_filters():
    client, requests = recording_client(
        paged_responder(
            [
                {"items": [{"id": "evaluation-2"}], "nextCursor": "evaluation-2"},
                {"items": [{"id": "evaluation-1"}], "nextCursor": None},
            ]
        )
    )
    with client:
        evaluations = list(
            client.list_promotion_evaluations(PROJECT, policy_id="policy-1", candidate_version_id="v2")
        )
    assert [evaluation["id"] for evaluation in evaluations] == ["evaluation-2", "evaluation-1"]
    assert [query for _, _, query, _ in requests] == [
        {"policyId": "policy-1", "candidateVersionId": "v2"},
        {"policyId": "policy-1", "candidateVersionId": "v2", "cursor": "evaluation-2"},
    ]


def test_promotion_policies_are_listed_for_one_model():
    client, requests = recording_client(
        lambda _request: httpx.Response(200, json={"items": [{"id": "policy-1"}]})
    )
    with client:
        assert client.list_promotion_policies(PROJECT, model_id="model-1") == [{"id": "policy-1"}]
    assert requests == [("GET", f"{PROJECT_PATH}/promotion-policies", {"modelId": "model-1"}, None)]


def test_chained_rule_sends_trigger_upstream_rule_and_summary_metrics():
    client, requests = recording_client()
    with client:
        client.create_automation_rule(
            PROJECT,
            name="evaluate after inference",
            model_families=["whisper"],
            kind="evaluation",
            experiment_id="experiment",
            code_version_id="evaluation-code",
            target_id="target",
            trigger="upstream_run_finished",
            upstream_rule_id="rule-inference",
            summary_metrics=["wer", "cer"],
            input_dataset_version_ids=["reference"],
        )
    body = requests[0][3]
    assert requests[0][:2] == ("POST", f"{PROJECT_PATH}/automation-rules")
    assert body["trigger"] == "upstream_run_finished"
    assert body["upstreamRuleId"] == "rule-inference"
    assert body["summaryMetrics"] == ["wer", "cer"]
    assert body["maxAttempts"] == 1


def test_registration_rule_omits_the_fields_it_does_not_use():
    client, requests = recording_client()
    with client:
        client.create_automation_rule(
            PROJECT,
            name="preprocess",
            model_families=["whisper"],
            kind="processing",
            experiment_id="experiment",
            code_version_id="code",
            target_id="target",
        )
    body = requests[0][3]
    assert body["trigger"] == "model_registered" and body["kind"] == "processing"
    assert "upstreamRuleId" not in body and "summaryMetrics" not in body


@pytest.mark.parametrize(
    ("trigger", "upstream_rule_id"),
    [("upstream_run_finished", None), ("model_registered", "rule-inference"), ("on_merge", None)],
)
def test_rule_trigger_and_upstream_rule_must_agree(trigger, upstream_rule_id):
    client, requests = recording_client()
    with client, pytest.raises(ConfigurationError):
        client.create_automation_rule(
            PROJECT,
            name="bad",
            model_families=["whisper"],
            kind="evaluation",
            experiment_id="e",
            code_version_id="c",
            target_id="t",
            trigger=trigger,
            upstream_rule_id=upstream_rule_id,
        )
    assert requests == []


def test_executions_are_filtered_by_version_and_rule_across_pages():
    client, requests = recording_client(
        paged_responder(
            [
                {"items": [{"id": "execution-2"}], "nextCursor": "execution-2"},
                {"items": [{"id": "execution-1"}], "nextCursor": None},
            ]
        )
    )
    with client:
        executions = client.list_automation_executions(
            PROJECT, model_version_id="version-1", rule_id="rule-1"
        )
    assert [execution["id"] for execution in executions] == ["execution-2", "execution-1"]
    path = f"{PROJECT_PATH}/automation-executions"
    assert requests == [
        ("GET", path, {"modelVersionId": "version-1", "ruleId": "rule-1"}, None),
        ("GET", path, {"modelVersionId": "version-1", "ruleId": "rule-1", "cursor": "execution-2"}, None),
    ]


def test_executions_from_an_api_without_paging_are_one_page():
    client, requests = recording_client(lambda _request: httpx.Response(200, json={"items": [{"id": "e"}]}))
    with client:
        assert client.list_automation_executions(PROJECT) == [{"id": "e"}]
    assert requests == [("GET", f"{PROJECT_PATH}/automation-executions", {}, None)]


def test_manual_application_names_either_the_version_or_the_upstream_run_and_is_not_resent():
    client, requests = recording_client(lambda _request: httpx.Response(502, json={"error": "gateway"}))
    with client:
        with pytest.raises(ApiError):
            client.apply_automation_rule(PROJECT, "rule-1", model_version_id="version-1")
        with pytest.raises(ConfigurationError):
            client.apply_automation_rule(PROJECT, "rule-1")
        with pytest.raises(ConfigurationError):
            client.apply_automation_rule(PROJECT, "rule-1", model_version_id="v", trigger_run_id="r")
    assert requests == [
        ("POST", f"{PROJECT_PATH}/automation-rules/rule-1/executions", {}, {"modelVersionId": "version-1"})
    ]


def test_manual_application_of_a_chained_rule_sends_the_upstream_run():
    client, requests = recording_client()
    with client:
        client.apply_automation_rule(PROJECT, "rule-2", trigger_run_id="inference-run")
    assert requests[0][3] == {"triggerRunId": "inference-run"}


def test_owner_transfers_put_the_service_account_on_the_rule_the_policy_and_the_hook():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": request.url.path.split("/")[-2], "runAsUserId": "sa-1"})

    client, requests = recording_client(respond)
    with client:
        rule = client.transfer_automation_rule_owner(PROJECT, "rule-1", service_account_id="sa-1")
        policy = client.transfer_promotion_policy_owner(PROJECT, "policy-1", service_account_id="sa-1")
        hook = client.transfer_hook_owner(PROJECT, "hook-1", service_account_id="sa-1")
    assert rule == {"id": "rule-1", "runAsUserId": "sa-1"}
    assert policy == {"id": "policy-1", "runAsUserId": "sa-1"}
    assert hook == {"id": "hook-1", "runAsUserId": "sa-1"}
    assert requests == [
        ("PUT", f"{PROJECT_PATH}/automation-rules/rule-1/owner", {}, {"serviceAccountId": "sa-1"}),
        ("PUT", f"{PROJECT_PATH}/promotion-policies/policy-1/owner", {}, {"serviceAccountId": "sa-1"}),
        ("PUT", f"{PROJECT_PATH}/hooks/hook-1/owner", {}, {"serviceAccountId": "sa-1"}),
    ]


def test_service_account_token_expiry_is_sent_in_utc():
    client, requests = recording_client(
        lambda _request: httpx.Response(201, json={"token": "mmt_value", "item": {"id": "token-1"}})
    )
    tokyo = timezone(timedelta(hours=9))
    with client:
        issued = client.create_service_account_token(
            PROJECT,
            "sa-1",
            name="worker",
            scopes=["worker:execute"],
            expires_at=datetime(2027, 1, 1, 9, 0, tzinfo=tokyo),
        )
    assert issued["item"] == {"id": "token-1"}
    assert requests == [
        (
            "POST",
            f"{PROJECT_PATH}/service-accounts/sa-1/tokens",
            {},
            {"name": "worker", "scopes": ["worker:execute"], "expiresAt": "2027-01-01T00:00:00Z"},
        )
    ]


def test_service_account_token_rejects_a_naive_expiry_and_empty_scopes():
    client, requests = recording_client()
    with client:
        with pytest.raises(ConfigurationError, match="timezone"):
            client.create_service_account_token(
                PROJECT, "sa-1", name="t", scopes=["read"], expires_at=datetime(2027, 1, 1)
            )
        with pytest.raises(ConfigurationError, match="scopes"):
            client.create_service_account_token(PROJECT, "sa-1", name="t", scopes="read")
    assert requests == []


def test_token_issue_is_not_resent_so_no_unseen_token_is_left_behind():
    client, requests = recording_client(lambda _request: httpx.Response(503, json={"error": "busy"}))
    with client, pytest.raises(ApiError):
        client.create_service_account_token(
            PROJECT, "sa-1", name="t", scopes=["read"], expires_at=datetime.now(UTC) + timedelta(days=7)
        )
    assert len(requests) == 1


def test_service_accounts_and_project_tokens_are_listed():
    client, requests = recording_client(lambda _request: httpx.Response(200, json={"items": [{"id": "x"}]}))
    with client:
        account = client.list_service_accounts(PROJECT)
        tokens = client.list_project_tokens(PROJECT)
    assert account == tokens == [{"id": "x"}]
    assert [path for _, path, _, _ in requests] == [
        f"{PROJECT_PATH}/service-accounts",
        f"{PROJECT_PATH}/tokens",
    ]


def test_service_account_creation_sends_the_role():
    client, requests = recording_client()
    with client:
        client.create_service_account(PROJECT, name="pipeline", role="editor", description="自動評価")
        with pytest.raises(ConfigurationError, match="role"):
            client.create_service_account(PROJECT, name="pipeline", role="owner")
    assert requests == [
        (
            "POST",
            f"{PROJECT_PATH}/service-accounts",
            {},
            {"name": "pipeline", "description": "自動評価", "role": "editor"},
        )
    ]


def test_dataset_with_files_creates_the_dataset_and_delegates_the_directory_upload(monkeypatch, tmp_path):
    delegated = []

    def upload(client, project_id, dataset_id, directory, *, version=None, metadata=None, schema=None):
        delegated.append((project_id, dataset_id, directory, version, metadata, schema))
        return {"id": "dataset-version", "contentKind": "artifacts"}

    monkeypatch.setattr("mado_tracking.client.upload_dataset_directory", upload)
    client, requests = recording_client(lambda _request: httpx.Response(201, json={"id": "dataset-1"}))
    with client:
        version = client.register_dataset(
            PROJECT, name="speech", files=tmp_path, version="v1", metadata={"lang": "ja"}
        )
    assert version == {"id": "dataset-version", "contentKind": "artifacts"}
    assert requests == [
        (
            "POST",
            f"{PROJECT_PATH}/datasets",
            {},
            {"name": "speech", "namespace": "default", "description": ""},
        )
    ]
    assert delegated == [(PROJECT, "dataset-1", tmp_path, "v1", {"lang": "ja"}, None)]


def test_dataset_files_cannot_be_combined_with_a_reference_uri(tmp_path):
    client, requests = recording_client()
    with client:
        with pytest.raises(ConfigurationError, match="files"):
            client.register_dataset(PROJECT, dataset_id="d", files=tmp_path, uri="s3://x", digest="sha256:0")
        with pytest.raises(ConfigurationError, match="uri"):
            client.register_dataset(PROJECT, dataset_id="d", version="v1")
    assert requests == []


class InterruptedBody(httpx.SyncByteStream):
    def __init__(self, content: bytes, *, fail_after: int | None):
        self.content = content
        self.fail_after = fail_after

    def __iter__(self):
        if self.fail_after is None:
            yield self.content
            return
        yield self.content[: self.fail_after]
        raise httpx.ReadError("connection dropped")


def test_upstream_artifact_resumes_with_range_after_a_dropped_connection(monkeypatch, tmp_path):
    content = b"RIFF" + bytes(range(256)) * 64
    entity_tag = f'"sha256-{hashlib.sha256(content).hexdigest()}"'
    monkeypatch.setenv("MMT_PROJECT_ID", PROJECT)
    monkeypatch.setenv("MMT_UPSTREAM_RUN_ID", "inference-run")
    ranges = []

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/artifacts"):
            return httpx.Response(
                200, json={"items": [{"id": "wav-1", "path": "wav/a.wav"}], "nextCursor": None}
            )
        ranges.append(request.headers.get("range"))
        if request.headers.get("range") is None:
            return httpx.Response(
                200,
                headers={"etag": entity_tag, "content-length": str(len(content))},
                stream=InterruptedBody(content, fail_after=1000),
            )
        assert request.headers["if-range"] == entity_tag
        return httpx.Response(
            206,
            headers={"etag": entity_tag, "content-range": f"bytes 1000-{len(content) - 1}/{len(content)}"},
            stream=InterruptedBody(content[1000:], fail_after=None),
        )

    client, _requests = recording_client(respond)
    with client:
        saved = download_upstream_artifacts(tmp_path / "upstream", client=client)
    assert saved == [tmp_path / "upstream/wav/a.wav"]
    assert saved[0].read_bytes() == content
    assert ranges == [None, "bytes=1000-"]
    assert [path.name for path in Path(tmp_path / "upstream/wav").iterdir()] == ["a.wav"]
