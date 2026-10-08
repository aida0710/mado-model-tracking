import type { MetricSeriesRequest, MetricSeriesResponse } from '@mmt/contracts';
import { metricSeriesApi } from '../api/metricSeries';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

/**
 * Sampled series of the Runs for a chart. Pass null to fetch nothing. It polls while `live` (some
 * Run is still running) and stops once every Run has ended; a zoom is a new request with xRange.
 */
export function useMetricSeries(
  projectId: string,
  body: MetricSeriesRequest | null,
  live: boolean,
): QueryState<MetricSeriesResponse> {
  return useQuery(
    body ? `${projectId}:metric-series:${JSON.stringify(body)}` : null,
    (signal) => metricSeriesApi.series(projectId, body!, signal),
    live ? EXECUTION_POLL_MS : undefined,
  );
}
