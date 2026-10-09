import type { Job, JsonObject } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';

/**
 * WorkerJob.triggerPayload: what started the hook (a manual payload or a webhook body). The
 * execution names the first attempt or the array, so a retry walks back to its first attempt.
 */
export async function findTriggerPayload(
  connection: Connection,
  job: Pick<Job, 'id' | 'projectId' | 'hookId' | 'arrayGroupId'>,
): Promise<JsonObject | null> {
  if (!job.hookId) return null;
  const execution = await first<{ payload: JsonObject | null }>(
    connection,
    `WITH RECURSIVE attempts AS (
      SELECT id,retry_of_job_id FROM jobs WHERE id=$1
      UNION ALL
      SELECT j.id,j.retry_of_job_id FROM jobs j JOIN attempts a ON j.id=a.retry_of_job_id
    )
    SELECT payload FROM hook_executions
    WHERE project_id=$2 AND hook_id=$3
    AND (job_id IN (SELECT id FROM attempts) OR ($4::uuid IS NOT NULL AND array_group_id=$4::uuid))
    LIMIT 1`,
    [job.id, job.projectId, job.hookId, job.arrayGroupId],
  );
  return execution?.payload ?? null;
}
