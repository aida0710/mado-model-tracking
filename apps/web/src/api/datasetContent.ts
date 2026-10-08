import type { ArtifactTree, DatasetVersionFilePage } from '@mmt/contracts';
import { encodeId, projectPath, request } from './http';

const versionPath = (location: DatasetVersionLocation) =>
  `${projectPath(location.projectId)}/datasets/${encodeId(location.datasetId)}/versions/${encodeId(location.versionId)}`;

export interface DatasetVersionLocation {
  projectId: string;
  datasetId: string;
  versionId: string;
}

export const datasetContentApi = {
  /** Files directly in `prefix` (a directory ending with `/`, or '' for the root), in path order. */
  directoryFiles: (
    location: DatasetVersionLocation,
    page: { prefix: string; limit: number; cursor?: string },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ prefix: page.prefix, delimiter: '/', limit: String(page.limit) });
    if (page.cursor) query.set('cursor', page.cursor);
    return request<DatasetVersionFilePage>(`${versionPath(location)}/files?${query}`, { signal });
  },
  fileTree: (location: DatasetVersionLocation, prefix: string, signal?: AbortSignal) =>
    request<ArtifactTree>(`${versionPath(location)}/files/tree?${new URLSearchParams({ prefix })}`, { signal }),
};
