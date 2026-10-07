import type { ProjectRole } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';

const roleOrder: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function requireScope(principal: Principal, scope: string): void {
  if (principal.method === 'session') return;
  if (!principal.token?.scopes.includes(scope) && !principal.token?.scopes.includes('admin')) {
    throw new DomainError(403, 'API tokenのscopeが不足しています', 'insufficient_scope');
  }
}

export async function requireProject(
  connection: Connection,
  principal: Principal,
  permission: { projectId: string; role: ProjectRole; scope: string },
): Promise<ProjectRole> {
  const { projectId } = permission;
  requireScope(principal, permission.scope);
  if (principal.token?.projectId && principal.token.projectId !== projectId)
    throw new DomainError(403, 'API tokenのprojectが一致しません', 'project_forbidden');
  const membership = await first<{ role: ProjectRole | null }>(
    connection,
    `SELECT m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$2 WHERE p.id=$1`,
    [projectId, principal.user.id],
  );
  if (!membership) notFound('Project');
  // Token access always requires current membership, including a global administrator's tokens.
  const role =
    membership.role ?? (principal.method === 'session' && principal.user.isAdmin ? 'admin' : null);
  if (!role || roleOrder[role] < roleOrder[permission.role])
    throw new DomainError(403, 'Projectの権限が不足しています', 'project_forbidden');
  return role;
}

export function requireGlobalAdmin(principal: Principal): void {
  requireScope(principal, 'admin');
  if (!principal.user.isAdmin || principal.token?.projectId)
    throw new DomainError(403, '管理者権限が必要です', 'admin_required');
}

export async function requireWorker(
  connection: Connection,
  principal: Principal,
): Promise<{ projectId: string; tokenId: string }> {
  if (
    principal.method !== 'token' ||
    !principal.token?.projectId ||
    !principal.token.scopes.includes('worker:execute')
  ) {
    throw new DomainError(
      403,
      'Projectに限定されたworker tokenが必要です',
      'worker_token_required',
    );
  }
  await requireProject(connection, principal, {
    projectId: principal.token.projectId,
    role: 'editor',
    scope: 'worker:execute',
  });
  return { projectId: principal.token.projectId, tokenId: principal.token.id };
}
