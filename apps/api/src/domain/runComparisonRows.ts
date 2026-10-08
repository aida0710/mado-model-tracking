import type { Run, RunComparisonRow, RunComparisonValue } from '@mmt/contracts';
import { compareMetrics, type EvaluatedMetrics } from './evaluationComparison.js';
import { getRunParameterCells, parseMetricValue } from './runTableCells.js';

const sortedKeys = (records: readonly Record<string, unknown>[]) =>
  [...new Set(records.flatMap((record) => Object.keys(record)))].sort();

function namespaceRows(
  namespace: RunComparisonRow['namespace'],
  records: readonly Record<string, RunComparisonValue>[],
): RunComparisonRow[] {
  return sortedKeys(records).map((key) => ({
    namespace,
    key,
    values: records.map((record) => (Object.hasOwn(record, key) ? record[key]! : null)),
  }));
}

function evaluatedMetrics(run: Run): EvaluatedMetrics {
  const metrics: Record<string, { value: number; source: 'run_latest' }> = {};
  for (const [key, raw] of Object.entries(run.latestMetrics)) {
    const value = parseMetricValue(raw);
    if (value !== null) metrics[key] = { value, source: 'run_latest' };
  }
  return metrics;
}

/**
 * Lines up params, metrics and tags of the Runs (one value per Run, in the given order).
 * Metric rows follow metricKeys when given, otherwise every logged key by name; with a baseline
 * they also carry each Run's difference from it, computed like evaluation comparisons.
 */
export function buildComparisonRows(comparison: {
  runs: readonly Run[];
  baselineRunId: string | null;
  metricKeys: readonly string[] | null;
}): RunComparisonRow[] {
  const { runs, baselineRunId } = comparison;
  const metricKeys = comparison.metricKeys ?? sortedKeys(runs.map((run) => run.latestMetrics));
  const metricRows: RunComparisonRow[] = metricKeys.map((key) => ({
    namespace: 'metrics',
    key,
    values: runs.map((run) =>
      Object.hasOwn(run.latestMetrics, key) ? run.latestMetrics[key]! : null,
    ),
  }));
  const baseline = runs.find((run) => run.id === baselineRunId);
  if (baseline) {
    const baselineMetrics = evaluatedMetrics(baseline);
    // compareMetrics answers per Run for every key; rows need the transpose.
    const differences = runs.map((run) =>
      compareMetrics({
        candidate: evaluatedMetrics(run),
        baseline: baselineMetrics,
        metricKeys,
      }),
    );
    metricRows.forEach((row, keyIndex) => {
      row.deltaFromBaseline = differences.map((perKey) => perKey[keyIndex]!.delta);
      row.relativeDeltaFromBaseline = differences.map((perKey) => perKey[keyIndex]!.relativeDelta);
    });
  }
  return [
    ...namespaceRows('params', runs.map(getRunParameterCells)),
    ...metricRows,
    ...namespaceRows(
      'tags',
      runs.map((run) => run.tags),
    ),
  ];
}
