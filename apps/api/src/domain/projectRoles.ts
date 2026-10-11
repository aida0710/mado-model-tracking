import type { ProjectRole } from '@mmt/contracts';

// Matches project_role_rank(), which the role views rank grants with (migration 054).
const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function satisfiesProjectRole(actual: ProjectRole, required: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[actual] >= PROJECT_ROLE_RANK[required];
}

