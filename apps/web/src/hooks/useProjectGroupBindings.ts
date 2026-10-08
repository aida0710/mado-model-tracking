import type { ProjectRole } from '@mmt/contracts';
import { accessApi } from '../api/access';
import { explainLastProjectAdminConflict } from '../lib/lastProjectAdminConflict';
import { useQuery } from './useQuery';

/** Authentik group bindings of a Project, and the changes a Project admin can make. */
export function useProjectGroupBindings(projectId: string) {
  const bindings = useQuery(`${projectId}:group-bindings`, (signal) =>
    accessApi.groupBindings(projectId, signal),
  );
  return {
    bindings,
    saveGroupBinding: (group: string, role: ProjectRole) =>
      explainLastProjectAdminConflict(accessApi.saveGroupBinding(projectId, group, role)),
    removeGroupBinding: (group: string) =>
      explainLastProjectAdminConflict(accessApi.removeGroupBinding(projectId, group)),
  };
}

/**
 * Group names to offer when adding a binding. Candidates are only a convenience, so a failed
 * lookup leaves the list empty and the name can still be typed.
 */
export function useGroupNameCandidates(): string[] {
  const groups = useQuery('auth-groups', accessApi.groups);
  return groups.value ?? [];
}
