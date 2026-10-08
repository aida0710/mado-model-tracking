import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useQuery } from './useQuery';
import { ARTIFACT_LIST_LIMIT } from '../lib/artifactCatalog';

export function useProjectArtifacts(projectId: string, enabled: boolean, search: string) {
  const query = useQuery(enabled ? `${projectId}:project-artifacts:${search}` : null, (signal) =>
    trackingApi.projectArtifacts(projectId, { limit: ARTIFACT_LIST_LIMIT, query: search }, signal),
  );
  const [selectedArtifacts, setSelectedArtifacts] = useState<Artifact[]>([]);
  const items = [
    ...new Map(
      [...(query.value ?? []), ...selectedArtifacts].map((artifact) => [artifact.id, artifact]),
    ).values(),
  ];
  function rememberArtifact(artifact: Artifact) {
    setSelectedArtifacts((previous) => [
      ...previous.filter((item) => item.id !== artifact.id),
      artifact,
    ]);
  }
  return { ...query, items, rememberArtifact };
}
