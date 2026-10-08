import type { ChartXAxis } from '@mmt/contracts';
import { metricSeriesApi } from '../api/metricSeries';
import type { MetricsChartMarker } from '../components/charts/chartProps';
import { textTemplates } from '../i18n/catalog';
import { resumeMarkers } from '../lib/metricSeries';
import { useQuery, type QueryState } from './useQuery';

// resume-events is one request per Run, so markers are drawn only for charts of a few Runs.
export const MAX_RESUME_MARKER_RUNS = 10;

/**
 * Vertical markers where the Runs were resumed, for MetricsChart. Charts of more Runs than
 * MAX_RESUME_MARKER_RUNS get none instead of one request per Run.
 */
export function useResumeMarkers(
  projectId: string,
  runs: readonly { id: string; label: string }[],
  xAxis: ChartXAxis,
): QueryState<MetricsChartMarker[]> {
  const isFewRuns = runs.length > 0 && runs.length <= MAX_RESUME_MARKER_RUNS;
  return useQuery(
    isFewRuns
      ? `${projectId}:resume-markers:${xAxis.kind}:${runs.map((run) => run.id).join(',')}`
      : null,
    async (signal) =>
      resumeMarkers(
        xAxis,
        await Promise.all(
          runs.map(async (run) => ({
            label: textTemplates.chartResumeMarkerOf(run.label),
            resumeEvents: await metricSeriesApi.resumeEvents(projectId, run.id, signal),
          })),
        ),
      ),
  );
}
