import type { ProjectRole, User } from '@mmt/contracts';

// Mirrors the API's checks (accessService.requireProject / requireGlobalAdmin) so screens hide
// actions the API would reject. The API stays the authority; these only decide what to show.

export function isGlobalAdmin(user: Pick<User, 'isAdmin'>): boolean {
  return user.isAdmin;
}

/** Registering runs, versions, tasks and jobs needs at least the editor role. */
export function canEditProject(role: ProjectRole): boolean {
  return role !== 'viewer';
}

/** Project settings, members and service tokens need the Project admin role. */
export function canManageProject(role: ProjectRole): boolean {
  return role === 'admin';
}

/** Plugin connections can be managed by the Project admin or a global administrator. */
export function canManagePlugins(role: ProjectRole | undefined, globalAdmin: boolean): boolean {
  return globalAdmin || (role !== undefined && canManageProject(role));
}

/** Model automation rules follow the same rule as plugins (modelAutomationService). */
export function canManageAutomationRules(role: ProjectRole, globalAdmin: boolean): boolean {
  return globalAdmin || canManageProject(role);
}

/**
 * Any signed-in user who is not disabled may create a Project (projectService.create).
 * Checks for "not disabled" so a session from an API that does not send status yet still works.
 */
export function canCreateProject(user: Pick<User, 'status'>): boolean {
  return user.status !== 'disabled';
}

/** Only users with a local credential have a password here; SSO users change theirs in the IdP. */
export function canChangeOwnPassword(user: Pick<User, 'authSources'>): boolean {
  return user.authSources.includes('local');
}
