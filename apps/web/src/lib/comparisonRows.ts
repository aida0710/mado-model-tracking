import {
  RUN_COMPARISON_MAX_RUNS,
  RUN_COMPARISON_MIN_RUNS,
  type ComparedDatasetVersion,
  type ComparedModelVersion,
  type RunComparison,
  type RunComparisonNamespace,
  type RunComparisonValue,
} from '@mmt/contracts';

// Same labels as the API's CSV, so the page and a downloaded file name versions alike.
export const modelVersionLabel = (version: ComparedModelVersion) =>
  `${version.modelName}@${version.version}`;
export const datasetVersionLabel = (version: ComparedDatasetVersion) =>
  `${version.namespace ? `${version.namespace}/` : ''}${version.name}@${version.version}`;

export type ComparisonRowGroup = 'modelVersion' | 'datasetVersions' | RunComparisonNamespace;

export interface ComparisonCellDelta {
  delta: number | null;
  relativeDelta: number | null;
}

/** One table row: a field and one cell per Run, in the compared order. */
export interface ComparisonTableRow {
  id: string;
  group: ComparisonRowGroup;
  /** The key for params, metrics and tags; empty for the reference rows labelled by group. */
  key: string;
  values: RunComparisonValue[];
  /** Present on metric rows when a baseline Run is chosen. */
  deltas?: ComparisonCellDelta[];
  differs: boolean;
}

/** The Run IDs of the `runs` URL parameter, unique and in order. */
export function parseComparedRunIds(parameter: string | null): string[] {
  return [...new Set((parameter ?? '').split(',').filter(Boolean))];
}

export const isComparableRunCount = (count: number) =>
  count >= RUN_COMPARISON_MIN_RUNS && count <= RUN_COMPARISON_MAX_RUNS;

/** A baseline is kept only while it is one of the compared Runs. */
export function chooseBaselineRunId(runIds: string[], parameter: string | null): string | null {
  return parameter && runIds.includes(parameter) ? parameter : null;
}

// A missing key differs from any value, so null takes part in the comparison like a value.
export const valuesDiffer = (values: RunComparisonValue[]) =>
  new Set(values.map((value) => JSON.stringify(value))).size > 1;

function referenceRow(
  group: 'modelVersion' | 'datasetVersions',
  values: (string | null)[],
): ComparisonTableRow {
  return { id: group, group, key: '', values, differs: valuesDiffer(values) };
}

/**
 * The rows of the comparison table: the ModelVersion and evaluation DatasetVersions each Run
 * used, then params, metrics and tags as the API ordered them.
 */
export function buildComparisonTableRows(comparison: RunComparison): ComparisonTableRow[] {
  const modelVersions = new Map(comparison.modelVersions.map((version) => [version.id, version]));
  const datasetVersions = new Map(
    comparison.datasetVersions.map((version) => [version.id, version]),
  );
  const modelVersionCells = comparison.runs.map((run) => {
    if (!run.modelVersionId) return null;
    const version = modelVersions.get(run.modelVersionId);
    return version ? modelVersionLabel(version) : run.modelVersionId;
  });
  const datasetVersionCells = comparison.runs.map((run) =>
    run.inputDatasetVersionIds.length
      ? run.inputDatasetVersionIds
          .map((id) => {
            const version = datasetVersions.get(id);
            return version ? datasetVersionLabel(version) : id;
          })
          .join(', ')
      : null,
  );
  return [
    referenceRow('modelVersion', modelVersionCells),
    referenceRow('datasetVersions', datasetVersionCells),
    ...comparison.rows.map((row) => ({
      id: `${row.namespace}.${row.key}`,
      group: row.namespace,
      key: row.key,
      values: row.values,
      ...(row.deltaFromBaseline
        ? {
            deltas: row.deltaFromBaseline.map((delta, index) => ({
              delta,
              relativeDelta: row.relativeDeltaFromBaseline?.[index] ?? null,
            })),
          }
        : {}),
      differs: valuesDiffer(row.values),
    })),
  ];
}

export function filterComparisonRows(
  rows: ComparisonTableRow[],
  onlyDifferences: boolean,
): ComparisonTableRow[] {
  return onlyDifferences ? rows.filter((row) => row.differs) : rows;
}
