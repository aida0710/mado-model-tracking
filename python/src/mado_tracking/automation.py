"""Automation rules (inference / evaluation / processing after registration or an upstream Run)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from .api_paths import path_id
from .errors import ConfigurationError
from .pagination import iterate_listed_items

if TYPE_CHECKING:
    from .client import Client

AUTOMATION_RULE_KINDS = {"inference", "evaluation", "processing"}
AUTOMATION_TRIGGERS = {"model_registered", "upstream_run_finished"}


def create_automation_rule(
    client: Client,
    project_id: str,
    *,
    name: str,
    model_families: Sequence[str],
    kind: str,
    experiment_id: str,
    code_version_id: str,
    target_id: str,
    trigger: str = "model_registered",
    upstream_rule_id: str | None = None,
    summary_metrics: Sequence[str] = (),
    gpu_ids: Sequence[str] = (),
    input_dataset_version_ids: Sequence[str] = (),
    parameters: Mapping[str, Any] | None = None,
    tags: Mapping[str, str] | None = None,
    max_attempts: int = 1,
    enabled: bool = True,
) -> dict[str, Any]:
    """Create a rule; settings are immutable afterwards, only ``enabled`` can change.

    ``trigger="upstream_run_finished"`` chains the rule after ``upstream_rule_id``: it starts when a
    Run of that rule finishes with output DatasetVersions. ``summary_metrics`` are the metric names
    listed first in the evaluation results of a model version.
    """
    if kind not in AUTOMATION_RULE_KINDS:
        raise ConfigurationError("Automation supports inference, evaluation or processing")
    if trigger not in AUTOMATION_TRIGGERS:
        raise ConfigurationError("trigger must be model_registered or upstream_run_finished")
    if (trigger == "upstream_run_finished") != (upstream_rule_id is not None):
        raise ConfigurationError("upstream_rule_id is required for, and only for, upstream_run_finished")
    if isinstance(summary_metrics, str):
        raise ConfigurationError("summary_metrics must be a sequence of strings")
    body: dict[str, Any] = {
        "name": name,
        "enabled": enabled,
        "modelFamilies": list(model_families),
        "kind": kind,
        "trigger": trigger,
        "experimentId": experiment_id,
        "codeVersionId": code_version_id,
        "targetId": target_id,
        "gpuIds": list(gpu_ids),
        "inputDatasetVersionIds": list(input_dataset_version_ids),
        "parameters": dict(parameters or {}),
        "tags": dict(tags or {}),
        "maxAttempts": max_attempts,
    }
    # Optional fields are left out when unset so an API without them still accepts the rule.
    if upstream_rule_id is not None:
        body["upstreamRuleId"] = upstream_rule_id
    if summary_metrics:
        body["summaryMetrics"] = list(summary_metrics)
    # Not retried: a resent create would add a second rule.
    return client.request("POST", client.project_path(project_id, "automation-rules"), json=body)


def list_automation_executions(
    client: Client,
    project_id: str,
    *,
    model_version_id: str | None = None,
    rule_id: str | None = None,
) -> list[dict[str, Any]]:
    """Every matching ModelAutomationExecution, newest first, including pending registrations.

    All pages are read; an API that predates paging returns its latest 100 rows in one page.
    """
    optional_values = {"modelVersionId": model_version_id, "ruleId": rule_id}
    conditions = {key: value for key, value in optional_values.items() if value is not None}
    path = client.project_path(project_id, "automation-executions")
    return list(iterate_listed_items(client, path, params=conditions, label="Automation execution list"))


def apply_automation_rule(
    client: Client,
    project_id: str,
    rule_id: str,
    *,
    model_version_id: str | None = None,
    trigger_run_id: str | None = None,
) -> dict[str, Any]:
    """Apply a rule by hand (Project admin): to a version, or for a chained rule to an upstream Run.

    A rule triggered by registration takes ``model_version_id``; an ``upstream_run_finished`` rule
    takes ``trigger_run_id``. Skipped or failed checks come back as the returned execution.
    """
    if (model_version_id is None) == (trigger_run_id is None):
        raise ConfigurationError("Specify exactly one of model_version_id and trigger_run_id")
    body = {"modelVersionId": model_version_id} if model_version_id else {"triggerRunId": trigger_run_id}
    # Not retried: each application starts another attempt.
    return client.request(
        "POST",
        client.project_path(project_id, f"automation-rules/{path_id(rule_id)}/executions"),
        json=body,
    )


def transfer_automation_rule_owner(
    client: Client, project_id: str, rule_id: str, *, service_account_id: str
) -> dict[str, Any]:
    """Run the rule as a Service Account so it keeps working when its creator leaves.

    Returns the updated rule with ``runAsUserId``. Setting the same owner again changes nothing,
    so the PUT is retried after a lost response.
    """
    return client.request(
        "PUT",
        client.project_path(project_id, f"automation-rules/{path_id(rule_id)}/owner"),
        json={"serviceAccountId": service_account_id},
        retryable=True,
    )
