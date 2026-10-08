import type { DatasetVersion } from '@mmt/contracts';

/**
 * How a dataset version is named where it is referenced: its version alone inside its own dataset,
 * `namespace/name / version` (the selectors' form) for another dataset.
 */
export function datasetVersionLabel(version: DatasetVersion, shownDatasetId: string): string {
  if (version.datasetId === shownDatasetId) return version.version;
  return `${version.namespace}/${version.name} / ${version.version}`;
}
