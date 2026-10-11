import type { ComputeTarget, ProjectRole, User } from '@mmt/contracts';

// Mirrors the API's checks (accessService.requireProject / requireGlobalAdmin) so screens hide
// actions the API would reject. The API stays the authority; these only decide what to show.

export function isGlobalAdmin(user: Pick<User, 'isAdmin'>): boolean {
  return user.isAdmin;
}

/** Registering runs, versions, tasks and jobs needs at least the editor role. */
export function canEditProject(role: ProjectRole): boolean {
  return role !== 'viewer';
}

/**
 * Project settings (description, visibility, storage), members, service tokens and archiving the
 * Project need the Project admin role. A global administrator's session resolves to admin.
 */
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

/**
 * Adding a computer: anyone signed in may add a site (POST /targets from a session), and becomes
 * its owner; global administrators also add ssh and local targets.
 */
export function canAddTarget(user: Pick<User, 'status'>): boolean {
  return user.status !== 'disabled';
}

/** ssh and local targets run through the workers' own SSH keys, so only global administrators add them. */
export function canAddSshOrLocalTarget(user: Pick<User, 'isAdmin'>): boolean {
  return isGlobalAdmin(user);
}

/** Whoever added a computer owns it; one from before owners has none. */
export function isTargetOwner(
  user: Pick<User, 'id'>,
  target: Pick<ComputeTarget, 'ownerUserId'>,
): boolean {
  return target.ownerUserId !== null && target.ownerUserId === user.id;
}

/**
 * Editing a computer (its visibility too), saving its job shell, its shared account key and
 * everyone's settings on it: a global administrator or its owner (targetService). Everyone who may
 * use it reads its job shell and keeps their own settings and key.
 */
export function canManageTarget(
  user: Pick<User, 'id' | 'isAdmin'>,
  target: Pick<ComputeTarget, 'ownerUserId'>,
): boolean {
  return isGlobalAdmin(user) || isTargetOwner(user, target);
}
