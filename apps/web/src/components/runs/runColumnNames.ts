import type { Run } from '@mmt/contracts';
import { getRunParameters } from '../../lib/runParameters';

// Experiment metrics come before system metrics so the initial columns show training results.
const SYSTEM_METRIC_PREFIX = 'system.';

/** Metric and parameter names present on the shown Runs, in column order. */
export function getRunColumnNames(runs: Run[]): {
  metricNames: string[];
  parameterNames: string[];
} {
  const parameterNames = Array.from(
    new Set(runs.flatMap((run) => Object.keys(getRunParameters(run)))),
  ).sort();
  const metricNames = Array.from(
    new Set(runs.flatMap((run) => Object.keys(run.latestMetrics))),
  ).sort(
    (left, right) =>
      Number(left.startsWith(SYSTEM_METRIC_PREFIX)) -
        Number(right.startsWith(SYSTEM_METRIC_PREFIX)) || left.localeCompare(right),
  );
  return { metricNames, parameterNames };
}
