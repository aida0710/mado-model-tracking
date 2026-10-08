import type {
  CreateAutomationExecution,
  ModelAutomationExecution,
  ModelAutomationRule,
} from '@mmt/contracts';
import { hasActiveExecution } from './automationActivity';
import { manualExecutionRequest } from './automationManualExecution';

type RerunExecution = Pick<
  ModelAutomationExecution,
  'status' | 'runStatus' | 'jobStatus' | 'modelVersionId' | 'triggerRunId'
>;
type RerunRule = Pick<
  ModelAutomationRule,
  'enabled' | 'trigger' | 'upstreamRuleId' | 'modelFamilies'
>;

/**
 * Whether the row can be applied again by hand: a stored execution of an enabled rule that is no
 * longer running. A chained rule needs the upstream Run it was started from. The API rechecks.
 */
export function canRerunExecution(execution: RerunExecution, rule: RerunRule | undefined): boolean {
  if (!rule?.enabled || hasActiveExecution([execution])) return false;
  return rule.trigger === 'model_registered' || execution.triggerRunId !== null;
}

/** The manual application that runs the same rule for the same version (or upstream Run). */
export function rerunRequest(
  execution: RerunExecution,
  rule: RerunRule,
): CreateAutomationExecution {
  return manualExecutionRequest(
    rule,
    rule.trigger === 'upstream_run_finished' ? execution.triggerRunId! : execution.modelVersionId,
  );
}
