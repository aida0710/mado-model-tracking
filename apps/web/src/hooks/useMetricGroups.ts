import type { MetricGroupsRequest, MetricGroupsResponse } from '@mmt/contracts';
import { metricSeriesApi } from '../api/metricSeries';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

/**
 * Mean and min/max of Run groups for a chart. Pass null to fetch nothing. Polls while `live`, the
 * same as useMetricSeries.
 */
export function useMetricGroups(
  projectId: string,
  body: MetricGroupsRequest | null,
  live: boolean,
): QueryState<MetricGroupsResponse> {
  return useQuery(
    body ? `${projectId}:metric-groups:${JSON.stringify(body)}` : null,
    (signal) => metricSeriesApi.groups(projectId, body!, signal),
    live ? EXECUTION_POLL_MS : undefined,
  );
}
