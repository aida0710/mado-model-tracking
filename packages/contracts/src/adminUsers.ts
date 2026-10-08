import type { User } from './index.js';

export type UserKind = 'human' | 'service';

/** A user as the global administrator sees it (GET /admin/users). */
export interface AdminUser extends User {
  kind: UserKind;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserQuery {
  /** Partial match on username, email and display name, ignoring case. */
  query?: string;
  status?: User['status'];
  kind?: UserKind;
}

/** POST /admin/users: a local account whose password must be changed at the first login. */
export interface AdminUserCreate {
  username: string;
  displayName: string;
  email?: string;
  /** Temporary password, 12-1024 UTF-8 bytes. */
  password: string;
  isAdmin: boolean;
}

/** PATCH /admin/users/:id. SSO users' isAdmin and displayName come from the IdP and are refused. */
export interface AdminUserPatch {
  status?: User['status'];
  displayName?: string;
  isAdmin?: boolean;
}

/** POST /admin/users/:id/reset-password. The password is returned only in this response. */
export interface AdminUserPasswordReset {
  temporaryPassword: string;
}

/** GET /account: the signed-in user's own profile. */
export interface Account {
  user: AdminUser;
  /** SSO groups from the last login; read-only because Authentik is the source of truth. */
  groups: string[];
  groupsSyncedAt: string | null;
  /** How the calling session signed in; null for API tokens. */
  sessionAuthMethod: 'local' | 'oidc' | 'development' | null;
}
