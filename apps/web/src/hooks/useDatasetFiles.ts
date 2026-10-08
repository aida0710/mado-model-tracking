import { datasetContentApi, type DatasetVersionLocation } from '../api/datasetContent';
import { useCursorPages } from './useCursorPages';
import { useQuery } from './useQuery';

// One screenful of a directory, as in a Run's Artifact browser.
export const DATASET_FILE_PAGE_SIZE = 200;

/** One directory level of a DatasetVersion: its subdirectories with counts, and its files page by page. */
export function useDatasetFiles(location: DatasetVersionLocation, prefix: string) {
  const key = `${location.projectId}:dataset-files:${location.versionId}:${prefix}`;
  const tree = useQuery(`${key}:tree`, (signal) => datasetContentApi.fileTree(location, prefix, signal));
  const files = useCursorPages(`${key}:files`, (cursor, signal) =>
    datasetContentApi.directoryFiles(location, { prefix, limit: DATASET_FILE_PAGE_SIZE, cursor }, signal),
  );
  return { tree, files };
}
