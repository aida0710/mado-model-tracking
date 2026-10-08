import type { Artifact, ArtifactUsage } from '@mmt/contracts';
import { encodeId, projectPath, request } from './http';

export const artifactLifecycleApi = {
  /** Project admins only; the blob is removed after the server's grace period. */
  delete: (projectId: string, artifactId: string): Promise<Artifact> =>
    request<Artifact>(`${projectPath(projectId)}/artifacts/${encodeId(artifactId)}`, {
      method: 'DELETE',
    }),
  usage: (projectId: string, signal?: AbortSignal): Promise<ArtifactUsage> =>
    request<ArtifactUsage>(`${projectPath(projectId)}/artifact-usage`, { signal }),
};
