import type { Job, Run } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import { findJob } from '../repositories/jobRepository.js';
import type { ModelAutomationService } from './modelAutomationService.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';

/**
 * Whether a terminal automated Run should get another attempt. Only a failure of both the Run and
 * its Job counts: a cancellation is a person's decision, and a Run that ended while its Job still
 * runs (an SDK reporting FAILED early) leaves the Job to the worker. Kinds of failure such as a
 * lost worker can be told apart here later.
 */
export function isRetryableFailure(failure: {
  run: Pick<Run, 'status'>;
  job: Pick<Job, 'status'>;
}): boolean {
  return failure.run.status === 'failed' && failure.job.status === 'failed';
}

/**
 * Retries automated Runs that failed, up to the rule's maxAttempts. It runs after chaining and
 * promotion and before Sweep trials and notifications. Only the execution's own Run is retried:
 * a Run created by a manual Job retry (which the lookup also follows) belongs to the person who
 * retried it. Run tags are never consulted, so a Run a person tagged by hand is not retried. The
 * execution is retried once, which keeps a resent completion or an MLflow reopen/finish cycle
 * from starting a second attempt. When the retry finishes, the chain handler starts the next stage.
 */
export class AutomationRetryHandler implements RunCompletionHandler {
  readonly name = 'automation-retry';

  constructor(private readonly automation: ModelAutomationService) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    const { run } = change;
    if (run.status !== 'failed') return;
    const execution = await findExecutionForRun(connection, {
      projectId: run.projectId,
      runId: run.id,
    });
    if (!execution || execution.runId !== run.id || !execution.jobId) return;
    const job = await findJob(connection, {
      projectId: run.projectId,
      id: execution.jobId,
      lock: true,
    });
    if (!isRetryableFailure({ run, job })) return;
    await this.automation.retryExecution(connection, { execution, run, job });
  }
}
