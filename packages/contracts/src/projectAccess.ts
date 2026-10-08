import type { ProjectRole, User } from './index.js';

/** A Project role granted to everyone in an Authentik group (project_group_bindings). */
export interface ProjectGroupBinding {
  projectId: string;
  group: string;
  role: ProjectRole;
  createdBy: string | null;
  createdAt: string;
}

/** One group through which a member holds a Project role. */
export interface ProjectMemberGroupRole {
  group: string;
  role: ProjectRole;
}

/**
 * A user with a Project role. `role` is the effective role: the highest of the direct grant
 * (`directRole`, null when the user has none) and the roles of the group bindings in `groups`.
 */
export interface ProjectMember {
  user: User;
  role: ProjectRole;
  directRole: ProjectRole | null;
  groups: ProjectMemberGroupRole[];
}

/** A user found by GET /users?query=. Carries only what is needed to pick the user. */
export interface UserSearchResult {
  id: string;
  email: string;
  displayName: string;
}
