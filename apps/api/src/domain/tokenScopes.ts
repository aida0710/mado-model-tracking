import { TOKEN_SCOPE_REQUIRED_ROLE, type ProjectRole, type TokenScope } from '@mmt/contracts';
import { satisfiesProjectRole } from './projectRoles.js';

/** The weakest Project role that may hold every requested scope. */
export function requiredProjectRoleForScopes(scopes: readonly TokenScope[]): ProjectRole {
  return scopes.reduce<ProjectRole>((strongest, scope) => {
    const required = TOKEN_SCOPE_REQUIRED_ROLE[scope];
    return satisfiesProjectRole(strongest, required) ? strongest : required;
  }, 'viewer');
}

/** Scopes from the request that the role cannot hold. */
export function scopesBeyondRole(scopes: readonly TokenScope[], role: ProjectRole): TokenScope[] {
  return scopes.filter((scope) => !satisfiesProjectRole(role, TOKEN_SCOPE_REQUIRED_ROLE[scope]));
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export type TokenExpiryResolution =
  { expiresAt: Date } | { error: 'expiry_in_past' | 'lifetime_exceeded' };

/**
 * Resolves a requested expiry against the lifetime limit. No expiry means the longest allowed
 * one, so every new token expires.
 */
export function resolveTokenExpiry(request: {
  expiresAt: string | null | undefined;
  maxLifetimeDays: number;
  now: Date;
}): TokenExpiryResolution {
  const latest = new Date(request.now.getTime() + request.maxLifetimeDays * DAY_MILLISECONDS);
  if (!request.expiresAt) return { expiresAt: latest };
  const expiresAt = new Date(request.expiresAt);
  if (expiresAt <= request.now) return { error: 'expiry_in_past' };
  if (expiresAt > latest) return { error: 'lifetime_exceeded' };
  return { expiresAt };
}
