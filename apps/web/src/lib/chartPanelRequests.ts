import {
  DEFAULT_SERIES_POINTS,
  MAX_SERIES_KEYS,
  type ChartPanelConfig,
  type ChartXAxis,
  type RunGroupBy,
} from '@mmt/contracts';

// Which /metrics/series and /metrics/groups requests a page of panels needs. Panels that share an
// x axis (and grouping) share one request, so a page usually fetches every panel at once.

/** Points the browser receives for one page of panels; keeps 50 Runs x 24 panels responsive. */
export const CHART_PAGE_POINT_BUDGET = 200_000;
/** Fewer points than this make a long training curve look jagged. */
export const MIN_POINTS_PER_SERIES = 100;
/** Groups are not known before the response; a page rarely shows more lines than this. */
const EXPECTED_GROUP_COUNT = 10;

export interface ChartRequestPlan {
  /** Same for panels that can share the response. */
  id: string;
  kind: 'series' | 'groups';
  xAxis: ChartXAxis;
  groupBy?: RunGroupBy;
  keys: string[];
}

export function chartRequestPlanId(panel: ChartPanelConfig, groupingEnabled: boolean): string {
  const groupBy = groupingEnabled ? panel.groupBy : undefined;
  return JSON.stringify([
    groupBy ? 'groups' : 'series',
    panel.xAxis.kind,
    panel.xAxis.metricKey ?? null,
    groupBy?.kind ?? null,
    groupBy?.key ?? null,
  ]);
}

/**
 * One plan per x axis and grouping. Without `groupingEnabled` (a single Run) the grouping of a
 * stored panel is ignored and the Runs are drawn one by one.
 */
export function planChartRequests(
  panels: readonly ChartPanelConfig[],
  groupingEnabled: boolean,
): ChartRequestPlan[] {
  const plans = new Map<string, ChartRequestPlan>();
  for (const panel of panels) {
    const id = chartRequestPlanId(panel, groupingEnabled);
    const groupBy = groupingEnabled ? panel.groupBy : undefined;
    const plan = plans.get(id) ?? {
      id,
      kind: groupBy ? 'groups' : 'series',
      xAxis: panel.xAxis,
      ...(groupBy ? { groupBy } : {}),
      keys: [],
    };
    for (const key of panel.metricKeys) if (!plan.keys.includes(key)) plan.keys.push(key);
    plans.set(id, plan);
  }
  return [...plans.values()];
}

/** The API takes at most MAX_SERIES_KEYS keys per request. */
export function chunkMetricKeys(keys: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < keys.length; index += MAX_SERIES_KEYS)
    chunks.push(keys.slice(index, index + MAX_SERIES_KEYS));
  return chunks;
}

/** Points per series so that every line of the page fits in CHART_PAGE_POINT_BUDGET. */
export function pointsPerSeries(lineCount: number): number {
  const share = Math.floor(CHART_PAGE_POINT_BUDGET / Math.max(1, lineCount));
  return Math.max(MIN_POINTS_PER_SERIES, Math.min(DEFAULT_SERIES_POINTS, share));
}

export function maxPointsForPlan(plan: ChartRequestPlan, runCount: number): number {
  const lines = (plan.kind === 'groups' ? EXPECTED_GROUP_COUNT : runCount) * plan.keys.length;
  return pointsPerSeries(lines);
}
