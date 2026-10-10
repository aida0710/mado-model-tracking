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

/** Promotion policies are created and switched by the Project admin or a global administrator. */
export function canManagePromotionPolicies(role: ProjectRole, globalAdmin: boolean): boolean {
  return globalAdmin || canManageProject(role);
}

/**
 * Re-evaluating a promotion decision needs the Project admin role itself; editors could otherwise
 * retry until a pass. A global administrator who is not a member resolves to admin in `role`.
 */
export function canReevaluatePromotion(role: ProjectRole): boolean {
  return canManageProject(role);
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

/** Alias protections follow the promotion policy rule (aliasProtectionService). */
export function canManageAliasProtections(role: ProjectRole, globalAdmin: boolean): boolean {
  return globalAdmin || canManageProject(role);
}

/**
 * Pausing, resuming, canceling or resizing a sweep: its creator while still an editor, or a
 * Project admin (sweepService; other editors get 403 sweep_owner_required).
 */
export function canControlSweep(role: ProjectRole, userId: string, sweep: { createdBy: string }): boolean {
  return canManageProject(role) || (canEditProject(role) && sweep.createdBy === userId);
}

/**
 * Hooks: every researcher (editor) may create one, switch one on or off and start a 'manual' one
 * (hookService checks the editor role with jobs:write); a hook runs with its owner's authority.
 */
export function canManageHooks(role: ProjectRole): boolean {
  return canEditProject(role);
}

/**
 * Moving a hook to a Service Account changes whose authority it runs with, so it follows the
 * automation rule rule: a Project admin or a global administrator (hookService.transferOwner).
 */
export function canTransferHookOwners(role: ProjectRole, globalAdmin: boolean): boolean {
  return globalAdmin || canManageProject(role);
}
