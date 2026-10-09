import type { Job, JobEndReason, Run } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { jobColumns } from '../repositories/jobRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import { runColumns } from '../repositories/runListProjection.js';
import type { RunCompletionService } from './runCompletionService.js';

/**
 * Counts submissions among a target's Jobs: the members of an array are one submission where the
 * site takes arrays (the boolean parameter supportsArray), and one each where it does not.
 */
export function submissionCountSql(supportsArray: string, filter = ''): string {
  return `count(DISTINCT CASE WHEN ${supportsArray}::boolean THEN COALESCE(array_group_id,id) ELSE id END)${filter}::int`;
}

/**
 * Fails a site Job whose runner never started: the job shell refused it, no result came back, or
 * it waited in the scheduler queue too long. A Job still in a scheduler queue is also marked for
 * the launcher to remove (scheduler_cancel_state). The caller holds the Job's row lock.
 */
export async function failUnstartedSiteJob(
  connection: Connection,
  runCompletion: RunCompletionService,
  failure: { job: Job; endReason: Exclude<JobEndReason, 'timed_out'>; error: string },
): Promise<Job> {
  const { job } = failure;
  const previousRun = await findRun(connection, {
    projectId: job.projectId,
    id: job.runId,
    lock: true,
  });
  const failed = (await first<Job>(
    connection,
    `UPDATE jobs SET status='failed',end_reason=$2,error=$3,ended_at=now(),
      scheduler_cancel_state=CASE WHEN scheduler_job_id IS NULL THEN NULL ELSE 'pending' END
    WHERE id=$1 RETURNING ${jobColumns()}`,
    [job.id, failure.endReason, failure.error],
  ))!;
  const run = (await first<Run>(
    connection,
    `UPDATE runs SET status='failed',error=$2,ended_at=now() WHERE id=$1 RETURNING ${runColumns}`,
    [job.runId, failure.error],
  ))!;
  await runCompletion.recordStatusChange(connection, { previousStatus: previousRun.status, run });
  return failed;
}
