import type { ComputeTargetDetails, Job, User } from '@mmt/contracts';
import { isTargetOwner } from './permissions';

/**
 * Whose a manual site is, as the viewer sees it. Each requester runs `mado-tracking submit` for
 * their own Jobs with their own account; the owner of a computer may also take everyone's
 * (`--all`). Someone else's computer may be their PC, where they wait with `--watch --all`, or a
 * site each requester logs in to themselves (one with OTP, say): the screen cannot tell, so both
 * are said. A site no longer listed counts as a global one.
 */
export type ManualSiteOwnership =
  | { kind: 'global' }
  | { kind: 'own' }
  | { kind: 'someoneElse'; ownerName: string };

/** Jobs of one manual site that wait for `mado-tracking submit`. */
export interface ManualSubmissionGroup {
  targetId: string;
  targetName: string;
  waitingJobs: number;
  ownership: ManualSiteOwnership;
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
 * How the owner of a shared PC submits the Jobs of everyone they shared it with: waiting on the
 * PC itself and taking all of them (others get 403 site_owner_required for `--all`). It takes the
 * Jobs of its token's Project, so a PC shared with several Projects waits once per Project.
 */
export const OWNER_SUBMIT_OPTIONS: ManualSubmitOptions = { watch: true, all: true };

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

/** Whose the manual site is for the viewer; a site no longer listed is treated as a global one. */
export function manualSiteOwnership(
  target: Pick<ComputeTargetDetails, 'ownerUserId' | 'ownerName'> | undefined,
  viewer: Pick<User, 'id'>,
): ManualSiteOwnership {
  if (!target || target.ownerUserId === null) return { kind: 'global' };
  if (isTargetOwner(viewer, target)) return { kind: 'own' };
  return { kind: 'someoneElse', ownerName: target.ownerName ?? target.ownerUserId };
}

/**
 * Waiting Jobs per manual site, in the order the sites first appear in the list, with whose each
 * site is for the viewer.
 */
export function manualSubmissionGroups(
  jobs: ReadonlyArray<Pick<Job, 'status' | 'phase' | 'targetId'>>,
  targets: ReadonlyArray<Pick<ComputeTargetDetails, 'id' | 'name' | 'ownerUserId' | 'ownerName'>>,
  viewer: Pick<User, 'id'>,
): ManualSubmissionGroup[] {
  const groups = new Map<string, ManualSubmissionGroup>();
  for (const job of jobs) {
    if (!isWaitingManualSubmission(job)) continue;
    const target = targets.find((item) => item.id === job.targetId);
    const group = groups.get(job.targetId) ?? {
      targetId: job.targetId,
      targetName: target?.name ?? job.targetId,
      waitingJobs: 0,
      ownership: manualSiteOwnership(target, viewer),
    };
    group.waitingJobs += 1;
    groups.set(job.targetId, group);
  }
  return [...groups.values()];
}
