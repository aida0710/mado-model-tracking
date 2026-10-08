import type { ModelAutomationExecution } from '@mmt/contracts';

// Error codes the API records when automation did not start because an earlier step did not
// succeed: the training Run behind the version, or the upstream stage of a chained rule.
const AUTOMATION_SKIP_REASONS = [
  'source_run_unsuccessful',
  'source_run_timeout',
  'upstream_unsuccessful',
  'upstream_outputs_missing',
] as const;
export type AutomationSkipReason = (typeof AUTOMATION_SKIP_REASONS)[number];

// Stored errors are "<code>: <message>"; only the code is a stable contract.
export function automationSkipReason(
  execution: Pick<ModelAutomationExecution, 'status' | 'error'>,
): AutomationSkipReason | null {
  if (execution.status !== 'skipped' || !execution.error) return null;
  const code = execution.error.split(':', 1)[0];
  return AUTOMATION_SKIP_REASONS.find((reason) => reason === code) ?? null;
}
