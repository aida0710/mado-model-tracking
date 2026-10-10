import type { ComputeTarget } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { targetUsableSql } from '../repositories/computeTargetSharingRepository.js';
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
 * The settings, job shell, sharing and shared key of a computer are its manager's: a global
 * administrator, or the researcher who owns it, in a browser session. Someone who may not even
 * use the computer gets 404, as for any computer they cannot see.
 */
export async function requireTargetManager(
  connection: Connection,
  principal: Principal,
  target: ComputeTarget,
): Promise<void> {
  if (isGlobalAdministrator(principal)) return;
  if (target.ownerUserId !== principal.user.id) {
    await requireTargetUser(connection, principal, target);
    throw new DomainError(
      403,
      'この計算機の設定は所有者か全体管理者だけが変えられます',
      'target_owner_required',
    );
  }
  requireSession(principal, '計算機の設定');
}

export function isTargetManager(principal: Principal, target: ComputeTarget): boolean {
  return isGlobalAdministrator(principal) || target.ownerUserId === principal.user.id;
}

/** Whether the user may run Jobs on the computer: in this Project, or in any when omitted. */
export async function canUseTarget(
  connection: Connection,
  usage: { targetId: string; userId: string; projectId?: string | null },
): Promise<boolean> {
  return !!(await first(
    connection,
    `SELECT 1 FROM compute_targets t WHERE t.id=$1 AND ${targetUsableSql('$2::uuid', '$3::uuid')}`,
    [usage.targetId, usage.userId, usage.projectId ?? null],
  ));
}

/**
 * A computer is visible to whoever may use it or manage it; for anyone else it does not exist,
 * so another person's PC is not revealed by its ID.
 */
export async function requireTargetUser(
  connection: Connection,
  principal: Principal,
  target: ComputeTarget,
): Promise<void> {
  if (isTargetManager(principal, target)) return;
  if (!(await canUseTarget(connection, { targetId: target.id, userId: principal.user.id })))
    notFound('ComputeTarget');
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
