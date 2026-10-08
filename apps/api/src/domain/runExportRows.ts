import type {
  ComparedDatasetVersion,
  ComparedModelVersion,
  Run,
  RunComparison,
} from '@mmt/contracts';
import type { CsvCell } from './csvEncoding.js';
import {
  DATASET_VERSION_SEPARATOR,
  datasetVersionLabel,
  getRunParameterCells,
  modelVersionLabel,
  parseMetricValue,
} from './runTableCells.js';

/** Looks up the descriptions a Run row refers to; unknown IDs are written as the raw ID. */
export interface RunReferenceLabels {
  experimentNames: ReadonlyMap<string, string>;
  modelVersions: ReadonlyMap<string, ComparedModelVersion>;
  datasetVersions: ReadonlyMap<string, ComparedDatasetVersion>;
}

const modelVersionCell = (run: Run, labels: RunReferenceLabels) => {
  if (!run.modelVersionId) return null;
  const version = labels.modelVersions.get(run.modelVersionId);
  return version ? modelVersionLabel(version) : run.modelVersionId;
};

const datasetVersionsCell = (run: Run, labels: RunReferenceLabels) =>
  run.inputDatasetVersionIds
    .map((id) => {
      const version = labels.datasetVersions.get(id);
      return version ? datasetVersionLabel(version) : id;
    })
    .join(DATASET_VERSION_SEPARATOR);

// ---- Comparison CSV: one row per field, one column per Run ----

/**
 * The comparison as rows of `field, run1, run2, ...`: Run attributes first, then params,
 * metrics and tags as `namespace.key`. With a baseline each metric is followed by its delta row.
 */
export function comparisonCsvLines(
  comparison: RunComparison,
  labels: RunReferenceLabels,
): CsvCell[][] {
  const { runs } = comparison;
  const attribute = (field: string, cell: (run: Run) => CsvCell): CsvCell[] => [
    field,
    ...runs.map(cell),
  ];
  const lines: CsvCell[][] = [
    attribute('name', (run) => run.name),
    attribute('id', (run) => run.id),
    attribute(
      'experiment',
      (run) => labels.experimentNames.get(run.experimentId) ?? run.experimentId,
    ),
    attribute('kind', (run) => run.kind),
    attribute('status', (run) => run.status),
    attribute('created', (run) => run.createdAt),
    attribute('ended', (run) => run.endedAt),
    attribute('modelVersion', (run) => modelVersionCell(run, labels)),
    attribute('datasetVersions', (run) => datasetVersionsCell(run, labels)),
  ];
  if (comparison.baselineRunId)
    lines.push(attribute('baseline', (run) => run.id === comparison.baselineRunId));
  for (const row of comparison.rows) {
    const field = `${row.namespace}.${row.key}`;
    const values =
      row.namespace === 'metrics' ? row.values.map((value) => parseMetricValue(value)) : row.values;
    lines.push([field, ...values]);
    if (row.deltaFromBaseline) lines.push([`${field} (delta)`, ...row.deltaFromBaseline]);
  }
  return lines;
}

// ---- Search export CSV: one row per Run ----

export interface RunExportKeys {
  parameterKeys: string[];
  metricKeys: string[];
  tagKeys: string[];
}

const RUN_ATTRIBUTE_COLUMNS = [
  'id',
  'name',
  'experiment',
  'kind',
  'status',
  'created',
  'ended',
  'modelVersion',
  'datasetVersions',
] as const;

/** Collects the keys of every namespace while the search pages are read once. */
export class RunExportKeyCollector {
  private readonly parameterKeys = new Set<string>();
  private readonly metricKeys = new Set<string>();
  private readonly tagKeys = new Set<string>();

  add(run: Run): void {
    for (const key of Object.keys(getRunParameterCells(run))) this.parameterKeys.add(key);
    for (const key of Object.keys(run.latestMetrics)) this.metricKeys.add(key);
    for (const key of Object.keys(run.tags)) this.tagKeys.add(key);
  }

  keys(): RunExportKeys {
    return {
      parameterKeys: [...this.parameterKeys].sort(),
      metricKeys: [...this.metricKeys].sort(),
      tagKeys: [...this.tagKeys].sort(),
    };
  }
}

export function searchExportHeader(keys: RunExportKeys): CsvCell[] {
  return [
    ...RUN_ATTRIBUTE_COLUMNS,
    ...keys.parameterKeys.map((key) => `params.${key}`),
    ...keys.metricKeys.map((key) => `metrics.${key}`),
    ...keys.tagKeys.map((key) => `tags.${key}`),
  ];
}

export function searchExportLine(
  run: Run,
  context: { keys: RunExportKeys; labels: RunReferenceLabels },
): CsvCell[] {
  const { keys, labels } = context;
  const parameters = getRunParameterCells(run);
  const valueOf = <T>(record: Record<string, T>, key: string) =>
    Object.hasOwn(record, key) ? record[key] : null;
  return [
    run.id,
    run.name,
    labels.experimentNames.get(run.experimentId) ?? run.experimentId,
    run.kind,
    run.status,
    run.createdAt,
    run.endedAt,
    modelVersionCell(run, labels),
    datasetVersionsCell(run, labels),
    ...keys.parameterKeys.map((key) => valueOf(parameters, key)),
    ...keys.metricKeys.map((key) => parseMetricValue(valueOf(run.latestMetrics, key))),
    ...keys.tagKeys.map((key) => valueOf(run.tags, key)),
  ];
}

/** The last line of an export cut at the row limit, so a reader cannot mistake it for complete. */
export function truncationNoticeLine(maxRows: number): CsvCell[] {
  return [`# truncated: ${maxRows}行を超えたため以降のRunを省略しました。検索条件を絞ってください`];
}
