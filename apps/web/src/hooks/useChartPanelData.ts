import type {
  MetricGroup,
  MetricGroupsRequest,
  MetricSeries,
  MetricXRange,
} from '@mmt/contracts';
import { metricSeriesApi } from '../api/metricSeries';
import { chunkMetricKeys, maxPointsForPlan, type ChartRequestPlan } from '../lib/chartPanelRequests';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';

/**
 * The Runs a page draws. Series are always fetched by id; a grouped panel sends `search` when the
 * page has one, so the groups cover the whole search and not only the Runs listed.
 */
export interface ChartRunSource {
  runIds: string[];
  search?: MetricGroupsRequest['search'];
}

export type ChartPlanData =
  | { kind: 'series'; series: MetricSeries[] }
  | { kind: 'groups'; groups: MetricGroup[] };

async function loadPlan(
  projectId: string,
  source: ChartRunSource,
  plan: ChartRequestPlan,
  xRange: MetricXRange | undefined,
  signal: AbortSignal,
): Promise<ChartPlanData> {
  const maxPoints = maxPointsForPlan(plan, source.runIds.length);
  const range = xRange ? { xRange } : {};
  if (plan.kind === 'series') {
    // A grouped page can have a search but no listed Runs; the API rejects an empty id list.
    if (!source.runIds.length) return { kind: 'series', series: [] };
    const responses = await Promise.all(
      chunkMetricKeys(plan.keys).map((keys) =>
        metricSeriesApi.series(
          projectId,
          { runIds: source.runIds, keys, xAxis: plan.xAxis, maxPoints, ...range },
          signal,
        ),
      ),
    );
    return { kind: 'series', series: responses.flatMap((response) => response.series) };
  }
  const runs = source.search ? { search: source.search } : { runIds: source.runIds };
  const responses = await Promise.all(
    chunkMetricKeys(plan.keys).map((keys) =>
      metricSeriesApi.groups(
        projectId,
        { ...runs, groupBy: plan.groupBy!, keys, xAxis: plan.xAxis, maxPoints, ...range },
        signal,
      ),
    ),
  );
  // Each key chunk returns the same groups; join their series by group.
  const groups = new Map<string, MetricGroup>();
  for (const group of responses.flatMap((response) => response.groups)) {
    const known = groups.get(group.groupKey);
    groups.set(group.groupKey, known ? { ...known, series: [...known.series, ...group.series] } : group);
  }
  return { kind: 'groups', groups: [...groups.values()] };
}

/** One response per request plan, keyed by plan id. Polls while any drawn Run is running. */
export function useChartPanelData({
  projectId,
  source,
  plans,
  xRange,
  live,
}: {
  projectId: string;
  source: ChartRunSource;
  plans: ChartRequestPlan[];
  xRange?: MetricXRange;
  live: boolean;
}) {
  const hasRuns = source.runIds.length > 0 || source.search !== undefined;
  const key =
    hasRuns && plans.length ? JSON.stringify(['chart-panels', projectId, source, plans, xRange ?? null]) : null;
  return useQuery(
    key,
    async (signal) => {
      const loaded = await Promise.all(
        plans.map(async (plan) => [plan.id, await loadPlan(projectId, source, plan, xRange, signal)] as const),
      );
      return Object.fromEntries(loaded) as Record<string, ChartPlanData>;
    },
    live ? EXECUTION_POLL_MS : undefined,
  );
}
