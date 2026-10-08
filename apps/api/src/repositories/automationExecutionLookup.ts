import type { ModelAutomationExecution } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';

// A Job retry chain is bounded by the Job's maxAttempts (at most 100); the limit only stops a
// corrupted chain from looping.
const MAX_RETRY_CHAIN_LENGTH = 100;

export type AutomationExecutionRecord = Pick<
  ModelAutomationExecution,
  | 'id'
  | 'projectId'
  | 'ruleId'
  | 'modelVersionId'
  | 'runId'
  | 'jobId'
  | 'status'
  | 'triggerRunId'
  | 'pipelineRootExecutionId'
  | 'attempt'
  | 'source'
>;

/**
 * Finds the automation execution that created a Run. A Run created by a manual Job retry has no
 * execution of its own, so the lookup follows jobs.retry_of_job_id back to the original Job's Run.
 * Returns null for Runs a person created. Run tags are never consulted: automation.* tags on old
 * Runs could have been written by users before reserved tags were enforced.
 */
export async function findExecutionForRun(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<AutomationExecutionRecord | null> {
  let runId: string | null = reference.runId;
  for (let step = 0; runId !== null && step <= MAX_RETRY_CHAIN_LENGTH; step += 1) {
    const execution = await first<AutomationExecutionRecord>(
      connection,
      `SELECT id,project_id,rule_id,model_version_id,run_id,job_id,status,trigger_run_id,
        pipeline_root_execution_id,attempt,source
      FROM model_automation_executions WHERE project_id=$1 AND run_id=$2`,
      [reference.projectId, runId],
    );
    if (execution) return execution;
    runId = await findRetriedRunId(connection, { projectId: reference.projectId, runId });
  }
  return null;
}

// The Run whose Job the given Run's Job retried, or null when the Run did not come from a retry.
async function findRetriedRunId(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<string | null> {
  const original = await first<{ runId: string }>(
    connection,
    `SELECT original.run_id FROM jobs retried
    JOIN jobs original ON original.id=retried.retry_of_job_id AND original.project_id=retried.project_id
    WHERE retried.project_id=$1 AND retried.run_id=$2`,
    [reference.projectId, reference.runId],
  );
  return original?.runId ?? null;
}
