import type { Artifact, ArtifactMediaInfo } from '@mmt/contracts';
import { artifactMediaInfoApi } from '../api/artifactMediaInfo';
import { useQuery } from './useQuery';

/**
 * The header-derived audio properties of one Artifact, or null while loading, when the server
 * has none, or when the request failed. They only supplement the decoded values, so a failure
 * is not shown.
 */
export function useArtifactMediaInfo(artifact: Pick<Artifact, 'projectId' | 'id'>): ArtifactMediaInfo | null {
  const query = useQuery(`${artifact.projectId}/${artifact.id}`, (signal) =>
    artifactMediaInfoApi.get(artifact.projectId, artifact.id, signal),
  );
  return query.value ?? null;
}
