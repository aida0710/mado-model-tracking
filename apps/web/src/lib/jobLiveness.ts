import type { Job } from '@mmt/contracts';

// The API derives heartbeatStale; a terminal Job in a stale poll response is not unresponsive.
export function isJobUnresponsive(job: Pick<Job, 'status' | 'heartbeatStale'>): boolean {
  return job.heartbeatStale && (job.status === 'claimed' || job.status === 'running');
}
