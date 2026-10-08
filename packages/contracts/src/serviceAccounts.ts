import type { ProjectRole } from './index.js';

/** Scopes an API token can hold, in the order screens list them. */
export const TOKEN_SCOPES = [
  'read',
  'runs:write',
  'registry:write',
  'artifacts:write',
  'jobs:write',
  'worker:execute',
  'admin',
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * The Project role a token's owner needs to hold a scope. The API checks it when a token is
 * issued; screens use it to offer only the scopes the owner can receive.
 */
export const TOKEN_SCOPE_REQUIRED_ROLE: Record<TokenScope, ProjectRole> = {
  read: 'viewer',
  'runs:write': 'editor',
  'registry:write': 'editor',
  'artifacts:write': 'editor',
  'jobs:write': 'editor',
  'worker:execute': 'admin',
  admin: 'admin',
};

/**
 * An account that belongs to a Project instead of a person (users.kind='service'). Its tokens
 * keep working when the people who issued them leave the Project. `role` is its direct Project
 * grant, null when the grant was removed through the members API.
 */
export interface ServiceAccount {
  id: string;
  projectId: string;
  name: string;
  description: string;
  role: ProjectRole | null;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface ServiceAccountCreate {
  name: string;
  description?: string;
  role: ProjectRole;
}

export interface ServiceAccountUpdate {
  description?: string;
  role?: ProjectRole;
  status?: 'active' | 'disabled';
}

export interface ServiceAccountTokenCreate {
  name: string;
  scopes: TokenScope[];
  expiresAt?: string | null;
}
