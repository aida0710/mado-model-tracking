import type { RunSet } from '@mmt/contracts';
import { runAnalysisApi } from '../api/runAnalysis';
import { resolveAnalysisTarget, tableMetricKeys, type AnalysisTarget } from '../lib/runAnalysisFields';
import { useQuery } from './useQuery';

/**
 * The params x metrics table and the parameter importance of one Run set. Metric names are
 * sampled first because both endpoints need them; `chosenTarget` falls back to the default when the set does not offer it.
 */
export function useRunAnalysis({
  projectId,
  runSet,
  chosenTarget,
}: {
  projectId: string;
  runSet: RunSet;
  chosenTarget: AnalysisTarget | null;
}) {
  const runSetKey = `${projectId}:run-analysis:${JSON.stringify(runSet)}`;
  const metricOptions = useQuery(runSetKey, (signal) => runAnalysisApi.metricOptions(projectId, runSet, signal));
  const target = metricOptions.value ? resolveAnalysisTarget(chosenTarget, metricOptions.value) : null;
  const metrics = metricOptions.value ? tableMetricKeys(metricOptions.value.metricKeys, target) : [];
  const table = useQuery(
    // Keyed by the set of metrics so picking another target among them does not reload the table.
    metrics.length > 0 ? `${runSetKey}:table:${JSON.stringify([...metrics].sort())}` : null,
    (signal) => runAnalysisApi.table(projectId, { runSet, metrics }, signal),
  );
  const importance = useQuery(
    target ? `${runSetKey}:importance:${JSON.stringify(target)}` : null,
    (signal) =>
      runAnalysisApi.parameterImportance(
        projectId,
        { runSet, ...(target?.source === 'latest_metric' ? { targetMetric: target.metric } : {}) },
        signal,
      ),
  );
  return { metricOptions, target, table, importance };
}
