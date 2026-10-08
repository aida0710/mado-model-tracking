import type { ProjectRole } from '@mmt/contracts';

// Matches the CASE ranking in the effective_project_roles view (migration 022).
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function satisfiesProjectRole(actual: ProjectRole, required: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[actual] >= PROJECT_ROLE_RANK[required];
}

