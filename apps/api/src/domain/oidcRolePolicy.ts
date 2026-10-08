// Decides from the IdP groups whether an SSO user may log in and which global role they hold.
// Project roles are not decided here: they come from direct grants and project group bindings.

// Ordered from weakest to strongest; a user in several mapped groups gets the strongest role.
// 'admin' is the global administrator (users.is_admin). 'user' may only log in.
export const GLOBAL_ROLES = ['user', 'admin'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

// Matches user_groups.group_name; longer or empty claim values are ignored rather than stored.
export const MAX_GROUP_NAME_LENGTH = 256;

export interface OidcRolePolicy {
  allowedGroups: string[];
  roleMapping: Record<string, GlobalRole>;
  defaultRole: GlobalRole;
}

export type OidcAccess =
  | { allowed: false; groups: string[] }
  | { allowed: true; globalRole: GlobalRole; isAdmin: boolean; groups: string[] };

export function isGlobalRole(value: unknown): value is GlobalRole {
  return GLOBAL_ROLES.includes(value as GlobalRole);
}

function strongerRole(left: GlobalRole, right: GlobalRole): GlobalRole {
  return GLOBAL_ROLES.indexOf(left) >= GLOBAL_ROLES.indexOf(right) ? left : right;
}

// Deduplicated and sorted so stored groups and audit diffs do not depend on claim order.
export function normalizeGroups(groups: readonly unknown[]): string[] {
  const names = groups.filter(
    (group): group is string =>
      typeof group === 'string' && group.length > 0 && group.length <= MAX_GROUP_NAME_LENGTH,
  );
  return [...new Set(names)].sort();
}

export function resolveOidcAccess(
  policy: OidcRolePolicy,
  claimGroups: readonly unknown[],
): OidcAccess {
  const groups = normalizeGroups(claimGroups);
  if (!groups.some((group) => policy.allowedGroups.includes(group)))
    return { allowed: false, groups };
  const mappedRoles = groups.flatMap((group) => {
    const role = policy.roleMapping[group];
    return role ? [role] : [];
  });
  const globalRole =
    mappedRoles.length === 0 ? policy.defaultRole : mappedRoles.reduce(strongerRole);
  return { allowed: true, globalRole, isAdmin: globalRole === 'admin', groups };
}

export interface OidcRolePolicySettings {
  // Comma-separated OIDC_ALLOWED_GROUPS.
  allowedGroups: string | undefined;
  // OIDC_ROLE_MAPPING_JSON: {"<group>": "<global role>"}.
  roleMappingJson: string | undefined;
  defaultRole: string | undefined;
  // OIDC_ADMIN_GROUP: shorthand for {"<group>": "admin"}.
  adminGroup: string | undefined;
}

// Kept from before role mapping existed, so a deployment without either setting keeps its admins.
export const LEGACY_DEFAULT_ADMIN_GROUP = 'mmt-admins';

function parseRoleMapping(json: string): Record<string, GlobalRole> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('OIDC_ROLE_MAPPING_JSON must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('OIDC_ROLE_MAPPING_JSON must be a JSON object');
  const mapping: Record<string, GlobalRole> = {};
  for (const [group, role] of Object.entries(parsed)) {
    if (group.length === 0 || group.length > MAX_GROUP_NAME_LENGTH)
      throw new Error('OIDC_ROLE_MAPPING_JSON has an invalid group name');
    // Unknown roles stop startup: a role added later must not be silently treated as 'user'.
    if (!isGlobalRole(role))
      throw new Error(`OIDC_ROLE_MAPPING_JSON roles must be one of ${GLOBAL_ROLES.join(', ')}`);
    mapping[group] = role;
  }
  return mapping;
}

function adminGroupsOf(mapping: Record<string, GlobalRole>): string[] {
  return Object.entries(mapping)
    .filter(([, role]) => role === 'admin')
    .map(([group]) => group)
    .sort();
}

// Builds the policy from environment settings. Errors name the setting, never its value.
export function createOidcRolePolicy(settings: OidcRolePolicySettings): OidcRolePolicy {
  const allowedGroups = normalizeGroups(
    (settings.allowedGroups ?? '').split(',').map((group) => group.trim()),
  );
  if (allowedGroups.length === 0) throw new Error('OIDC_ALLOWED_GROUPS is required');
  const defaultRole = settings.defaultRole ?? 'user';
  if (!isGlobalRole(defaultRole))
    throw new Error(`OIDC_DEFAULT_ROLE must be one of ${GLOBAL_ROLES.join(', ')}`);
  const adminGroup = settings.adminGroup?.trim() || undefined;
  if (settings.roleMappingJson === undefined)
    return {
      allowedGroups,
      roleMapping: { [adminGroup ?? LEGACY_DEFAULT_ADMIN_GROUP]: 'admin' },
      defaultRole,
    };
  const roleMapping = parseRoleMapping(settings.roleMappingJson);
  // With both settings, the admin groups must agree exactly; otherwise neither can be trusted.
  const mappedAdminGroups = adminGroupsOf(roleMapping);
  if (
    adminGroup !== undefined &&
    !(mappedAdminGroups.length === 1 && mappedAdminGroups[0] === adminGroup)
  )
    throw new Error('OIDC_ADMIN_GROUP disagrees with the admin groups in OIDC_ROLE_MAPPING_JSON');
  return { allowedGroups, roleMapping, defaultRole };
}
