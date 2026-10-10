import { executionApi } from '../api/execution';
import { useQuery } from './useQuery';

/**
 * The targets a Job of the Project may run on, for every screen that chooses one: global ones,
 * one's own and those shared with the Project (GET /targets?projectId=).
 */
export function useProjectTargets(projectId: string) {
  return useQuery(`${projectId}:project-targets`, (signal) =>
    executionApi.projectTargets(projectId, signal),
  );
}
