import type { Job } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';
import { jobHeartbeatStaleSql } from '../domain/workerLiveness.js';

const publicJobColumns = [
  'id',
  'project_id',
  'run_id',
  'target_id',
  'status',
  'gpu_ids',
  'worker_id',
  'lease_id',
  'cancel_requested',
  'attempt',
  'max_attempts',
  'created_at',
  'started_at',
  'ended_at',
  'heartbeat_at',
  'exit_code',
  'error',
  'phase',
  'gpu_count',
  'walltime_seconds',
  'scheduler_job_id',
  'submitted_at',
  'runner_host',
  'array_group_id',
  'array_index',
  'end_reason',
  'parent_job_id',
  'chain_depth',
  'hook_id',
  'allow_child_jobs',
  'retry_on_failure',
  'retry_on_timeout',
  'dataset_partition_version_id',
  'site_job_shell_id',
];

export function jobColumns(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const columns = publicJobColumns.map((column) => `${prefix}${column}`);
  // Array members show the size of their group; the group row keeps it once.
  const arraySize = `(SELECT g.size FROM job_array_groups g WHERE g.id=${prefix}array_group_id) AS array_size`;
  return [...columns, arraySize, `${jobHeartbeatStaleSql(alias)} AS heartbeat_stale`].join(',');
}

export async function findJob(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<Job> {
  const job = await first<Job>(
    connection,
    `SELECT ${jobColumns()} FROM jobs WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR UPDATE' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!job) notFound('Job');
  return job;
}
