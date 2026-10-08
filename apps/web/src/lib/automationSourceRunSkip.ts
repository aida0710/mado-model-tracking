import type { ModelAutomationExecution } from '@mmt/contracts';

// Error codes the API records when automation waited for a training Run that did not succeed.
const SOURCE_RUN_SKIP_REASONS = ['source_run_unsuccessful', 'source_run_timeout'] as const;
export type SourceRunSkipReason = (typeof SOURCE_RUN_SKIP_REASONS)[number];

// Stored errors are "<code>: <message>"; only the code is a stable contract.
export function sourceRunSkipReason(
  execution: Pick<ModelAutomationExecution, 'status' | 'error'>,
): SourceRunSkipReason | null {
  if (execution.status !== 'skipped' || !execution.error) return null;
  const code = execution.error.split(':', 1)[0];
  return SOURCE_RUN_SKIP_REASONS.find((reason) => reason === code) ?? null;
}
