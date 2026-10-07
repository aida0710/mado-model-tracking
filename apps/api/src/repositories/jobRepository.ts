import type { Job } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';

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
];

export function jobColumns(alias = ''): string {
  return publicJobColumns.map((column) => `${alias ? `${alias}.` : ''}${column}`).join(',');
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
