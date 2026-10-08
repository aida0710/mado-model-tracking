import { artifactLifecycleApi } from '../api/artifactLifecycle';
import { useQuery } from './useQuery';

/** Stored Artifact bytes of the Project per backend. */
export function useArtifactUsage(projectId: string) {
  return useQuery(`${projectId}:artifact-usage`, (signal) =>
    artifactLifecycleApi.usage(projectId, signal),
  );
}
