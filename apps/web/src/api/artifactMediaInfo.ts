import { ARTIFACT_MEDIA_INFO_BATCH_LIMIT, type ArtifactMediaInfo } from '@mmt/contracts';
import { encodeId, projectPath, request, RequestError, requestItems } from './http';

const HTTP_NOT_FOUND = 404;

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

export const artifactMediaInfoApi = {
  /** null when the server has no media info, e.g. a format it does not read headers of. */
  get: async (projectId: string, artifactId: string, signal?: AbortSignal): Promise<ArtifactMediaInfo | null> => {
    try {
      return await request<ArtifactMediaInfo>(
        `${projectPath(projectId)}/artifacts/${encodeId(artifactId)}/media-info`,
        { signal },
      );
    } catch (error) {
      if (error instanceof RequestError && error.status === HTTP_NOT_FOUND) return null;
      throw error;
    }
  },
  /** Splits large lists into API-sized requests; Artifacts without media info are absent. */
  list: async (projectId: string, artifactIds: string[], signal?: AbortSignal): Promise<ArtifactMediaInfo[]> => {
    const pages = await Promise.all(
      chunksOf([...new Set(artifactIds)], ARTIFACT_MEDIA_INFO_BATCH_LIMIT).map((chunk) =>
        requestItems<ArtifactMediaInfo>(
          `${projectPath(projectId)}/artifact-media-info?artifactIds=${chunk.map(encodeId).join(',')}`,
          signal,
        ),
      ),
    );
    return pages.flat();
  },
};
