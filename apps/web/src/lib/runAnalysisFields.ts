import { ANALYSIS_MAX_METRICS, type ParameterImportanceResult, type RunAnalysisTableResponse } from '@mmt/contracts';
import type { RunAnalysisMetricOptions } from '../api/runAnalysis';
import type { AxisDefinition, ChartRunRow } from './parallelCoordinates';
import { isSystemMetricKey } from './systemMetricKeys';

// Turns the analysis table into the rows and fields the charts draw. Field keys carry the
// namespace (params./metrics.) like MLflow search, so a param and a metric may share a name.

export const OBJECTIVE_FIELD_KEY = 'objective';
// More axes than this crowd the chart; the rest can be turned on from the axis menu.
export const DEFAULT_PARAM_AXIS_COUNT = 6;

export const paramFieldKey = (key: string) => `params.${key}`;
export const metricFieldKey = (key: string) => `metrics.${key}`;

export function analysisRows(table: RunAnalysisTableResponse): ChartRunRow[] {
  return table.runs.map((run) => {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(run.params)) values[paramFieldKey(key)] = value;
    for (const [key, value] of Object.entries(run.metrics)) values[metricFieldKey(key)] = value;
    if (table.objective) values[OBJECTIVE_FIELD_KEY] = run.objective ?? null;
    return { runId: run.runId, name: run.name, values };
  });
}

export function paramFields(table: RunAnalysisTableResponse): AxisDefinition[] {
  return table.params.map((param) => ({
    key: paramFieldKey(param.key),
    label: param.key,
    kind: param.kind,
    ...(param.values ? { categories: param.values } : {}),
  }));
}

export function metricFields(table: RunAnalysisTableResponse, objectiveLabel: string): AxisDefinition[] {
  const metrics: AxisDefinition[] = table.metrics.map((metric) => ({
    key: metricFieldKey(metric.key),
    label: metric.key,
    kind: 'numeric',
  }));
  return table.objective
    ? [{ key: OBJECTIVE_FIELD_KEY, label: `${objectiveLabel} (${table.objective.metric})`, kind: 'numeric' }, ...metrics]
    : metrics;
}

/**
 * The params shown first: the most important ones when importance is known, then the best covered
 * (ties by name). Importance may rank none (no Run has the target), which must not leave the
 * chart without param axes. Params the table did not return are skipped.
 */
export function defaultParamAxisKeys(
  table: RunAnalysisTableResponse,
  importance: ParameterImportanceResult | undefined,
): string[] {
  const available = new Set(table.params.map((param) => param.key));
  const important = (importance?.entries ?? [])
    .map((entry) => entry.param)
    .filter((key) => available.has(key));
  const covered = [...table.params]
    .sort((left, right) => right.coverage - left.coverage || left.key.localeCompare(right.key))
    .map((param) => param.key);
  const ranked = [...new Set([...important, ...covered])];
  return ranked.slice(0, DEFAULT_PARAM_AXIS_COUNT).map(paramFieldKey);
}

/**
 * Metric names in the order they are offered: result metrics by name, then system metrics
 * (CPU, memory, ...), which describe the machine rather than the result and so never come first.
 */
export function orderAnalysisMetricKeys(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)].sort();
  return [...unique.filter((key) => !isSystemMetricKey(key)), ...unique.filter(isSystemMetricKey)];
}

/** What the importance table explains: a metric's latest value, or a sweep's aggregated objective. */
export type AnalysisTarget = { source: 'sweep_objective' } | { source: 'latest_metric'; metric: string };

/** The metrics requested for the table: the target first so it survives the API's cap. */
export function tableMetricKeys(metricKeys: string[], target: AnalysisTarget | null): string[] {
  const targetMetric = target?.source === 'latest_metric' ? target.metric : null;
  const ordered = targetMetric ? [targetMetric, ...metricKeys.filter((key) => key !== targetMetric)] : metricKeys;
  return ordered.slice(0, ANALYSIS_MAX_METRICS);
}

/**
 * The chosen target while the Run set still offers it, otherwise the default: the sweep objective
 * when there is one, then the preferred metric, then the first offered metric (system metrics
 * come last in the order).
 */
export function resolveAnalysisTarget(
  chosen: AnalysisTarget | null,
  options: RunAnalysisMetricOptions,
): AnalysisTarget | null {
  const isOffered =
    chosen?.source === 'sweep_objective'
      ? options.objectiveMetric !== null
      : chosen !== null && options.metricKeys.includes(chosen.metric);
  return isOffered ? chosen : defaultAnalysisTarget(options);
}

function defaultAnalysisTarget(options: RunAnalysisMetricOptions): AnalysisTarget | null {
  if (options.objectiveMetric) return { source: 'sweep_objective' };
  const preferred = options.preferredMetric;
  if (preferred && options.metricKeys.includes(preferred))
    return { source: 'latest_metric', metric: preferred };
  const firstMetric = options.metricKeys[0];
  return firstMetric ? { source: 'latest_metric', metric: firstMetric } : null;
}
