import {
  TOKEN_SCOPE_REQUIRED_ROLE,
  TOKEN_SCOPES,
  type ProjectRole,
  type TokenScope,
} from '@mmt/contracts';

// Same ranking as the API's domain/projectRoles.ts.
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

/** Scopes a token owner with this role may receive; the API refuses the others. */
export function scopesAllowedForRole(role: ProjectRole): TokenScope[] {
  return TOKEN_SCOPES.filter(
    (scope) => PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[TOKEN_SCOPE_REQUIRED_ROLE[scope]],
  );
}
