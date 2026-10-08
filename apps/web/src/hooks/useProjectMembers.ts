import type { ProjectRole } from '@mmt/contracts';
import { accessApi } from '../api/access';
import { explainLastProjectAdminConflict } from '../lib/lastProjectAdminConflict';
import { useQuery } from './useQuery';

/** Project members with their effective role, and the changes a Project admin can make. */
export function useProjectMembers(projectId: string) {
  const members = useQuery(`${projectId}:members`, (signal) =>
    accessApi.members(projectId, signal),
  );
  return {
    members,
    saveMember: (userId: string, role: ProjectRole) =>
      explainLastProjectAdminConflict(accessApi.saveMember(projectId, userId, role)),
    removeMember: (userId: string) =>
      explainLastProjectAdminConflict(accessApi.removeMember(projectId, userId)),
  };
}
