import type { ProjectRole } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { satisfiesProjectRole } from '../domain/projectRoles.js';

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
  // The effective role is the strongest of the direct grant, the user's group bindings and, on a
  // public Project, editor. An archived Project is gone for everyone, global administrators too.
  const membership = await first<{ role: ProjectRole | null }>(
    connection,
    `SELECT e.role FROM projects p LEFT JOIN effective_project_roles e ON e.project_id=p.id AND e.user_id=$2
    WHERE p.id=$1 AND p.archived_at IS NULL`,
    [projectId, principal.user.id],
  );
  if (!membership) notFound('Project');
  // A global administrator's session is admin in every live Project, also where public access or
  // a weaker grant gives a role. Token access always requires current membership, including a
  // global administrator's tokens.
  const role = principal.method === 'session' && principal.user.isAdmin ? 'admin' : membership.role;
  if (!role || !satisfiesProjectRole(role, permission.role))
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

// Descriptions and comments are human records, so code running inside a Job may not write them.
export function rejectJobToken(principal: Principal): void {
  if (principal.token?.job)
    throw new DomainError(403, 'Job限定tokenではこの操作はできません', 'job_token_forbidden');
}
