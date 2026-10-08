import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { previousArtifactVersions } from '../lib/artifactTree';
import { useCursorPages } from './useCursorPages';
import { useQuery } from './useQuery';

// One screenful of a directory; a Run with thousands of files shows its first page quickly.
export const RUN_ARTIFACT_PAGE_SIZE = 200;
// Re-saves of one path are few; older uploads beyond this stay reachable through the API.
const ARTIFACT_VERSION_LIMIT = 100;

/**
 * One directory level of a Run: its subdirectories with counts, and its files page by page.
 * `revision` reloads both after an upload.
 */
export function useRunArtifacts(
  location: { projectId: string; runId: string; prefix: string },
  revision: number,
) {
  const { projectId, runId, prefix } = location;
  const key = `${projectId}:${runId}:artifacts:${revision}:${prefix}`;
  const tree = useQuery(`${key}:tree`, (signal) =>
    trackingApi.runArtifactTree(projectId, runId, prefix, signal),
  );
  const files = useCursorPages(`${key}:files`, (cursor, signal) =>
    trackingApi.runArtifactPage(
      projectId,
      runId,
      { prefix, directFilesOnly: true, limit: RUN_ARTIFACT_PAGE_SIZE, cursor },
      signal,
    ),
  );
  return { tree, files };
}

/** Earlier uploads to the path of `artifact`, newest first. */
export function useArtifactVersions(artifact: Artifact | undefined) {
  const versions = useQuery(
    artifact?.runId ? `${artifact.runId}:artifact-versions:${artifact.id}` : null,
    (signal) =>
      trackingApi.runArtifactPage(
        artifact!.projectId,
        artifact!.runId!,
        { prefix: artifact!.path, versions: 'all', limit: ARTIFACT_VERSION_LIMIT },
        signal,
      ),
  );
  return {
    ...versions,
    value:
      artifact && versions.value
        ? previousArtifactVersions(versions.value.items, artifact)
        : undefined,
  };
}
