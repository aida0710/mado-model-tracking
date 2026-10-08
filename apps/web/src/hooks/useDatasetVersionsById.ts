import type { Dataset, DatasetVersion } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { useQuery } from './useQuery';

/**
 * The dataset versions with the given ids. Versions already loaded are used as they are; the
 * other datasets' versions are read only when an id is not among them (a parent from another dataset).
 */
export function useDatasetVersionsById({
  projectId,
  ids,
  loadedVersions,
  datasets,
}: {
  projectId: string;
  ids: readonly string[];
  loadedVersions: readonly DatasetVersion[];
  datasets: readonly Dataset[];
}): Map<string, DatasetVersion> {
  const known = new Map(loadedVersions.map((version) => [version.id, version]));
  const missingIds = ids.filter((id) => !known.has(id));
  const loadedDatasetIds = new Set(loadedVersions.map((version) => version.datasetId));
  const others = useQuery(
    missingIds.length > 0 ? `${projectId}:dataset-versions-by-id:${missingIds.join(',')}` : null,
    async (signal) =>
      (
        await Promise.all(
          datasets
            .filter((dataset) => !loadedDatasetIds.has(dataset.id))
            .map((dataset) => registryApi.datasetVersions(projectId, dataset.id, signal)),
        )
      ).flat(),
  );
  for (const version of others.value ?? []) known.set(version.id, version);
  return known;
}
