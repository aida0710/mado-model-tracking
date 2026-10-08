import type { ChartXAxis, RunGroupBy } from './chartPanels.js';
import type { RunSearchRequest } from './runSearch.js';

// Limits published in docs/api-contract.md.
/** About the pixel width of a chart, which is all a line can show. */
export const DEFAULT_SERIES_POINTS = 1000;
export const MAX_SERIES_POINTS = 5000;
export const MAX_SERIES_RUNS = 200;
export const MAX_SERIES_KEYS = 50;
export const MAX_GROUPED_RUNS = 1000;
export const MAX_SERIES_GROUPS = 50;
/** The label and groupKey of Runs without the grouping tag or param. */
export const RUN_GROUP_NONE = '(none)';

/** Inclusive x interval, in the unit of the selected x axis. */
export interface MetricXRange {
  min: number;
  max: number;
}
export interface MetricSeriesRequest {
  runIds: string[];
  keys: string[];
  xAxis: ChartXAxis;
  maxPoints?: number;
  xRange?: MetricXRange;
}
/**
 * One stored point (`count` 1, `min`=`max`=`value`) or one bucket of a sampled series. In a bucket
 * `x` and `value` are the means of its finite points, `step` is its last step.
 */
export interface MetricSeriesPoint {
  x: number;
  step: number;
  value: number;
  min: number;
  max: number;
  count: number;
}
export interface MetricSeries {
  runId: string;
  key: string;
  points: MetricSeriesPoint[];
  sampled: boolean;
  /** Points inside the x range that have an x value, NaN and infinite values included. */
  totalPoints: number;
  /** NaN and infinite values, which are left out of every point. */
  nanCount: number;
  /** Points without an x value: no `metricKey` value at their step for the `metric` axis. */
  droppedPoints: number;
}
export interface MetricSeriesResponse {
  series: MetricSeries[];
}

/** Exactly one of `runIds` and `search` is given. `search` takes no `limit` or `cursor`. */
export interface MetricGroupsRequest {
  runIds?: string[];
  search?: Omit<RunSearchRequest, 'limit' | 'cursor'>;
  groupBy: RunGroupBy;
  keys: string[];
  xAxis: ChartXAxis;
  maxPoints?: number;
  xRange?: MetricXRange;
}
/** Statistics over the bucket means of the Runs that have a value in the bucket. */
export interface MetricGroupPoint {
  x: number;
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation, 0 for a single Run. */
  stddev: number;
  runCount: number;
}
export interface MetricGroup {
  groupKey: string;
  label: string;
  runIds: string[];
  series: { key: string; points: MetricGroupPoint[] }[];
}
export interface MetricGroupsResponse {
  groups: MetricGroup[];
}
