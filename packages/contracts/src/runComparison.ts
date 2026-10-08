import type { MetricSeries } from './metricSeries.js';
import type { Run } from './index.js';

// Limits published in docs/api-contract.md.
export const RUN_COMPARISON_MIN_RUNS = 2;
export const RUN_COMPARISON_MAX_RUNS = 50;
export const RUN_COMPARISON_MAX_METRIC_KEYS = 200;
// Response header of the search CSV export; "true" when the row limit cut the export short.
export const RUN_EXPORT_TRUNCATED_HEADER = 'X-MMT-Export-Truncated';

/** POST /projects/:p/runs/compare. runIds keep their order in every array of the response. */
export interface RunComparisonRequest {
  runIds: string[];
  /** One of runIds. Metric rows then carry the difference of every Run from this one. */
  baselineRunId?: string;
  /** Metric rows to return, in this order. Without it every logged metric key, by name. */
  metricKeys?: string[];
  /** Adds downsampled step series of the first 50 metric rows (same as POST /metrics/series). */
  includeHistory?: boolean;
}

export type RunComparisonNamespace = 'params' | 'metrics' | 'tags';
/** Parameters keep their JSON type; objects and arrays arrive as JSON text. NaN metrics arrive as 'NaN'. */
export type RunComparisonValue = string | number | boolean | null;

export interface RunComparisonRow {
  namespace: RunComparisonNamespace;
  key: string;
  /** One value per Run in runIds order; null when the Run has no such key. */
  values: RunComparisonValue[];
  /** Metrics with a baseline only: value − baseline per Run, null unless both are finite. */
  deltaFromBaseline?: (number | null)[];
  /** delta ÷ |baseline| per Run, null when the delta is null or the baseline is 0. */
  relativeDeltaFromBaseline?: (number | null)[];
}

export interface ComparedDatasetVersion {
  id: string;
  datasetId: string;
  namespace: string;
  name: string;
  version: string;
  digest: string;
}

export interface ComparedModelVersion {
  id: string;
  modelId: string;
  modelName: string;
  version: string;
}

export interface RunComparison {
  /** Polling summaries without executionSnapshot, in runIds order. */
  runs: Run[];
  baselineRunId: string | null;
  /** Input DatasetVersions referenced by the Runs (evaluation datasets), first use first. */
  datasetVersions: ComparedDatasetVersion[];
  /** ModelVersions the Runs used (Run.modelVersionId), first use first. */
  modelVersions: ComparedModelVersion[];
  rows: RunComparisonRow[];
  history?: MetricSeries[];
}
