import type { ComputeTarget, Job } from '@mmt/contracts';

/** Jobs of one manual site that wait for the requester's `mado-tracking submit`. */
export interface ManualSubmissionGroup {
  targetId: string;
  targetName: string;
  waitingJobs: number;
}

export const isWaitingManualSubmission = (job: Pick<Job, 'status' | 'phase'>): boolean =>
  job.status === 'queued' && job.phase === 'waiting_manual';

/**
 * How `mado-tracking submit` runs: `watch` keeps waiting for new Jobs until it is stopped (a PC
 * that is the computer itself), and `all` takes everyone's waiting Jobs, which only the
 * computer's owner may do.
 */
export interface ManualSubmitOptions {
  watch?: boolean;
  all?: boolean;
}

/**
 * The command the requester runs on the site (its login node, or the PC itself); it claims their
 * waiting Jobs of the site and submits them through the site's job shell (one call per array).
 */
export function manualSubmitCommand(targetId: string, options: ManualSubmitOptions = {}): string {
  return [
    `mado-tracking submit --site ${targetId}`,
    ...(options.watch ? ['--watch'] : []),
    ...(options.all ? ['--all'] : []),
  ].join(' ');
}

/** Waiting Jobs per manual site, in the order the sites first appear in the list. */
export function manualSubmissionGroups(
  jobs: ReadonlyArray<Pick<Job, 'status' | 'phase' | 'targetId'>>,
  targets: ReadonlyArray<Pick<ComputeTarget, 'id' | 'name'>>,
): ManualSubmissionGroup[] {
  const groups = new Map<string, ManualSubmissionGroup>();
  for (const job of jobs) {
    if (!isWaitingManualSubmission(job)) continue;
    const group = groups.get(job.targetId) ?? {
      targetId: job.targetId,
      targetName: targets.find((target) => target.id === job.targetId)?.name ?? job.targetId,
      waitingJobs: 0,
    };
    group.waitingJobs += 1;
    groups.set(job.targetId, group);
  }
  return [...groups.values()];
}
