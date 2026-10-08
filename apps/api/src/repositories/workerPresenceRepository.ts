import type { WorkerPresence } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';
import {
  workerOfflineSql,
  workerPresenceStatusSql,
  workerPresenceWriteDueSql,
} from '../domain/workerLiveness.js';

// Worker ids are configured per host, so a project rarely has more; bound the response anyway.
const WORKER_LIST_LIMIT = 1000;

export interface WorkerPresenceTouch {
  projectId: string;
  tokenId: string;
  workerId: string;
  targetIds: string[] | null;
  version?: string;
  hostname?: string;
  parallelJobs?: number;
}

// Upserts on claim/resume. An unchanged worker is rewritten only after the write interval, and
// started_at restarts when the worker comes back from offline so it shows the current uptime.
// Omitted workerInfo fields keep their previous values for workers that do not send them.
export async function touchWorker(
  connection: Connection,
  presence: WorkerPresenceTouch,
): Promise<void> {
  await connection.query(
    `INSERT INTO workers(project_id,token_id,worker_id,version,hostname,target_ids,parallel_jobs)
    VALUES($1,$2,$3,$4,$5,$6::uuid[],$7)
    ON CONFLICT (token_id,worker_id) DO UPDATE SET
      version=COALESCE(EXCLUDED.version,workers.version),
      hostname=COALESCE(EXCLUDED.hostname,workers.hostname),
      target_ids=EXCLUDED.target_ids,
      parallel_jobs=COALESCE(EXCLUDED.parallel_jobs,workers.parallel_jobs),
      started_at=CASE WHEN ${workerOfflineSql('workers')} THEN now() ELSE workers.started_at END,
      last_seen_at=now()
    WHERE ${workerPresenceWriteDueSql('workers')}
      OR EXCLUDED.target_ids IS DISTINCT FROM workers.target_ids
      OR COALESCE(EXCLUDED.version,workers.version) IS DISTINCT FROM workers.version
      OR COALESCE(EXCLUDED.hostname,workers.hostname) IS DISTINCT FROM workers.hostname
      OR COALESCE(EXCLUDED.parallel_jobs,workers.parallel_jobs) IS DISTINCT FROM workers.parallel_jobs`,
    [
      presence.projectId,
      presence.tokenId,
      presence.workerId,
      presence.version ?? null,
      presence.hostname ?? null,
      presence.targetIds,
      presence.parallelJobs ?? null,
    ],
  );
}

// Heartbeats carry no worker description, so they only extend last_seen_at of the Job's worker.
export async function touchWorkerLastSeen(
  connection: Connection,
  lease: { jobId: string },
): Promise<void> {
  await connection.query(
    `UPDATE workers w SET last_seen_at=now(),
      started_at=CASE WHEN ${workerOfflineSql('w')} THEN now() ELSE w.started_at END
    FROM jobs j WHERE j.id=$1 AND w.token_id=j.worker_token_id AND w.worker_id=j.worker_id
      AND ${workerPresenceWriteDueSql('w')}`,
    [lease.jobId],
  );
}

// projectId null lists every project's workers (global administrators only).
export async function listWorkerPresence(
  connection: Connection,
  filter: { projectId: string | null },
): Promise<WorkerPresence[]> {
  return rows<WorkerPresence>(
    connection,
    `SELECT w.project_id,w.token_id,t.name AS token_name,w.worker_id,w.version,w.hostname,
      w.target_ids,w.parallel_jobs,w.started_at,w.last_seen_at,${workerPresenceStatusSql('w')} AS status,
      (SELECT count(*)::int FROM jobs j WHERE j.worker_token_id=w.token_id AND j.worker_id=w.worker_id
        AND j.status IN ('claimed','running')) AS active_job_count
    FROM workers w JOIN api_tokens t ON t.id=w.token_id
    WHERE ($1::uuid IS NULL OR w.project_id=$1)
    ORDER BY w.last_seen_at DESC,w.token_id,w.worker_id LIMIT ${WORKER_LIST_LIMIT}`,
    [filter.projectId],
  );
}
