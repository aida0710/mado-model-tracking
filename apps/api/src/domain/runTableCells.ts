import type {
  ComparedDatasetVersion,
  ComparedModelVersion,
  Run,
  RunComparisonValue,
} from '@mmt/contracts';

// Joins several DatasetVersions in one cell; neither character appears in a version label.
export const DATASET_VERSION_SEPARATOR = '; ';

/**
 * Parameters of a Run as table cells. Native parameters win over the SDK's recorded strings so
 * numbers stay numbers; nested objects and arrays become JSON text.
 */
export function getRunParameterCells(
  run: Pick<Run, 'parameters' | 'recordedParameters'>,
): Record<string, RunComparisonValue> {
  const merged = { ...run.recordedParameters, ...run.parameters };
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [
      key,
      value === null || typeof value !== 'object' ? value : JSON.stringify(value),
    ]),
  );
}

/**
 * PostgreSQL writes non-finite doubles of latest_metrics as the JSON strings 'NaN', 'Infinity'
 * and '-Infinity'. They are turned back into numbers; anything else is not a metric value.
 */
export function parseMetricValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return Number(value);
  return null;
}

export const modelVersionLabel = (version: ComparedModelVersion) =>
  `${version.modelName}@${version.version}`;

export const datasetVersionLabel = (version: ComparedDatasetVersion) =>
  `${version.namespace ? `${version.namespace}/` : ''}${version.name}@${version.version}`;
