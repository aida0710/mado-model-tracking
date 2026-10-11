import type { ComputeTarget, Job } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { targetUsableSql } from '../repositories/computeTargetAccessRepository.js';
import { requireGlobalAdmin } from './accessService.js';
import { requireSession } from './tokenService.js';

/** requireGlobalAdmin as a question: an administrator's session or unrestricted admin token. */
export function isGlobalAdministrator(principal: Principal): boolean {
  try {
    requireGlobalAdmin(principal);
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

/**
 * The settings, visibility, job shell and shared key of a computer are its manager's: a global
 * administrator, or whoever owns it, in a browser session.
 */
export function requireTargetManager(principal: Principal, target: ComputeTarget): void {
  if (isGlobalAdministrator(principal)) return;
  if (target.ownerUserId !== principal.user.id)
    throw new DomainError(
      403,
      'このコンピュータの設定は所有者か全体管理者だけが変えられます',
      'target_owner_required',
    );
  requireSession(principal, 'コンピュータの設定');
}

export function isTargetManager(
  principal: Principal,
  target: Pick<ComputeTarget, 'ownerUserId'>,
): boolean {
  return isGlobalAdministrator(principal) || target.ownerUserId === principal.user.id;
}

/** Whether Jobs that run as the user may run on the computer (targetUsableSql). */
export async function canUseTarget(
  connection: Connection,
  usage: { targetId: string; userId: string },
): Promise<boolean> {
  return !!(await first(
    connection,
    `SELECT 1 FROM compute_targets t WHERE t.id=$1 AND ${targetUsableSql('$2::uuid')}`,
    [usage.targetId, usage.userId],
  ));
}

/**
 * Whether a queued Job's requester (its Run's creator) may still use its computer: the computer
 * may have turned private, or changed owner, since the Job was created.
 */
export async function canRunQueuedJob(
  connection: Connection,
  job: Pick<Job, 'runId' | 'targetId'>,
): Promise<boolean> {
  return !!(await first(
    connection,
    `SELECT 1 FROM compute_targets t JOIN runs r ON r.id=$2 WHERE t.id=$1 AND ${targetUsableSql('r.created_by')}`,
    [job.targetId, job.runId],
  ));
}

export const TARGET_NOT_AVAILABLE_MESSAGE =
  'このコンピュータはPrivateです。所有者と、所有者が作ったService AccountのJobだけが動きます';

/** Refuses Jobs of someone who may not use a private computer (the Job's, rule's or hook's owner). */
export function targetNotAvailable(status: 403 | 422): never {
  throw new DomainError(status, TARGET_NOT_AVAILABLE_MESSAGE, 'target_not_available');
}

/**
 * Anyone sees that a computer exists (GET /targets/overview), but its job shell, keys and
 * personal settings are for those who may use or manage it.
 */
export async function requireTargetUser(
  connection: Connection,
  principal: Principal,
  target: ComputeTarget,
): Promise<void> {
  if (isTargetManager(principal, target)) return;
  if (!(await canUseTarget(connection, { targetId: target.id, userId: principal.user.id })))
    targetNotAvailable(403);
}

export async function findSiteTarget(
  connection: Connection,
  targetId: string,
  options: { lock?: boolean } = {},
): Promise<ComputeTarget> {
  const target = await first<ComputeTarget>(
    connection,
    `SELECT * FROM compute_targets WHERE id=$1 AND executor='site'${options.lock ? ' FOR UPDATE' : ''}`,
    [targetId],
  );
  if (!target) notFound('ComputeTarget');
  return target;
}
