import type {
  CreateAutomationExecution,
  ModelAutomationExecution,
  ModelAutomationRule,
} from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { SelectOption } from '../types/form';
import { RequestError } from '../api/http';
import { buildCatalogOptions } from './catalogOptions';
import { formatErrorMessage } from './errorMessage';
import { formatDate } from './format';
import { automationText } from '../i18n/automation';

type ManualRule = Pick<ModelAutomationRule, 'trigger' | 'upstreamRuleId' | 'modelFamilies'>;

/** Versions of the rule's model families; the API rechecks weights and compatibility. */
export function manualVersionOptions(
  rule: ManualRule,
  registry: ExecutionCatalog,
): SelectOption[] {
  const familyVersionIds = new Set(
    registry.modelVersions
      .filter((version) => rule.modelFamilies.includes(version.family))
      .map((version) => version.id),
  );
  return buildCatalogOptions(registry).models.filter((option) =>
    familyVersionIds.has(option.value),
  );
}

/**
 * Finished Runs that the upstream rule created. Only those can start a chained rule, because the
 * API finds the upstream stage through the execution, never through Run tags.
 */
export function manualUpstreamRunOptions({
  rule,
  executions,
  versionLabel,
}: {
  rule: ManualRule;
  executions: ModelAutomationExecution[];
  versionLabel: (modelVersionId: string) => string;
}): SelectOption[] {
  const seenRunIds = new Set<string>();
  const options: SelectOption[] = [];
  for (const execution of executions) {
    const runId = execution.runId;
    if (execution.ruleId !== rule.upstreamRuleId || execution.runStatus !== 'finished' || !runId)
      continue;
    if (seenRunIds.has(runId)) continue;
    seenRunIds.add(runId);
    options.push({
      value: runId,
      label: `${versionLabel(execution.modelVersionId)} · ${formatDate(execution.createdAt)}`,
    });
  }
  return options;
}

export function manualExecutionRequest(
  rule: ManualRule,
  selectedId: string,
): CreateAutomationExecution {
  return rule.trigger === 'upstream_run_finished'
    ? { triggerRunId: selectedId }
    : { modelVersionId: selectedId };
}

/** 409 means the same rule and version is still running; 422 means the rule cannot run now. */
export function manualExecutionErrorMessage(failure: unknown): string {
  if (failure instanceof RequestError && failure.status === 409) return automationText.applyRunning;
  if (failure instanceof RequestError && failure.status === 422)
    return failure.serverMessage ?? automationText.applyInvalidRule;
  return formatErrorMessage(failure);
}
