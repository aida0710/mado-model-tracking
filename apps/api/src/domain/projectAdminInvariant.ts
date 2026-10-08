import type { ProjectRole } from '@mmt/contracts';

// A Project must keep at least one admin grant: a direct admin member or an admin group
// binding. A binding counts even while no user holds the group, because SSO users join it at
// their next login and a global administrator can still recover the Project.

export interface ProjectAdminGrants {
  directAdminUserIds: readonly string[];
  adminGroupNames: readonly string[];
}

// role is the value after the change; null removes the grant.
export type ProjectAdminChange =
  | { kind: 'member'; userId: string; role: ProjectRole | null }
  | { kind: 'group_binding'; groupName: string; role: ProjectRole | null };

// The caller reads grants after locking the Project row so concurrent removals serialize.
export function removesLastProjectAdmin(
  grants: ProjectAdminGrants,
  change: ProjectAdminChange,
): boolean {
  if (change.role === 'admin') return false;
  const directAdmins = grants.directAdminUserIds.filter(
    (userId) => !(change.kind === 'member' && userId === change.userId),
  );
  const adminGroups = grants.adminGroupNames.filter(
    (groupName) => !(change.kind === 'group_binding' && groupName === change.groupName),
  );
  const removesAGrant =
    directAdmins.length !== grants.directAdminUserIds.length ||
    adminGroups.length !== grants.adminGroupNames.length;
  return removesAGrant && directAdmins.length + adminGroups.length === 0;
}
