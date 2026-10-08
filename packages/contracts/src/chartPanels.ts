/**
 * Metric chart panels. `relative_time` is seconds since the Run started (or its first metric
 * point), `wall_time` is epoch milliseconds and `metric` uses the value of `metricKey` at the same
 * step.
 */
export interface ChartXAxis {
  kind: 'step' | 'relative_time' | 'wall_time' | 'metric';
  metricKey?: string;
}
/** `weight` is the smoothing strength from 0 (none) to 1 for the selected kind. */
export interface ChartSmoothing {
  kind: 'none' | 'ema' | 'gaussian' | 'running_average';
  weight: number;
}
/** `key` names the tag or param; it is absent for `experiment`. */
export interface RunGroupBy {
  kind: 'tag' | 'param' | 'experiment';
  key?: string;
}
export interface ChartPanelConfig {
  id: string;
  title?: string;
  metricKeys: string[];
  xAxis: ChartXAxis;
  yScale: 'linear' | 'log';
  smoothing: ChartSmoothing;
  /** Draws the min/max band of sampled buckets or of a Run group. */
  showRange: boolean;
  groupBy?: RunGroupBy;
  /** Grid cell in the 12-column layout. */
  layout: { x: number; y: number; w: number; h: number };
}
export interface ChartPanelLayout {
  version: 1;
  columns: 12;
  panels: ChartPanelConfig[];
}
