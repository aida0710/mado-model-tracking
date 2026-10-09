import type { Job, JobStatus } from '@mmt/contracts';

/** The order the array summary lists states in: what still moves first, then how members ended. */
export const JOB_ARRAY_STATE_ORDER: readonly JobStatus[] = [
  'running',
  'claimed',
  'queued',
  'finished',
  'failed',
  'canceled',
];

/** One Job array as the loaded Jobs list shows it. */
export interface JobArraySummary {
  arrayGroupId: string;
  targetId: string;
  size: number;
  hookId: string | null;
  parentJobId: string | null;
  /** The first member's creation; members are created together. */
  createdAt: string;
  /** Status of the newest attempt of each index present in the list. */
  counts: Partial<Record<JobStatus, number>>;
}

type ArrayMember = Pick<
  Job,
  | 'arrayGroupId'
  | 'arrayIndex'
  | 'arraySize'
  | 'attempt'
  | 'status'
  | 'targetId'
  | 'hookId'
  | 'parentJobId'
  | 'createdAt'
>;

/**
 * Groups array members by arrayGroupId. A retried member keeps its index, so each index counts
 * once, by its newest attempt. Groups keep the list's order (the API lists newest Jobs first).
 */
export function summarizeJobArrays(jobs: readonly ArrayMember[]): JobArraySummary[] {
  const newestAttempts = new Map<string, Map<number, ArrayMember>>();
  for (const job of jobs) {
    if (job.arrayGroupId === null || job.arrayIndex === null) continue;
    const members = newestAttempts.get(job.arrayGroupId) ?? new Map<number, ArrayMember>();
    const known = members.get(job.arrayIndex);
    if (!known || job.attempt > known.attempt) members.set(job.arrayIndex, job);
    newestAttempts.set(job.arrayGroupId, members);
  }
  return [...newestAttempts].map(([arrayGroupId, members]) => {
    const jobsOfGroup = [...members.values()];
    const first = jobsOfGroup.reduce((earliest, job) =>
      job.createdAt < earliest.createdAt ? job : earliest,
    );
    const counts: Partial<Record<JobStatus, number>> = {};
    for (const job of jobsOfGroup) counts[job.status] = (counts[job.status] ?? 0) + 1;
    return {
      arrayGroupId,
      targetId: first.targetId,
      size: first.arraySize ?? jobsOfGroup.length,
      hookId: first.hookId,
      parentJobId: first.parentJobId,
      createdAt: first.createdAt,
      counts,
    };
  });
}
